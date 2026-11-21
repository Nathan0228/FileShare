import { SftError } from './errors.js'
import { checkResponse, decodeResponse, encodeRequest, NO_CHUNK, SUBPROTOCOL, Type } from './protocol.js'

const connectionTimeout = 8000
const requestTimeout = 15000
const maxPendingRequests = 24
const maxSendBuffer = 2 * 1024 * 1024
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

export function configuredEndpoint() {
  return import.meta.env?.VITE_SFT_WS_URL?.trim() || (import.meta.env?.PROD
    ? 'wss://fs-api.findingai.top/sft'
    : 'ws://127.0.0.1:8080/sft')
}

function endpointUrl(endpoint) {
  let url
  try {
    url = new URL(endpoint)
  } catch (cause) {
    throw new SftError('ENDPOINT_INVALID', false, { cause })
  }
  const localDev = !import.meta.env?.PROD && url.protocol === 'ws:' && localHosts.has(url.hostname)
  if ((!localDev && url.protocol !== 'wss:') || url.pathname !== '/sft' || url.search || url.hash ||
    url.username || url.password || /[?#]/.test(endpoint)) {
    throw new SftError('ENDPOINT_INVALID')
  }
  return url.href
}

export class SftSocket {
  #socket = null
  #opening = null
  #finishOpening = null
  #pending = new Map()
  #issued = 0
  #closed = false

  constructor(endpoint, onClose) {
    this.endpoint = endpoint
    this.onClose = onClose
  }

  get isOpen() {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  open() {
    if (this.#closed) return Promise.reject(new SftError('CONNECTION_LOST', true))
    if (this.isOpen) return Promise.resolve()
    if (this.#opening) return this.#opening
    this.#opening = new Promise((resolve, reject) => {
      let socket
      try {
        socket = new WebSocket(endpointUrl(this.endpoint), SUBPROTOCOL)
      } catch (error) {
        reject(error instanceof SftError ? error : new SftError('CONNECTION_LOST', true, { cause: error }))
        return
      }
      this.#socket = socket
      socket.binaryType = 'arraybuffer'
      const timer = setTimeout(() => this.close(new SftError('CONNECTION_TIMEOUT', true)), connectionTimeout)
      this.#finishOpening = (error) => {
        clearTimeout(timer)
        this.#finishOpening = null
        if (error) reject(error)
        else resolve()
      }
      socket.onopen = () => {
        if (socket.protocol !== SUBPROTOCOL) {
          this.close(new SftError('PROTOCOL_ERROR'))
          return
        }
        this.#finishOpening?.()
      }
      socket.onmessage = ({ data }) => this.#receive(data)
      socket.onerror = () => this.close()
      socket.onclose = () => this.close()
    }).finally(() => { this.#opening = null })
    return this.#opening
  }

  request(type, options = {}) {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.isOpen) return Promise.reject(new SftError('CONNECTION_LOST', true))
    if (this.#pending.size >= maxPendingRequests || this.#socket.bufferedAmount > maxSendBuffer) {
      return Promise.reject(new SftError('BUSY', true))
    }
    if (this.#issued === NO_CHUNK) {
      this.close()
      return Promise.reject(new SftError('CONNECTION_LOST', true))
    }
    const requestId = this.#issued + 1
    let frame
    try {
      frame = encodeRequest(type, requestId, options)
    } catch (error) {
      return Promise.reject(error)
    }
    if (signal?.aborted) return Promise.reject(signal.reason)
    this.#issued = requestId
    return new Promise((resolve, reject) => {
      const abort = () => finish(signal.reason)
      const timer = setTimeout(() => finish(new SftError('CONNECTION_TIMEOUT', true)), options.timeoutMs ??
        (type === Type.PUT_COMMIT ? 130000 : requestTimeout))
      const finish = (error, response) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.#pending.delete(requestId)
        if (response === undefined) reject(error)
        else resolve(response)
      }
      this.#pending.set(requestId, { type, options, finish })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.#socket.send(frame)
      } catch (cause) {
        this.close(new SftError('CONNECTION_LOST', true, { cause }))
      }
    })
  }

  #receive(data) {
    try {
      const response = decodeResponse(data)
      const pending = this.#pending.get(response.requestId)
      if (!pending) {
        // An aborted or timed-out request can still receive its server reply.
        if (response.requestId > this.#issued) throw new SftError('PROTOCOL_ERROR')
        return
      }
      checkResponse(pending.type, pending.options, response)
      if (response.type === Type.ERROR) {
        pending.finish(new SftError(response.body.code, response.body.retryable))
      } else {
        pending.finish(null, response)
      }
    } catch (cause) {
      this.close(new SftError('PROTOCOL_ERROR', false, { cause }))
    }
  }

  close(error = new SftError('CONNECTION_LOST', true)) {
    if (this.#closed) return
    this.#closed = true
    this.#finishOpening?.(error)
    for (const pending of this.#pending.values()) pending.finish(error)
    if (this.#socket) {
      const socket = this.#socket
      this.#socket = null
      socket.onclose = socket.onerror = socket.onopen = socket.onmessage = null
      socket.close(error.code === 'PROTOCOL_ERROR' ? 4002 : 1000)
    }
    this.onClose?.(this, error)
  }
}
