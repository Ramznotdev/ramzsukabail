import { getLinkPreview } from 'link-preview-js'
import mql from '@microlink/mql'
import { lookup } from 'dns'
import { promisify } from 'util'
import { LRUCache } from 'lru-cache'
import { prepareWAMessageMedia } from './messages.js'
import { extractImageThumb, getHttpStream } from './messages-media.js'

const dnsLookup = promisify(lookup)
const THUMBNAIL_WIDTH = 192
const TIMEOUT = 4_000
const MAX_CONCURRENT = 20
const MAX_INFLIGHT = 1000

const _previewCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 10 })
const _negCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 2 })
const _thumbCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 30 })
const _inflight = new Map()

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

const _resolveDNS = async url => {
    try { return (await dnsLookup(new URL(url).hostname)).address }
    catch { return new URL(url).hostname }
}

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
        const info = await getLinkPreview(url, {
            timeout: opts.fetchOpts?.timeout ?? TIMEOUT,
            followRedirects: 'follow',
            resolveDNSHost: _resolveDNS,
        })
        if (info?.title) return info
    } catch (err) {
        opts.logger?.warn({ err: err?.message || err, url }, 'getLinkPreview failed')
    }
    return undefined
}

const _tryMicrolink = async (url, opts) => {
    try {
        const { data } = await mql(url)
        if (!data?.title) return undefined
        return {
            url: data.url ?? url,
            title: data.title,
            description: data.description ?? '',
            images: [data.image?.url].filter(Boolean),
            mediaType: 'website',
        }
    } catch (err) {
        opts.logger?.warn({ err: err?.message || err, url }, 'microlink failed')
    }
    return undefined
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
            // Primary: link-preview-js
            let info = await _tryLinkPreview(url, o)

            // Fallback: microlink (if no result or no image)
            if (!info?.title || !(info.images ?? []).length) {
                o.logger?.debug({ url }, 'falling back to microlink')
                info = await _tryMicrolink(url, o) ?? info
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