import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import Brand from '../../components/Brand.jsx'
import ConnectionStatus from '../../components/ConnectionStatus.jsx'
import Icon from '../../components/Icon.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { Alert, Hint } from '../../components/ui/Feedback.jsx'
import { Field } from '../../components/ui/Field.jsx'
import { workspaceDestination } from '../../app/routes.js'
import { getErrorMessage } from '../../services/errors.js'
import { useToast } from '../feedback/toast.js'
import { useSession } from './session.js'

export function AuthPage({ mode }) {
  const { user, status, login, enroll } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const isSignup = mode === 'register'
  const returnTo = location.state?.returnTo
  const [value, setValue] = useState(() => isSignup ? '' : (location.state?.username || ''))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const ceremony = useRef(null)

  useEffect(() => () => ceremony.current?.abort(), [])

  if (user) return <Navigate to={workspaceDestination(returnTo, user.role)} replace />

  async function submit(event) {
    event.preventDefault()
    if (ceremony.current) return
    const text = value.trim()
    if (isSignup ? !/^[a-zA-Z0-9_-]{43}$/.test(text) : !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(text)) {
      setProblem(isSignup ? '请输入管理员提供的完整邀请码。' : '账号名须以小写字母或数字开头，可使用小写字母、数字、点、下划线和连字符。')
      return
    }
    setProblem('')
    setBusy(true)
    const controller = new AbortController()
    const { signal } = controller
    ceremony.current = controller
    try {
      if (isSignup) {
        const { username } = await enroll(text, { signal })
        if (signal.aborted) return
        toast({ title: 'Passkey 已注册', description: '现在可使用 Passkey 登录。', tone: 'success' })
        navigate('/login', { replace: true, state: { username, returnTo } })
      } else {
        await login(text, { signal })
      }
    } catch (error) {
      if (!signal.aborted) setProblem(getErrorMessage(error))
    } finally {
      ceremony.current = null
      if (!signal.aborted) setBusy(false)
    }
  }

  function switchMode(event) {
    if (busy) event.preventDefault()
  }

  return (
    <div className="auth-shell">
      <aside className="auth-art" aria-label="FileShare 安全文件共享平台">
        <div className="auth-art-inner">
          <Brand dark />
          <div className="auth-hero-copy">
            <div className="auth-hero-tag"><Icon name="shield-check" size={19} />安全文件共享平台</div>
            <p className="auth-hero-title">文件共享，<br /><span>权限可控。</span></p>
            <p className="auth-hero-description">指定谁可以访问文件。断线后，从已确认的分片继续传输。</p>
          </div>
          <img className="auth-illustration" src={`${import.meta.env.BASE_URL}assets/svg/vault-hero.svg`} width="580" height="360" alt="" />
          <div className="auth-art-footer text-sm">
            <span className="inline-flex items-center gap-2"><Icon name="key" size={17} />Passkey 公钥认证</span>
            <span className="inline-flex items-center gap-2"><Icon name="transfer" size={17} />SFT/1 分片传输</span>
          </div>
        </div>
      </aside>

      <div className="auth-side">
        <header className="auth-side-top"><ConnectionStatus status={status} /></header>
        <main className="auth-content" id="main-content">
          <span className="auth-action-mark"><Icon name={isSignup ? 'shield-check' : 'key'} size={26} /></span>
          <h1 className="auth-title">{isSignup ? '注册 Passkey' : '登录工作区'}</h1>
          <p className="mt-3 text-base leading-relaxed text-muted">
            {isSignup ? '使用管理员提供的一次性邀请码，在此设备上创建 Passkey。' : '使用你的 Passkey，访问个人文件和共享给你的文件。'}
          </p>

          <form className="mt-8 space-y-5" onSubmit={submit}>
            <Field
              label={isSignup ? '邀请码' : '账号名'}
              icon={isSignup ? 'lock' : 'user'}
              name={isSignup ? 'inviteToken' : 'username'}
              type={isSignup ? 'password' : 'text'}
              autoComplete={isSignup ? 'off' : 'username'}
              autoCapitalize="none"
              spellCheck={false}
              placeholder={isSignup ? '粘贴邀请码' : '输入管理员分配的账号名'}
              maxLength={isSignup ? 100 : 64}
              required
              disabled={busy}
              value={value}
              onChange={(event) => { setValue(event.target.value); setProblem('') }}
              labelAction={<Hint text={isSignup ? '邀请码由管理员签发，仅可使用一次，有效期为 15 分钟。' : 'Passkey 可以通过设备指纹、面容识别、屏幕解锁或实体安全密钥验证。'}><Icon name="info" size={16} />{isSignup ? '邀请码是什么？' : '什么是 Passkey？'}</Hint>}
            />
            {problem && <Alert tone="error">{problem}</Alert>}
            <Button type="submit" className="w-full" icon={isSignup ? 'shield-check' : 'key'} busy={busy}>
              {busy ? '等待设备验证…' : isSignup ? '创建 Passkey' : '使用 Passkey 登录'}
            </Button>
          </form>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-line pt-6 text-sm text-muted">
            <span>{isSignup ? '已注册 Passkey？' : '第一次使用？'}</span>
            <Link className="ui-link" onClick={switchMode} aria-disabled={busy || undefined} to={isSignup ? '/login' : '/register'} state={{ returnTo }}>
              {isSignup ? '返回登录' : '使用邀请码注册'}
            </Link>
          </div>
        </main>
        <footer className="auth-side-footer"><span className="inline-flex items-center gap-2"><Icon name="lock" size={15} />私钥由你的设备或 Passkey 服务保管</span></footer>
      </div>
    </div>
  )
}
