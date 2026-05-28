import {
    SessionCipher,
    SessionBuilder,
    SessionRecord,
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

const bufEqual = (a, b) =>
    a && b && a.length === b.length && a.every((byte, i) => byte === b[i])

// ─── Identity Extraction ──────────────────────────────────────────────────────
// Reads field 4 (identity key, 33 bytes) from PreKeyWhisperMessage protobuf envelope

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
    const parsedKeys = auth.keys

    // #17 — expose lidCache ref so migrateSession can invalidate it
    const lidCache = new LRUCache({ max: 500, ttl: 5 * 60 * 1000 })

    // #1 — dedicated mutex serialising all session index writes to prevent cross-JID race
    let sessionIndexWriteLock = Promise.resolve()
    const withSessionLock = (fn) => {
        const next = sessionIndexWriteLock.then(fn).catch(fn)
        sessionIndexWriteLock = next.then(() => { }, () => { })
        return next
    }

    // #2 — session read cache: avoids full index read on every decrypt
    const sessionReadCache = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000, ttlAutopurge: true })

    const storage = signalStorage(auth, lidMapping, logger, lidCache, sessionReadCache, withSessionLock)
    const migratedCache = new LRUCache({ ttl: 7 * 24 * 60 * 60 * 1000, ttlAutopurge: true, updateAgeOnGet: true })
    const txn = (fn, key) => parsedKeys.transaction(fn, key)

    return {
        // ── Group ─────────────────────────────────────────────────────────────────

        decryptGroupMessage({ group, authorJid, msg }) {
            return txn(() => new GroupCipher(storage, group, jidToAddr(authorJid)).decrypt(msg), group)
        },

        async processSenderKeyDistributionMessage({ item, authorJid }) {
            if (!item.groupId) throw new Error('Group ID required')
            const senderName = jidToSenderKeyName(item.groupId, authorJid)
            const senderMsg = SenderKeyDistributionMessage.deserialize(
                toU8(item.axolotlSenderKeyDistributionMessage)
            )
            // do NOT pre-store a blank SenderKeyRecord — serialize() returns 0 bytes and bridge throws
            return txn(() => new GroupSessionBuilder(storage).process(senderName, senderMsg), item.groupId)
        },

        encryptGroupMessage({ group, meId, data }) {
            return txn(async () => {
                const senderName = jidToSenderKeyName(group, meId)
                const skdm = await new GroupSessionBuilder(storage).create(senderName)
                const ciphertext = await new GroupCipher(storage, group, jidToAddr(meId)).encrypt(toU8(data))
                return { ciphertext, senderKeyDistributionMessage: skdm.serialize() }
            }, group)
        },

        // #10 — kept for API completeness but not called by messages-send.js
        getSenderKeyDistributionMessage({ group, meId }) {
            return txn(async () => {
                const senderName = jidToSenderKeyName(group, meId)
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

        // ── 1:1 ───────────────────────────────────────────────────────────────────

        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToAddr(jid)
            const addrStr = addr.toString()
            const cipher = new SessionCipher(storage, addr)

            try {
                return await txn(async () => {
                    // #8 — identity save inside transaction to prevent concurrent pkmsg race
                    if (type === 'pkmsg') {
                        const identityKey = extractIdentityFromPkmsg(ciphertext)
                        if (identityKey) {
                            const changed = await storage.saveIdentity(addrStr, identityKey)
                            if (changed) logger?.info?.({ jid }, '[Signal] Identity key changed, session cleared')
                        } else {
                            logger?.debug?.({ jid }, '[Signal] pkmsg: could not extract identity key from envelope')
                        }
                        return cipher.decryptPreKeyWhisperMessage(ciphertext)
                    }
                    if (type === 'msg') return cipher.decryptWhisperMessage(ciphertext)
                    throw new Error(`Unknown message type: ${type}`)
                }, jid)
            } catch (e) {
                if (e?.message?.includes('DuplicatedMessage')) {
                    logger?.debug?.({ jid }, '[Signal] Duplicate message ignored')
                    return null
                }
                // #11 — on untrusted identity / session corruption, wipe and let caller retry
                if (e?.message?.includes('UntrustedIdentity') || e?.message?.includes('InvalidMessage')) {
                    logger?.warn?.({ jid, err: e.message }, '[Signal] Session error — wiping session for re-handshake')
                    await storage.wipeSession(addrStr)
                    sessionReadCache.delete(addrStr)
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

        // ── Session management ────────────────────────────────────────────────────

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
                // #9 — spread before mutating to avoid corrupting in-memory store on write failure
                const batch = await migrateIndexKey(parsedKeys, 'session')
                const updated = { ...batch }
                for (const jid of jids) {
                    const addr = jidToAddr(jid).toString()
                    delete updated[addr]
                    delete updated[v2Key(addr)]
                    sessionReadCache.delete(addr)
                }
                await parsedKeys.set({ session: { index: updated } })
            }, `del-${jids.length}`)
        },

        // ── Session migration ─────────────────────────────────────────────────────

        async migrateSession(fromJid, toJid) {
            if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }
            if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) return { migrated: 0, skipped: 0, total: 1 }
            const { user } = jidDecode(fromJid)

            // #15 — parallel fetch of device-list and session index
            const [deviceListBatch, sessionBatch] = await Promise.all([
                migrateIndexKey(parsedKeys, 'device-list'),
                migrateIndexKey(parsedKeys, 'session'),
            ])

            const userDevices = deviceListBatch[user] ? [...deviceListBatch[user]] : []
            const fromDeviceStr = jidDecode(fromJid).device?.toString() || '0'
            if (!userDevices.includes(fromDeviceStr)) userDevices.push(fromDeviceStr)

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
                // #5 — re-read inside txn for a fresh snapshot
                const freshBatch = await migrateIndexKey(parsedKeys, 'session')
                const updated = { ...freshBatch }
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
                    // #3 — invalidate lidCache for migrated PN addr so next resolve hits store
                    lidCache.delete(pnAddr)
                    sessionReadCache.delete(pnAddr)
                    migrated++
                    migratedCache.set(cacheKey, true)
                }

                if (migrated > 0) await parsedKeys.set({ session: { index: updated } })
                return { migrated, skipped: deviceJids.length - migrated, total: deviceJids.length }
            }, `migrate-${jidDecode(toJid)?.user}`)
        },

        async migrateAllPNSessionsToLID() {
            // #16 — skip everything if creds have no LID at all
            if (!auth.creds?.me?.lid) return 0

            // lid-mapping read outside txn to avoid nested key-namespace lock
            // #5 — session batch read outside is intentional; re-read inside txn before write
            const [sessionBatch, stored] = await (async () => {
                const sb = await migrateIndexKey(parsedKeys, 'session')
                const sessionKeys = Object.keys(sb)
                if (!sessionKeys.length) return [sb, {}]
                const pnAddrs = sessionKeys.filter(addr => {
                    if (addr.endsWith(':v2') || !addr.includes('.')) return false
                    const [, dt] = addr.split('.')[0].split('_')
                    const domainType = parseInt(dt || '0')
                    return domainType === WAJIDDomains.WHATSAPP || domainType === WAJIDDomains.HOSTED
                })
                if (!pnAddrs.length) return [sb, {}]
                const pnUserSet = new Set(pnAddrs.map(addr => addr.split('.')[0].split('_')[0]))
                const s = await parsedKeys.get('lid-mapping', [...pnUserSet])
                return [sb, s]
            })()

            const sessionKeys = Object.keys(sessionBatch)
            if (!sessionKeys.length) return 0

            const pnAddrs = sessionKeys.filter(addr => {
                if (addr.endsWith(':v2') || !addr.includes('.')) return false
                const [, dt] = addr.split('.')[0].split('_')
                const domainType = parseInt(dt || '0')
                return domainType === WAJIDDomains.WHATSAPP || domainType === WAJIDDomains.HOSTED
            })
            if (!pnAddrs.length) return 0

            const pnToLidUserMap = new Map()
            for (const pnUser of new Set(pnAddrs.map(addr => addr.split('.')[0].split('_')[0]))) {
                const lidUser = stored[pnUser]
                if (lidUser && typeof lidUser === 'string') pnToLidUserMap.set(pnUser, lidUser)
            }
            if (!pnToLidUserMap.size) return 0

            return txn(async () => {
                // #5 — fresh read inside txn before writing
                const freshBatch = await migrateIndexKey(parsedKeys, 'session')
                const updated = { ...freshBatch }
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
                    // #3 — invalidate caches for migrated addresses
                    lidCache.delete(addr)
                    sessionReadCache.delete(addr)
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

        // #17 — warm the LID cache on connect from stored mappings
        async warmLIDCache(mappings) {
            for (const { pn, lid } of mappings) {
                try {
                    const pnAddr = jidToAddr(pn).toString()
                    const lidAddr = jidToAddr(lid).toString()
                    lidCache.set(pnAddr, lidAddr)
                } catch { }
            }
        },

        close() {
            migratedCache.clear()
            sessionReadCache.clear()
            lidCache.clear()
            lidMapping.close?.()
        }
    }
}

// ─── Storage Adapter ──────────────────────────────────────────────────────────
// Implements SignalStorage interface for whatsapp-rust-bridge.
//
// Session index dual-key pattern:
//   v2Key(addr) → actual binary SessionRecord bytes
//   addr        → JSON tombstone { version:'v1', _sessions:{} } for old-code compat
//
// storeSenderKey always receives plain Uint8Array from bridge (confirmed by unit test).
// NEVER pre-store a blank SenderKeyRecord — serialize() returns 0 bytes, bridge throws.

function signalStorage({ creds, keys }, lidMapping, logger, lidCache, sessionReadCache, withSessionLock) {
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

    // #1/#2 — all index reads go through the read cache; all writes go through the write lock
    const getIndex = async () => {
        const cached = sessionReadCache.get('__index__')
        if (cached) return cached
        const batch = await migrateIndexKey(keys, 'session')
        sessionReadCache.set('__index__', batch)
        return batch
    }

    const setIndex = (batch) => withSessionLock(async () => {
        sessionReadCache.set('__index__', batch)
        try {
            await keys.set({ session: { index: batch } })
        } catch (e) {
            // #18 — on write failure invalidate cache so next read hits store
            sessionReadCache.delete('__index__')
            logger?.error?.(`[Signal] storeSession write failed: ${e.message}`)
            throw e
        }
    })

    return {
        loadSession: async (id) => {
            try {
                const addr = await resolveLID(id)
                // #2 — check per-addr cache before reading full index
                const cached = sessionReadCache.get(addr)
                if (cached !== undefined) return cached === null ? null : toU8(cached)
                const batch = await getIndex()
                const v2 = batch[v2Key(addr)]
                if (v2) {
                    if (isOldJson(v2)) { logger?.debug?.(`[Signal] Corrupt v2 for ${addr}, fresh handshake`); sessionReadCache.set(addr, null); return null }
                    const buf = toU8(v2)
                    if (buf) { sessionReadCache.set(addr, buf); return buf }
                }
                const plain = batch[addr]
                if (!plain || isOldJson(plain)) {
                    if (plain) logger?.debug?.(`[Signal] Old JSON session for ${addr}, fresh handshake`)
                    sessionReadCache.set(addr, null)
                    return null
                }
                const buf = toU8(plain)
                sessionReadCache.set(addr, buf)
                return buf
            } catch (e) { logger?.error?.(`[Signal] loadSession error: ${e.message}`); return null }
        },

        storeSession: async (id, record) => {
            const addr = await resolveLID(id)
            const serialized = record.serialize()
            // #19 — only update tombstone on first write; v2 always updated
            const batch = await getIndex()
            const needsTombstone = !batch[addr] || !isOldJson(batch[addr])
            const updated = {
                ...batch,
                [v2Key(addr)]: serialized,
                ...(needsTombstone ? { [addr]: { version: 'v1', _sessions: {} } } : {}),
            }
            sessionReadCache.set(addr, toU8(serialized))
            await setIndex(updated)
        },

        // #7 — proper identity verification instead of always trusting
        isTrustedIdentity: async (id, identityKey) => {
            try {
                const addr = await resolveLID(id)
                const { [addr]: raw } = await keys.get('identity-key', [addr])
                const existing = toU8(raw)
                if (!existing) return true
                return !!bufEqual(existing, identityKey instanceof Uint8Array ? identityKey : toU8(identityKey))
            } catch { return true }
        },

        loadIdentityKey: async (id) => {
            const addr = await resolveLID(id)
            const { [addr]: key } = await keys.get('identity-key', [addr])
            return toU8(key) ?? undefined
        },

        saveIdentity: async (id, identityKey) => {
            const addr = await resolveLID(id)
            const { [addr]: raw } = await keys.get('identity-key', [addr])
            const existing = toU8(raw)
            if (existing && !bufEqual(existing, identityKey)) {
                const batch = await getIndex()
                const updated = { ...batch }
                delete updated[addr]
                delete updated[v2Key(addr)]
                sessionReadCache.delete(addr)
                sessionReadCache.delete('__index__')
                await setIndex(updated)
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

        // #11 — exposed for decryptMessage error recovery
        wipeSession: async (addr) => {
            const batch = await getIndex()
            const updated = { ...batch }
            delete updated[addr]
            delete updated[v2Key(addr)]
            sessionReadCache.delete(addr)
            await setIndex(updated)
        },

        loadPreKey: async (id) => {
            const { [id.toString()]: key } = await keys.get('pre-key', [id.toString()])
            if (!key) return null
            return {
                pubKey: new Uint8Array(Buffer.from(key.public)),
                privKey: new Uint8Array(Buffer.from(key.private))
            }
        },

        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

        // #13 — return null on id mismatch instead of silently returning wrong key
        loadSignedPreKey: (id) => {
            const key = creds.signedPreKey
            if (key.keyId !== id) {
                logger?.warn?.({ requested: id, current: key.keyId }, '[Signal] loadSignedPreKey id mismatch')
                return null
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

        loadSenderKey: async (keyId) => {
            try {
                const id = keyId.toString()
                const { [id]: key } = await keys.get('sender-key', [id])
                return toBuffer(key) ?? null
            } catch (e) { logger?.error?.(`[Signal] loadSenderKey error: ${e.message}`); return null }
        },

        storeSenderKey: async (keyId, record) => {
            await keys.set({ 'sender-key': { [keyId.toString()]: Buffer.from(record) } })
        },

        getOurRegistrationId: () => creds.registrationId,

        getOurIdentity: () => ({
            pubKey: new Uint8Array(generateSignalPubKey(Buffer.from(creds.signedIdentityKey.public))),
            privKey: new Uint8Array(Buffer.from(creds.signedIdentityKey.private))
        })
    }
}

export default makeLibSignalRepository