import Icon from '../../components/Icon.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { Alert, EmptyState } from '../../components/ui/Feedback.jsx'
import { RefreshButton } from '../../components/ui/RefreshButton.jsx'

export function AdminHeader({ title, description, children }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-[28px]">{title}</h1>
        <p className="mt-1.5 text-sm leading-6 text-slate-500">{description}</p>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>
    </header>
  )
}

export function PageControls({ page }) {
  if (page.number === 1 && !page.hasNext) return null
  return (
    <nav aria-label="表格分页" className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 sm:px-5">
      <span className="text-sm text-slate-500">第 {page.number} 页</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={page.number === 1 || page.loading} onClick={page.previous}>上一页</Button>
        <Button variant="secondary" size="sm" disabled={!page.hasNext || page.loading || Boolean(page.error)} onClick={page.next}>下一页</Button>
      </div>
    </nav>
  )
}

export function Results({ page, emptyIcon, emptyTitle, emptyDescription, children }) {
  if (page.loading) {
    return (
      <div role="status" className="flex min-h-32 items-center justify-center gap-2 px-5 py-10 text-sm text-slate-500">
        <Icon name="refresh" size={17} className="motion-safe:animate-spin" />
        正在加载
      </div>
    )
  }
  if (page.error) {
    return (
      <div className="p-4 sm:p-5">
        <Alert tone="error" title="加载失败">{page.error}</Alert>
        <div className="mt-3"><RefreshButton label="重新加载" size="sm" onClick={page.refresh} /></div>
      </div>
    )
  }
  if (page.items.length === 0) {
    return <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
  }
  return children
}

export function StatePill({ tone = 'neutral', children }) {
  const colors = {
    neutral: 'bg-slate-100 text-slate-600',
    positive: 'bg-emerald-50 text-emerald-800',
    warning: 'bg-amber-50 text-amber-800',
  }
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ${colors[tone]}`}>{children}</span>
}
