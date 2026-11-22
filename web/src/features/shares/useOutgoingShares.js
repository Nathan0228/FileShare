import { useEffect, useState } from 'react'
import { getErrorMessage, SftError } from '../../services/errors.js'
import { isTransferId, Type } from '../../services/protocol.js'
import { useSession } from '../auth/session.js'

const firstPage = [null]

function validShare(item, view) {
  return isTransferId(item?.fileId) && typeof item.name === 'string' && typeof item.grantee === 'string' &&
    (item.action === 'grant' || item.action === 'revoke') && typeof item.createdAt === 'string' &&
    Number.isFinite(Date.parse(item.createdAt)) && typeof item.deleted === 'boolean' &&
    (view !== 'active' || (item.action === 'grant' && !item.deleted && item.name.length > 0 && item.grantee.length > 0))
}

function verifyPage(body, view, cursors) {
  if (!Array.isArray(body?.items) || !body.items.every((item) => validShare(item, view)) ||
    (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !body.nextCursor || cursors.includes(body.nextCursor)))) {
    throw new SftError('PROTOCOL_ERROR')
  }
  return { items: body.items, nextCursor: body.nextCursor }
}

export function useOutgoingShares(view) {
  const { request, reconnect, status, user } = useSession()
  const [cursors, setCursors] = useState(() => [...firstPage])
  const [result, setResult] = useState(null)
  const ready = Boolean(user && status === 'online')
  const connecting = status === 'connecting' || status === 'reconnecting'

  useEffect(() => {
    if (!ready) return undefined
    const controller = new AbortController()
    const { signal } = controller
    const cursor = cursors.at(-1)

    async function load() {
      try {
        const { body } = await request(Type.OUTGOING_SHARES, { body: { view, cursor }, signal })
        if (!signal.aborted) setResult({ user, view, cursors, ...verifyPage(body, view, cursors) })
      } catch (cause) {
        if (signal.aborted) return
        const error = cause?.code === 'BAD_REQUEST'
          ? (cursor ? '分页已失效，请从第一页重新加载。' : '当前服务端版本暂不支持查看发出的共享。')
          : getErrorMessage(cause)
        setResult({ user, view, cursors, error })
      }
    }

    void load()
    return () => controller.abort()
  }, [cursors, ready, request, user, view])

  const current = ready && result?.user === user && result?.view === view && result?.cursors === cursors ? result : null
  const nextCursor = current?.nextCursor

  return {
    items: current?.items ?? [],
    loading: connecting || (ready && !current),
    error: current?.error ?? '',
    ready,
    number: cursors.length,
    hasNext: Boolean(nextCursor),
    canRevoke: Boolean(user?.permissions.includes('SHARE')),
    refresh() {
      setCursors([...firstPage])
      if (status === 'offline' || status === 'idle') void reconnect().catch(() => {})
    },
    previous() {
      setCursors((previous) => previous.length > 1 ? previous.slice(0, -1) : previous)
    },
    next() {
      if (!nextCursor) return
      setCursors((previous) => previous === cursors ? [...previous, nextCursor] : previous)
    },
  }
}
