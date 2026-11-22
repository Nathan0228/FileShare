import { Button } from '../../components/ui/Button.jsx'
import { Alert } from '../../components/ui/Feedback.jsx'

export function FriendName({ friend }) {
  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-semibold text-ink" title={friend.note || friend.username}>{friend.note || friend.username}</span>
      {friend.note && <span className="mt-0.5 block truncate text-xs text-muted" title={friend.username}>{friend.username}</span>}
    </span>
  )
}

export function FriendListStatus({ page }) {
  if (page.loading) return <p role="status" className="text-sm text-muted">正在加载好友…</p>
  if (page.error) return (
    <Alert tone="error" title="无法加载好友" action={<Button variant="secondary" size="sm" onClick={page.refresh}>重试</Button>}>{page.error}</Alert>
  )
  if (!page.ready) return <p className="text-sm text-muted">连接恢复后会加载好友列表。</p>
  return null
}

export function FriendPagination({ page }) {
  if (page.number === 1 && !page.hasNext) return null
  return (
    <nav aria-label="好友分页" className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted">第 {page.number} 页</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page.number === 1 || page.loading} onClick={page.previous}>上一页</Button>
        <Button variant="secondary" size="sm" disabled={!page.hasNext || page.loading} onClick={page.next}>下一页</Button>
      </div>
    </nav>
  )
}
