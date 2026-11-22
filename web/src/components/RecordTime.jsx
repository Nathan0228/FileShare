import { formatDate } from '../utils/dateTime.js'

export default function RecordTime({ value, className }) {
  const label = typeof value === 'string' ? formatDate(value) : '—'
  return label === '—'
    ? <span className={className}>{label}</span>
    : <time dateTime={value} className={className}>{label}</time>
}
