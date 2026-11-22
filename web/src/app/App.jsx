import { useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import { AdminAudit, AdminUsers } from '../features/admin/AdminPages.jsx'
import { AuthPage } from '../features/auth/AuthPage.jsx'
import { SessionProvider } from '../features/auth/SessionProvider.jsx'
import { useSession } from '../features/auth/session.js'
import { ToastProvider } from '../features/feedback/ToastProvider.jsx'
import { FileBrowserPage } from '../features/files/FileBrowserPage.jsx'
import { FriendsPage } from '../features/friends/FriendsPage.jsx'
import { OutgoingSharesPage } from '../features/shares/OutgoingSharesPage.jsx'
import { TransferPage, TransferProvider } from '../features/transfers/index.js'
import NotFound from './NotFound.jsx'
import { WorkspaceLayout } from './WorkspaceLayout.jsx'
import { adminLinks, workspaceLinks } from './routes.js'

const titles = new Map([
  ...[...workspaceLinks, ...adminLinks].map(({ to, label }) => [to, label]),
  ['/login', '登录'],
  ['/register', '注册 Passkey'],
  ['/admin', '用户管理'],
])

function DocumentTitle() {
  const { pathname } = useLocation()
  useEffect(() => {
    const normalPath = pathname.replace(/\/+$/, '').toLowerCase()
    document.title = `${titles.get(normalPath) || (normalPath ? '找不到页面' : '安全文件共享')} · FileShare`
  }, [pathname])
  return null
}

function Home() {
  const { user } = useSession()
  return <Navigate replace to={user ? '/files' : '/login'} />
}

function RequireSession() {
  const { user } = useSession()
  const { pathname } = useLocation()
  return user ? <WorkspaceLayout /> : <Navigate replace to="/login" state={{ returnTo: pathname }} />
}

function RequireAdmin() {
  const { user } = useSession()
  return user.role === 'admin' ? <Outlet /> : <Navigate replace to="/files" state={{ accessDenied: true }} />
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <TransferProvider>
            <DocumentTitle />
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<AuthPage key="login" mode="login" />} />
              <Route path="/register" element={<AuthPage key="register" mode="register" />} />
              <Route element={<RequireSession />}>
                <Route path="/files" element={<FileBrowserPage key="owned" scope="owned" />} />
                <Route path="/shared" element={<FileBrowserPage key="shared" scope="shared" />} />
                <Route path="/shares" element={<OutgoingSharesPage />} />
                <Route path="/friends" element={<FriendsPage />} />
                <Route path="/transfers" element={<TransferPage />} />
                <Route path="/admin" element={<RequireAdmin />}>
                  <Route index element={<Navigate replace to="/admin/users" />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="audit" element={<AdminAudit />} />
                </Route>
              </Route>
              <Route path="/404" element={<NotFound />} />
              <Route path="*" element={<Navigate replace to="/404" />} />
            </Routes>
          </TransferProvider>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  )
}
