import { useCallback, useEffect, useState } from 'react'
import { getErrorMessage, SftError } from '../../services/errors.js'
import { Type } from '../../services/protocol.js'
import { useSession } from './session.js'

const allowedPermissions = new Set(['UPLOAD', 'DOWNLOAD', 'SHARE'])
const usernamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

function readProfile(body, expectedUserId) {
  if (body?.userId !== expectedUserId || typeof body.username !== 'string' || !usernamePattern.test(body.username) ||
    (body.role !== 'admin' && body.role !== 'user') || !Array.isArray(body.permissions) ||
    new Set(body.permissions).size !== body.permissions.length ||
    body.permissions.some((permission) => !allowedPermissions.has(permission)) ||
    ![body.quotaBytes, body.usedBytes, body.reservedBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new SftError('PROTOCOL_ERROR')
  }
  const { userId, username, role, permissions, quotaBytes, usedBytes, reservedBytes } = body
  return { userId, username, role, permissions, quotaBytes, usedBytes, reservedBytes }
}

export function useAccountProfile() {
  const { user, status, request, reconnect } = useSession()
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState(null)
  const ready = Boolean(user && status === 'online')

  useEffect(() => {
    if (!ready) return undefined
    const controller = new AbortController()
    const { signal } = controller

    async function load() {
      try {
        const { body } = await request(Type.USER_PROFILE, { signal })
        if (!signal.aborted) setResult({ user, revision, profile: readProfile(body, user.userId) })
      } catch (cause) {
        if (signal.aborted) return
        const error = cause?.code === 'BAD_REQUEST'
          ? '当前服务端版本暂不支持查询账号用量。'
          : getErrorMessage(cause)
        setResult({ user, revision, error })
      }
    }

    void load()
    return () => controller.abort()
  }, [ready, request, revision, user])

  const refresh = useCallback(() => {
    setRevision((current) => current + 1)
    if (user && status === 'offline') void reconnect().catch(() => {})
  }, [reconnect, status, user])

  const current = ready && result?.user === user && result.revision === revision ? result : null
  const waitForConnection = status === 'connecting' || status === 'reconnecting'
  return {
    profile: current?.profile ?? null,
    loading: Boolean(user && (waitForConnection || (ready && !current))),
    error: current?.error ?? (user && !ready && !waitForConnection ? '连接已断开，重试后可查看账号用量。' : ''),
    refresh,
  }
}
