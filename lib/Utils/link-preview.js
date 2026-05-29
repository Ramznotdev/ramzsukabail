import { lookup } from 'dns'
import { promisify } from 'util'
import { getLinkPreview } from 'link-preview-js'
import { LRUCache } from 'lru-cache'
import { prepareWAMessageMedia } from './messages.js'
import { extractImageThumb, getHttpStream } from './messages-media.js'

const dnsLookup = promisify(lookup)

// ─── Constants ────────────────────────────────────────────────────────────────
const THUMBNAIL_WIDTH_PX = 192
const PREVIEW_TIMEOUT = 8_000
const MAX_CONCURRENT = 20

// ─── Caches ───────────────────────────────────────────────────────────────────

/** Full preview result — avoids re-fetching the same URL entirely */
const _previewCache = new LRUCache({
    max: 500,
    ttl: 1000 * 60 * 10, // 10 min
})

/** Compressed/HQ thumbnail blobs — avoids re-downloading images */
const _thumbCache = new LRUCache({
    max: 200,
    ttl: 1000 * 60 * 30, // 30 min
})

/** In-flight dedup — multiple calls for the same URL share one promise */
const _inflight = new Map()

// ─── User-Agent rotation ──────────────────────────────────────────────────────
const USER_AGENTS = [
    'WhatsApp/2.2413.51 iOS/17.5.1 Device/Apple-iPhone_13',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Twitterbot/1.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

// ─── Concurrency queue ────────────────────────────────────────────────────────
let _active = 0
const _queue = []

const _drain = () => {
    if (_queue.length === 0 || _active >= MAX_CONCURRENT) return
    _active++
    const { fn, resolve, reject } = _queue.shift()
    fn().then(resolve).catch(reject).finally(() => { _active--; _drain() })
}

const _enqueue = fn => new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject }); _drain()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────
const _normalizeUrl = text => {
    const t = text.trim()
    return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

const _getPreviewType = (mediaType, image) => {
    if (!mediaType) return image ? 5 : 0
    const mt = mediaType.toLowerCase()
    if (mt === 'video' || mt.startsWith('video.')) return 1
    if (mt === 'image') return 5
    return image ? 5 : 0
}

// ─── SSRF protection ──────────────────────────────────────────────────────────
const _resolveDNSHost = async url => {
    try {
        const { address } = await dnsLookup(new URL(url).hostname)
        return address
    } catch {
        return new URL(url).hostname
    }
}

// ─── Thumbnail resolution ─────────────────────────────────────────────────────
const _getCompressedThumb = async (url, opts) => {
    const stream = await getHttpStream(url, opts.fetchOpts)
    const result = await extractImageThumb(stream, opts.thumbnailWidth ?? THUMBNAIL_WIDTH_PX)
    return result.buffer
}

const _resolveThumbnail = async (image, opts) => {
    if (!image) return {}

    const cacheKey = `thumb:${image}`
    const cached = _thumbCache.get(cacheKey)
    if (cached) return cached

    let thumbs = {}

    if (opts.uploadImage) {
        try {
            const { imageMessage } = await prepareWAMessageMedia(
                { image: { url: image } },
                { upload: opts.uploadImage, mediaTypeOverride: 'thumbnail-link', options: opts.fetchOpts }
            )
            const jpegThumbnail = imageMessage?.jpegThumbnail
                ? Buffer.from(imageMessage.jpegThumbnail)
                : await _getCompressedThumb(image, opts).catch(() => undefined)
            thumbs = { jpegThumbnail, highQualityThumbnail: imageMessage ?? undefined }
        } catch (err) {
            opts.logger?.warn({ err: err.message, url: image }, 'HQ thumbnail failed, falling back to compressed')
            try {
                thumbs = { jpegThumbnail: await _getCompressedThumb(image, opts) }
            } catch (e) {
                opts.logger?.debug({ err: e.stack }, 'Compressed thumb also failed')
            }
        }
    } else {
        try {
            thumbs = { jpegThumbnail: await _getCompressedThumb(image, opts) }
        } catch (err) {
            opts.logger?.debug({ err: err.stack }, 'Compressed thumb failed')
        }
    }

    if (thumbs.jpegThumbnail) _thumbCache.set(cacheKey, thumbs)
    return thumbs
}

// ─── link-preview-js with UA rotation ────────────────────────────────────────
const _tryLinkPreview = async (url, opts, uaIndex = 0) => {
    if (uaIndex >= USER_AGENTS.length) return undefined
    try {
        let retries = 0
        const info = await getLinkPreview(url, {
            timeout: opts.fetchOpts?.timeout ?? PREVIEW_TIMEOUT,
            headers: {
                'user-agent': USER_AGENTS[uaIndex],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                ...(opts.fetchOpts?.headers ?? {}),
            },
            followRedirects: 'follow',
            handleRedirects: (baseURL, forwardedURL) => {
                if (retries >= 5) return false
                const base = new URL(baseURL)
                const fwd = new URL(forwardedURL)
                const sameHost =
                    fwd.hostname === base.hostname ||
                    fwd.hostname === `www.${base.hostname}` ||
                    `www.${fwd.hostname}` === base.hostname
                if (sameHost) { retries++; return true }
                return false
            },
            resolveDNSHost: _resolveDNSHost,
        })
        if (info?.title) return info
        return _tryLinkPreview(url, opts, uaIndex + 1)
    } catch (err) {
        if (err.message?.includes('SSRF') || err.message?.includes('private')) throw err
        return _tryLinkPreview(url, opts, uaIndex + 1)
    }
}

// ─── Raw fetch fallback (charset-aware OG parse) ──────────────────────────────
const _fetchFallback = async (url, opts, uaIndex = 0) => {
    if (uaIndex >= USER_AGENTS.length) return undefined
    try {
        const res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'user-agent': USER_AGENTS[uaIndex],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(opts.fetchOpts?.timeout ?? PREVIEW_TIMEOUT),
        })
        if (!res.ok) return _fetchFallback(url, opts, uaIndex + 1)

        const buf = await res.arrayBuffer()
        const ct = res.headers.get('content-type') ?? ''
        const headerCharset = ct.match(/charset=([^\s;]+)/i)?.[1]
        const sniff = new TextDecoder('latin1').decode(new Uint8Array(buf).slice(0, 2048))
        const metaCharset = sniff.match(/<meta[^>]+charset=["']?([^"'>\s]+)/i)?.[1]
        const html = new TextDecoder(headerCharset || metaCharset || 'utf-8').decode(buf)

        const og = p =>
            html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ||
            html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i'))?.[1]
        const meta = n =>
            html.match(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ||
            html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${n}["']`, 'i'))?.[1]

        const title = og('og:title') || meta('twitter:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
        if (!title) return _fetchFallback(url, opts, uaIndex + 1)

        return {
            url: res.url || url,
            title,
            description: og('og:description') || meta('description') || '',
            images: [og('og:image') || meta('twitter:image')].filter(Boolean),
            mediaType: og('og:type') || 'website',
        }
    } catch {
        return _fetchFallback(url, opts, uaIndex + 1)
    }
}

// ─── WhatsApp group invite — native socket metadata ───────────────────────────
const _fetchInviteMetadata = async (inviteCode, opts) => {
    try {
        const metadata = await opts.groupGetInviteInfo(inviteCode)
        const images = []
        if (opts.getProfilePicUrl && metadata.id) {
            try {
                const pfpUrl = await opts.getProfilePicUrl(metadata.id, 'image')
                if (pfpUrl) images.push(pfpUrl)
            } catch { /* profile pic is best-effort */ }
        }
        return {
            url: `https://chat.whatsapp.com/${inviteCode}`,
            title: metadata.subject || 'WhatsApp Group Invite',
            description: metadata.description || metadata.desc || '',
            images,
            mediaType: 'website',
        }
    } catch {
        return undefined
    }
}

// ─── Build final result object ────────────────────────────────────────────────
const _buildResult = async (info, text, opts) => {
    const [image] = info.images ?? []
    const thumbs = await _resolveThumbnail(image, opts)
    return {
        'canonical-url': info.url,
        'matched-text': text,
        title: info.title,
        description: info.description,
        originalThumbnailUrl: image,
        previewType: _getPreviewType(info.mediaType, image),
        ...thumbs,
    }
}

// ─── Main export ──────────────────────────────────────────────────────────────
export const getUrlInfo = (text, opts = {}) => {
    const previewLink = _normalizeUrl(text)

    // 1. Full preview cache hit → return immediately, no work needed
    const cached = _previewCache.get(previewLink)
    if (cached) return Promise.resolve(cached)

    // 2. Already in-flight for this URL → share the same promise
    const existing = _inflight.get(previewLink)
    if (existing) return existing

    // 3. New request — enqueue and register in-flight entry
    const resolvedOpts = {
        ...opts,
        fetchOpts: { timeout: PREVIEW_TIMEOUT, ...opts.fetchOpts },
        thumbnailWidth: opts.thumbnailWidth ?? THUMBNAIL_WIDTH_PX,
    }

    const promise = _enqueue(async () => {
        try {
            const inviteMatch = previewLink.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9-]+)/i)

            // Step 1: link-preview-js (handles most URLs including WA)
            let info = await _tryLinkPreview(previewLink, resolvedOpts)

            // Step 2: raw fetch + OG parse fallback
            if (!info?.title) {
                resolvedOpts.logger?.debug({ url: previewLink }, 'getLinkPreview failed, trying fetch fallback')
                info = await _fetchFallback(previewLink, resolvedOpts)
            }

            // Step 3: WA group invite — use native socket if title/image still missing
            if (inviteMatch && resolvedOpts.groupGetInviteInfo) {
                const needsNative = !info?.title || !(info?.images?.length)
                if (needsNative) {
                    const nativeInfo = await _fetchInviteMetadata(inviteMatch[1], resolvedOpts)
                    if (nativeInfo) {
                        info = {
                            ...nativeInfo,
                            title: info?.title || nativeInfo.title,
                            description: info?.description || nativeInfo.description,
                        }
                    }
                }
            }

            if (!info?.title) return undefined

            const result = await _buildResult(info, text, resolvedOpts)
            _previewCache.set(previewLink, result)
            return result
        } catch (err) {
            if (!err.message?.includes('receive a valid')) throw err
        }
    }).finally(() => {
        _inflight.delete(previewLink)
    })

    _inflight.set(previewLink, promise)
    return promise
}