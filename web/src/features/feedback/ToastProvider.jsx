import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.jsx'
import { Alert } from '../../components/ui/Feedback.jsx'
import { ToastContext } from './toast.js'

export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const timers = useRef(new Map())
  const nextId = useRef(0)

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback(({ title, description, tone = 'info' }) => {
    const id = ++nextId.current
    setItems((current) => [...current.slice(-3), { id, title, description, tone }])
    timers.current.set(id, setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 5000))
  }, [dismiss])

  useEffect(() => {
    const scheduled = timers.current
    return () => { for (const timer of scheduled.values()) clearTimeout(timer); scheduled.clear() }
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" aria-label="通知">
        {items.map(({ id, title, description, tone }) => (
          <div key={id} className="toast-item">
            <Alert tone={tone} title={title}>{description}</Alert>
            <Button variant="ghost" size="sm" icon="x" className="icon-button toast-close" aria-label="关闭通知" onClick={() => dismiss(id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
