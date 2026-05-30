import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { zip } from 'fflate'
import { proto } from '../../WAProto/index.js'
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js'
import { WAMessageStatus, WAProto } from '../Types/index.js'
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js'
import { sha256 } from './crypto.js'
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js'
import { downloadContentFromMessage, encryptedStream, prepareStream, generateThumbnail, getAudioDuration, getAudioWaveform, getStream, toBuffer, getImageProcessingLibrary } from './messages-media.js'
import { shouldIncludeReportingToken } from './reporting-utils.js'

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MIMETYPE_MAP = {
    image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus', sticker: 'image/webp', 'product-catalog-image': 'image/jpeg'
}

const MessageTypeProto = {
    image: WAProto.Message.ImageMessage, video: WAProto.Message.VideoMessage,
    audio: WAProto.Message.AudioMessage, sticker: WAProto.Message.StickerMessage,
    document: WAProto.Message.DocumentMessage
}

const HIGH_LEVEL_KEYS = [
    'text', 'image', 'video', 'audio', 'document', 'sticker', 'contacts', 'location',
    'react', 'delete', 'forward', 'disappearingMessagesInChat', 'groupInvite', 'stickerPack',
    'pin', 'buttonReply', 'ptv', 'product', 'listReply', 'event', 'poll', 'inviteAdmin',
    'requestPayment', 'sharePhoneNumber', 'requestPhoneNumber', 'limitSharing', 'viewOnce',
    'mentions', 'edit', 'buttons', 'templateButtons', 'sections', 'interactiveButtons',
    'album', 'call', 'paymentInvite', 'order', 'keep', 'shop', 'payment'
]

const REUPLOAD_REQUIRED_STATUS = [410, 404]

// ─── UTILITIES ────────────────────────────────────────────────────────────────
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0]

export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text)
    if (!getUrlInfo || !url) return
    try { return await getUrlInfo(url) }
    catch (e) { logger?.warn({ trace: e.stack }, 'url generation failed') }
}

const assertColor = (color) => {
    if (typeof color === 'number') return color > 0 ? color : 0xffffffff + Number(color) + 1
    const hex = color.trim().replace('#', '')
    return parseInt(hex.length <= 6 ? 'FF' + hex.padStart(6, '0') : hex, 16)
}

export const getContentType = (content) => {
    if (!content) return
    return Object.keys(content).find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage')
}

export const normalizeMessageContent = (content) => {
    if (!content) return
    for (let i = 0; i < 5; i++) {
        const inner = (
            content?.ephemeralMessage || content?.viewOnceMessage ||
            content?.documentWithCaptionMessage || content?.viewOnceMessageV2 ||
            content?.viewOnceMessageV2Extension || content?.editedMessage ||
            content?.groupMentionedMessage || content?.botInvokeMessage ||
            content?.lottieStickerMessage || content?.eventCoverImage ||
            content?.statusMentionMessage || content?.pollCreationOptionImageMessage ||
            content?.associatedChildMessage || content?.groupStatusMentionMessage ||
            content?.pollCreationMessageV4 || content?.pollCreationMessageV5 ||
            content?.statusAddYours || content?.groupStatusMessage ||
            content?.limitSharingMessage || content?.botTaskMessage ||
            content?.questionMessage || content?.botForwardedMessage
        )
        if (!inner) break
        content = inner.message
    }
    return content
}

export const extractMessageContent = (content) => {
    content = normalizeMessageContent(content)
    const extractFromButtons = (msg) => {
        if (msg.imageMessage) return { imageMessage: msg.imageMessage }
        if (msg.documentMessage) return { documentMessage: msg.documentMessage }
        if (msg.videoMessage) return { videoMessage: msg.videoMessage }
        if (msg.locationMessage) return { locationMessage: msg.locationMessage }
        if (msg.productMessage) return { productMessage: msg.productMessage }
        return { conversation: msg.contentText || msg.hydratedContentText || msg.body?.text || '' }
    }
    if (content?.buttonsMessage) return extractFromButtons(content.buttonsMessage)
    if (content?.interactiveMessage) return extractFromButtons(content.interactiveMessage)
    if (content?.templateMessage?.interactiveMessageTemplate) return extractFromButtons(content.templateMessage.interactiveMessageTemplate)
    if (content?.templateMessage?.hydratedFourRowTemplate) return extractFromButtons(content.templateMessage.hydratedFourRowTemplate)
    if (content?.templateMessage?.hydratedTemplate) return extractFromButtons(content.templateMessage.hydratedTemplate)
    if (content?.templateMessage?.fourRowTemplate) return extractFromButtons(content.templateMessage.fourRowTemplate)
    return content
}

// ─── MEDIA PREPARATION ────────────────────────────────────────────────────────
export const prepareWAMessageMedia = async (message, options) => {
    const mediaType = MEDIA_KEYS.find(k => k in message)
    if (!mediaType) throw new Boom('Invalid media type', { statusCode: 400 })

    const uploadData = { ...message, media: message[mediaType] }
    delete uploadData[mediaType]
    if (mediaType === 'document' && !uploadData.fileName) uploadData.fileName = 'file'
    if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_MAP[mediaType]

    const cacheableKey = typeof uploadData.media === 'object' && 'url' in uploadData.media && uploadData.media.url && options.mediaCache
        ? `${mediaType}:${uploadData.media.url.toString()}` : null

    if (cacheableKey) {
        const cached = await options.mediaCache?.get(cacheableKey)
        if (cached) {
            options.logger?.debug({ cacheableKey }, 'got media cache hit')
            const obj = WAProto.Message.decode(cached)
            Object.assign(obj[`${mediaType}Message`], { ...uploadData, media: undefined })
            return obj
        }
    }

    const isNewsletter = !!options.jid && isJidNewsletter(options.jid)
    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData.jpegThumbnail === 'undefined'
    const requiresWaveformProcessing = mediaType === 'audio' && (uploadData.ptt === true || !!options.backgroundColor)
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation || requiresWaveformProcessing

    const encryptionResult = await (isNewsletter ? prepareStream : encryptedStream)(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger: options.logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options,
        isPtt: uploadData.ptt,
        forceOpus: mediaType === 'audio' && uploadData.mimetype?.includes('opus'),
        convertVideo: mediaType === 'video'
    })

    const { mediaKey, encWriteStream, bodyPath, fileEncSha256, fileSha256, fileLength, didSaveToTmpPath, opusConverted, encFilePath, encBuffer, cleanup } = encryptionResult
    if (mediaType === 'audio' && opusConverted) uploadData.mimetype = 'audio/ogg; codecs=opus'

    const fileEncSha256B64 = (isNewsletter ? fileSha256 : (fileEncSha256 ?? fileSha256)).toString('base64')
    const uploadSource = isNewsletter ? encWriteStream : (encFilePath || encBuffer || encWriteStream)

    const [{ mediaUrl, directPath, handle }] = await Promise.all([
        (async () => {
            const result = await options.upload(uploadSource, { fileEncSha256B64, mediaType, timeoutMs: options.mediaUploadTimeoutMs })
            options.logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
            return result
        })(),
        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(bodyPath, mediaType, options)
                    uploadData.jpegThumbnail = thumbnail
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width
                        uploadData.height = originalImageDimensions.height
                    }
                }
                if (requiresDurationComputation) uploadData.seconds = await getAudioDuration(bodyPath)
                if (requiresWaveformProcessing) {
                    try { uploadData.waveform = await getAudioWaveform(bodyPath, options.logger) }
                    catch {
                        options.logger?.warn('failed to generate waveform, using fallback')
                        uploadData.waveform = new Uint8Array([0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99, 0, 99, 0, 99, 0, 99, 0, 99, 88, 99, 0, 99, 0, 55, 0, 99])
                    }
                }
                if (options.backgroundColor && mediaType === 'audio') uploadData.backgroundArgb = assertColor(options.backgroundColor)
            } catch (e) { options.logger?.warn({ trace: e.stack }, 'failed to obtain extra info') }
        })()
    ]).finally(async () => {
        if (encWriteStream && !Buffer.isBuffer(encWriteStream)) encWriteStream.destroy?.()
        if (cleanup) await cleanup()
    })

    const obj = WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: handle ? undefined : mediaUrl, directPath, mediaKey, fileEncSha256, fileSha256, fileLength,
            mediaKeyTimestamp: handle ? undefined : unixTimestampSeconds(), ...uploadData, media: undefined
        })
    })
    if (uploadData.ptv) { obj.ptvMessage = obj.videoMessage; delete obj.videoMessage }
    if (cacheableKey) {
        options.logger?.debug({ cacheableKey }, 'set cache')
        await options.mediaCache?.set(cacheableKey, WAProto.Message.encode(obj).finish())
    }
    return obj
}

export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => WAProto.Message.fromObject({
    ephemeralMessage: { message: { protocolMessage: { type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING, ephemeralExpiration: ephemeralExpiration || 0 } } }
})

export const generateForwardMessageContent = (message, forceForward) => {
    let content = normalizeMessageContent(message.message)
    if (!content) throw new Boom('no content in message', { statusCode: 400 })
    content = proto.Message.decode(proto.Message.encode(content).finish())
    let key = Object.keys(content)[0]
    let score = (content?.[key]?.contextInfo?.forwardingScore || 0) + (message.key.fromMe && !forceForward ? 0 : 1)
    if (key === 'conversation') { content.extendedTextMessage = { text: content[key] }; delete content.conversation; key = 'extendedTextMessage' }
    content[key].contextInfo = score > 0 ? { forwardingScore: score, isForwarded: true } : {}
    return content
}

// ─── MESSAGE HANDLERS ─────────────────────────────────────────────────────────
const handleTextMessage = async (message, options) => {
    const extContent = { text: message.text }
    let urlInfo = message.linkPreview
    if (typeof urlInfo === 'undefined') urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger)
    if (urlInfo) {
        Object.assign(extContent, { matchedText: urlInfo['matched-text'], jpegThumbnail: urlInfo.jpegThumbnail, description: urlInfo.description, title: urlInfo.title, previewType: urlInfo.previewType ?? 0 })
        const img = urlInfo.highQualityThumbnail
        if (img) Object.assign(extContent, { thumbnailDirectPath: img.directPath, mediaKey: img.mediaKey, mediaKeyTimestamp: img.mediaKeyTimestamp, thumbnailWidth: img.width, thumbnailHeight: img.height, thumbnailSha256: img.fileSha256, thumbnailEncSha256: img.fileEncSha256 })
    }
    if (options.backgroundColor) extContent.backgroundArgb = assertColor(options.backgroundColor)
    if (options.font) extContent.font = options.font
    return { extendedTextMessage: extContent }
}

const handleSpecialMessages = async (message, options) => {
    if ('contacts' in message) {
        const { contacts } = message.contacts
        if (!contacts.length) throw new Boom('require atleast 1 contact', { statusCode: 400 })
        return contacts.length === 1 ? { contactMessage: WAProto.Message.ContactMessage.create(contacts[0]) } : { contactsArrayMessage: WAProto.Message.ContactsArrayMessage.create(message.contacts) }
    }
    if ('location' in message) return { locationMessage: WAProto.Message.LocationMessage.create(message.location) }
    if ('react' in message) { if (!message.react.senderTimestampMs) message.react.senderTimestampMs = Date.now(); return { reactionMessage: WAProto.Message.ReactionMessage.create(message.react) } }
    if ('delete' in message) return { protocolMessage: { key: message.delete, type: WAProto.Message.ProtocolMessage.Type.REVOKE } }
    if ('forward' in message) return generateForwardMessageContent(message.forward, message.force)
    if ('disappearingMessagesInChat' in message) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean' ? (message.disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) : message.disappearingMessagesInChat
        return prepareDisappearingMessageSettingContent(exp)
    }
    return null
}

const handleGroupInvite = async (message, options) => {
    const m = { groupInviteMessage: { inviteCode: message.groupInvite.inviteCode, inviteExpiration: message.groupInvite.inviteExpiration, caption: message.groupInvite.text, groupJid: message.groupInvite.jid, groupName: message.groupInvite.subject } }
    if (options.getProfilePicUrl) {
        const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview')
        if (pfpUrl) {
            const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher })
            if (resp.ok) m.groupInviteMessage.jpegThumbnail = Buffer.from(await resp.arrayBuffer())
        }
    }
    return m
}

const handleEventMessage = async (message, options) => {
    const startTime = Math.floor(message.event.startDate.getTime() / 1000)
    const m = {
        eventMessage: {
            name: message.event.name, description: message.event.description, startTime,
            endTime: message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined,
            isCanceled: message.event.isCancelled ?? false, extraGuestsAllowed: message.event.extraGuestsAllowed,
            isScheduleCall: message.event.isScheduleCall ?? false, location: message.event.location
        },
        messageContextInfo: { messageSecret: message.event.messageSecret || randomBytes(32) }
    }
    if (message.event.call && options.getCallLink) {
        const token = await options.getCallLink(message.event.call, { startTime })
        m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token
    }
    return m
}

const handlePollMessage = (message) => {
    message.poll.selectableCount ||= 0
    message.poll.toAnnouncementGroup ||= false
    if (!Array.isArray(message.poll.values)) throw new Boom('Invalid poll values', { statusCode: 400 })
    if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length)
        throw new Boom(`poll.selectableCount should be >= 0 and <= ${message.poll.values.length}`, { statusCode: 400 })
    const pollMsg = { name: message.poll.name, selectableOptionsCount: message.poll.selectableCount, options: message.poll.values.map(optionName => ({ optionName })) }
    const m = { messageContextInfo: { messageSecret: message.poll.messageSecret || randomBytes(32) } }
    if (message.poll.toAnnouncementGroup) m.pollCreationMessageV2 = pollMsg
    else if (message.poll.selectableCount === 1) m.pollCreationMessageV3 = pollMsg
    else m.pollCreationMessage = pollMsg
    return m
}

const handleProductMessage = async (message, options) => {
    const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options)
    return { productMessage: WAProto.Message.ProductMessage.create({ ...message, product: { ...message.product, productImage: imageMessage } }) }
}

const handleRequestPayment = async (message, options) => {
    const data = message.requestPayment || message.payment
    const sticker = data.sticker ? await prepareWAMessageMedia({ sticker: data.sticker }, options) : null
    let notes
    if (sticker) notes = { stickerMessage: { ...sticker.stickerMessage, contextInfo: data.contextInfo } }
    else if (data.note) notes = { extendedTextMessage: { text: data.note, contextInfo: data.contextInfo } }
    else notes = { extendedTextMessage: { text: data.note || 'Notes' } }
    const m = {
        requestPaymentMessage: WAProto.Message.RequestPaymentMessage.fromObject({
            expiryTimestamp: data.expiryTimestamp || data.expiry || 0,
            amount1000: data.amount1000 || data.amount || 0,
            currencyCodeIso4217: data.currencyCodeIso4217 || data.currency || 'IDR',
            requestFrom: data.requestFrom || data.from || '0@s.whatsapp.net',
            noteMessage: notes,
            background: data.background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 }
        })
    }
    if ((data.currencyCodeIso4217 === 'BRL' || data.currency === 'BRL') && data.pixKey) {
        if (!m.requestPaymentMessage.noteMessage.extendedTextMessage) m.requestPaymentMessage.noteMessage = { extendedTextMessage: { text: '' } }
        m.requestPaymentMessage.noteMessage.extendedTextMessage.text += `\nPix Key: ${data.pixKey}`
    }
    return m
}

const handleButtonReply = (message) => {
    switch (message.type) {
        case 'list': return { listResponseMessage: { title: message.buttonReply.title, description: message.buttonReply.description, singleSelectReply: { selectedRowId: message.buttonReply.rowId }, lisType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT } }
        case 'template': return { templateButtonReplyMessage: { selectedDisplayText: message.buttonReply.displayText, selectedId: message.buttonReply.id, selectedIndex: message.buttonReply.index } }
        case 'interactive': return { interactiveResponseMessage: { body: { text: message.buttonReply.displayText, format: proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1 }, nativeFlowResponseMessage: { name: message.buttonReply.nativeFlows?.name, paramsJson: message.buttonReply.nativeFlows?.paramsJson, version: message.buttonReply.nativeFlows?.version } } }
        default: return { buttonsResponseMessage: { selectedButtonId: message.buttonReply.id, selectedDisplayText: message.buttonReply.displayText, type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT } }
    }
}

// ─── MAIN GENERATOR ───────────────────────────────────────────────────────────
export const generateWAMessageContent = async (message, options = {}) => {
    const messageKeys = Object.keys(message)
    const isRawProtoMessage = messageKeys.some(k => k.endsWith('Message') && typeof message[k] === 'object' && !HIGH_LEVEL_KEYS.includes(k))
    const isWrapperMessage = ['viewOnceMessage', 'ephemeralMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'].some(k => k in message)
    if ((isRawProtoMessage || isWrapperMessage) && messageKeys.length === 1) return WAProto.Message.create(message)
    if (!messageKeys.some(k => HIGH_LEVEL_KEYS.includes(k)) && isRawProtoMessage) return WAProto.Message.create(message)

    let m = {}

    if ('text' in message && !('buttons' in message) && !('templateButtons' in message) && !('sections' in message) && !('interactiveButtons' in message) && !('shop' in message)) {
        m = await handleTextMessage(message, options)
    } else {
        const special = await handleSpecialMessages(message, options)
        if (special) {
            m = special
        } else if ('groupInvite' in message) {
            m = await handleGroupInvite(message, options)
        } else if ('stickerPack' in message) {
            return WAProto.Message.create({ stickerPackMessage: (await prepareStickerPackMessage(message.stickerPack, options)).stickerPackMessage })
        } else if ('pin' in message) {
            const messageKey = typeof message.pin === 'boolean'
                ? (options.quoted?.key || (() => { throw new Boom('No quoted message key found for pin operation') })())
                : typeof message.pin === 'object'
                    ? (message.pin.key || (message.pin.id ? { remoteJid: options.jid, fromMe: message.pin.fromMe || false, id: message.pin.id, participant: message.pin.participant } : null))
                    : message.pin
            const shouldPin = typeof message.pin === 'boolean' ? message.pin : (message.pin?.unpin !== true)
            const pinTime = typeof message.pin === 'object' ? message.pin.time : message.time
            if (!messageKey?.id) throw new Boom('Invalid message key for pin operation')
            m = { pinInChatMessage: { key: messageKey, type: shouldPin ? 1 : 2, senderTimestampMs: Date.now().toString() }, messageContextInfo: { messageAddOnDurationInSecs: shouldPin ? (pinTime || 86400) : 0 } }
        } else if ('keep' in message) {
            m = { keepInChatMessage: { key: message.keep, keepType: message.type, timestampMs: Date.now() } }
        } else if ('call' in message) {
            m = { scheduledCallCreationMessage: { scheduledTimestampMs: message.call.time || Date.now(), callType: message.call.type || 1, title: message.call.title } }
        } else if ('paymentInvite' in message) {
            m = { paymentInviteMessage: { serviceType: message.paymentInvite.type, expiryTimestamp: message.paymentInvite.expiry } }
        } else if ('buttonReply' in message) {
            m = handleButtonReply(message)
        } else if ('ptv' in message && message.ptv) {
            const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options)
            m = { ptvMessage: videoMessage }
        } else if ('product' in message) {
            m = await handleProductMessage(message, options)
        } else if ('order' in message) {
            m = { orderMessage: WAProto.Message.OrderMessage.fromObject({ orderId: message.order.id, thumbnail: message.order.thumbnail, itemCount: message.order.itemCount, status: message.order.status, surface: message.order.surface, orderTitle: message.order.title, message: message.order.text, sellerJid: message.order.seller, token: message.order.token, totalAmount1000: message.order.amount, totalCurrencyCode: message.order.currency }) }
        } else if ('sections' in message) {
            m = { listMessage: { title: message.title, buttonText: message.buttonText, footerText: message.footer, description: message.text, sections: message.sections, listType: proto.Message.ListMessage.ListType.SINGLE_SELECT, contextInfo: { ...(message.contextInfo || {}), ...(message.mentions ? { mentionedJid: message.mentions } : {}) } } }
        } else if ('listReply' in message) {
            m = { listResponseMessage: { ...message.listReply } }
        } else if ('event' in message) {
            m = await handleEventMessage(message, options)
        } else if ('poll' in message) {
            m = handlePollMessage(message)
        } else if ('inviteAdmin' in message) {
            m = { newsletterAdminInviteMessage: { inviteExpiration: message.inviteAdmin.inviteExpiration, caption: message.inviteAdmin.text, newsletterJid: message.inviteAdmin.jid, newsletterName: message.inviteAdmin.subject, jpegThumbnail: message.inviteAdmin.thumbnail } }
        } else if ('requestPayment' in message || 'payment' in message) {
            m = await handleRequestPayment(message, options)
        } else if ('extendedTextMessage' in message) {
            m = { extendedTextMessage: WAProto.Message.ExtendedTextMessage.create(message.extendedTextMessage) }
        } else if ('interactiveMessage' in message) {
            m = { interactiveMessage: WAProto.Message.InteractiveMessage.create(message.interactiveMessage) }
        } else if ('sharePhoneNumber' in message) {
            m = { protocolMessage: { type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER } }
        } else if ('requestPhoneNumber' in message) {
            m = { requestPhoneNumberMessage: {} }
        } else if ('limitSharing' in message) {
            m = { protocolMessage: { type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING, limitSharing: { sharingLimited: message.limitSharing === true, trigger: 1, limitSharingSettingTimestamp: Date.now(), initiatedByMe: true } } }
        } else if ('album' in message) {
            const imageItems = message.album.filter(i => 'image' in i)
            const videoItems = message.album.filter(i => 'video' in i)
            m = { albumMessage: { expectedImageCount: imageItems.length, expectedVideoCount: videoItems.length } }
        } else if (MEDIA_KEYS.some(k => k in message)) {
            m = await prepareWAMessageMedia(message, options)
        }
    }

    // ─── BUTTONS ──────────────────────────────────────────────────────────────
    if ('buttons' in message && Array.isArray(message.buttons) && message.buttons.length > 0) {
        const hasNativeFlow = message.buttons.some(b => b.nativeFlowInfo || b.name || b.buttonParamsJson)
        if (hasNativeFlow) {
            const interactive = {
                body: { text: message.text || message.caption || message.contentText || '' },
                footer: { text: message.footer || message.footerText || '' },
                nativeFlowMessage: { buttons: message.buttons.map(btn => { if (btn.name && btn.buttonParamsJson) return btn; if (btn.nativeFlowInfo) return { name: btn.nativeFlowInfo.name, buttonParamsJson: btn.nativeFlowInfo.paramsJson }; return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.buttonText?.displayText || btn.displayText || '', id: btn.buttonId || btn.id || '' }) } }) }
            }
            if (message.title) interactive.header = { title: message.title, subtitle: message.subtitle || '', hasMediaAttachment: message.hasMediaAttachment || false }
            if (Object.keys(m).length > 0) { interactive.header = interactive.header || { title: message.title || '', hasMediaAttachment: true }; Object.assign(interactive.header, m) }
            m = { interactiveMessage: interactive }
        } else {
            const buttonsMessage = { buttons: message.buttons.map(b => ({ ...b, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE })) }
            if ('text' in message) { buttonsMessage.contentText = message.text; buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.EMPTY }
            else { if ('caption' in message) buttonsMessage.contentText = message.caption; const type = Object.keys(m)[0]?.replace('Message', '').toUpperCase(); buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType[type] || proto.Message.ButtonsMessage.HeaderType.EMPTY; Object.assign(buttonsMessage, m) }
            if (message.title) { buttonsMessage.text = message.title; buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.TEXT }
            if (message.footer) buttonsMessage.footerText = message.footer
            m = { buttonsMessage }
        }
    } else if ('templateButtons' in message && message.templateButtons) {
        const hydratedTemplate = { hydratedButtons: message.templateButtons }
        if ('text' in message) hydratedTemplate.hydratedContentText = message.text
        else { if ('caption' in message) hydratedTemplate.hydratedContentText = message.caption; Object.assign(hydratedTemplate, m) }
        if (message.footer) hydratedTemplate.hydratedFooterText = message.footer
        m = { templateMessage: { fourRowTemplate: hydratedTemplate, hydratedTemplate } }
    } else if ('interactiveButtons' in message && message.interactiveButtons) {
        const interactive = { nativeFlowMessage: WAProto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: message.interactiveButtons }) }
        if ('text' in message) { interactive.body = { text: message.text }; interactive.header = { title: message.title || '', subtitle: message.subtitle || '', hasMediaAttachment: false } }
        else if ('caption' in message) { interactive.body = { text: message.caption }; interactive.header = { title: message.title || '', subtitle: message.subtitle || '', hasMediaAttachment: message.hasMediaAttachment ?? (Object.keys(m).length > 0) }; if (Object.keys(m).length > 0) Object.assign(interactive.header, m) }
        if (message.footer) interactive.footer = { text: message.footer }
        m = { interactiveMessage: interactive, messageContextInfo: { messageSecret: randomBytes(32) } }
    } else if ('shop' in message && message.shop) {
        const interactive = { shopStorefrontMessage: WAProto.Message.InteractiveMessage.ShopMessage.fromObject({ surface: message.shop.surface || 1, id: message.shop.id || message.id }) }
        if ('text' in message) interactive.body = { text: message.text }
        else if ('caption' in message) interactive.body = { text: message.caption }
        if (message.title || Object.keys(m).length > 0) { interactive.header = { title: message.title || '', subtitle: message.subtitle || '', hasMediaAttachment: message.hasMediaAttachment ?? (Object.keys(m).length > 0) }; if (Object.keys(m).length > 0) Object.assign(interactive.header, m) }
        if (message.footer) interactive.footer = { text: message.footer }
        m = { interactiveMessage: interactive }
    } else if ('collection' in message && message.collection) {
        const interactive = { collectionMessage: { bizJid: message.collection.bizJid, id: message.collection.id, messageVersion: message.collection.version } }
        if ('text' in message) { interactive.body = { text: message.text }; interactive.header = { title: message.title || '', hasMediaAttachment: false } }
        else if ('caption' in message) { interactive.body = { text: message.caption }; interactive.header = { title: message.title || '', hasMediaAttachment: message.hasMediaAttachment ?? false }; if (Object.keys(m).length > 0) Object.assign(interactive.header, m) }
        if (message.footer) interactive.footer = { text: message.footer }
        m = { interactiveMessage: interactive }
    }

    // ─── AUTO CONTEXT + MENTIONS ──────────────────────────────────────────────
    const finalKey = Object.keys(m)[0]
    if ((message.contextInfo || message.mentions?.length) && finalKey && m[finalKey] && typeof m[finalKey] === 'object') {
        m[finalKey].contextInfo = { ...(m[finalKey].contextInfo || {}), ...(message.contextInfo || {}), ...(message.mentions?.length ? { mentionedJid: message.mentions } : {}) }
    }

    // ─── WRAPPERS ─────────────────────────────────────────────────────────────
    if (('viewOnce' in message && message.viewOnce) || ('viewOnceMessage' in message && message.viewOnceMessage)) m = { viewOnceMessage: { message: m } }
    if ('edit' in message) m = { protocolMessage: { key: message.edit, editedMessage: m, timestampMs: Date.now(), type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT } }
    if ('contextInfo' in message && message.contextInfo) { const k = Object.keys(m)[0]; if (k && m[k]) m[k].contextInfo = { ...(m[k].contextInfo || {}), ...message.contextInfo } }

    if (shouldIncludeReportingToken(m)) {
        m.messageContextInfo = m.messageContextInfo || {}
        if (!m.messageContextInfo.messageSecret) m.messageContextInfo.messageSecret = randomBytes(32)
    }

    return WAProto.Message.create(m)
}

// ─── STICKER PACK ─────────────────────────────────────────────────────────────
export const prepareStickerPackMessage = async (stickerPack, options) => {
    const { stickers, cover, name, publisher, packId, description } = stickerPack
    if (!stickers?.length) throw new Boom('Sticker pack requires at least one sticker', { statusCode: 400 })
    if (stickers.length > 120) throw new Boom('Sticker pack exceeds maximum of 120 stickers', { statusCode: 400 })

    const lib = await getImageProcessingLibrary()
    const packId_ = packId || generateMessageIDV2()

    const isWebPBuffer = (buf) => buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    const isAnimatedWebP = (buf) => {
        if (!isWebPBuffer(buf)) return false
        let offset = 12
        while (offset < buf.length - 8) {
            const fourCC = buf.toString('ascii', offset, offset + 4)
            const chunkSize = buf.readUInt32LE(offset + 4)
            if (fourCC === 'VP8X' && offset + 8 < buf.length && (buf[offset + 8] & 0x02)) return true
            if (fourCC === 'ANIM' || fourCC === 'ANMF') return true
            offset += 8 + chunkSize + (chunkSize % 2)
        }
        return false
    }
    const toWebp = async (buffer) => {
        if ('sharp' in lib && lib.sharp) return await lib.sharp.default(buffer).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75, effort: 6 }).toBuffer()
        if ('jimp' in lib && lib.jimp) return await lib.jimp.Jimp.read(buffer).then(img => img.getBuffer('image/webp'))
        throw new Boom('No image processing library available', { statusCode: 500 })
    }

    const validStickers = []
    await Promise.all(stickers.map(async (s) => {
        try {
            const { stream } = await getStream(s.data || s.sticker)
            const buffer = await toBuffer(stream)
            if (!buffer?.length) return
            const animated = isAnimatedWebP(buffer)
            let webpBuffer = isWebPBuffer(buffer) ? buffer : await toWebp(buffer)
            if (webpBuffer.length > 1024 * 1024) {
                if ('sharp' in lib && lib.sharp) webpBuffer = await lib.sharp.default(webpBuffer).webp({ quality: 50 }).toBuffer()
                if (webpBuffer.length > 1024 * 1024) return
            }
            const hash = sha256(webpBuffer).toString('base64').replace(/\//g, '-').replace(/=/g, '')
            validStickers.push({ fileName: `${hash}.webp`, buffer: webpBuffer, mimetype: 'image/webp', isAnimated: s.isAnimated ?? animated, isLottie: s.isLottie || false, emojis: s.emojis || [], accessibilityLabel: s.accessibilityLabel || '' })
        } catch (e) { options.logger?.warn({ err: e }, 'failed processing sticker') }
    }))

    if (!validStickers.length) throw new Boom('No valid stickers could be processed', { statusCode: 400 })

    const { stream: covStream } = await getStream(cover)
    const coverBuffer = await toWebp(await toBuffer(covStream))

    const processBatch = async (batch, batchIdx) => {
        const batchData = {}
        batch.forEach(s => { batchData[s.fileName] = [new Uint8Array(s.buffer), { level: 6 }] })
        const trayFile = `${packId_}_${batchIdx}.webp`
        batchData[trayFile] = [new Uint8Array(coverBuffer), { level: 6 }]
        const zipBuf = await new Promise((resolve, reject) => zip(batchData, { level: 6, memLevel: 9 }, (err, data) => err ? reject(err) : resolve(Buffer.from(data))))
        if (zipBuf.length > 10 * 1024 * 1024) throw new Boom(`Sticker pack batch ${batchIdx} too large`, { statusCode: 400 })
        const upload = await encryptedStream(zipBuf, 'sticker-pack', { logger: options.logger, opts: options.options })
        const uploadRes = await options.upload(upload.encFilePath || upload.encBuffer, { fileEncSha256B64: upload.fileEncSha256.toString('base64'), mediaType: 'sticker-pack', timeoutMs: options.mediaUploadTimeoutMs || 300000 })
        await upload.cleanup?.()

        let thumbRes = null
        try {
            let thumbBuf
            if ('sharp' in lib && lib.sharp) thumbBuf = await lib.sharp.default(coverBuffer).resize(252, 252, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer()
            else if ('jimp' in lib && lib.jimp) thumbBuf = await lib.jimp.Jimp.read(coverBuffer).then(img => img.resize({ w: 252, h: 252 }).getBuffer('image/jpeg'))
            if (thumbBuf?.length) {
                const thumbUpload = await encryptedStream(thumbBuf, 'thumbnail-sticker-pack', { logger: options.logger, opts: options.options, mediaKey: upload.mediaKey })
                thumbRes = await options.upload(thumbUpload.encFilePath || thumbUpload.encBuffer, { fileEncSha256B64: thumbUpload.fileEncSha256.toString('base64'), mediaType: 'thumbnail-sticker-pack', timeoutMs: options.mediaUploadTimeoutMs || 60000 })
                await thumbUpload.cleanup?.()
                thumbRes._buf = thumbBuf; thumbRes._enc = thumbUpload
            }
        } catch (e) { options.logger?.warn({ err: e }, 'failed generating sticker pack thumbnail') }

        return {
            name: batchIdx > 0 ? `${name} (${batchIdx + 1})` : name, publisher, packDescription: description,
            stickerPackId: batchIdx > 0 ? `${packId_}_${batchIdx}` : packId_,
            stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.THIRD_PARTY,
            stickerPackSize: zipBuf.length,
            stickers: batch.map(s => ({ fileName: s.fileName, mimetype: s.mimetype, isAnimated: s.isAnimated, isLottie: s.isLottie, emojis: s.emojis, accessibilityLabel: s.accessibilityLabel })),
            fileSha256: upload.fileSha256, fileEncSha256: upload.fileEncSha256, mediaKey: upload.mediaKey,
            directPath: uploadRes.directPath, fileLength: upload.fileLength, mediaKeyTimestamp: unixTimestampSeconds(), trayIconFileName: trayFile,
            ...(thumbRes && { thumbnailDirectPath: thumbRes.directPath, thumbnailHeight: 252, thumbnailWidth: 252, thumbnailSha256: thumbRes._enc?.fileSha256, thumbnailEncSha256: thumbRes._enc?.fileEncSha256, imageDataHash: thumbRes._buf ? sha256(thumbRes._buf).toString('base64') : undefined })
        }
    }

    if (validStickers.length > 60) {
        const batches = []
        for (let i = 0; i < validStickers.length; i += 60) batches.push(validStickers.slice(i, i + 60))
        const results = await Promise.all(batches.map((b, i) => processBatch(b, i)))
        return { stickerPackMessage: results, isBatched: true, batchCount: batches.length }
    }
    return { stickerPackMessage: await processBatch(validStickers, 0), isBatched: false }
}

// ─── MESSAGE BUILDERS ─────────────────────────────────────────────────────────
export const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) options.timestamp = new Date()
    const innerMessage = normalizeMessageContent(message)
    const key = getContentType(innerMessage)
    const { quoted, userJid } = options

    if (quoted && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe ? userJid : (quoted.participant || quoted.key.participant || quoted.key.remoteJid)
        const normalizedQuoted = normalizeMessageContent(quoted.message)
        const quotedType = getContentType(normalizedQuoted)
        const quotedMsg = proto.Message.fromObject({ [quotedType]: normalizedQuoted[quotedType] })
        const quotedContent = quotedMsg[quotedType]
        if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) delete quotedContent.contextInfo
        const contextInfo = (innerMessage[key]?.contextInfo) || {}
        contextInfo.participant = jidNormalizedUser(participant)
        contextInfo.stanzaId = quoted.key.id
        contextInfo.quotedMessage = quotedMsg
        if (jid !== quoted.key.remoteJid) contextInfo.remoteJid = quoted.key.remoteJid
        if (innerMessage[key]) innerMessage[key].contextInfo = contextInfo
    }

    if (options?.ephemeralExpiration && key !== 'protocolMessage' && key !== 'ephemeralMessage' && !isJidNewsletter(jid)) {
        innerMessage[key].contextInfo = { ...(innerMessage[key].contextInfo || {}), expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL }
    }

    return WAProto.WebMessageInfo.fromObject({
        key: { remoteJid: jid, fromMe: true, id: options?.messageId || generateMessageIDV2() },
        message: WAProto.Message.fromObject(message),
        messageTimestamp: unixTimestampSeconds(options.timestamp),
        messageStubParameters: [],
        participant: (isJidGroup(jid) || isJidStatusBroadcast(jid)) ? userJid : undefined,
        status: WAMessageStatus.PENDING
    })
}

export const generateWAMessage = async (jid, content, options = {}) => {
    options.logger = options?.logger?.child({ msgId: options.messageId })
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid }), options)
}

// ─── RECEIPTS / REACTIONS / POLLS ─────────────────────────────────────────────
export const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt ||= []
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
    if (recp) Object.assign(recp, receipt)
    else msg.userReceipt.push(receipt)
}

export const updateMessageWithReaction = (msg, reaction) => {
    const authorID = getKeyAuthor(reaction.key)
    msg.reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID)
    reaction.text ||= ''
    msg.reactions.push(reaction)
}

export const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = getKeyAuthor(update.pollUpdateMessageKey)
    msg.pollUpdates = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID)
    if (update.vote?.selectedOptions?.length) msg.pollUpdates.push(update)
}

export const updateMessageWithEventResponse = (msg, update) => {
    const authorID = getKeyAuthor(update.eventResponseMessageKey)
    msg.eventResponses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID)
    msg.eventResponses.push(update)
}

export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    const opts = message?.pollCreationMessage?.options || message?.pollCreationMessageV2?.options || message?.pollCreationMessageV3?.options || []
    const voteHashMap = opts.reduce((acc, opt) => { acc[sha256(Buffer.from(opt.optionName || '')).toString()] = { name: opt.optionName || '', voters: [] }; return acc }, {})
    for (const update of pollUpdates || []) {
        if (!update.vote) continue
        for (const option of update.vote.selectedOptions || []) {
            const hash = option.toString()
            voteHashMap[hash] ||= { name: 'Unknown', voters: [] }
            voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId))
        }
    }
    return Object.values(voteHashMap)
}

export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
    const responseMap = { GOING: { response: 'GOING', responders: [] }, NOT_GOING: { response: 'NOT_GOING', responders: [] }, MAYBE: { response: 'MAYBE', responders: [] } }
    for (const update of eventResponses || []) {
        const type = update.eventResponse || 'UNKNOWN'
        if (responseMap[type]) responseMap[type].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId))
    }
    return Object.values(responseMap)
}

export const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {}
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) { const uqKey = `${remoteJid}:${participant || ''}`; keyMap[uqKey] ||= { jid: remoteJid, participant, messageIds: [] }; keyMap[uqKey].messageIds.push(id) }
    }
    return Object.values(keyMap)
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
export const downloadMediaMessage = async (message, type, options, ctx) => {
    const downloadMsg = async () => {
        let normalized = message
        if (!message.message && message.key) normalized = { key: message.key, message: message.quoted?.message || message, messageTimestamp: message.messageTimestamp }
        const mContent = extractMessageContent(normalized.message)
        if (!mContent) throw new Boom('No message present', { statusCode: 400, data: message })
        const contentType = getContentType(mContent)
        let mediaType = contentType?.replace('Message', '')
        const media = mContent[contentType]
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) throw new Boom(`"${contentType}" message is not a media message`)
        const download = ('thumbnailDirectPath' in media && !('url' in media)) ? { directPath: media.thumbnailDirectPath, mediaKey: media.mediaKey } : media
        if ('thumbnailDirectPath' in media && !('url' in media)) mediaType = 'thumbnail-link'
        const stream = await downloadContentFromMessage(download, mediaType, options)
        if (type === 'buffer') { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) }
        return stream
    }
    return downloadMsg().catch(async (error) => {
        if (ctx && typeof error?.status === 'number' && REUPLOAD_REQUIRED_STATUS.includes(error.status)) {
            ctx.logger.info({ key: message.key }, 'sending reupload media request...')
            message = await ctx.reuploadRequest(message)
            return downloadMsg()
        }
        throw error
    })
}

export const assertMediaContent = (content) => {
    content = extractMessageContent(content)
    const mediaContent = content?.documentMessage || content?.imageMessage || content?.videoMessage || content?.audioMessage || content?.stickerMessage
    if (!mediaContent) throw new Boom('given message is not a media message', { statusCode: 400, data: content })
    return mediaContent
}

// ─── DEVICE / MD UTILS ────────────────────────────────────────────────────────
export const getDevice = (id) => /^3A.{18}$/.test(id) ? 'ios' : /^3E.{20}$/.test(id) ? 'web' : /^(.{21}|.{32})$/.test(id) ? 'android' : /^(3F|.{18}$)/.test(id) ? 'desktop' : 'unknown'

export const patchMessageForMdIfRequired = (message) => {
    if (message?.buttonsMessage || message?.templateMessage || message?.listMessage || message?.interactiveMessage?.nativeFlowMessage) {
        message = { viewOnceMessageV2Extension: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...message } } }
    }
    return message
}

export const hasNonNullishProperty = (message, key) => typeof message === 'object' && message !== null && key in message && message[key] !== null && message[key] !== undefined
export const hasOptionalProperty = (obj, key) => typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null