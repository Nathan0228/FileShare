import { useId, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.jsx'
import { Alert, Hint } from '../../components/ui/Feedback.jsx'
import { Field } from '../../components/ui/Field.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { useToast } from '../feedback/toast.js'
import { PageControls, Results, StatePill } from './AdminControls.jsx'
import { formatBytes, formatDate, mebibyte, permissionLabels, useAdminMutation, useAdminPage, usernamePattern } from './adminData.js'

function Cancel({ pending, onClose }) {
  return <Button variant="secondary" disabled={pending} onClick={onClose}>取消</Button>
}

function ActionError({ text }) {
  return text ? <Alert tone="error" title="操作未完成">{text}</Alert> : null
}

export function CreateAccountDialog({ onClose, onSuccess }) {
  const id = useId()
  const [username, setUsername] = useState('')
  const { pending, error, setError, perform } = useAdminMutation()
  const toast = useToast()

  async function submit(event) {
    event.preventDefault()
    const name = username.trim()
    if (!usernamePattern.test(name)) {
      setError('账号名须以小写字母或数字开头，可包含小写字母、数字、点、下划线和短横线，最多 64 个字符。')
      return
    }
    const { succeeded } = await perform('create', { username: name })
    if (!succeeded) return
    toast({ title: '账号已创建', description: '可在用户列表分配权限并签发登记邀请。', tone: 'success' })
    onSuccess()
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title="创建账号"
      description="新账号的初始权限和存储配额为空。"
      footer={(
        <>
          <Cancel pending={pending} onClose={onClose} />
          <Button type="submit" form={id} busy={pending}>{pending ? '创建中…' : '创建账号'}</Button>
        </>
      )}
    >
      <form id={id} onSubmit={submit} className="space-y-3">
        <Field
          label="账号名"
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          maxLength={64}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          required
          disabled={pending}
        />
        <ActionError text={error} />
      </form>
    </Modal>
  )
}

export function EditAccessDialog({ user, onClose, onSuccess }) {
  const id = useId()
  const [enabled, setEnabled] = useState(user.enabled)
  const [permissions, setPermissions] = useState(user.permissions)
  const [quota, setQuota] = useState(String(user.quotaBytes / mebibyte))
  const { pending, error, setError, perform } = useAdminMutation()
  const toast = useToast()
  const minimumQuota = user.usedBytes + user.reservedBytes

  async function submit(event) {
    event.preventDefault()
    const quotaBytes = Math.round(Number(quota) * mebibyte)
    if (!quota.trim() || !Number.isSafeInteger(quotaBytes) || quotaBytes < minimumQuota || quotaBytes > 2 ** 50) {
      setError(`配额须覆盖已用与预留空间，当前至少需要 ${formatBytes(minimumQuota)}。`)
      return
    }
    const { succeeded } = await perform('setAccess', { username: user.username, enabled, permissions, quotaBytes })
    if (!succeeded) return
    toast({ title: '权限设置已保存', description: user.username, tone: 'success' })
    onSuccess()
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title="编辑账号权限"
      description={user.username}
      footer={(
        <>
          <Cancel pending={pending} onClose={onClose} />
          <Button type="submit" form={id} busy={pending}>{pending ? '保存中…' : '保存设置'}</Button>
        </>
      )}
    >
      <form id={id} onSubmit={submit} className="space-y-5">
        <label className="flex items-center gap-2.5 text-sm font-medium text-slate-800">
          <input type="checkbox" checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-emerald-700" />
          启用账号
        </label>
        {user.enabled && !enabled && <Alert tone="warning" title="禁用后将撤销该账号的会话和待使用邀请。" />}
        <fieldset disabled={pending} className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-slate-800">文件权限</legend>
          <div className="flex flex-wrap gap-2">
            {Object.entries(permissionLabels).map(([key, label]) => (
              <label key={key} className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="size-4 accent-emerald-700"
                  checked={permissions.includes(key)}
                  onChange={(event) => setPermissions(event.target.checked ? [...permissions, key] : permissions.filter((value) => value !== key))}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <Field
          label="存储配额（MiB）"
          labelAction={<Hint text="配额至少须覆盖已用空间和未完成上传预留的空间。" />}
          hint={`已用和预留合计 ${formatBytes(minimumQuota)}`}
          type="number"
          min={0}
          max={2 ** 30}
          step="any"
          inputMode="decimal"
          disabled={pending}
          required
          value={quota}
          onChange={(event) => setQuota(event.target.value)}
        />
        <ActionError text={error} />
      </form>
    </Modal>
  )
}

const defaultInviteMinutes = 15
const maxInviteMinutes = 30 * 24 * 60
const inviteExpiryFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
})

export function InviteAccountDialog({ user, onClose }) {
  const formId = useId()
  const unitId = useId()
  const [duration, setDuration] = useState(String(defaultInviteMinutes))
  const [minutesPerUnit, setMinutesPerUnit] = useState(1)
  const [invite, setInvite] = useState(null)
  const [copyError, setCopyError] = useState(false)
  const input = useRef(null)
  const { pending, error, setError, perform } = useAdminMutation()
  const toast = useToast()
  const maxDuration = maxInviteMinutes / minutesPerUnit

  async function createInvite(event) {
    event.preventDefault()
    const amount = Number(duration)
    if (!Number.isInteger(amount) || amount < 1 || amount > maxDuration) {
      setError(`请输入 1 至 ${maxDuration} 的整数。`)
      return
    }
    const ttlMinutes = amount * minutesPerUnit
    const params = { username: user.username }
    if (ttlMinutes !== defaultInviteMinutes) params.ttlMinutes = ttlMinutes
    const { succeeded, body } = await perform('invite', params)
    if (!succeeded) return
    if (!/^[A-Za-z0-9_-]{43}$/.test(body?.inviteToken ?? '')) {
      setError('服务未返回有效的邀请令牌。')
      return
    }
    const expiresAt = typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt)) ? body.expiresAt : null
    setInvite({ token: body.inviteToken, expiresAt })
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.token)
      setCopyError(false)
      toast({ title: '邀请令牌已复制', tone: 'success' })
    } catch {
      input.current?.focus()
      input.current?.select()
      setCopyError(true)
    }
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title="签发登记邀请"
      description={`账号 ${user.username}`}
      footer={invite ? (
        <>
          <Button variant="secondary" onClick={onClose}>关闭</Button>
          <Button icon="copy" onClick={copy}>复制令牌</Button>
        </>
      ) : (
        <>
          <Cancel pending={pending} onClose={onClose} />
          <Button type="submit" form={formId} busy={pending}>{pending ? '生成中…' : '生成邀请'}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        {invite ? (
          <>
            <Field label="一次性邀请令牌" ref={input} value={invite.token} readOnly className="[&_input]:font-mono" onFocus={(event) => event.target.select()} />
            {invite.expiresAt && (
              <p className="text-sm text-slate-700">
                到期时间 <time dateTime={invite.expiresAt} className="font-medium">{inviteExpiryFormat.format(new Date(invite.expiresAt))}</time>
              </p>
            )}
            <p className="text-sm leading-6 text-slate-500">请通过可信渠道将令牌交给用户。用户可在登录页用它登记 Passkey。</p>
          </>
        ) : (
          <form id={formId} onSubmit={createInvite} className="space-y-3">
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-end gap-3">
              <Field label="有效期" type="number" min={1} max={maxDuration} step={1} inputMode="numeric" required
                disabled={pending} value={duration} onChange={(event) => { setDuration(event.target.value); setError('') }} />
              <div className="space-y-2">
                <label htmlFor={unitId} className="block text-sm font-semibold text-ink">单位</label>
                <select id={unitId} className="ui-input" disabled={pending} value={minutesPerUnit}
                  onChange={(event) => { setMinutesPerUnit(Number(event.target.value)); setError('') }}>
                  <option value={1}>分钟</option>
                  <option value={60}>小时</option>
                  <option value={1440}>天</option>
                </select>
              </div>
            </div>
            <p className="text-sm leading-6 text-slate-600">最长 30 天，按所选单位填写整数。重新签发会替换该账号尚未使用的邀请。</p>
          </form>
        )}
        {copyError && <Alert tone="warning" title="请手动复制">浏览器未授予剪贴板权限，令牌已选中。</Alert>}
        <ActionError text={error} />
      </div>
    </Modal>
  )
}

export function CredentialsDialog({ user, onClose }) {
  const page = useAdminPage('credentials', { username: user.username })
  const [selected, setSelected] = useState(null)
  const { perform, pending, error, setError } = useAdminMutation()
  const toast = useToast()

  async function revoke() {
    const { succeeded } = await perform('revokeCredential', { username: user.username, credentialId: selected.credentialId })
    if (!succeeded) return
    setSelected(null)
    page.refresh()
    toast({ title: 'Passkey 已撤销', description: '由该凭据建立的会话也已撤销。', tone: 'success' })
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title="Passkey 凭据"
      description={`账号 ${user.username}`}
      footer={<Button variant="secondary" onClick={onClose} disabled={pending}>关闭</Button>}
    >
      <div className="space-y-3">
        {selected && (
          <Alert tone="warning" title="撤销此 Passkey？">
            <p>该凭据及其已建立的会话会失效。</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => { setSelected(null); setError('') }}>保留凭据</Button>
              <Button variant="danger" size="sm" busy={pending} onClick={revoke}>{pending ? '撤销中…' : '确认撤销'}</Button>
            </div>
          </Alert>
        )}
        <ActionError text={error} />
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <Results page={page} emptyIcon="key" emptyTitle="暂无 Passkey" emptyDescription="用户完成登记后，凭据将显示在这里。">
            <ul className="divide-y divide-slate-100">
              {page.items.map((credential) => (
                <li key={credential.credentialId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm text-slate-800" title={credential.credentialId}>{credential.credentialId}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {credential.revokedAt ? `撤销于 ${formatDate(credential.revokedAt)}` : `登记于 ${formatDate(credential.createdAt)}`}
                    </p>
                  </div>
                  {credential.revokedAt ? <StatePill>已撤销</StatePill> : user.role === 'admin' ? <StatePill tone="positive">有效</StatePill> : (
                    <Button variant="ghost" size="sm" disabled={Boolean(selected)} onClick={() => setSelected(credential)}>撤销</Button>
                  )}
                </li>
              ))}
            </ul>
          </Results>
          {!selected && <PageControls page={page} />}
        </div>
      </div>
    </Modal>
  )
}
