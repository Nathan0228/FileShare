import { sha256 } from '@noble/hashes/sha2.js'
import { CHUNK_BYTES, DIGEST_BYTES, MAX_FILE_BYTES } from '../../services/protocol.js'

export { CHUNK_BYTES, MAX_FILE_BYTES }

export class IntegrityError extends Error {}

const hashReadSize = 1024 * 1024

export function fileProblem(file) {
  if (file.size > MAX_FILE_BYTES) return '单个文件不能超过 512 MiB。'
  if (!file.name || file.name === '.' || file.name === '..' || new TextEncoder().encode(file.name).length > 120 ||
      /[\\/\p{Cc}\p{Bidi_Control}]/u.test(file.name)) {
    return '文件名须为 1 到 120 字节，且不能含有路径分隔符或控制字符。'
  }
  return ''
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`
}

export function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function chunkCount(size) {
  return Math.ceil(size / CHUNK_BYTES)
}

export function chunkLength(size, index) {
  return Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES)
}

export async function hashFile(file, checkpoint) {
  const hash = sha256.create()
  for (let start = 0; start < file.size; start += hashReadSize) {
    checkpoint()
    const block = new Uint8Array(await file.slice(start, start + hashReadSize).arrayBuffer())
    hash.update(block)
  }
  checkpoint()
  return hex(hash.digest())
}

export async function makeChunk(file, index) {
  const start = index * CHUNK_BYTES
  const data = new Uint8Array(await file.slice(start, start + CHUNK_BYTES).arrayBuffer())
  const body = new Uint8Array(DIGEST_BYTES + data.length)
  body.set(sha256(data))
  body.set(data, DIGEST_BYTES)
  return body
}

export function checkChunk(body, size, index) {
  if (!(body instanceof Uint8Array) || body.length !== DIGEST_BYTES + chunkLength(size, index)) {
    throw new IntegrityError('收到的文件分片长度不正确。')
  }
  const data = body.subarray(DIGEST_BYTES)
  const digest = hex(body.subarray(0, DIGEST_BYTES))
  if (hex(sha256(data)) !== digest) throw new IntegrityError('文件分片完整性校验未通过。')
  return { digest, blob: new Blob([data]) }
}

export async function checkStoredChunk(chunk, size, index) {
  if (!(chunk?.blob instanceof Blob) || chunk.blob.size !== chunkLength(size, index)) return null
  const bytes = new Uint8Array(await chunk.blob.arrayBuffer())
  return hex(sha256(bytes)) === chunk.digest ? bytes : null
}

export async function verifyDownload(storage, task, checkpoint, onChunk) {
  const hash = sha256.create()
  for (let index = 0; index < chunkCount(task.size); index += 1) {
    checkpoint()
    const chunk = await storage.getChunk(task.id, index)
    const bytes = await checkStoredChunk(chunk, task.size, index)
    if (!bytes) throw new IntegrityError('本地文件分片缺失或校验失败，请重新下载。')
    hash.update(bytes)
    if (onChunk) await onChunk(chunk.blob)
  }
  checkpoint()
  return hex(hash.digest())
}
