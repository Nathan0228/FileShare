import { useId } from 'react'
import Icon from '../Icon.jsx'

export function Field({ label, hint, labelAction, icon, error, className = '', ...input }) {
  const id = useId()
  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-ink">{label}</label>
        {labelAction}
      </div>
      <div className="relative">
        {icon && <Icon name={icon} size={18} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />}
        <input {...input} id={id} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-hint` : undefined} className={`ui-input ${icon ? 'ps-10' : ''}`} />
      </div>
      {(error || hint) && <p id={`${id}-hint`} className={`text-sm ${error ? 'text-red-700' : 'text-muted'}`}>{error || hint}</p>}
    </div>
  )
}
