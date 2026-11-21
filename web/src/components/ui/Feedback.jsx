import { useId, useState } from 'react'
import Icon from '../Icon.jsx'

const toneIcons = { error: 'alert', warning: 'alert', success: 'check', info: 'info' }

export function Alert({ tone = 'info', title, children, action }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`ui-alert ui-alert-${tone}`}>
      <Icon name={toneIcons[tone] || toneIcons.info} size={19} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-1 text-sm leading-relaxed' : 'text-sm leading-relaxed'}>{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  )
}

export function Hint({ text, children }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span className={`ui-hint ${open ? 'is-open' : ''}`}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') setOpen(true) }}
      onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <button type="button" className="ui-hint-trigger" aria-label={children ? undefined : '帮助'} aria-describedby={id} aria-expanded={open} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
        {children || <Icon name="info" size={17} />}
      </button>
      <span id={id} role="tooltip" className="ui-tooltip">{text}</span>
    </span>
  )
}

export function EmptyState({ icon = 'folder', title, description, action }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{typeof icon === 'string' ? <Icon name={icon} size={28} /> : icon}</span>
      <p className="text-base font-semibold text-ink">{title}</p>
      {description && <p className="max-w-sm text-sm leading-relaxed text-muted">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  )
}
