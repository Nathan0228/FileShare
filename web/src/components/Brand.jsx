import { Link } from 'react-router'
import Icon from './Icon.jsx'

export default function Brand({ to = '/', dark = false }) {
  return (
    <Link to={to} className={`brand-lockup ${dark ? 'brand-on-dark' : ''}`} aria-label="FileShare 首页">
      <span className="brand-mark"><Icon name="brand" size={24} /></span>
      <span className="brand-name">FileShare</span>
    </Link>
  )
}
