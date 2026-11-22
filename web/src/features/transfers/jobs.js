import { sha256 } from '@noble/hashes/sha2.js'
import { decodeBase64Url } from '../../services/encoding.js'
import { Type } from '../../services/protocol.js'
import {
  CHUNK_BYTES, MAX_FILE_BYTES, checkChunk, checkStoredChunk, chunkCount,
  chunkLength, hashFile, hex, IntegrityError, makeChunk, verifyDownload,
} from './file-data.js'

export async function findUpload(operation) {
  if (operation.task.uploadId) return operation.task.uploadId
  const { id, name, size, sha256 } = operation.task
  await operation.update({ beginAttempted: true })
  const reply = await operation.ask(Type.PUT_BEGIN, { body: { opId: id, name, size, sha256 } })
  if (!reply.transferId || reply.body?.size !== size || reply.body.sha256 !== sha256 || reply.body.chunkBytes !== CHUNK_BYTES) {
    throw new Error('上传清单与原文件不匹配。')
  }
  await operation.update({ uploadId: reply.transferId })
  return reply.transferId
}

export async function performUpload(operation) {
  await operation.update({ status: 'hashing' })
  const sha256 = await hashFile(operation.file, operation.checkpoint)
  if (operation.task.sha256 && operation.task.sha256 !== sha256) {
    operation.discardFile()
    throw new Error('请选择上传任务对应的原文件。文件摘要与原记录不一致。')
  }
  await operation.update({ sha256 })
  operation.checkpoint()

  const transferId = await findUpload(operation)
  operation.checkpoint()
  const { body: info } = await operation.ask(Type.PUT_STATUS, { transferId })
  if (info?.state === 'READY' && info.fileId) {
    await operation.update({ status: 'complete', fileId: info.fileId, completedBytes: operation.task.size })
    return
  }
  if (info?.state === 'OPEN') {
    await sendChunks(operation, transferId, info.bitmap)
  } else if (info?.state !== 'VERIFYING') {
    throw new Error(info?.state === 'EXPIRED' ? '服务器上的上传断点已过期。请重新添加文件。' : '上传任务已结束。请重新添加文件。')
  }

  operation.checkpoint()
  await operation.update({ status: 'verifying', completedBytes: operation.task.size })
  const { body } = await operation.ask(Type.PUT_COMMIT, { transferId, timeoutMs: 130_000 })
  if (!body?.fileId) throw new Error('服务器未确认文件发布。')
  await operation.update({ status: 'complete', fileId: body.fileId, completedBytes: operation.task.size })
}

async function sendChunks(operation, transferId, bitmap) {
  const { size } = operation.task
  const total = chunkCount(size)
  const confirmed = bitmap === '' ? new Uint8Array() : decodeBase64Url(bitmap)
  if (confirmed.length !== Math.ceil(total / 8)) throw new Error('服务器返回的上传断点无效。')
  const missing = []
  let completedBytes = 0
  for (let index = 0; index < total; index += 1) {
    if (confirmed[index >> 3] & (1 << (index % 8))) completedBytes += chunkLength(size, index)
    else missing.push(index)
  }
  await operation.update({ status: 'transferring', completedBytes })
  await transferInPairs(operation, missing, async (chunkIndex) => {
    const body = await makeChunk(operation.file, chunkIndex)
    operation.checkpoint()
    await operation.ask(Type.PUT_DATA, { transferId, chunkIndex, body })
    return chunkLength(size, chunkIndex)
  })
}

async function openDownload(ask, fileId) {
  const { body: manifest } = await ask(Type.GET_BEGIN, { body: { fileId } })
  if (!manifest || typeof manifest.name !== 'string' || !Number.isSafeInteger(manifest.size) ||
      manifest.size < 0 || manifest.size > MAX_FILE_BYTES || manifest.chunkBytes !== CHUNK_BYTES ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('服务器返回的下载清单无效。')
  }
  return manifest
}

export async function readVerifiedPreview(ask, file, byteLimit, signal) {
  const { fileId } = file
  const manifest = await openDownload(ask, fileId)
  signal.throwIfAborted()
  const { size, sha256: expectedDigest } = manifest
  if (size > byteLimit || size !== file.size || manifest.name !== file.name) {
    throw new Error('预览清单与文件列表不匹配，请刷新列表。')
  }

  const bytes = new Uint8Array(size)
  for (let chunkIndex = 0; chunkIndex < chunkCount(size); chunkIndex += 1) {
    const { body } = await ask(Type.GET_CHUNK, { transferId: fileId, chunkIndex })
    const { data } = checkChunk(body, size, chunkIndex)
    bytes.set(data, chunkIndex * CHUNK_BYTES)
  }
  signal.throwIfAborted()
  if (hex(sha256(bytes)) !== expectedDigest) {
    throw new IntegrityError('整文件完整性校验未通过。')
  }
  return bytes
}

export async function performDownload(operation) {
  const { id, fileId } = operation.task
  const manifest = await openDownload(operation.ask, fileId)
  if (operation.task.sha256 && (operation.task.sha256 !== manifest.sha256 || operation.task.size !== manifest.size)) {
    await operation.storage.deleteChunks(id)
  }
  const { name, size, sha256 } = manifest
  await operation.update({ name, size, sha256, status: 'transferring', completedBytes: 0 })
  const total = chunkCount(size)
  const missing = []
  let completedBytes = 0

  for (let index = 0; index < total; index += 1) {
    operation.checkpoint()
    const stored = await operation.storage.getChunk(id, index)
    if (await checkStoredChunk(stored, size, index)) {
      completedBytes += chunkLength(size, index)
    } else {
      if (stored) await operation.storage.deleteChunk(id, index)
      missing.push(index)
    }
  }
  const budget = await navigator.storage?.estimate?.().catch(() => null)
  if (budget?.quota != null && budget.usage != null && size - completedBytes > budget.quota - budget.usage) {
    throw new Error('浏览器剩余空间不足。请保存或清除旧的下载任务后重试。')
  }
  await operation.update({ completedBytes })
  await transferInPairs(operation, missing, async (chunkIndex) => {
    const { body } = await operation.ask(Type.GET_CHUNK, { transferId: fileId, chunkIndex })
    const { digest, data } = checkChunk(body, size, chunkIndex)
    await operation.storage.putChunk(id, chunkIndex, digest, new Blob([data]))
    return data.length
  })

  operation.checkpoint()
  await operation.update({ status: 'verifying' })
  if (await verifyDownload(operation.storage, operation.task, operation.checkpoint) !== sha256) {
    await operation.storage.deleteChunks(id)
    await operation.update({ completedBytes: 0 })
    throw new Error('整文件完整性校验未通过。请重新下载。')
  }
  await operation.ask(Type.GET_DONE, { transferId: fileId, body: { sha256 } })
  await operation.update({ status: 'ready', completedBytes: size })
}

async function transferInPairs(operation, indexes, transfer) {
  for (let offset = 0; offset < indexes.length; offset += 2) {
    operation.checkpoint()
    const results = await Promise.allSettled(indexes.slice(offset, offset + 2).map(transfer))
    const added = results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0), 0)
    if (added) await operation.update({ completedBytes: operation.task.completedBytes + added })
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }
}
