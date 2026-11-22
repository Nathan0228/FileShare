import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import FileIcon from '../../components/FileIcon.jsx'
import Icon from '../../components/Icon.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { Alert, EmptyState } from '../../components/ui/Feedback.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { RefreshButton } from '../../components/ui/RefreshButton.jsx'
import { getErrorMessage } from '../../services/errors.js'
import { Type } from '../../services/protocol.js'
import { formatDate } from '../../utils/dateTime.js'
import { useSession } from '../auth/session.js'
import { useToast } from '../feedback/toast.js'
import { useOutgoingShares } from './useOutgoingShares.js'

const tabs = [
  { key: 'active', label: '当前授权', icon: 'link' },
  { key: 'history', label: '共享历史', icon: 'history' },
]
const rowLayout = 'min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(7rem,.4fr)_minmax(9rem,.45fr)_6.5rem]'

function RevokeShareDialog({ share, onClose, onRevoked }) {
  const { request, status, user } = useSession()
  const toast = useToast()
  const operation = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = status === 'online' && user?.permissions.includes('SHARE')

  useEffect(() => () => operation.current?.abort(), [])

  async function revoke() {
    if (!ready || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    try {
      await request(Type.SHARE_SET, {
        body: { fileId: share.fileId, grantee: share.grantee, allow: false },
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      toast({ title: '访问权限已撤销', description: `接收账号 ${share.grantee}`, tone: 'success' })
      onRevoked()
    } catch (cause) {
      if (!controller.signal.aborted) setError(getErrorMessage(cause))
    } finally {
      operation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <Modal open title="撤销共享？" description="撤销后，此账号将无法继续访问该文件。"
      onClose={() => { if (!operation.current) onClose() }}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
        <Button variant="danger" icon="lock" busy={busy} disabled={!ready} onClick={revoke}>撤销权限</Button>
      </>}
    >
      <div className="flex items-center gap-3 rounded-xl border border-line bg-canvas p-3">
        <FileIcon filename={share.name} />
        <div className="min-w-0">
          <p className="wrap-anywhere text-sm font-semibold text-ink">{share.name}</p>
          <p className="mt-1 wrap-anywhere text-sm text-muted">接收账号 {share.grantee}</p>
        </div>
      </div>
      {error && <div className="mt-3"><Alert tone="error">{error}</Alert></div>}
    </Modal>
  )
}

function ShareEvent({ action }) {
  const revoke = action === 'revoke'
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ${revoke ? 'bg-slate-100 text-slate-700' : 'bg-mint text-primary'}`}>
      {revoke ? '撤销权限' : '授权共享'}
    </span>
  )
}

function ShareRow({ share, active, canRevoke, onRevoke }) {
  const fileName = share.name || '未知文件'
  const grantee = share.grantee || '未知账号'
  const date = formatDate(share.createdAt)

  return (
    <li className={`${rowLayout} grid transition-colors hover:bg-[#f8faf9]`}>
      <div className="flex min-w-0 items-center gap-3">
        <FileIcon filename={fileName} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink" title={fileName}>{fileName}</p>
          {share.deleted && <p className="mt-0.5 text-xs text-muted">文件已删除</p>}
        </div>
      </div>
      <span className="hidden truncate text-sm text-muted lg:block" title={grantee}>{grantee}</span>
      <time className="hidden text-sm tabular-nums text-muted lg:block" dateTime={share.createdAt}>{date}</time>
      <div className="flex justify-end">
        {active && canRevoke ? (
          <Button variant="ghost" size="sm" icon="lock" aria-label={`撤销 ${grantee} 对 ${fileName} 的访问权限`} onClick={onRevoke}>撤销</Button>
        ) : <ShareEvent action={share.action} />}
      </div>
      <div className="col-span-2 flex flex-wrap gap-x-3 gap-y-1 ps-13 text-xs text-muted lg:hidden">
        <span className="wrap-anywhere">接收账号 {grantee}</span>
        <time dateTime={share.createdAt}>{date}</time>
      </div>
    </li>
  )
}

function SharesPanel({ view }) {
  const page = useOutgoingShares(view)
  const [selected, setSelected] = useState(null)
  const active = view === 'active'

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
        <p className="text-sm text-muted">{active ? '仍有访问权限的接收账号' : '最近 30 天的授权和撤销'}</p>
        <RefreshButton size="sm" label="刷新共享列表" iconOnly loading={page.loading} onClick={page.refresh} />
      </div>
      <div className={`${rowLayout} hidden border-y border-line bg-[#f8faf8] text-sm font-semibold text-muted lg:grid`} aria-hidden="true">
        <span>文件名称</span><span>接收账号</span><span>{active ? '授权时间' : '变更时间'}</span><span className="text-right">{active ? '操作' : '变更'}</span>
      </div>
      {page.loading ? (
        <div role="status" className="flex min-h-56 items-center justify-center gap-3 border-t border-line text-sm text-muted lg:border-t-0">
          <span className="button-spinner text-primary" aria-hidden="true" />正在获取共享…
        </div>
      ) : !page.ready || page.error ? (
        <div className="border-t border-line p-4 sm:p-5 lg:border-t-0">
          <Alert tone={page.error ? 'error' : 'info'} title={page.error ? '无法获取共享' : '等待连接'}
            action={<RefreshButton size="sm" label="重试" onClick={page.refresh} />}>
            {page.error || '连接恢复后会重新获取共享列表。'}
          </Alert>
        </div>
      ) : page.items.length > 0 ? (
        <ul className="divide-y divide-line border-t border-line lg:border-t-0" aria-label={active ? '当前共享授权' : '共享变更记录'}>
          {page.items.map((share, index) => (
            <ShareRow key={JSON.stringify([share.fileId, share.grantee, share.createdAt, index])} share={share} active={active} canRevoke={page.canRevoke} onRevoke={() => setSelected(share)} />
          ))}
        </ul>
      ) : (
        <div className="border-t border-line lg:border-t-0">
          <EmptyState icon={active ? 'link' : 'history'} title={active ? '暂无生效的共享' : '暂无共享记录'}
            description={active ? '在我的文件中给指定账号授权后，授权会显示在这里。' : '最近 30 天的共享授权和撤销会显示在这里。'}
            action={active && page.number === 1 ? <Link className="ui-link" to="/files">前往我的文件</Link> : undefined} />
        </div>
      )}
      {(page.number > 1 || page.hasNext) && <nav aria-label="共享分页" className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-3.5 sm:px-5">
        <span className="text-sm text-muted">第 {page.number} 页</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={page.number === 1 || page.loading} onClick={page.previous}>上一页</Button>
          <Button variant="secondary" size="sm" disabled={!page.hasNext || page.loading} onClick={page.next}>下一页</Button>
        </div>
      </nav>}
      {selected && <RevokeShareDialog share={selected} onClose={() => setSelected(null)} onRevoked={() => { setSelected(null); page.refresh() }} />}
    </div>
  )
}

export function OutgoingSharesPage() {
  const [view, setView] = useState('active')
  const id = useId()

  function changeTab(event, index) {
    const positions = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }
    const next = positions[event.key]
    if (!Number.isInteger(next)) return
    event.preventDefault()
    setView(tabs[next].key)
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next]?.focus()
  }

  return (
    <section className="space-y-5">
      <header>
        <h1 className="page-title">我发出的共享</h1>
        <p className="page-description">查看哪些账号可以访问你的文件，以及最近的授权变更。</p>
      </header>
      <div role="tablist" aria-label="共享视图" className="inline-flex max-w-full flex-wrap gap-1 rounded-xl border border-line bg-white p-1">
        {tabs.map((tab, index) => (
          <button type="button" role="tab" key={tab.key} id={`${id}-${tab.key}`} aria-controls={`${id}-${tab.key}-panel`}
            aria-selected={view === tab.key} tabIndex={view === tab.key ? 0 : -1} onClick={() => setView(tab.key)} onKeyDown={(event) => changeTab(event, index)}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors sm:px-4 ${view === tab.key ? 'bg-mint text-primary' : 'text-muted hover:bg-canvas hover:text-ink'}`}>
            <Icon name={tab.icon} size={17} />{tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} role="tabpanel" id={`${id}-${tab.key}-panel`} aria-labelledby={`${id}-${tab.key}`} hidden={view !== tab.key}>
          {view === tab.key && <SharesPanel view={tab.key} />}
        </div>
      ))}
    </section>
  )
}
