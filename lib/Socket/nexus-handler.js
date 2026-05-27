import { proto } from '../../WAProto/index.js'
import axios from 'axios'
import crypto from 'crypto'

class NexusHandler {
    constructor(utils, waUploadToServer, relayMessageFn, options = {}) {
        this.utils = utils
        this.relay = relayMessageFn
        this.upload = waUploadToServer
        this.opts = options
        this.user = options.user || null
        this.handlers = {
            PAYMENT: this.handlePayment.bind(this),
            PRODUCT: this.handleProduct.bind(this),
            INTERACTIVE: this.handleInteractive.bind(this),
            ALBUM: this.handleAlbum.bind(this),
            EVENT: this.handleEvent.bind(this),
            POLL_RESULT: this.handlePollResult.bind(this),
            STATUS_MENTION: this.handleStMention.bind(this),
            ORDER: this.handleOrderMessage.bind(this),
            STICKER_PACK: this.handleStickerPack.bind(this),
            GROUP_STATUS: this.handleGroupStory.bind(this),
            CAROUSEL: this.handleCarousel.bind(this),
            CAROUSEL_PROTO: this.handleCarouselProto.bind(this)
        }
    }

    // ─── TYPE DETECTION ───────────────────────────────────────────────────────
    detectType(content) {
        if (content.carouselMessage || content.carousel) return 'CAROUSEL'
        if (content.carouselProto) return 'CAROUSEL_PROTO'
        const map = {
            requestPaymentMessage: 'PAYMENT', productMessage: 'PRODUCT',
            interactiveMessage: 'INTERACTIVE', interactive: 'INTERACTIVE',
            albumMessage: 'ALBUM', eventMessage: 'EVENT',
            pollResultMessage: 'POLL_RESULT', statusMentionMessage: 'STATUS_MENTION',
            orderMessage: 'ORDER', stickerPack: 'STICKER_PACK', groupStatus: 'GROUP_STATUS'
        }
        return map[Object.keys(map).find(k => content[k])] || null
    }

    // ─── UNIFIED PROCESSOR ────────────────────────────────────────────────────
    async processMessage(content, jid, quoted) {
        const type = this.detectType(content)
        if (!type) throw new Error('Unknown message type')
        const handler = this.handlers[type]
        if (!handler) throw new Error(`No handler for: ${type}`)
        return await handler(content, jid, quoted)
    }

    // ─── HELPERS ──────────────────────────────────────────────────────────────
    async prepMedia(data, type) {
        if (!data) return null
        const payload = typeof data === 'object' && data.url ? { [type]: { url: data.url } } : { [type]: data }
        return await this.utils.prepareWAMessageMedia(payload, { upload: this.upload })
    }

    async genMsg(jid, content, opts = {}) {
        return await this.utils.generateWAMessage(jid, content, {
            ...opts,
            upload: this.upload,
            userJid: opts.userJid || this.user?.id,
            getUrlInfo: opts.getUrlInfo || this.opts.getUrlInfo,
            logger: opts.logger || this.opts.logger
        })
    }

    async genFromContent(jid, content, opts = {}) {
        return await this.utils.generateWAMessageFromContent(jid, content, {
            ...opts,
            userJid: opts.userJid || this.user?.id
        })
    }

    async sendMsg(jid, message, opts = {}) {
        return await this.relay(jid, message, opts)
    }

    buildCtx(quoted, sender) {
        return {
            stanzaId: quoted?.key?.id,
            participant: quoted?.key?.participant || sender,
            quotedMessage: quoted?.message
        }
    }

    buildFullCtx(ctx, adReply) {
        const allowed = ['title', 'body', 'mediaType', 'thumbnailUrl', 'mediaUrl', 'sourceUrl', 'showAdAttribution', 'renderLargerThumbnail', 'thumbnail']
        const final = ctx ? { mentionedJid: ctx.mentionedJid || [], forwardingScore: ctx.forwardingScore || 0, isForwarded: ctx.isForwarded || false, ...ctx } : {}
        if (adReply) {
            final.externalAdReply = {}
            for (const k of allowed) if (adReply[k] !== undefined) final.externalAdReply[k] = adReply[k]
            final.externalAdReply = { mediaType: 1, showAdAttribution: false, renderLargerThumbnail: false, ...final.externalAdReply }
        }
        return final
    }

    genJid() {
        const id = this.utils.generateMessageIDV2?.() || this.utils.generateMessageID?.() || crypto.randomBytes(10).toString('hex')
        return id.includes('@') ? id : `${id}@s.whatsapp.net`
    }

    parseTime(val, def) { return typeof val === 'string' ? parseInt(val) : (val || def) }
    delay(ms) { return new Promise(r => setTimeout(r, ms)) }

    async downloadBuffer(urlOrBuffer) {
        if (Buffer.isBuffer(urlOrBuffer)) return urlOrBuffer
        if (typeof urlOrBuffer === 'string') {
            try {
                const res = await axios.get(urlOrBuffer, { responseType: 'arraybuffer' })
                return Buffer.from(res.data)
            } catch { this.opts.logger?.warn('Failed to download buffer from URL') }
        }
        return null
    }

    // ─── PAYMENT ──────────────────────────────────────────────────────────────
    async handlePayment(content, jid, quoted) {
        const d = content.requestPaymentMessage
        const ctx = this.buildCtx(quoted, content.sender)
        const notes = d.sticker?.stickerMessage
            ? { stickerMessage: { ...d.sticker.stickerMessage, contextInfo: ctx } }
            : d.note ? { extendedTextMessage: { text: d.note, contextInfo: ctx } } : {}
        const targetJid = jid || content.jid
        const msg = await this.genFromContent(targetJid, {
            requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({
                expiryTimestamp: d.expiry || 0,
                amount1000: d.amount || 0,
                currencyCodeIso4217: d.currency || 'IDR',
                requestFrom: d.from || '0@s.whatsapp.net',
                noteMessage: notes,
                background: d.background ?? { id: 'DEFAULT', placeholderArgb: 0xfff0f0f0 }
            })
        }, { quoted })
        await this.sendMsg(targetJid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── PRODUCT ──────────────────────────────────────────────────────────────
    async handleProduct(content, jid, quoted) {
        const p = content.productMessage || {}
        let prodImg = null
        if (p.thumbnail) {
            const src = Buffer.isBuffer(p.thumbnail) ? { image: p.thumbnail } : { image: { url: p.thumbnail.url || p.thumbnail } }
            const res = await this.utils.generateWAMessageContent(src, { upload: this.upload })
            prodImg = res?.imageMessage || res?.message?.imageMessage
        }
        const product = proto.Message.ProductMessage.ProductSnapshot.create({
            productId: p.productId,
            title: p.title || '',
            description: p.description || '',
            currencyCode: p.currencyCode || 'IDR',
            priceAmount1000: p.priceAmount1000,
            retailerId: p.retailerId,
            url: p.url,
            productImageCount: prodImg ? 1 : 0,
            ...(prodImg && { productImage: prodImg })
        })
        const msg = await this.genFromContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        body: proto.Message.InteractiveMessage.Body.create({ text: p.body || '' }),
                        footer: proto.Message.InteractiveMessage.Footer.create({ text: p.footer || '' }),
                        header: proto.Message.InteractiveMessage.Header.create({
                            title: p.title || '',
                            hasMediaAttachment: !!prodImg,
                            productMessage: proto.Message.ProductMessage.create({ product, businessOwnerJid: '0@s.whatsapp.net' })
                        }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: p.buttons || [] })
                    })
                }
            }
        }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── INTERACTIVE ──────────────────────────────────────────────────────────
    async handleInteractive(content, jid, quoted) {
        const i = content.interactiveMessage || content.interactive || {}
        let media = null
        if (i.thumbnail) media = await this.prepMedia({ url: i.thumbnail }, 'image')
        else if (i.image) media = await this.prepMedia(i.image, 'image')
        else if (i.video) media = await this.prepMedia(i.video, 'video')
        else if (i.document) {
            media = await this.prepMedia(i.document, 'document')
            if (i.jpegThumbnail) media.documentMessage.jpegThumbnail = typeof i.jpegThumbnail === 'object' && i.jpegThumbnail.url ? { url: i.jpegThumbnail.url } : i.jpegThumbnail
            if (i.fileName) media.documentMessage.fileName = i.fileName
            if (i.mimetype) media.documentMessage.mimetype = i.mimetype
        }
        const bodyText = i.body?.text || i.title || ''
        const footerText = i.footer?.text || (typeof i.footer === 'string' ? i.footer : '') || ''
        const headerTitle = typeof i.header === 'string' ? i.header : i.header?.title || ''
        let nativeFlow = null
        if (i.buttons?.length || i.nativeFlowMessage) {
            const nfm = i.nativeFlowMessage || {}
            nativeFlow = proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: i.buttons || nfm.buttons || [],
                messageParamsJson: nfm.messageParamsJson || ''
            })
        }
        const headerMedia = {}
        if (media?.imageMessage) headerMedia.imageMessage = media.imageMessage
        if (media?.videoMessage) headerMedia.videoMessage = media.videoMessage
        if (media?.documentMessage) headerMedia.documentMessage = media.documentMessage
        const interactive = proto.Message.InteractiveMessage.create({
            body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }),
            header: proto.Message.InteractiveMessage.Header.create({ title: headerTitle, hasMediaAttachment: !!media, ...headerMedia }),
            ...(nativeFlow && { nativeFlowMessage: nativeFlow })
        })
        const ctx = this.buildFullCtx(i.contextInfo, i.externalAdReply)
        if (Object.keys(ctx).length) interactive.contextInfo = ctx
        const msg = await this.genFromContent(jid, { interactiveMessage: interactive }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── ALBUM ────────────────────────────────────────────────────────────────
    async handleAlbum(content, jid, quoted) {
        const arr = Array.isArray(content.albumMessage) ? content.albumMessage : []
        if (!arr.length) throw new Error('albumMessage must contain media items')
        const album = await this.genFromContent(jid, {
            messageContextInfo: proto.MessageContextInfo.create({ messageSecret: crypto.randomBytes(32) }),
            albumMessage: proto.Message.AlbumMessage.create({
                expectedImageCount: arr.filter(a => a.image).length,
                expectedVideoCount: arr.filter(a => a.video).length
            })
        }, { userJid: this.genJid(), quoted })
        await this.sendMsg(jid, album.message, { messageId: album.key.id })
        for (const item of arr) {
            const img = await this.genMsg(jid, item, {})
            img.message.messageContextInfo = proto.MessageContextInfo.create({
                messageSecret: crypto.randomBytes(32),
                messageAssociation: proto.MessageAssociation.create({ associationType: 1, parentMessageKey: album.key }),
                participant: '0@s.whatsapp.net',
                remoteJid: 'status@broadcast',
                forwardingScore: 99999,
                isForwarded: true,
                mentionedJid: [jid],
                starred: true,
                labels: ['Y', 'Important'],
                isHighlighted: true,
                businessMessageForwardInfo: proto.ContextInfo.BusinessMessageForwardInfo.create({ businessOwnerJid: jid }),
                dataSharingContext: proto.ContextInfo.DataSharingContext.create({ showMmDisclosure: true })
            })
            img.message.forwardedNewsletterMessageInfo = proto.ContextInfo.ForwardedNewsletterMessageInfo.create({
                newsletterJid: '0@newsletter',
                serverMessageId: 1,
                newsletterName: 'WhatsApp',
                contentType: 'UPDATE_CARD',
                timestamp: new Date().toISOString(),
                senderName: 'Nexus',
                priority: 'high',
                status: 'sent'
            })
            img.message.disappearingMode = proto.DisappearingMode.create({
                initiator: 3, trigger: 4, initiatorDeviceJid: jid,
                initiatedByExternalService: true, initiatedByUserDevice: true,
                initiatedBySystem: true, initiatedByServer: true,
                initiatedByAdmin: true, initiatedByUser: true,
                initiatedByApp: true, initiatedByBot: true, initiatedByMe: true
            })
            await this.sendMsg(jid, img.message, {
                messageId: img.key.id,
                quoted: { key: { ...album.key, fromMe: true, participant: this.genJid() }, message: album.message }
            })
        }
        return album
    }

    // ─── EVENT ────────────────────────────────────────────────────────────────
    async handleEvent(content, jid, quoted) {
        const e = content.eventMessage
        const msg = await this.genFromContent(jid, {
            messageContextInfo: proto.MessageContextInfo.create({
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
                messageSecret: crypto.randomBytes(32),
                supportPayload: JSON.stringify({ version: 2, is_ai_message: true, should_show_system_message: true, ticket_id: crypto.randomBytes(16).toString('hex') })
            }),
            eventMessage: proto.Message.EventMessage.create({
                contextInfo: proto.ContextInfo.create({
                    mentionedJid: [jid],
                    participant: jid,
                    remoteJid: 'status@broadcast',
                    forwardedNewsletterMessageInfo: proto.ContextInfo.ForwardedNewsletterMessageInfo.create({
                        newsletterName: 'Nexus Events',
                        newsletterJid: '120363422827915475@newsletter',
                        serverMessageId: 1
                    })
                }),
                isCanceled: e.isCanceled || false,
                name: e.name,
                description: e.description,
                location: e.location || { degreesLatitude: 0, degreesLongitude: 0, name: 'Location' },
                joinLink: e.joinLink || '',
                startTime: this.parseTime(e.startTime, Date.now()),
                endTime: this.parseTime(e.endTime, Date.now() + 3600000),
                extraGuestsAllowed: e.extraGuestsAllowed !== false
            })
        }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── POLL RESULT ──────────────────────────────────────────────────────────
    async handlePollResult(content, jid, quoted) {
        const p = content.pollResultMessage
        const msg = await this.genFromContent(jid, {
            pollResultSnapshotMessage: proto.Message.PollResultSnapshotMessage.create({
                name: p.name,
                pollVotes: (p.pollVotes || []).map(v => proto.Message.PollResultSnapshotMessage.PollVote.create({
                    optionName: v.optionName,
                    optionVoteCount: typeof v.optionVoteCount === 'number' ? v.optionVoteCount.toString() : v.optionVoteCount
                })),
                contextInfo: proto.ContextInfo.create({
                    isForwarded: true,
                    forwardingScore: 1,
                    forwardedNewsletterMessageInfo: proto.ContextInfo.ForwardedNewsletterMessageInfo.create({
                        newsletterName: p.newsletter?.newsletterName || 'Newsletter',
                        newsletterJid: p.newsletter?.newsletterJid || '120363399602691477@newsletter',
                        serverMessageId: 1000,
                        contentType: 'UPDATE'
                    })
                })
            })
        }, { userJid: this.genJid(), quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── STATUS MENTION ───────────────────────────────────────────────────────
    async handleStMention(content, jid, quoted) {
        const d = content.statusMentionMessage
        const mediaType = d.image ? 'image' : 'video'
        const media = await this.prepMedia(d.image || d.video, mediaType)
        const statusMsg = await this.relay('status@broadcast', { ...media }, {
            statusJidList: [d.mentions, this.user?.id].filter(Boolean),
            additionalNodes: [{
                tag: 'meta', attrs: {},
                content: [{ tag: 'mentioned_users', attrs: {}, content: [{ tag: 'to', attrs: { jid: d.mentions }, content: undefined }] }]
            }]
        })
        const mentionMsg = await this.genFromContent(jid, {
            statusMentionMessage: proto.Message.StatusMentionMessage.create({
                message: {
                    protocolMessage: proto.Message.ProtocolMessage.create({
                        messageId: statusMsg?.key?.id || d.mentions,
                        type: proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE
                    })
                }
            })
        }, { additionalNodes: [{ tag: 'meta', attrs: { is_status_mention: 'true' }, content: undefined }] })
        await this.sendMsg(jid, mentionMsg.message, { messageId: mentionMsg.key.id })
        return mentionMsg
    }

    // ─── ORDER ────────────────────────────────────────────────────────────────
    async handleOrderMessage(content, jid, quoted) {
        const o = content.orderMessage
        const thumb = await this.downloadBuffer(o.thumbnail)
        const cleanJid = (id) => {
            if (!id) return null
            const [user] = id.split(':')
            return user.includes('@') ? user : `${user}@s.whatsapp.net`
        }
        const seller = cleanJid(o.sellerJid) || cleanJid(this.user?.id) || cleanJid(jid) || '0@s.whatsapp.net'
        const msg = await this.genFromContent(jid, {
            orderMessage: proto.Message.OrderMessage.create({
                orderId: o.orderId || '7NEXUS25022008',
                thumbnail: thumb,
                itemCount: o.itemCount || 0,
                status: 2, // ACCEPTED
                surface: 1, // CATALOG
                message: o.message,
                orderTitle: o.orderTitle,
                sellerJid: seller,
                token: o.token || 'NEXUS_EXAMPLE_TOKEN',
                totalAmount1000: o.totalAmount1000 || 0,
                totalCurrencyCode: o.totalCurrencyCode || 'IDR',
                messageVersion: 2
            })
        }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── GROUP STATUS ─────────────────────────────────────────────────────────
    async handleGroupStory(content, jid, quoted) {
        const s = content.groupStatus
        const mediaContent = await this.utils.generateWAMessageContent(s, {
            upload: this.upload,
            getUrlInfo: this.opts.getUrlInfo,
            logger: this.opts.logger
        })
        const msg = await this.genFromContent(jid, {
            groupStatusMessageV2: proto.Message.FutureProofMessage.create({ message: proto.Message.fromObject(mediaContent) })
        }, { userJid: jid })
        return await this.sendMsg(jid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [{ tag: 'meta', attrs: { is_group_status: 'true' }, content: undefined }]
        })
    }

    // ─── CAROUSEL ─────────────────────────────────────────────────────────────
    async handleCarousel(content, jid, quoted) {
        const c = content.carouselMessage || content.carousel || {}
        const cards = await Promise.all((c.cards || []).map(card => this.buildCard(card)))
        const msg = await this.genFromContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        body: proto.Message.InteractiveMessage.Body.create({ text: c.caption || c.body || '' }),
                        footer: proto.Message.InteractiveMessage.Footer.create({ text: c.footer || '' }),
                        carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({ cards, messageVersion: 1 })
                    })
                }
            }
        }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    async buildCard(card) {
        const buttons = (card.buttons || []).map(btn => ({
            name: btn.name,
            buttonParamsJson: JSON.stringify(btn.params || {})
        }))
        if (card.productTitle) {
            const imgMedia = await this.prepMedia({ url: card.imageUrl }, 'image')
            return {
                header: proto.Message.InteractiveMessage.Header.create({
                    title: card.headerTitle || '',
                    subtitle: card.headerSubtitle || '',
                    hasMediaAttachment: false,
                    productMessage: proto.Message.ProductMessage.create({
                        product: proto.Message.ProductMessage.ProductSnapshot.create({
                            productImage: imgMedia?.imageMessage,
                            productId: card.productId || '123456',
                            title: card.productTitle,
                            description: card.productDescription || '',
                            currencyCode: card.currencyCode || 'IDR',
                            priceAmount1000: card.priceAmount1000 || '100000',
                            retailerId: card.retailerId || 'Retailer',
                            url: card.url || '',
                            productImageCount: 1
                        }),
                        businessOwnerJid: card.businessOwnerJid || '0@s.whatsapp.net'
                    })
                }),
                body: proto.Message.InteractiveMessage.Body.create({ text: card.bodyText || '' }),
                footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footerText || '' }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons })
            }
        }
        const imgMedia = card.imageUrl ? await this.prepMedia({ url: card.imageUrl }, 'image') : {}
        return {
            header: proto.Message.InteractiveMessage.Header.create({
                title: card.headerTitle || '',
                subtitle: card.headerSubtitle || '',
                hasMediaAttachment: !!card.imageUrl,
                ...imgMedia
            }),
            body: proto.Message.InteractiveMessage.Body.create({ text: card.bodyText || '' }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footerText || '' }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons })
        }
    }

    // ─── CAROUSEL PROTO ───────────────────────────────────────────────────────
    async handleCarouselProto(content, jid, quoted) {
        const c = content.carouselProto
        const cards = await Promise.all((c.cards || []).map(async card => ({
            header: proto.Message.InteractiveMessage.Header.create({
                title: card.title?.substring(0, 60) || '',
                subtitle: card.subtitle || '',
                hasMediaAttachment: false
            }),
            body: proto.Message.InteractiveMessage.Body.create({ text: card.bodyText || '' }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: card.footerText || '' }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: (card.buttons || []).map(btn => ({ name: btn.name, buttonParamsJson: JSON.stringify(btn.params || {}) }))
            })
        })))
        const msg = await this.genFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: proto.MessageContextInfo.create({ deviceListMetadata: {}, deviceListMetadataVersion: 2 }),
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        body: proto.Message.InteractiveMessage.Body.create({ text: c.body || '' }),
                        footer: proto.Message.InteractiveMessage.Footer.create({ text: c.footer || '' }),
                        carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({ cards, messageVersion: 1 })
                    })
                }
            }
        }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    // ─── STICKER PACK ─────────────────────────────────────────────────────────
    async handleStickerPack(content, jid, quoted) {
        const stickerPack = content.stickerPack
        const result = await this.utils.prepareStickerPackMessage(stickerPack, {
            logger: this.opts?.logger,
            upload: this.upload,
            mediaCache: this.opts?.mediaCache,
            options: this.opts,
            mediaUploadTimeoutMs: this.opts?.mediaUploadTimeoutMs
        })
        if (result.isBatched) {
            const sent = []
            for (let i = 0; i < result.stickerPackMessage.length; i++) {
                const msg = await this.genFromContent(jid, { stickerPackMessage: result.stickerPackMessage[i] }, { quoted })
                await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
                sent.push(msg)
                if (i < result.stickerPackMessage.length - 1) await this.delay(2000)
            }
            return sent[sent.length - 1]
        }
        const msg = await this.genFromContent(jid, { stickerPackMessage: result.stickerPackMessage }, { quoted })
        await this.sendMsg(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

export default NexusHandler