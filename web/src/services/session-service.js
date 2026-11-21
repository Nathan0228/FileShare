import { SftError } from './errors.js'
import { answerPasskeyChallenge, verifyPasskeySupport } from './passkey.js'
import { isTransferId, Type } from './protocol.js'
import { configuredEndpoint, SftSocket } from './socket.js'

const permittedActions = new Set(['UPLOAD', 'DOWNLOAD', 'SHARE'])
const usernamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const emptySnapshot = Object.freeze({ user: null, status: 'idle' })

function challengeFrom(body) {
  if (typeof body?.challengeId !== 'string' || !body.challengeId || !body.options || typeof body.options !== 'object') {
    throw new SftError('PROTOCOL_ERROR')
  }
  return body
}

function identityFrom(body, username) {
  if (!isTransferId(body?.userId) || (body.role !== 'admin' && body.role !== 'user') ||
    !Array.isArray(body.permissions) || body.permissions.some((permission) => !permittedActions.has(permission)) ||
    typeof body.token !== 'string' || !tokenPattern.test(body.token)) {
    throw new SftError('PROTOCOL_ERROR')
  }
  return Object.freeze({
    userId: body.userId,
    role: body.role,
    permissions: Object.freeze([...body.permissions]),
    username,
  })
}

function waitFor(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export class SessionService {
  #listeners = new Set()
  #snapshot = emptySnapshot
  #token = null
  #link = null
  #opening = null
  #retryTimer = null
  #retryCount = 0
  #version = 0
  #ceremony = null
  #loggingOut = false

  constructor(endpoint = configuredEndpoint()) {
    this.endpoint = endpoint
  }

  getSnapshot = () => this.#snapshot

  subscribe = (listener) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #update(status, user = this.#snapshot.user) {
    if (status === this.#snapshot.status && user === this.#snapshot.user) return
    this.#snapshot = Object.freeze({ user, status })
    for (const listener of this.#listeners) listener()
  }

  #clearRetry() {
    clearTimeout(this.#retryTimer)
    this.#retryTimer = null
  }

  #onDisconnected(error) {
    if (this.#token && error.retryable && !this.#loggingOut) {
      this.#update('reconnecting')
      if (this.#retryTimer !== null) return
      const delay = Math.min(20000, 500 * 2 ** Math.min(this.#retryCount, 6))
      this.#retryCount++
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null
        this.#connect().catch(() => {})
      }, delay * (0.8 + Math.random() * 0.4))
    } else {
      this.#update('offline')
    }
  }

  #connect() {
    if (this.#opening) return this.#opening
    if (this.#link?.isOpen) return Promise.resolve(this.#link)
    this.#clearRetry()
    const link = new SftSocket(this.endpoint, (closed, error) => {
      if (this.#link !== closed) return
      this.#link = null
      this.#ceremony?.abort(error)
      if (!this.#opening) this.#onDisconnected(error)
    })
    this.#link = link
    const version = this.#version
    const opening = this.#openLink(link, version).finally(() => {
      if (this.#opening === opening) this.#opening = null
    })
    this.#opening = opening
    this.#update(this.#token ? 'reconnecting' : 'connecting')
    return opening
  }

  async #openLink(link, version) {
    try {
      await link.open()
      if (this.#link !== link) throw new SftError('CONNECTION_LOST', true)
      let user = this.#snapshot.user
      if (this.#token) {
        try {
          const { body } = await link.request(Type.SESSION_ATTACH, { body: { token: this.#token } })
          if (this.#link !== link) throw new SftError('CONNECTION_LOST', true)
          const identity = identityFrom(body, user.username)
          if (identity.userId !== user.userId) throw new SftError('PROTOCOL_ERROR')
          this.#token = body.token
          user = identity
        } catch (error) {
          if (error.code !== 'UNAUTH') throw error
          if (this.#link !== link) throw new SftError('CONNECTION_LOST', true)
          this.#token = null
          user = null
        }
      }
      if (this.#link !== link) throw new SftError('CONNECTION_LOST', true)
      this.#retryCount = 0
      this.#update('online', user)
      return link
    } catch (error) {
      if (this.#link === link) {
        this.#link = null
        link.close(error)
      }
      if (version === this.#version) this.#onDisconnected(error)
      throw error
    }
  }

  reconnect = async () => {
    await this.#connect()
  }

  login = async (enteredUsername, { signal } = {}) => {
    const username = typeof enteredUsername === 'string' ? enteredUsername.trim() : ''
    if (!usernamePattern.test(username)) throw new SftError('USERNAME_INVALID')
    return this.#passkey(false, { username }, signal)
  }

  enroll = async (enteredToken, { signal } = {}) => {
    const inviteToken = typeof enteredToken === 'string' ? enteredToken.trim() : ''
    if (!tokenPattern.test(inviteToken)) throw new SftError('INVITE_INVALID')
    return this.#passkey(true, { inviteToken }, signal)
  }

  async #passkey(enrollment, body, callerSignal) {
    callerSignal?.throwIfAborted()
    if (this.#ceremony || this.#token || this.#loggingOut) throw new SftError('BUSY')
    verifyPasskeySupport()
    const ceremony = new AbortController()
    const { signal } = ceremony
    this.#ceremony = ceremony
    const cancel = () => {
      ceremony.abort(callerSignal.reason)
      // A late AUTH_FINISH can bind the account even after its request is cancelled.
      if (this.#ceremony === ceremony && !this.#token) this.reset()
    }
    callerSignal?.addEventListener('abort', cancel, { once: true })
    try {
      const link = await waitFor(this.#connect(), signal)
      const begin = enrollment ? Type.ENROLL_BEGIN : Type.AUTH_BEGIN
      const challenge = await link.request(begin, { body, signal })
      const { challengeId, options } = challengeFrom(challenge.body)
      const credential = await answerPasskeyChallenge(options, { enrollment, signal })
      const finish = enrollment ? Type.ENROLL_FINISH : Type.AUTH_FINISH
      const response = await link.request(finish, { body: { challengeId, credential }, signal })
      signal.throwIfAborted()
      if (enrollment) return { username: options.user?.name ?? '' }
      const identity = identityFrom(response.body, body.username)
      this.#token = response.body.token
      this.#update('online', identity)
      return identity
    } finally {
      callerSignal?.removeEventListener('abort', cancel)
      if (this.#ceremony === ceremony) this.#ceremony = null
    }
  }

  request = async (type, options = {}) => {
    options.signal?.throwIfAborted()
    if (type <= Type.LOGOUT) throw new SftError('BAD_REQUEST')
    const userId = this.#snapshot.user?.userId
    if (!userId || this.#loggingOut) throw new SftError('UNAUTH')
    const version = this.#version
    const link = await waitFor(this.#connect(), options.signal)
    this.#checkActiveSession(userId, version)
    try {
      const response = await link.request(type, options)
      this.#checkActiveSession(userId, version)
      return response
    } catch (error) {
      if (error?.code === 'UNAUTH' && this.#link === link && !this.#loggingOut) this.reset()
      throw error
    }
  }

  #checkActiveSession(userId, version) {
    if (this.#version !== version || this.#snapshot.user?.userId !== userId || this.#loggingOut) {
      throw new DOMException('Session changed', 'AbortError')
    }
  }

  logout = async () => {
    if (this.#loggingOut) return false
    this.#loggingOut = true
    this.#clearRetry()
    this.#ceremony?.abort()
    try {
      if (!this.#token) return true
      if (!this.#link?.isOpen) return false
      await this.#link.request(Type.LOGOUT, { timeoutMs: 5000 })
      return true
    } catch {
      return false
    } finally {
      this.reset()
      this.#loggingOut = false
    }
  }

  reset = () => {
    this.#version++
    this.#token = null
    this.#retryCount = 0
    this.#clearRetry()
    this.#ceremony?.abort()
    this.#ceremony = null
    const link = this.#link
    this.#link = null
    this.#opening = null
    link?.close()
    this.#update('idle', null)
  }
}
