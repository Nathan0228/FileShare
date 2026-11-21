import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import Brand from '../components/Brand.jsx'
import ConnectionStatus from '../components/ConnectionStatus.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Modal } from '../components/ui/Modal.jsx'
import { useSession } from '../features/auth/session.js'
import { useToast } from '../features/feedback/toast.js'
import { useTransfers } from '../features/transfers/index.js'
import { adminLinks, workspaceDestination, workspaceLinks } from './routes.js'

function NavigationItems({ items, activeTransfers }) {
  return items.map(({ to, label, icon }) => (
    <NavLink to={to} key={to} className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`}>
      <Icon name={icon} size={19} />
      <span>{label}</span>
      {to === '/transfers' && activeTransfers > 0 && <span className="ml-auto min-w-6 rounded-full bg-white px-1.5 py-0.5 text-center text-xs tabular-nums">{activeTransfers}</span>}
    </NavLink>
  ))
}

export function WorkspaceLayout() {
  const { user, status, logout, reconnect } = useSession()
  const { activeCount } = useTransfers()
  const toast = useToast()
  const location = useLocation()
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const isAdmin = user.role === 'admin'
  const navigation = isAdmin ? [...workspaceLinks, ...adminLinks] : workspaceLinks
  const currentPath = workspaceDestination(location.pathname, user.role)
  const current = navigation.find(({ to }) => to === currentPath)?.label
  const username = user.username || (isAdmin ? '管理员' : '普通用户')

  async function signOut() {
    if (leaving) return
    setLeaving(true)
    try {
      if (!(await logout())) toast({ title: '已退出本地会话', description: '服务端暂时无法确认撤销。', tone: 'warning' })
    } finally {
      setLeaving(false)
      setLogoutOpen(false)
    }
  }

  return (
    <div className="workspace-shell">
      <a className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:p-2" href="#main-content">跳到主要内容</a>
      <aside className="workspace-sidebar">
        <div className="ps-2"><Brand to="/files" /></div>
        <nav className="mt-9 space-y-1" aria-label="文件工作区">
          <p className="mb-2 px-3 text-xs font-semibold tracking-wider text-muted">工作区</p>
          <NavigationItems items={workspaceLinks} activeTransfers={activeCount} />
        </nav>
        {isAdmin && <nav className="mt-7 space-y-1" aria-label="管理">
          <p className="mb-2 px-3 text-xs font-semibold tracking-wider text-muted">管理</p>
          <NavigationItems items={adminLinks} />
        </nav>}
        <div className="mt-auto flex min-w-0 items-center gap-2.5 border-t border-line pt-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-mint text-primary"><Icon name="user" size={19} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold" title={username}>{username}</div>
            <div className="mt-0.5 text-xs text-muted">{isAdmin ? '管理员' : '普通用户'}</div>
          </div>
          <Button variant="ghost" size="sm" icon="logout" className="icon-button" aria-label="退出登录" title="退出登录" onClick={() => setLogoutOpen(true)} />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="workspace-header">
          <div className="md:hidden"><Brand to="/files" /></div>
          <div className="hidden items-center gap-2.5 text-sm md:flex" aria-label="当前位置">
            <span className="text-muted">工作区</span><Icon name="chevron-right" size={15} className="text-muted" /><strong className="font-semibold">{current}</strong>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ConnectionStatus status={status} onRetry={() => { void reconnect().catch(() => {}) }} />
            <Button variant="ghost" size="sm" icon="logout" className="icon-button md:hidden" aria-label="退出登录" title="退出登录" onClick={() => setLogoutOpen(true)} />
          </div>
        </header>
        <nav className="mobile-nav" aria-label="工作区导航"><NavigationItems items={navigation} activeTransfers={activeCount} /></nav>
        <main id="main-content" className="workspace-content" tabIndex={-1}><Outlet /></main>
      </div>

      <Modal open={logoutOpen} onClose={() => { if (!leaving) setLogoutOpen(false) }} title="退出登录？" description="传输将暂停。再次登录后可以恢复已保存的断点。" footer={<>
        <Button variant="secondary" disabled={leaving} onClick={() => setLogoutOpen(false)}>取消</Button>
        <Button variant="danger" icon="logout" busy={leaving} onClick={signOut}>退出登录</Button>
      </>} />
    </div>
  )
}
