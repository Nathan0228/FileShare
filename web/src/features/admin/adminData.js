import { useEffect, useRef, useState } from 'react'
import { useSession } from '../auth/session.js'
import { getErrorMessage } from '../../services/errors.js'
import { Type } from '../../services/protocol.js'

export { formatDate } from '../../utils/dateTime.js'

export const permissionLabels = {
  UPLOAD: '上传',
  DOWNLOAD: '下载',
  SHARE: '共享',
}

export const mebibyte = 1024 ** 2
export const usernamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
const decimals = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const mutationErrors = {
  create: { CONFLICT: '该账号名已存在。' },
  setAccess: { QUOTA: '当前用量已变化。请刷新账号列表后重新设置配额。' },
  invite: { DENIED: '邀请只能发给已启用的普通用户。请检查账号状态。' },
}

export function formatBytes(value) {
  if (!value) return '0 B'
  const unit = Math.min(sizes.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${decimals.format(value / (1024 ** unit))} ${sizes[unit]}`
}

export function useAdminPage(action, { username = '', role = '' } = {}) {
  const { request } = useSession()
  const [navigation, setNavigation] = useState({ cursors: [null], revision: 0, search: '' })
  const [result, setResult] = useState(null)
  const cursor = navigation.cursors.at(-1)
  const { search } = navigation
  const key = JSON.stringify([action, username, role, search, cursor, navigation.revision])

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      try {
        const body = { action, cursor }
        if (username) body.username = username
        if (role) body.role = role
        if (search) body.search = search
        const response = await request(Type.ADMIN, {
          body,
          signal: controller.signal,
        })
        if (!controller.signal.aborted) setResult({ key, body: response.body })
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: getErrorMessage(error) })
      }
    }

    load()
    return () => controller.abort()
  }, [action, cursor, key, request, role, search, username])

  const current = result?.key === key ? result : null
  const nextCursor = current?.body?.nextCursor

  return {
    items: current?.body?.items ?? [],
    loading: current === null,
    error: current?.error,
    number: navigation.cursors.length,
    hasNext: Boolean(nextCursor),
    search,
    previous() {
      setNavigation((previous) => ({
        ...previous,
        cursors: previous.cursors.length > 1 ? previous.cursors.slice(0, -1) : previous.cursors,
        revision: previous.revision + 1,
      }))
    },
    next() {
      if (!nextCursor) return
      setNavigation((previous) => previous.cursors.at(-1) === nextCursor ? previous : {
        ...previous,
        cursors: [...previous.cursors, nextCursor],
        revision: previous.revision + 1,
      })
    },
    refresh() {
      setNavigation((previous) => ({ ...previous, cursors: [null], revision: previous.revision + 1 }))
    },
    setSearch(value) {
      setNavigation((previous) => ({ cursors: [null], revision: previous.revision + 1, search: value }))
    },
  }
}

export function useAdminMutation() {
  const { request } = useSession()
  const ongoing = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function perform(action, params) {
    if (ongoing.current) return { succeeded: false }
    ongoing.current = true
    setPending(true)
    setError('')
    try {
      const { body } = await request(Type.ADMIN, { body: { action, ...params } })
      return { succeeded: true, body }
    } catch (reason) {
      setError(mutationErrors[action]?.[reason?.code] ?? getErrorMessage(reason))
      return { succeeded: false }
    } finally {
      ongoing.current = false
      setPending(false)
    }
  }

  return { pending, error, setError, perform }
}
