import Icon from '../Icon.jsx'

export function Button({ variant = 'primary', size = 'md', icon, busy = false, disabled, className = '', children, type = 'button', ...props }) {
  return (
    <button type={type} className={`ui-button ui-button-${variant} ui-button-${size} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...props}>
      {busy ? <span className="button-spinner" aria-hidden="true" /> : typeof icon === 'string' ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : icon}
      {children}
    </button>
  )
}
