import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { Button } from './Button.jsx'

const rotationMs = 650

export function RefreshButton({ onClick, loading = false, disabled = false, label = '刷新', iconOnly = false, size = 'md' }) {
  const [recentlyClicked, setRecentlyClicked] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  function refresh() {
    clearTimeout(timer.current)
    setRecentlyClicked(true)
    timer.current = setTimeout(() => setRecentlyClicked(false), rotationMs)
    onClick()
  }

  const rotating = loading || recentlyClicked

  return (
    <Button
      variant="secondary"
      size={size}
      className={iconOnly ? 'icon-button' : ''}
      aria-label={iconOnly ? label : undefined}
      aria-busy={loading || undefined}
      title={iconOnly ? label : undefined}
      disabled={disabled || loading}
      onClick={refresh}
      icon={<Icon name="refresh" size={size === 'sm' ? 16 : 18} className={rotating ? 'origin-center motion-safe:animate-spin motion-safe:[animation-duration:650ms]' : ''} />}
    >
      {!iconOnly && label}
    </Button>
  )
}
