import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useSession } from '../auth/session.js'
import { TransferContext } from './context.js'
import { TransferQueue } from './queue.js'

export function TransferProvider({ children }) {
  const { user, endpoint, request, status } = useSession()
  const owner = user?.userId ? `${endpoint}\0${user.userId}` : ''
  const online = Boolean(owner && status === 'online')
  const queue = useMemo(() => new TransferQueue(owner, request), [owner, request])
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)

  useEffect(() => queue.start(), [queue])
  useEffect(() => queue.setOnline(online), [online, queue])

  const transfers = useMemo(() => ({
    ...snapshot,
    enqueueUploads: queue.enqueueUploads,
    enqueueDownload: queue.enqueueDownload,
    pause: queue.pause,
    resume: queue.resume,
    reselect: queue.reselect,
    cancel: queue.cancel,
    save: queue.save,
    remove: queue.remove,
  }), [queue, snapshot])

  return <TransferContext.Provider value={transfers}>{children}</TransferContext.Provider>
}
