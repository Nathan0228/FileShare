import { useEffect, useRef, useState } from 'react'
import { useSession } from '../auth/session.js'
import { getErrorMessage } from '../../services/errors.js'
import { Type } from '../../services/protocol.js'

export const permissionLabels = {
  UPLOAD: '上传',
  DOWNLOAD: '下载',
  SHARE: '共享',
}

export const mebibyte = 1024 ** 2
export const usernamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
const decimals = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const dates = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
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

export function formatDate(value) {
  const date = new Date(value)
  return value && !Number.isNaN(date.getTime()) ? dates.format(date) : '—'
}

export function useAdminPage(action, username = '') {
  const { request } = useSession()
  const [navigation, setNavigation] = useState({ cursors: [null], revision: 0 })
  const [result, setResult] = useState(null)
  const cursor = navigation.cursors.at(-1)
  const key = JSON.stringify([action, username, cursor, navigation.revision])

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      try {
        const params = username ? { username, cursor } : { cursor }
        const { body } = await request(Type.ADMIN, {
          body: { action, ...params },
          signal: controller.signal,
        })
        if (!controller.signal.aborted) setResult({ key, body })
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: getErrorMessage(error) })
      }
    }

    load()
    return () => controller.abort()
  }, [action, cursor, key, request, username])

  const current = result?.key === key ? result : null
  const nextCursor = current?.body?.nextCursor

  return {
    items: current?.body?.items ?? [],
    loading: current === null,
    error: current?.error,
    number: navigation.cursors.length,
    hasNext: Boolean(nextCursor),
    previous() {
      setNavigation((previous) => ({
        cursors: previous.cursors.length > 1 ? previous.cursors.slice(0, -1) : previous.cursors,
        revision: previous.revision + 1,
      }))
    },
    next() {
      if (!nextCursor) return
      setNavigation((previous) => previous.cursors.at(-1) === nextCursor ? previous : {
        cursors: [...previous.cursors, nextCursor],
        revision: previous.revision + 1,
      })
    },
    refresh() {
      setNavigation((previous) => ({ cursors: [null], revision: previous.revision + 1 }))
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
