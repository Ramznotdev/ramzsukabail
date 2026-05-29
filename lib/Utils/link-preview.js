import { lookup } from 'dns'
import { promisify } from 'util'
import { getLinkPreview } from 'link-preview-js'
import { LRUCache } from 'lru-cache'
import { prepareWAMessageMedia } from './messages.js'
import { extractImageThumb, getHttpStream } from './messages-media.js'

const dnsLookup = promisify(lookup)

const THUMBNAIL_WIDTH = 192
const TIMEOUT = 8_000
const MAX_CONCURRENT = 20
const MAX_INFLIGHT = 1000

const _previewCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 10 })
const _negCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 2 })
const _thumbCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 30 })
const _inflight = new Map()

const PROFILES = [
    {
        ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    },
    {
        ua: 'WhatsApp/2.2413.51 iOS/17.5.1 Device/Apple-iPhone_13',
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    },
    {
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
        },
    },
    {
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'upgrade-insecure-requests': '1',
        },
    },
    {
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    },
    {
        ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' },
    },
]

let _active = 0
const _queue = []

const _drain = () => {
    if (!_queue.length || _active >= MAX_CONCURRENT) return
    _active++
    const { fn, resolve, reject } = _queue.shift()
    fn().then(resolve).catch(reject).finally(() => { _active--; _drain() })
}

const _enqueue = fn => new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject }); _drain()
})

const _normalize = text => {
    const t = text.trim()
    return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

const _previewType = (mediaType, image) => {
    if (!mediaType) return image ? 5 : 0
    const mt = mediaType.toLowerCase()
    if (mt === 'video' || mt.startsWith('video.')) return 1
    return mt === 'image' || image ? 5 : 0
}

const _resolveDNS = async url => {
    try { return (await dnsLookup(new URL(url).hostname)).address }
    catch { return new URL(url).hostname }
}

const _compressedThumb = async (url, opts) => {
    const stream = await getHttpStream(url, opts.fetchOpts)
    return (await extractImageThumb(stream, opts.thumbnailWidth ?? THUMBNAIL_WIDTH)).buffer
}

const _resolveThumbnail = async (image, opts) => {
    if (!image) return {}
    const key = `thumb:${image}`
    const hit = _thumbCache.get(key)
    if (hit) return hit

    let thumbs = {}
    if (opts.uploadImage) {
        try {
            const { imageMessage } = await prepareWAMessageMedia(
                { image: { url: image } },
                { upload: opts.uploadImage, mediaTypeOverride: 'thumbnail-link', options: opts.fetchOpts }
            )
            const jpeg = imageMessage?.jpegThumbnail
                ? Buffer.from(imageMessage.jpegThumbnail)
                : await _compressedThumb(image, opts).catch(() => undefined)
            thumbs = { jpegThumbnail: jpeg, highQualityThumbnail: imageMessage ?? undefined }
        } catch {
            try { thumbs = { jpegThumbnail: await _compressedThumb(image, opts) } } catch { }
        }
    } else {
        try { thumbs = { jpegThumbnail: await _compressedThumb(image, opts) } } catch { }
    }

    if (thumbs.jpegThumbnail) _thumbCache.set(key, thumbs)
    return thumbs
}

const _tryLinkPreview = async (url, opts) => {
    try {
        return await Promise.any(PROFILES.map(({ ua, headers }, i) =>
            new Promise((resolve, reject) =>
                setTimeout(async () => {
                    try {
                        let hops = 0
                        const info = await getLinkPreview(url, {
                            timeout: opts.fetchOpts?.timeout ?? TIMEOUT,
                            headers: { 'user-agent': ua, ...headers, ...(opts.fetchOpts?.headers ?? {}) },
                            followRedirects: 'follow',
                            handleRedirects: (base, fwd) => {
                                if (hops >= 5) return false
                                const b = new URL(base), f = new URL(fwd)
                                const same = f.hostname === b.hostname
                                    || f.hostname === `www.${b.hostname}`
                                    || `www.${f.hostname}` === b.hostname
                                if (same) { hops++; return true }
                                return false
                            },
                            resolveDNSHost: _resolveDNS,
                        })
                        if (info?.title) resolve(info)
                        else reject(new Error('no title'))
                    } catch (err) {
                        reject(err)
                    }
                }, i * 200) // 200ms stagger between each profile
            )
        ))
    } catch {
        return undefined
    }
}

const _fetchFallback = async (url, opts) => {
    try {
        return await Promise.any(PROFILES.map(({ ua, headers }, i) =>
            new Promise((resolve, reject) =>
                setTimeout(async () => {
                    try {
                        const ctrl = new AbortController()
                        const timer = setTimeout(() => ctrl.abort(), opts.fetchOpts?.timeout ?? TIMEOUT)
                        const res = await fetch(url, {
                            method: 'GET', redirect: 'follow',
                            headers: { 'user-agent': ua, ...headers },
                            signal: ctrl.signal,
                        }).finally(() => clearTimeout(timer))

                        if (!res.ok) { reject(new Error('not ok')); return }

                        const buf = await res.arrayBuffer()
                        const ct = res.headers.get('content-type') ?? ''
                        const charset = ct.match(/charset=([^\s;]+)/i)?.[1]
                            ?? new TextDecoder('latin1').decode(new Uint8Array(buf).slice(0, 2048))
                                .match(/<meta[^>]+charset=["']?([^"'>\s]+)/i)?.[1]
                            ?? 'utf-8'
                        const html = new TextDecoder(charset).decode(buf)

                        const og = p => html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1]
                            || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${p}["']`, 'i'))?.[1]
                        const meta = n => html.match(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1]
                            || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${n}["']`, 'i'))?.[1]

                        const title = og('og:title') || meta('twitter:title')
                            || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()

                        if (!title) { reject(new Error('no title')); return }

                        resolve({
                            url: res.url || url, title,
                            description: og('og:description') || meta('description') || '',
                            images: [og('og:image') || meta('twitter:image')].filter(Boolean),
                            mediaType: og('og:type') || 'website',
                        })
                    } catch (err) {
                        reject(err)
                    }
                }, i * 200) // 200ms stagger between each profile
            )
        ))
    } catch {
        return undefined
    }
}

const _buildResult = async (info, text, opts) => {
    const [image] = info.images ?? []
    return {
        'canonical-url': info.url,
        'matched-text': text,
        title: info.title,
        description: info.description,
        originalThumbnailUrl: image,
        previewType: _previewType(info.mediaType, image),
        ...await _resolveThumbnail(image, opts),
    }
}

export const getUrlInfo = (text, opts = {}) => {
    const url = _normalize(text)

    if (_negCache.has(url)) return Promise.resolve(undefined)
    if (_previewCache.has(url)) return Promise.resolve(_previewCache.get(url))
    if (_inflight.has(url)) return _inflight.get(url)
    if (_inflight.size >= MAX_INFLIGHT) return Promise.resolve(undefined)

    const o = {
        fetchOpts: { timeout: TIMEOUT, ...opts.fetchOpts },
        thumbnailWidth: opts.thumbnailWidth ?? THUMBNAIL_WIDTH,
        uploadImage: opts.uploadImage,
        logger: opts.logger,
    }

    const promise = _enqueue(async () => {
        try {
            let info = await _tryLinkPreview(url, o)

            if (!info?.title) {
                o.logger?.debug({ url }, 'link-preview-js failed, trying fetch fallback')
                info = await _fetchFallback(url, o)
            }

            if (!info?.title) {
                _negCache.set(url, true)
                return undefined
            }

            const result = await _buildResult(info, text, o)
            _previewCache.set(url, result)
            return result
        } catch (err) {
            _negCache.set(url, true)
            if (!err.message?.includes('receive a valid')) throw err
            return undefined
        }
    }).finally(() => _inflight.delete(url))

    _inflight.set(url, promise)
    return promise
}