import { Link } from 'react-router'
import Brand from '../components/Brand.jsx'
import Icon from '../components/Icon.jsx'
import { useSession } from '../features/auth/session.js'

export default function NotFound() {
  const { user } = useSession()
  const home = user ? '/files' : '/login'
  return (
    <div className="mx-auto flex min-h-svh max-w-6xl flex-col px-6 py-6 sm:px-10 sm:py-9">
      <Brand to={home} />
      <main id="main-content" className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 py-12 text-center">
        <span className="missing-drawing"><Icon name="folder" size={40} /></span>
        <p className="text-sm font-bold tracking-wider text-primary">404</p>
        <h1 className="page-title">找不到这个页面</h1>
        <p className="text-base leading-relaxed text-muted">页面地址有误，或者页面已移动。</p>
        <Link className="ui-button ui-button-primary ui-button-md mt-3" to={home} replace>{user ? '返回我的文件' : '返回登录'}</Link>
      </main>
    </div>
  )
}
