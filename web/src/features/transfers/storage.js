const databaseName = 'fileshare-transfers'
let openPromise

function openDatabase() {
  if (!openPromise) {
    openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('tasks', { keyPath: ['owner', 'id'] })
        request.result.createObjectStore('chunks', { keyPath: ['owner', 'id', 'index'] })
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('请关闭其他 FileShare 标签页后重试。'))
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => {
          database.close()
          openPromise = undefined
        }
        resolve(database)
      }
    }).catch((error) => {
      openPromise = undefined
      throw error
    })
  }
  return openPromise
}

function runTransaction(database, stores, mode, work) {
  return new Promise((resolve, reject) => {
    const transaction = mode === 'readwrite'
      ? database.transaction(stores, mode, { durability: 'strict' })
      : database.transaction(stores, mode)
    const request = work(transaction)
    transaction.oncomplete = () => resolve(request?.result)
    transaction.onabort = () => reject(transaction.error || request?.error || new Error('浏览器存储事务中断。'))
  })
}

function chunkRange(owner, id) {
  return IDBKeyRange.bound([owner, id, 0], [owner, id, Number.MAX_SAFE_INTEGER])
}

export async function createTransferStorage(owner) {
  const database = await openDatabase()
  const read = (name, work) => runTransaction(database, name, 'readonly', (transaction) => work(transaction.objectStore(name)))
  const write = (name, work) => runTransaction(database, name, 'readwrite', (transaction) => work(transaction.objectStore(name)))

  return {
    async getTasks() {
      const range = IDBKeyRange.bound([owner, ''], [owner, '\uffff'])
      const entries = await read('tasks', (store) => store.getAll(range))
      return entries.map(({ task }) => task)
    },
    async getTask(id) {
      const entry = await read('tasks', (store) => store.get([owner, id]))
      return entry?.task
    },
    putTask(task) {
      return write('tasks', (store) => store.put({ owner, id: task.id, task }))
    },
    async getChunk(id, index) {
      return read('chunks', (store) => store.get([owner, id, index]))
    },
    putChunk(id, index, digest, blob) {
      return write('chunks', (store) => store.put({ owner, id, index, digest, blob }))
    },
    deleteChunk(id, index) {
      return write('chunks', (store) => store.delete([owner, id, index]))
    },
    deleteChunks(id) {
      return write('chunks', (store) => store.delete(chunkRange(owner, id)))
    },
    deleteTask(id) {
      return runTransaction(database, ['tasks', 'chunks'], 'readwrite', (transaction) => {
        transaction.objectStore('tasks').delete([owner, id])
        transaction.objectStore('chunks').delete(chunkRange(owner, id))
      })
    },
    replaceTaskAndClearChunks(task) {
      return runTransaction(database, ['tasks', 'chunks'], 'readwrite', (transaction) => {
        transaction.objectStore('tasks').put({ owner, id: task.id, task })
        transaction.objectStore('chunks').delete(chunkRange(owner, task.id))
      })
    },
  }
}
