const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const minute = 60 * 1000
const hour = 60 * minute
const day = 24 * hour
const month = 30 * day

export function formatDate(value, now = Date.now()) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '—'

  const elapsed = now - date.getTime()
  if (elapsed < 0) return formatter.format(date)
  if (elapsed < minute) return `${Math.floor(elapsed / 1000)}秒前`
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}分钟前`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}小时前`
  if (elapsed < month) return `${Math.floor(elapsed / day)}天前`
  return formatter.format(date)
}
