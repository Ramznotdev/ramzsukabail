import { KEY_BUNDLE_TYPE } from '../Defaults/index.js'
import { assertNodeErrorFree, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, getBinaryNodeChildUInt, getServerFromDomainType, jidDecode, S_WHATSAPP_NET, WAJIDDomains } from '../WABinary/index.js'
import { Curve, generateSignalPubKey } from './crypto.js'
import { encodeBigEndian } from './generics.js'

const chunk = (array, size) => {
    const chunks = []
    for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size))
    return chunks
}

export const createSignalIdentity = (wid, accountSignatureKey) => ({
    identifier: { name: wid, deviceId: 0 },
    identifierKey: generateSignalPubKey(accountSignatureKey)
})

export const getPreKeys = async ({ get }, min, limit) => {
    const idList = []
    for (let id = min; id < limit; id++) idList.push(id.toString())
    return get('pre-key', idList)
}

export const generateOrGetPreKeys = (creds, range) => {
    const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
    const remaining = range - avaliable
    const lastPreKeyId = creds.nextPreKeyId + remaining - 1
    const newPreKeys = {}
    if (remaining > 0) {
        for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) newPreKeys[i] = Curve.generateKeyPair()
    }
    return { newPreKeys, lastPreKeyId, preKeysRange: [creds.firstUnuploadedPreKeyId, range] }
}

export const xmppSignedPreKey = (key) => ({
    tag: 'skey',
    attrs: {},
    content: [
        { tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
        { tag: 'value', attrs: {}, content: key.keyPair.public },
        { tag: 'signature', attrs: {}, content: key.signature }
    ]
})

export const xmppPreKey = (pair, id) => ({
    tag: 'key',
    attrs: {},
    content: [
        { tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
        { tag: 'value', attrs: {}, content: pair.public }
    ]
})

const isValidUInt = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0

/**
 * Extract a full E2E session bundle from a retry receipt's <keys> node.
 * Returns null if the bundle is missing, malformed, or fails any integrity check.
 * Used in sendMessagesAgain to inject the sender's fresh session on retry.
 */
export const extractE2ESessionFromRetryReceipt = (receipt) => {
    const keysNode = getBinaryNodeChild(receipt, 'keys')
    if (!keysNode) return null

    const typeBuf = getBinaryNodeChildBuffer(keysNode, 'type')
    if (!typeBuf || typeBuf.length !== 1 || typeBuf[0] !== KEY_BUNDLE_TYPE[0]) return null

    const identity = getBinaryNodeChildBuffer(keysNode, 'identity')
    const skey = getBinaryNodeChild(keysNode, 'skey')
    if (!identity || identity.length !== 32 || !skey) return null

    const registrationId = getBinaryNodeChildUInt(receipt, 'registration', 4)
    if (!isValidUInt(registrationId)) return null

    const signedPubKey = getBinaryNodeChildBuffer(skey, 'value')
    const signedSig = getBinaryNodeChildBuffer(skey, 'signature')
    const signedKeyId = getBinaryNodeChildUInt(skey, 'id', 3)
    if (!signedPubKey || signedPubKey.length !== 32 || !signedSig || !isValidUInt(signedKeyId)) return null

    const preKeyNode = getBinaryNodeChild(keysNode, 'key')
    let preKey
    if (preKeyNode) {
        const preKeyPub = getBinaryNodeChildBuffer(preKeyNode, 'value')
        const preKeyId = getBinaryNodeChildUInt(preKeyNode, 'id', 3)
        if (!preKeyPub || preKeyPub.length !== 32 || !isValidUInt(preKeyId)) return null
        preKey = { keyId: preKeyId, publicKey: generateSignalPubKey(preKeyPub) }
    }

    return {
        registrationId,
        identityKey: generateSignalPubKey(identity),
        signedPreKey: { keyId: signedKeyId, publicKey: generateSignalPubKey(signedPubKey), signature: signedSig },
        preKey
    }
}

/**
 * Parse and inject E2E sessions from a server key response node.
 * Unlike upstream, we filter error nodes individually so one bad user
 * never aborts the entire batch — all valid sessions still get injected.
 * CPU-heavy work is chunked in groups of 100 to yield to the event loop between batches.
 */
export const parseAndInjectE2ESessions = async (node, repository) => {
    const extractKey = (key) => key ? {
        keyId: getBinaryNodeChildUInt(key, 'id', 3),
        publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(key, 'value')),
        signature: getBinaryNodeChildBuffer(key, 'signature')
    } : undefined

    const allNodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user')
    const nodes = allNodes.filter(node => {
        try { assertNodeErrorFree(node); return true }
        catch { return false }
    })

    const chunks = chunk(nodes, 100)
    for (const nodesChunk of chunks) {
        for (const node of nodesChunk) {
            const signedKey = getBinaryNodeChild(node, 'skey')
            const key = getBinaryNodeChild(node, 'key')
            const identity = getBinaryNodeChildBuffer(node, 'identity')
            const jid = node.attrs.jid
            const registrationId = getBinaryNodeChildUInt(node, 'registration', 4)
            await repository.injectE2ESession({
                jid,
                session: {
                    registrationId,
                    identityKey: generateSignalPubKey(identity),
                    signedPreKey: extractKey(signedKey),
                    preKey: extractKey(key)
                }
            })
        }
        // Yield to event loop between chunks to avoid blocking on large batches
        await new Promise(resolve => setImmediate(resolve))
    }
}

/**
 * Extract device JIDs from a USync result list.
 * Skips your own current device, respects excludeZeroDevices flag,
 * and correctly resolves hosted LID/PN domain types.
 */
export const extractDeviceJids = (result, myJid, myLid, excludeZeroDevices) => {
    const { user: myUser, device: myDevice } = jidDecode(myJid)
    const extracted = []
    for (const userResult of result) {
        const { devices, id } = userResult
        const decoded = jidDecode(id)
        const { user, server } = decoded
        let { domainType } = decoded
        const deviceList = devices?.deviceList
        if (!Array.isArray(deviceList)) continue
        for (const { id: device, keyIndex, isHosted } of deviceList) {
            if ((!excludeZeroDevices || device !== 0) &&
                ((myUser !== user && myLid !== user) || myDevice !== device) &&
                (device === 0 || !!keyIndex)) {
                if (isHosted) domainType = domainType === WAJIDDomains.LID ? WAJIDDomains.HOSTED_LID : WAJIDDomains.HOSTED
                extracted.push({ user, device, domainType, server: getServerFromDomainType(server, domainType) })
            }
        }
    }
    return extracted
}

export const getNextPreKeys = async ({ creds, keys }, count) => {
    const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count)
    const update = {
        nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
        firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
    }
    await keys.set({ 'pre-key': newPreKeys })
    const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])
    return { update, preKeys }
}

export const getNextPreKeysNode = async (state, count) => {
    const { creds } = state
    const { update, preKeys } = await getNextPreKeys(state, count)
    const node = {
        tag: 'iq',
        attrs: { xmlns: 'encrypt', type: 'set', to: S_WHATSAPP_NET },
        content: [
            { tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
            { tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
            { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
            { tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
            xmppSignedPreKey(creds.signedPreKey)
        ]
    }
    return { update, node }
}