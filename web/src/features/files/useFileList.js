import { useEffect, useRef, useState } from 'react'
import { useSession } from '../auth/session.js'
import { getErrorMessage, SftError } from '../../services/errors.js'
import { isTransferId, Type } from '../../services/protocol.js'

function verifyPage(body) {
  if (!Array.isArray(body?.items) || (body.nextCursor !== null && typeof body.nextCursor !== 'string') ||
    body.items.some((file) => !isTransferId(file?.fileId) || typeof file.name !== 'string' ||
      typeof file.owner !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0)) {
    throw new SftError('PROTOCOL_ERROR')
  }
  return { items: body.items, nextCursor: body.nextCursor }
}

export function useFileList(scope, uploadRevision) {
  const { user, status, request } = useSession()
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState({ items: [], nextCursor: null, key: '', error: '' })
  const [pagination, setPagination] = useState({ busy: false, error: '' })
  const extraRequest = useRef(null)
  const ready = Boolean(user && status === 'online')
  const key = `${scope}:${revision}:${uploadRevision}`

  useEffect(() => {
    if (!ready) return undefined
    const controller = new AbortController()
    request(Type.LIST, { body: { scope, cursor: null }, signal: controller.signal }).then(({ body }) => {
      if (!controller.signal.aborted) setPage({ ...verifyPage(body), key, error: '' })
    }).catch((error) => {
      if (!controller.signal.aborted) setPage({ items: [], nextCursor: null, key, error: getErrorMessage(error) })
    })
    return () => { controller.abort(); extraRequest.current?.abort() }
  }, [key, ready, request, scope])

  function refresh() {
    setPagination({ busy: false, error: '' })
    setRevision((current) => current + 1)
  }

  async function loadMore() {
    if (!ready || !page.nextCursor || page.key !== key || extraRequest.current) return
    const controller = new AbortController()
    extraRequest.current = controller
    setPagination({ busy: true, error: '' })
    let error = ''
    try {
      const { body } = await request(Type.LIST, { body: { scope, cursor: page.nextCursor }, signal: controller.signal })
      if (!controller.signal.aborted) {
        const next = verifyPage(body)
        setPage((previous) => {
          const merged = new Map(previous.items.map((file) => [file.fileId, file]))
          for (const file of next.items) merged.set(file.fileId, file)
          return { ...previous, items: [...merged.values()], nextCursor: next.nextCursor }
        })
      }
    } catch (cause) {
      if (!controller.signal.aborted) error = getErrorMessage(cause)
    } finally {
      extraRequest.current = null
      setPagination({ busy: false, error })
    }
  }

  return { ...page, loading: ready && page.key !== key, pagination, refresh, loadMore, ready }
}
