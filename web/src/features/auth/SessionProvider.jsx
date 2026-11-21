import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { SessionService } from '../../services/session-service.js'
import { SessionContext } from './session.js'

export function SessionProvider({ children }) {
  const [service] = useState(() => new SessionService())
  const { user, status } = useSyncExternalStore(service.subscribe, service.getSnapshot)
  useEffect(() => service.reset, [service])
  const value = useMemo(() => ({
    user,
    status,
    endpoint: service.endpoint,
    login: service.login,
    enroll: service.enroll,
    logout: service.logout,
    reconnect: service.reconnect,
    request: service.request,
  }), [service, status, user])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
