import { useEffect, useState } from 'react'
import { getErrorMessage, SftError } from '../../services/errors.js'
import { isTransferId, Type } from '../../services/protocol.js'
import { useSession } from '../auth/session.js'

export const accountNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

function verifyPage(body, cursors) {
  if (!Array.isArray(body?.items) || !body.items.every((friend) =>
    isTransferId(friend?.userId) && typeof friend.username === 'string' && accountNamePattern.test(friend.username) &&
    typeof friend.enabled === 'boolean' && typeof friend.note === 'string') ||
    (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !body.nextCursor || cursors.includes(body.nextCursor)))) {
    throw new SftError('PROTOCOL_ERROR')
  }
  return { items: body.items, nextCursor: body.nextCursor }
}

export function useFriends() {
  const { user, status, request } = useSession()
  const [cursors, setCursors] = useState(() => [null])
  const [result, setResult] = useState(null)
  const ready = Boolean(user && status === 'online')

  useEffect(() => {
    if (!ready) return undefined
    const controller = new AbortController()
    const { signal } = controller
    async function load() {
      try {
        const { body } = await request(Type.FRIENDS, { body: { cursor: cursors.at(-1) }, signal })
        if (!signal.aborted) setResult({ user, cursors, ...verifyPage(body, cursors) })
      } catch (error) {
        if (!signal.aborted) setResult({ user, cursors, error: getErrorMessage(error) })
      }
    }
    void load()
    return () => controller.abort()
  }, [cursors, ready, request, user])

  const page = ready && result?.user === user && result.cursors === cursors ? result : null
  return {
    ready,
    loading: ready && !page,
    items: page?.items ?? [],
    error: page?.error ?? '',
    number: cursors.length,
    hasNext: Boolean(page?.nextCursor),
    refresh() { setCursors([null]) },
    reload() { setCursors((current) => [...current]) },
    previous() { setCursors((current) => current.length > 1 ? current.slice(0, -1) : current) },
    next() {
      if (page?.nextCursor) setCursors((current) => current === cursors ? [...current, page.nextCursor] : current)
    },
  }
}
