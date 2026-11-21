import { SftError } from './errors.js'

export const Type = Object.freeze({
  ENROLL_BEGIN: 0x01, CHALLENGE: 0x02, ENROLL_FINISH: 0x03,
  AUTH_BEGIN: 0x04, AUTH_FINISH: 0x05, AUTH_OK: 0x06, SESSION_ATTACH: 0x07, LOGOUT: 0x08,
  LIST: 0x10, LIST_OK: 0x11, SHARE_SET: 0x12, ADMIN: 0x13, FILE_DELETE: 0x14,
  PUT_BEGIN: 0x20, PUT_READY: 0x21, PUT_DATA: 0x22, PUT_STATUS: 0x23, PUT_STATE: 0x24,
  PUT_COMMIT: 0x25, PUT_DONE: 0x26, PUT_CANCEL: 0x27, PUT_PAUSE: 0x28,
  GET_BEGIN: 0x30, GET_READY: 0x31, GET_CHUNK: 0x32, GET_DATA: 0x33,
  GET_DONE: 0x34, GET_CLOSE: 0x35, OK: 0x7d, ERROR: 0x7e,
})

export const SUBPROTOCOL = 'sft.v1'
export const NO_CHUNK = 0xffffffff
export const CHUNK_BYTES = 256 * 1024
export const DIGEST_BYTES = 32
export const MAX_FILE_BYTES = 512 * 1024 * 1024

const headerBytes = 32
const maxControlBytes = 16 * 1024
const maxDataBytes = DIGEST_BYTES + CHUNK_BYTES
const maxMessageBytes = headerBytes + maxDataBytes
const zeroUuid = '00000000-0000-0000-0000-000000000000'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const requestRules = new Map([
  [Type.ENROLL_BEGIN, { reply: Type.CHALLENGE, payload: 'json' }],
  [Type.ENROLL_FINISH, { reply: Type.OK, payload: 'json' }],
  [Type.AUTH_BEGIN, { reply: Type.CHALLENGE, payload: 'json' }],
  [Type.AUTH_FINISH, { reply: Type.AUTH_OK, payload: 'json' }],
  [Type.SESSION_ATTACH, { reply: Type.AUTH_OK, payload: 'json' }],
  [Type.LOGOUT, { reply: Type.OK }],
  [Type.LIST, { reply: Type.LIST_OK, payload: 'json' }],
  [Type.SHARE_SET, { reply: Type.OK, payload: 'json' }],
  [Type.ADMIN, { reply: Type.OK, payload: 'json' }],
  [Type.FILE_DELETE, { reply: Type.OK, payload: 'json' }],
  [Type.PUT_BEGIN, { reply: Type.PUT_READY, payload: 'json' }],
  [Type.PUT_DATA, { reply: Type.OK, payload: 'binary', transfer: true, chunk: true }],
  [Type.PUT_STATUS, { reply: Type.PUT_STATE, transfer: true }],
  [Type.PUT_COMMIT, { reply: Type.PUT_DONE, transfer: true }],
  [Type.PUT_CANCEL, { reply: Type.OK, transfer: true }],
  [Type.PUT_PAUSE, { reply: Type.OK, transfer: true }],
  [Type.GET_BEGIN, { reply: Type.GET_READY, payload: 'json' }],
  [Type.GET_CHUNK, { reply: Type.GET_DATA, transfer: true, chunk: true }],
  [Type.GET_DONE, { reply: Type.OK, payload: 'json', transfer: true }],
  [Type.GET_CLOSE, { reply: Type.OK, transfer: true }],
])
const responseTypes = new Set([...requestRules.values()].map(({ reply }) => reply))
responseTypes.add(Type.ERROR)

export function isTransferId(value) {
  return typeof value === 'string' && uuidPattern.test(value) && value !== zeroUuid
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function encodeBody(rule, body) {
  if (rule.payload === 'binary') {
    if (!(body instanceof Uint8Array) || body.byteLength <= DIGEST_BYTES || body.byteLength > maxDataBytes) {
      throw new SftError('BAD_REQUEST')
    }
    return body
  }
  if (rule.payload === 'json') {
    if (!isRecord(body) || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) throw new SftError('BAD_REQUEST')
    const payload = encoder.encode(JSON.stringify(body))
    if (payload.byteLength > maxControlBytes) throw new SftError('BAD_REQUEST')
    return payload
  }
  if (body != null) throw new SftError('BAD_REQUEST')
  return new Uint8Array(0)
}

export function encodeRequest(type, requestId, { body, transferId = null, chunkIndex = NO_CHUNK } = {}) {
  const rule = requestRules.get(type)
  if (!rule || !Number.isInteger(requestId) || requestId < 1 || requestId > NO_CHUNK ||
    (rule.transfer ? !isTransferId(transferId) : transferId !== null) ||
    (rule.chunk ? !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= NO_CHUNK : chunkIndex !== NO_CHUNK)) {
    throw new SftError('BAD_REQUEST')
  }
  const payload = encodeBody(rule, body)
  const frame = new Uint8Array(headerBytes + payload.byteLength)
  const header = new DataView(frame.buffer)
  header.setUint16(0, 0x5346)
  header.setUint8(2, 1)
  header.setUint8(3, type)
  header.setUint32(4, payload.byteLength)
  header.setUint32(8, requestId)
  if (transferId) {
    const hex = transferId.replaceAll('-', '')
    for (let index = 0; index < 16; index++) frame[12 + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  header.setUint32(28, chunkIndex)
  frame.set(payload, headerBytes)
  return frame
}

function readTransferId(frame) {
  const hex = Array.from(new Uint8Array(frame, 12, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return uuid === zeroUuid ? null : uuid
}

function readBody(type, payload) {
  if (type === Type.GET_DATA) {
    if (payload.byteLength <= DIGEST_BYTES || payload.byteLength > maxDataBytes) throw new SftError('PROTOCOL_ERROR')
    return payload
  }
  if (payload.byteLength === 0 && type === Type.OK) return null
  if (payload.byteLength > maxControlBytes) throw new SftError('PROTOCOL_ERROR')
  let body
  try {
    body = JSON.parse(decoder.decode(payload))
  } catch (cause) {
    throw new SftError('PROTOCOL_ERROR', false, { cause })
  }
  if (!isRecord(body)) throw new SftError('PROTOCOL_ERROR')
  if (type === Type.ERROR && (typeof body.code !== 'string' || typeof body.retryable !== 'boolean')) {
    throw new SftError('PROTOCOL_ERROR')
  }
  return body
}

export function decodeResponse(frame) {
  if (!(frame instanceof ArrayBuffer) || frame.byteLength < headerBytes || frame.byteLength > maxMessageBytes) {
    throw new SftError('PROTOCOL_ERROR')
  }
  const header = new DataView(frame)
  const requestId = header.getUint32(8)
  const type = header.getUint8(3)
  if (header.getUint16(0) !== 0x5346 || header.getUint8(2) !== 1 || requestId === 0 ||
    header.getUint32(4) !== frame.byteLength - headerBytes || !responseTypes.has(type)) {
    throw new SftError('PROTOCOL_ERROR')
  }
  return {
    type,
    requestId,
    transferId: readTransferId(frame),
    chunkIndex: header.getUint32(28),
    body: readBody(type, new Uint8Array(frame, headerBytes)),
  }
}

export function checkResponse(type, options, response) {
  const rule = requestRules.get(type)
  const failed = response.type === Type.ERROR
  let expectedId = options.transferId ?? null
  if (!failed && type === Type.GET_BEGIN) expectedId = options.body.fileId
  if (!failed && type === Type.PUT_BEGIN && response.transferId !== null) expectedId = response.transferId
  if ((!failed && response.type !== rule.reply) || response.transferId !== expectedId ||
    (!failed && type === Type.PUT_BEGIN && response.transferId === null) ||
    response.chunkIndex !== (options.chunkIndex ?? NO_CHUNK) ||
    (response.type === Type.OK && type !== Type.ADMIN && response.body !== null)) {
    throw new SftError('PROTOCOL_ERROR')
  }
}
