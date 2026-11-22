import { useEffect, useId, useRef } from 'react'
import { Button } from './Button.jsx'

export function Modal({ open, onClose, title, description, children, footer, className = '' }) {
  const element = useRef(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = element.current
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={element}
      className={`ui-modal ${className}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget && event.detail > 0) onClose() }}
    >
      <div className="ui-modal-content">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl font-bold tracking-tight wrap-anywhere text-ink">{title}</h2>
            {description && <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-muted">{description}</p>}
          </div>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="关闭弹窗" className="icon-button" />
        </header>
        {children && <div className="mt-5">{children}</div>}
        {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  )
}
