import {
    SessionCipher,
    SessionBuilder,
    SessionRecord,
    SenderKeyRecord,
    ProtocolAddress,
    GroupCipher,
    GroupSessionBuilder,
    SenderKeyName,
    SenderKeyDistributionMessage,
} from 'whatsapp-rust-bridge'
import { LRUCache } from 'lru-cache'
import { generateSignalPubKey, migrateIndexKey } from '../Utils/index.js'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, transferDevice, WAJIDDomains } from '../WABinary/index.js'
import { LIDMappingStore } from './lid-mapping.js'

// ─── Address Helpers ──────────────────────────────────────────────────────────

const jidToAddr = (jid) => {
    const { user, device, server, domainType } = jidDecode(jid)
    if (!user) throw new Error(`Invalid JID: "${jid}"`)
    if (device === 99 && server !== 'hosted' && server !== 'hosted.lid') throw new Error('Invalid device 99: ' + jid)
    return new ProtocolAddress(
        domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user,
        device || 0
    )
}

const jidToSenderKeyName = (group, user) => new SenderKeyName(group, jidToAddr(user))

const v2Key = (addr) => `${addr}:v2`

// ─── Buffer Utils ─────────────────────────────────────────────────────────────

const toBuffer = (raw) => {
    if (!raw) return null
    if (raw instanceof Uint8Array) return raw
    if (Buffer.isBuffer(raw)) return raw
    if (raw?.type === 'Buffer' && Array.isArray(raw?.data)) return Buffer.from(raw.data)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') return Buffer.from(raw, 'base64')
    if (raw?.data) return Buffer.from(raw.data)
    return null
}

// safely coerce any buffer-like to a plain Uint8Array for the bridge
const toU8 = (raw) => {
    const buf = toBuffer(raw)
    if (!buf) return null
    return buf instanceof Uint8Array && buf.constructor === Uint8Array
        ? buf
        : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

const isOldJson = (raw) => {
    if (!raw || raw instanceof Uint8Array || Buffer.isBuffer(raw)) return false
    if (typeof raw === 'object') return 'version' in raw || '_sessions' in raw
    if (typeof raw === 'string') {
        try { const p = JSON.parse(raw); return 'version' in p || '_sessions' in p } catch { return false }
    }
    return false
}

// ─── Identity Extraction from PreKeyWhisperMessage ───────────────────────────
// field 4 (identity key, 33 bytes) from the protobuf envelope

const extractIdentityFromPkmsg = (ciphertext) => {
    try {
        if (!ciphertext || ciphertext.length < 2) return undefined
        if ((ciphertext[0] & 0xf) !== 3) return undefined
        const buf = ciphertext.slice(1)
        let i = 0
        while (i < buf.length) {
            const tag = buf[i++]
            const fieldNum = tag >> 3
            const wireType = tag & 0x7
            if (wireType === 2) {
                let len = 0, shift = 0
                while (i < buf.length) { const b = buf[i++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7 }
                if (fieldNum === 4 && len === 33) return new Uint8Array(buf.slice(i, i + len))
                i += len
            } else if (wireType === 0) { while (i < buf.length && buf[i++] & 0x80) { } }
            else if (wireType === 5) { i += 4 }
            else if (wireType === 1) { i += 8 }
            else break
        }
    } catch { }
    return undefined
}

// ─── Main Factory ─────────────────────────────────────────────────────────────

export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
    const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc)
    const storage = signalStorage(auth, lidMapping, logger)
    const parsedKeys = auth.keys
    const migratedCache = new LRUCache({ ttl: 7 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })
    const txn = (fn, key) => parsedKeys.transaction(fn, key)

    // ensures a SenderKeyRecord exists before any GroupSessionBuilder op;
    // GroupSessionBuilder.create/process throws on a missing record
    const ensureSenderKey = async (senderName) => {
        const nameStr = senderName.toString()
        const { [nameStr]: existing } = await parsedKeys.get('sender-key', [nameStr])
        if (!toBuffer(existing)) {
            await parsedKeys.set({ 'sender-key': { [nameStr]: Buffer.from(new SenderKeyRecord().serialize()) } })
        }
    }

    return {
        // ── Group ────────────────────────────────────────────────────────────────

        decryptGroupMessage({ group, authorJid, msg }) {
            return txn(() => new GroupCipher(storage, group, jidToAddr(authorJid)).decrypt(msg), group)
        },

        async processSenderKeyDistributionMessage({ item, authorJid }) {
            if (!item.groupId) throw new Error('Group ID required')
            const senderName = jidToSenderKeyName(item.groupId, authorJid)
            await ensureSenderKey(senderName)
            const senderMsg = SenderKeyDistributionMessage.deserialize(
                toU8(item.axolotlSenderKeyDistributionMessage)
            )
            return txn(() => new GroupSessionBuilder(storage).process(senderName, senderMsg), item.groupId)
        },

        encryptGroupMessage({ group, meId, data }) {
            return txn(async () => {
                const senderName = jidToSenderKeyName(group, meId)
                await ensureSenderKey(senderName)
                const skdm = await new GroupSessionBuilder(storage).create(senderName)
                // bridge requires a plain Uint8Array — Buffer is a subclass but constructor check differs
                const plaintext = toU8(data)
                const ciphertext = await new GroupCipher(storage, group, jidToAddr(meId)).encrypt(plaintext)
                return { ciphertext, senderKeyDistributionMessage: skdm.serialize() }
            }, group)
        },

        getSenderKeyDistributionMessage({ group, meId }) {
            return txn(async () => {
                const senderName = jidToSenderKeyName(group, meId)
                await ensureSenderKey(senderName)
                return (await new GroupSessionBuilder(storage).create(senderName)).serialize()
            }, group)
        },

        async hasSenderKey({ group, meId }) {
            const name = jidToSenderKeyName(group, meId).toString()
            const { [name]: key } = await parsedKeys.get('sender-key', [name])
            return !!toBuffer(key)
        },

        deleteSenderKey(group, authorJid) {
            return parsedKeys.set({ 'sender-key': { [jidToSenderKeyName(group, authorJid).toString()]: null } })
        },

        // ── 1:1 ──────────────────────────────────────────────────────────────────

        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToAddr(jid)
            const cipher = new SessionCipher(storage, addr)
            if (type === 'pkmsg') {
                const identityKey = extractIdentityFromPkmsg(ciphertext)
                if (identityKey) {
                    const changed = await storage.saveIdentity(addr.toString(), identityKey)
                    if (changed) logger?.info?.({ jid }, '[Signal] Identity key changed, session cleared')
                }
            }
            try {
                return await txn(() => {
                    if (type === 'pkmsg') return cipher.decryptPreKeyWhisperMessage(ciphertext)
                    if (type === 'msg') return cipher.decryptWhisperMessage(ciphertext)
                    throw new Error(`Unknown message type: ${type}`)
                }, jid)
            } catch (e) {
                if (e?.message?.includes('DuplicatedMessage')) {
                    logger?.debug?.({ jid }, '[Signal] Duplicate message ignored')
                    return null
                }
                throw e
            }
        },

        encryptMessage({ jid, data }) {
            return txn(async () => {
                const { type: sigType, body } = await new SessionCipher(storage, jidToAddr(jid)).encrypt(data)
                return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body) }
            }, jid)
        },

        injectE2ESession({ jid, session }) {
            return txn(() => new SessionBuilder(storage, jidToAddr(jid)).processPreKeyBundle(session), jid)
        },

        // ── Session management ───────────────────────────────────────────────────

        jidToSignalProtocolAddress: jid => jidToAddr(jid).toString(),

        lidMapping,

        async validateSession(jid) {
            try {
                const addr = jidToAddr(jid).toString()
                const batch = await migrateIndexKey(parsedKeys, 'session')
                const raw = toBuffer(batch[v2Key(addr)]) || toBuffer(batch[addr])
                if (!raw || isOldJson(raw)) return { exists: false, reason: 'no session' }
                return SessionRecord.deserialize(raw).haveOpenSession()
                    ? { exists: true }
                    : { exists: false, reason: 'no open session' }
            } catch { return { exists: false, reason: 'error' } }
        },

        async deleteSession(jids) {
            if (!jids?.length) return
            return txn(async () => {
                const batch = await migrateIndexKey(parsedKeys, 'session')
                for (const jid of jids) {
                    const addr = jidToAddr(jid).toString()
                    delete batch[addr]
                    delete batch[v2Key(addr)]
                }
                await parsedKeys.set({ session: { index: batch } })
            }, `del-${jids.length}`)
        },

        // ── Session migration ────────────────────────────────────────────────────

        async migrateSession(fromJid, toJid) {
            if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }
            if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) return { migrated: 0, skipped: 0, total: 1 }
            const { user } = jidDecode(fromJid)
            const deviceListBatch = await migrateIndexKey(parsedKeys, 'device-list')
            // copy array — don't mutate stored batch
            const userDevices = deviceListBatch[user] ? [...deviceListBatch[user]] : []
            const fromDeviceStr = jidDecode(fromJid).device?.toString() || '0'
            if (!userDevices.includes(fromDeviceStr)) userDevices.push(fromDeviceStr)
            const sessionBatch = await migrateIndexKey(parsedKeys, 'session')
            const deviceJids = userDevices
                .filter(d => !migratedCache.has(`${user}.${d}`))
                .map(d => {
                    const num = parseInt(d)
                    return {
                        cacheKey: `${user}.${d}`,
                        jid: num === 99 ? `${user}:99@hosted` : num === 0 ? `${user}@s.whatsapp.net` : `${user}:${num}@s.whatsapp.net`
                    }
                })
                .filter(({ jid }) => {
                    const addr = jidToAddr(jid).toString()
                    return sessionBatch[v2Key(addr)] || sessionBatch[addr]
                })
            if (!deviceJids.length) return { migrated: 0, skipped: 0, total: 0 }
            return txn(async () => {
                const updated = { ...sessionBatch }
                let migrated = 0
                for (const { jid, cacheKey } of deviceJids) {
                    const pnAddr = jidToAddr(jid).toString()
                    const lidAddr = jidToAddr(transferDevice(jid, toJid)).toString()
                    const raw = toBuffer(updated[v2Key(pnAddr)]) || toBuffer(updated[pnAddr])
                    if (!raw || isOldJson(raw)) continue
                    const sess = SessionRecord.deserialize(raw)
                    if (!sess.haveOpenSession()) continue
                    updated[v2Key(lidAddr)] = sess.serialize()
                    updated[lidAddr] = { version: 'v1', _sessions: {} }
                    delete updated[v2Key(pnAddr)]
                    delete updated[pnAddr]
                    migrated++
                    migratedCache.set(cacheKey, true)
                }
                if (migrated > 0) await parsedKeys.set({ session: { index: updated } })
                return { migrated, skipped: deviceJids.length - migrated, total: deviceJids.length }
            }, `migrate-${jidDecode(toJid)?.user}`)
        },

        async migrateAllPNSessionsToLID() {
            // lid-mapping read happens outside the txn to avoid nested key-namespace lock issues
            const sessionBatch = await migrateIndexKey(parsedKeys, 'session')
            const sessionKeys = Object.keys(sessionBatch)
            if (!sessionKeys.length) return 0
            const pnAddrs = sessionKeys.filter(addr => {
                if (addr.endsWith(':v2') || !addr.includes('.')) return false
                const [, dt] = addr.split('.')[0].split('_')
                const domainType = parseInt(dt || '0')
                return domainType === WAJIDDomains.WHATSAPP || domainType === WAJIDDomains.HOSTED
            })
            if (!pnAddrs.length) return 0
            const pnUserSet = new Set(pnAddrs.map(addr => addr.split('.')[0].split('_')[0]))
            const stored = await parsedKeys.get('lid-mapping', [...pnUserSet])
            const pnToLidUserMap = new Map()
            for (const pnUser of pnUserSet) {
                const lidUser = stored[pnUser]
                if (lidUser && typeof lidUser === 'string') pnToLidUserMap.set(pnUser, lidUser)
            }
            if (!pnToLidUserMap.size) return 0
            return txn(async () => {
                const updated = { ...sessionBatch }
                let migrated = 0
                for (const addr of pnAddrs) {
                    const [deviceId, device] = addr.split('.')
                    const [user, dt] = deviceId.split('_')
                    const domainType = parseInt(dt || '0')
                    const lidUser = pnToLidUserMap.get(user)
                    if (!lidUser) continue
                    const lidDomainType = domainType === WAJIDDomains.HOSTED ? WAJIDDomains.HOSTED_LID : WAJIDDomains.LID
                    const lidAddr = `${lidUser}_${lidDomainType}.${device}`
                    if (updated[v2Key(lidAddr)]) continue
                    const raw = toBuffer(updated[v2Key(addr)]) || toBuffer(updated[addr])
                    if (!raw || isOldJson(raw)) continue
                    const sess = SessionRecord.deserialize(raw)
                    if (!sess.haveOpenSession()) continue
                    updated[v2Key(lidAddr)] = sess.serialize()
                    updated[lidAddr] = { version: 'v1', _sessions: {} }
                    delete updated[v2Key(addr)]
                    delete updated[addr]
                    migrated++
                    migratedCache.set(`${user}.${device}`, true)
                }
                if (migrated > 0) {
                    await parsedKeys.set({ session: { index: updated } })
                    logger?.info?.({ migrated, totalPN: pnAddrs.length, mappingsFound: pnToLidUserMap.size }, '[Signal] Batch-migrated PN sessions to LID on connect')
                }
                return migrated
            }, 'migrate-all-pn-to-lid')
        },

        close() {
            migratedCache.clear()
            lidMapping.close?.()
        }
    }
}

// ─── Storage Adapter ──────────────────────────────────────────────────────────
// implements SignalStorage interface expected by whatsapp-rust-bridge

function signalStorage({ creds, keys }, lidMapping, logger) {
    const lidCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 })

    const resolveLID = async (id) => {
        if (!id.includes('.')) return id
        const cached = lidCache.get(id)
        if (cached) return cached
        const [deviceId, device] = id.split('.')
        const [user, dt] = deviceId.split('_')
        const domainType = parseInt(dt || '0')
        if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id
        const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`
        const lid = await lidMapping.getLIDForPN(pnJid)
        const result = lid ? jidToAddr(lid).toString() : id
        lidCache.set(id, result)
        return result
    }

    const getIndex = () => migrateIndexKey(keys, 'session')
    const setIndex = (batch) => keys.set({ session: { index: batch } })

    return {
        // bridge calls loadSession(address: string) → Uint8Array | null
        loadSession: async (id) => {
            try {
                const addr = await resolveLID(id)
                const batch = await getIndex()
                const v2 = batch[v2Key(addr)]
                if (v2) {
                    if (isOldJson(v2)) { logger?.debug?.(`[Signal] Corrupt v2 for ${addr}, fresh handshake`); return null }
                    const buf = toU8(v2)
                    if (buf) return buf
                }
                const plain = batch[addr]
                if (!plain || isOldJson(plain)) {
                    if (plain) logger?.debug?.(`[Signal] Old JSON session for ${addr}, fresh handshake`)
                    return null
                }
                return toU8(plain)
            } catch (e) { logger?.error?.(`[Signal] loadSession error: ${e.message}`); return null }
        },

        // bridge calls storeSession(address: string, record: SessionRecord) → void
        storeSession: async (id, record) => {
            const addr = await resolveLID(id)
            const batch = await getIndex()
            batch[v2Key(addr)] = record.serialize()
            batch[addr] = { version: 'v1', _sessions: {} }
            await setIndex(batch)
        },

        // bridge calls isTrustedIdentity(name, identityKey, direction) → boolean
        isTrustedIdentity: () => true,

        // not in the bridge interface but used internally by decryptMessage
        loadIdentityKey: async (id) => {
            const addr = await resolveLID(id)
            const { [addr]: key } = await keys.get('identity-key', [addr])
            return toU8(key) ?? undefined
        },

        // not in the bridge interface but used internally by decryptMessage
        saveIdentity: async (id, identityKey) => {
            const addr = await resolveLID(id)
            const { [addr]: raw } = await keys.get('identity-key', [addr])
            const existing = toU8(raw)
            const match = existing &&
                existing.length === identityKey.length &&
                existing.every((b, i) => b === identityKey[i])
            if (existing && !match) {
                // wipe session from index (not flat namespace) before updating identity
                const batch = await getIndex()
                delete batch[addr]
                delete batch[v2Key(addr)]
                await setIndex(batch)
                await keys.set({ 'identity-key': { [addr]: identityKey } })
                lidCache.delete(id)
                return true
            }
            if (!existing) {
                await keys.set({ 'identity-key': { [addr]: identityKey } })
                return true
            }
            return false
        },

        // bridge calls loadPreKey(id: number) → KeyPair | null
        loadPreKey: async (id) => {
            const { [id.toString()]: key } = await keys.get('pre-key', [id.toString()])
            if (!key) return null
            return {
                pubKey: new Uint8Array(Buffer.from(key.public)),
                privKey: new Uint8Array(Buffer.from(key.private))
            }
        },

        // bridge calls removePreKey(id: number) → void
        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

        // bridge calls loadSignedPreKey(id: number) → SignedPreKey | null
        // WA only rotates one signed pre-key at a time so creds.signedPreKey is always current;
        // we still validate the requested id matches to catch unexpected rotation
        loadSignedPreKey: (id) => {
            const key = creds.signedPreKey
            if (key.keyId !== id) {
                logger?.warn?.({ requested: id, current: key.keyId }, '[Signal] loadSignedPreKey id mismatch — returning current key')
            }
            return {
                keyId: key.keyId,
                keyPair: {
                    pubKey: new Uint8Array(Buffer.from(key.keyPair.public)),
                    privKey: new Uint8Array(Buffer.from(key.keyPair.private))
                },
                signature: new Uint8Array(Buffer.from(key.signature))
            }
        },

        // bridge calls loadSenderKey(keyId: string) → Uint8Array | null
        loadSenderKey: async (keyId) => {
            try {
                const id = keyId.toString()
                const { [id]: key } = await keys.get('sender-key', [id])
                return toU8(key) ?? null
            } catch (e) { logger?.error?.(`[Signal] loadSenderKey error: ${e.message}`); return null }
        },

        // bridge calls storeSenderKey(keyId: string, record: Uint8Array) → void
        storeSenderKey: async (keyId, record) => {
            await keys.set({ 'sender-key': { [keyId.toString()]: Buffer.from(record) } })
        },

        // bridge calls getOurRegistrationId() → number
        getOurRegistrationId: () => creds.registrationId,

        // bridge calls getOurIdentity() → KeyPair
        getOurIdentity: () => ({
            pubKey: new Uint8Array(generateSignalPubKey(Buffer.from(creds.signedIdentityKey.public))),
            privKey: new Uint8Array(Buffer.from(creds.signedIdentityKey.private))
        })
    }
}

export default makeLibSignalRepository