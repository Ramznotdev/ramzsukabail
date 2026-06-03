import { Mutex } from 'async-mutex'
import { mkdir, readFile, rename, stat, unlink, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { initAuthCreds } from './auth-utils.js'
import { BufferJSON } from './generics.js'

// ─── Constants ────────────────────────────────────────────────────────────────
const CURRENT_VERSION = 1
const DEFAULT_PREKEY_RETENTION = 150
const DEFAULT_CLEANUP_THRESHOLD = 50
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

// ─── File Lock Registry ───────────────────────────────────────────────────────
const fileLocks = new Map()
const getFileLock = (path) => {
    if (!fileLocks.has(path)) fileLocks.set(path, new Mutex())
    return fileLocks.get(path)
}
const releaseFileLock = (path) => {
    if (fileLocks.has(path) && !fileLocks.get(path).isLocked()) fileLocks.delete(path)
}

// ─── Checksum ─────────────────────────────────────────────────────────────────
const computeChecksum = (data) => createHash('sha256').update(data).digest('hex')

/**
 * Production-grade multi-file auth state for Baileys.
 * Atomic writes, checksum integrity, and smart prekey cleanup.
 * Compatible with standard Baileys auth folder format.
 *
 * @param {string} folder - Directory to store auth files
 * @param {object} [options] - Configuration options
 * @param {number} [options.preKeyRetention=150] - How many recent prekeys to keep
 * @param {number} [options.cleanupThreshold=50] - How many new prekeys trigger a cleanup
 * @param {object} [options.logger] - Optional logger with .info/.warn methods
 */
export const useMultiFileAuthState = async (folder, options = {}) => {
    const {
        preKeyRetention = DEFAULT_PREKEY_RETENTION,
        cleanupThreshold = DEFAULT_CLEANUP_THRESHOLD,
        logger,
    } = options
    const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')
    const filePath = (file) => join(folder, fixFileName(file))
    const tmpPath = (file) => filePath(file) + '.tmp'

    // ─── Folder Bootstrap ───────────────────────────────────────────────────────
    const folderInfo = await stat(folder).catch(() => null)
    if (folderInfo) {
        if (!folderInfo.isDirectory()) throw new Error(`Path exists but is not a directory: ${folder}`)
    } else {
        await mkdir(folder, { recursive: true })
    }

    // ─── Atomic Write ────────────────────────────────────────────────────────────
    const writeData = async (data, file) => {
        const fp = filePath(file)
        const tp = tmpPath(file)
        const mutex = getFileLock(fp)
        const release = await mutex.acquire()
        try {
            const serialized = JSON.stringify(data, BufferJSON.replacer)
            const checksum = computeChecksum(serialized)
            const payload = JSON.stringify({ data: JSON.parse(serialized), __checksum: checksum })
            await writeFile(tp, payload)
            await rename(tp, fp)
        } finally {
            release()
            releaseFileLock(fp)
        }
    }

    // ─── Read with Checksum Verification ─────────────────────────────────────────
    const readData = async (file) => {
        const fp = filePath(file)
        const mutex = getFileLock(fp)
        const release = await mutex.acquire()
        try {
            const raw = await readFile(fp, { encoding: 'utf-8' }).catch(() => null)
            if (!raw) return null
            try {
                const parsed = JSON.parse(raw)
                if (parsed.__checksum) {
                    const expected = computeChecksum(JSON.stringify(parsed.data))
                    if (expected !== parsed.__checksum) throw new Error('checksum mismatch')
                    return JSON.parse(JSON.stringify(parsed.data), BufferJSON.reviver)
                }
                // legacy file without checksum — read as-is for compatibility
                return JSON.parse(raw, BufferJSON.reviver)
            } catch (err) {
                logger?.warn({ file, err: err.message }, 'failed to read auth file')
                return null
            }
        } finally {
            release()
            releaseFileLock(fp)
        }
    }

    // ─── Remove File ────────────────────────────────────────────────────────────
    const removeData = async (file) => {
        const fp = filePath(file)
        const mutex = getFileLock(fp)
        const release = await mutex.acquire()
        try {
            await unlink(fp).catch(() => { })
        } finally {
            release()
            releaseFileLock(fp)
        }
    }

    // ─── Credentials Bootstrap ──────────────────────────────────────────────────
    let creds = (await readData('creds.json')) || initAuthCreds()
    if (!creds.__version) {
        creds.__version = CURRENT_VERSION
    } else if (creds.__version < CURRENT_VERSION) {
        creds.__version = CURRENT_VERSION
    }

    // ─── Prekey Cleanup ─────────────────────────────────────────────────────────
    let cleanupRunning = false
    let lastCleanupAt = 0
    let lastCleanedPreKeyId = creds.nextPreKeyId

    const cleanOldPreKeys = async () => {
        const now = Date.now()
        if (cleanupRunning) return
        if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
        cleanupRunning = true
        try {
            const minId = creds.nextPreKeyId - preKeyRetention
            if (minId <= 0) return
            const files = await readdir(folder)
            const targets = []
            for (const file of files) {
                const match = file.match(/^pre-key-(\d+)\.json(\.tmp)?$/)
                if (!match) continue
                if (parseInt(match[1], 10) < minId) targets.push(join(folder, file))
            }
            if (!targets.length) return
            await Promise.all(targets.map(f => unlink(f).catch(() => { })))
            lastCleanupAt = Date.now()
            lastCleanedPreKeyId = creds.nextPreKeyId
            logger?.info({ deleted: targets.length, minId }, 'prekey cleanup complete')
        } catch (err) {
            logger?.warn({ err }, 'prekey cleanup failed')
        } finally {
            cleanupRunning = false
        }
    }

    cleanOldPreKeys().catch(() => { })

    // ─── Stats ──────────────────────────────────────────────────────────────────
    const getStats = async () => {
        const files = await readdir(folder).catch(() => [])
        const preKeyFiles = files.filter(f => /^pre-key-\d+\.json$/.test(f))
        return {
            totalFiles: files.length,
            preKeyCount: preKeyFiles.length,
            nextPreKeyId: creds.nextPreKeyId,
            lastCleanupAt: lastCleanupAt ? new Date(lastCleanupAt).toISOString() : null,
        }
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`)
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value)
                        }
                        data[id] = value
                    }))
                    return data
                },
                set: async (data) => {
                    const tasks = []
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id]
                            tasks.push(value ? writeData(value, `${category}-${id}.json`) : removeData(`${category}-${id}.json`))
                        }
                    }
                    await Promise.all(tasks)
                },
            },
        },
        saveCreds: async () => {
            if (creds.nextPreKeyId - lastCleanedPreKeyId >= cleanupThreshold) {
                cleanOldPreKeys().catch(() => { })
            }
            return writeData(creds, 'creds.json')
        },
        getStats,
    }
}