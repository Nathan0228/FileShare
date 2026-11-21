import { getErrorMessage, SftError } from '../../services/errors.js'
import { Type } from '../../services/protocol.js'
import { fileProblem, IntegrityError, verifyDownload } from './file-data.js'
import { findUpload, performDownload, performUpload } from './jobs.js'
import { createTransferStorage } from './storage.js'

const MAX_ACTIVE = 4
const terminal = new Set(['complete', 'ready', 'cancelled'])
export const workingStatuses = new Set(['hashing', 'transferring', 'verifying', 'pausing', 'cancelling'])
const stopRequested = Symbol('transfer interrupted')
const lostConnection = (error) => error?.code === 'CONNECTION_LOST' || error?.code === 'CONNECTION_TIMEOUT'

function restoreTask(task) {
  if (terminal.has(task.status) || ['paused', 'error', 'needs-file'].includes(task.status)) return task
  const status = task.cancelRequested ? 'cancel-pending'
    : task.kind === 'upload' ? 'needs-file' : 'queued'
  return { ...task, status }
}

function message(error) {
  if (error?.name === 'QuotaExceededError') return '浏览器存储空间不足。请保存或清除旧下载后重试。'
  return error?.code ? getErrorMessage(error) : error?.message || '传输未完成，请重试。'
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class TransferQueue {
  #owner
  #request
  #storage
  #controller
  #online = false
  #connectionEpoch = 0
  #listeners = new Set()
  #tasks = new Map()
  #files = new Map()
  #active = new Map()
  #editing = new Set()
  #saving = new Set()
  #scheduled = false
  #retryTimer
  #snapshot = { tasks: [], activeCount: 0, completedUploads: 0, storageReady: false, storageError: '', saving: [] }

  constructor(owner, request) {
    this.#owner = owner
    this.#request = request
  }

  subscribe = (listener) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    if (!this.#owner) return undefined
    const controller = new AbortController()
    this.#controller = controller
    createTransferStorage(this.#owner).then(async (storage) => {
      const records = await storage.getTasks()
      if (controller.signal.aborted) return
      this.#storage = storage
      this.#tasks = new Map(records.map((task) => [task.id, restoreTask(task)]))
      this.#emit({ storageReady: true, storageError: '' })
      this.#schedule()
    }).catch((error) => {
      if (!controller.signal.aborted) this.#emit({ storageError: `无法读取本地传输记录。${message(error)}` })
    })
    return () => {
      controller.abort()
      this.#online = false
      clearTimeout(this.#retryTimer)
      this.#retryTimer = undefined
      this.#files.clear()
    }
  }

  setOnline(online) {
    if (this.#online && !online) this.#connectionEpoch += 1
    this.#online = online
    this.#schedule()
  }

  enqueueUploads = async (files) => {
    this.#assertStorage()
    const selection = Array.from(files)
    for (const file of selection) {
      const problem = fileProblem(file)
      if (problem) throw new Error(`${file.name} · ${problem}`)
    }
    for (const file of selection) {
      const id = crypto.randomUUID()
      this.#files.set(id, file)
      try {
        await this.#put({ id, kind: 'upload', name: file.name, size: file.size, status: 'queued', completedBytes: 0, createdAt: Date.now() })
        this.#schedule()
      } catch (error) {
        this.#files.delete(id)
        throw error
      }
    }
    return selection.length
  }

  enqueueDownload = async ({ fileId, name, size }) => {
    this.#assertStorage()
    const id = `download-${fileId}`
    const task = this.#tasks.get(id)
    if (task && task.status !== 'complete' && task.status !== 'cancelled') {
      if (['paused', 'error'].includes(task.status)) await this.resume(id)
      return id
    }
    navigator.storage?.persist?.().catch(() => {})
    await this.#withEditLock(id, async () => {
      const saved = await this.#storage.getTask(id)
      if (saved?.status === 'ready') {
        this.#tasks.set(id, saved)
        this.#emit()
      } else {
        await this.#put({ id, fileId, kind: 'download', name, size, status: 'queued', completedBytes: 0, createdAt: Date.now() })
      }
    })
    this.#schedule()
    return id
  }

  pause = async (id) => {
    const task = this.#tasks.get(id)
    if (!task || terminal.has(task.status)) return
    const running = this.#active.get(id)
    if (running) {
      running.intent = 'pause'
      if (running.locked) await this.#update(id, { status: 'pausing', error: '' })
      return
    }
    await this.#withInactiveTask(id, () => this.#update(id, { status: 'paused', error: '' }))
  }

  resume = async (id) => {
    const task = this.#tasks.get(id)
    if (!task || this.#active.has(id) || terminal.has(task.status)) return
    await this.#withInactiveTask(id, async (current) => {
      const status = current.cancelRequested ? 'cancel-pending' : current.kind === 'upload' && !this.#files.has(id) ? 'needs-file' : 'queued'
      await this.#update(id, { status, error: '' })
    })
    this.#schedule()
  }

  reselect = async (id, file) => {
    const task = this.#tasks.get(id)
    if (task?.kind !== 'upload' || this.#active.has(id) || terminal.has(task.status)) return
    if (file.name !== task.name || file.size !== task.size) throw new Error('请选择与原任务同名且大小一致的文件。')
    this.#files.set(id, file)
    await this.resume(id)
  }

  cancel = async (id) => {
    const task = this.#tasks.get(id)
    if (!task || terminal.has(task.status)) return
    const running = this.#active.get(id)
    if (running) {
      running.intent = 'cancel'
      if (running.locked) await this.#update(id, { status: 'cancelling', cancelRequested: true, error: '' })
      return
    }
    await this.#withInactiveTask(id, () => this.#update(id, { status: 'cancel-pending', cancelRequested: true, error: '' }))
    this.#schedule()
  }

  remove = async (id) => {
    const task = this.#tasks.get(id)
    if (!task || this.#active.has(id) || this.#saving.has(id)) return
    if (!terminal.has(task.status)) throw new Error('请先取消还未结束的传输任务。')
    await this.#withLock(id, async () => {
      const saved = await this.#storage.getTask(id)
      if (saved && !terminal.has(saved.status)) throw new Error('这项任务已在其他标签页继续。请先取消任务。')
      await this.#storage.deleteTask(id)
      this.#tasks.delete(id)
      this.#files.delete(id)
      this.#emit()
    })
  }

  save = async (id) => {
    const task = this.#tasks.get(id)
    if (task?.status !== 'ready' || this.#saving.has(id)) return
    const signal = this.#controller.signal
    this.#saving.add(id)
    this.#emit()
    let writable
    try {
      // The picker must be called during the click before any asynchronous storage work.
      const handle = await this.#saveHandle(task.name)
      signal.throwIfAborted()
      await this.#withLock(id, async () => {
        const saved = await this.#storage.getTask(id)
        if (saved?.status !== 'ready') {
          if (saved) this.#tasks.set(id, saved)
          else this.#tasks.delete(id)
          this.#emit()
          return
        }
        const parts = []
        if (handle) writable = await handle.createWritable()
        const digest = await verifyDownload(this.#storage, task, () => signal.throwIfAborted(), (blob) => {
          if (writable) return writable.write(blob)
          parts.push(blob)
        })
        if (digest !== task.sha256) {
          await this.#storage.deleteChunks(id)
          throw new IntegrityError('保存前的完整性校验未通过，请重新下载。')
        }
        if (writable) {
          await writable.close()
          writable = undefined
        } else {
          const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }))
          const link = document.createElement('a')
          link.href = url
          link.download = task.name
          document.body.append(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
        const complete = { ...task, status: 'complete' }
        await this.#storage.replaceTaskAndClearChunks(complete)
        if (!signal.aborted) {
          this.#tasks.set(id, complete)
          this.#emit()
        }
      })
    } catch (error) {
      await writable?.abort().catch(() => {})
      if (error instanceof IntegrityError && !signal.aborted) {
        await this.#update(id, { status: 'error', error: error.message })
      }
      if (error?.name !== 'AbortError') throw error
    } finally {
      this.#saving.delete(id)
      if (!signal.aborted) this.#emit()
    }
  }

  async #saveHandle(name) {
    if (typeof window.showSaveFilePicker !== 'function') return null
    try {
      return await window.showSaveFilePicker({ suggestedName: name })
    } catch (error) {
      // Embedded previews can restrict the native picker even when the API exists.
      if (error?.name === 'SecurityError') return null
      throw error
    }
  }

  async #put(task) {
    this.#assertStorage()
    const signal = this.#controller.signal
    await this.#storage.putTask(task)
    signal.throwIfAborted()
    this.#tasks.set(task.id, task)
    this.#emit()
  }

  async #update(id, changes) {
    this.#assertStorage()
    const previous = this.#tasks.get(id)
    const next = { ...previous, ...changes }
    this.#tasks.set(id, next)
    this.#emit()
    await this.#storage.putTask(next)
  }

  async #withInactiveTask(id, work) {
    this.#assertStorage()
    await this.#withEditLock(id, async () => {
      const task = await this.#reloadTask(id)
      if (task && !terminal.has(task.status)) await work(task)
      else this.#emit()
    })
  }

  async #reloadTask(id) {
    this.#assertStorage()
    const signal = this.#controller.signal
    const task = await this.#storage.getTask(id)
    signal.throwIfAborted()
    if (task) this.#tasks.set(id, task)
    else this.#tasks.delete(id)
    return task
  }

  #assertStorage() {
    this.#controller?.signal.throwIfAborted()
    if (!this.#storage) throw new Error('浏览器未能打开传输存储，请重新登录或刷新页面。')
  }

  #emit(changes) {
    const tasks = [...this.#tasks.values()].sort((left, right) => right.createdAt - left.createdAt)
    this.#snapshot = { ...this.#snapshot, tasks, activeCount: this.#active.size, saving: [...this.#saving], ...changes }
    this.#listeners.forEach((listener) => listener())
  }

  #schedule() {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      if (!this.#storage || this.#controller?.signal.aborted) return
      const tasks = [...this.#tasks.values()]
        .filter((task) => !this.#active.has(task.id) && !this.#editing.has(task.id))
        .sort((left, right) => left.createdAt - right.createdAt)
      for (const task of tasks) {
        if (this.#active.size === MAX_ACTIVE) break
        if (task.status === 'cancel-pending' && (this.#online || task.kind === 'download' || !task.beginAttempted)) this.#startTask(task, 'cancel')
        if (this.#online && task.status === 'queued') this.#startTask(task)
      }
    })
  }

  #startTask(task, intent = '') {
    const controller = this.#controller
    const job = { intent, locked: false }
    this.#active.set(task.id, job)
    this.#emit()
    this.#run(task.id, job, controller.signal).catch((error) => {
      if (controller.signal.aborted) return
      void this.#recordFailure(task.id, error, false)
    }).finally(() => {
      if (this.#active.get(task.id) === job) this.#active.delete(task.id)
      if (controller.signal.aborted) return
      this.#emit()
      this.#schedule()
    })
  }

  async #run(id, job, signal) {
    const queue = this
    const epoch = this.#connectionEpoch
    const checkConnection = () => {
      if (!this.#online || epoch !== this.#connectionEpoch) throw new SftError('CONNECTION_LOST', true)
    }
    const operation = {
      get task() { return queue.#tasks.get(id) },
      file: this.#files.get(id),
      discardFile: () => this.#files.delete(id),
      storage: this.#storage,
      update: (next) => {
        signal.throwIfAborted()
        if (job.intent && ['hashing', 'transferring', 'verifying'].includes(next.status)) {
          next = { ...next, status: job.intent === 'pause' ? 'pausing' : 'cancelling' }
        }
        return this.#update(id, next)
      },
      ask: (type, options) => this.#ask(type, options, signal, checkConnection),
      checkpoint: () => {
        signal.throwIfAborted()
        if (job.intent) throw stopRequested
        checkConnection()
      },
    }
    await this.#withLock(id, async () => {
      signal.throwIfAborted()
      const saved = await this.#reloadTask(id)
      signal.throwIfAborted()
      if (!saved || terminal.has(saved.status)) {
        this.#files.delete(id)
        return
      }
      job.locked = true
      try {
        if (job.intent || saved.cancelRequested) {
          await this.#stopOperation(operation, saved.cancelRequested ? 'cancel' : job.intent)
          return
        }
        await this.#transfer(operation, job, signal)
      } catch (error) {
        if (signal.aborted) return
        if (lostConnection(error) || (!this.#online && error?.code === 'UNAUTH')) {
          const status = job.intent === 'pause' ? 'paused' : 'waiting'
          await this.#update(id, { status, error: '' })
          this.#retryWhenOnline()
        } else {
          await this.#recordFailure(id, error)
        }
      } finally {
        job.locked = false
      }
    })
  }

  async #transfer(operation, job, signal) {
    try {
      operation.checkpoint()
      if (operation.task.kind === 'download') {
        await performDownload(operation)
        return
      }
      if (!operation.file) {
        await operation.update({ status: 'needs-file' })
        return
      }
      await performUpload(operation)
      signal.throwIfAborted()
      this.#files.delete(operation.task.id)
      this.#emit({ completedUploads: this.#snapshot.completedUploads + 1 })
    } catch (error) {
      if (signal.aborted) return
      if (job.intent && (error === stopRequested || !terminal.has(operation.task.status))) {
        await this.#stopOperation(operation, job.intent)
        return
      }
      await this.#release(operation)
      if (error?.name === 'NotReadableError' && operation.task.kind === 'upload') {
        operation.discardFile()
        throw new Error('浏览器无法读取原文件，请重新选择后续传。', { cause: error })
      }
      throw error
    }
  }

  async #stopOperation(operation, intent) {
    const task = operation.task
    if (intent === 'pause') {
      await this.#release(operation)
      await operation.update({ status: 'paused', error: '' })
      return
    }

    await operation.update({ status: 'cancelling', cancelRequested: true, error: '' })

    if (task.kind === 'upload' && task.beginAttempted) {
      const transferId = await findUpload(operation)
      try {
        await operation.ask(Type.PUT_CANCEL, { transferId })
      } catch (error) {
        if (error.code === 'CONFLICT') {
          const { body } = await operation.ask(Type.PUT_STATUS, { transferId })
          if (body?.state === 'READY' && body.fileId) {
            await operation.update({ status: 'complete', cancelRequested: false, completedBytes: task.size, fileId: body.fileId })
            this.#files.delete(task.id)
            this.#emit({ completedUploads: this.#snapshot.completedUploads + 1 })
            return
          }
          if (!['FAILED', 'CANCELLED', 'EXPIRED'].includes(body?.state)) throw error
        } else if (error.code !== 'EXPIRED') {
          throw error
        }
      }
    }
    if (task.kind === 'download') {
      await this.#release(operation)
      await this.#storage.deleteChunks(task.id)
    }
    this.#files.delete(task.id)
    await operation.update({ status: 'cancelled', cancelRequested: false, completedBytes: 0 })
  }

  async #release(operation) {
    if (!this.#online) return
    try {
      const { kind, fileId, uploadId } = operation.task
      if (kind === 'download') await operation.ask(Type.GET_CLOSE, { transferId: fileId, timeoutMs: 3_000 })
      else if (uploadId) await operation.ask(Type.PUT_PAUSE, { transferId: uploadId, timeoutMs: 3_000 })
    } catch {
      // The peer may already have released a finished transfer or closed the socket.
    }
  }

  async #ask(type, options, signal, checkConnection) {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted()
      checkConnection()
      try {
        return await this.#request(type, { ...options, signal })
      } catch (error) {
        if (!error?.retryable || !['BUSY', 'STORAGE_UNAVAILABLE'].includes(error.code) || attempt >= 2) throw error
        await delay(150 * 2 ** attempt + Math.random() * 100, signal)
      }
    }
  }

  #retryWhenOnline() {
    if (this.#retryTimer) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      for (const task of this.#tasks.values()) {
        if (task.status === 'waiting') {
          this.#tasks.set(task.id, { ...task, status: task.cancelRequested ? 'cancel-pending' : 'queued' })
        }
      }
      this.#emit()
      this.#schedule()
    }, 600)
  }

  async #recordFailure(id, error, persist = true) {
    if (!this.#tasks.has(id)) return
    const task = this.#tasks.get(id)
    const status = task.kind === 'upload' && !this.#files.has(id) && !task.cancelRequested ? 'needs-file' : 'error'
    if (!persist) {
      this.#tasks.set(id, { ...task, status, error: message(error) })
      this.#emit()
      return
    }
    try {
      await this.#update(id, { status, error: message(error) })
    } catch {
      // The latest UI state is already visible if browser quota prevented persistence.
    }
  }

  #withLock(id, task) {
    if (!navigator.locks) return task()
    return navigator.locks.request(`fileshare:${this.#owner}:${id}`, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error('此任务正在其他标签页运行。请在该标签页完成操作后重试。')
      return task()
    })
  }

  async #withEditLock(id, task) {
    if (this.#editing.has(id)) throw new Error('传输任务正在更新，请稍后重试。')
    this.#editing.add(id)
    try {
      return await this.#withLock(id, task)
    } finally {
      this.#editing.delete(id)
      this.#schedule()
    }
  }
}
