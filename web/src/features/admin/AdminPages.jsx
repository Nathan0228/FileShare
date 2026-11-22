import { useId, useState } from 'react'
import Icon from '../../components/Icon.jsx'
import RecordTime from '../../components/RecordTime.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { Field } from '../../components/ui/Field.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { RefreshButton } from '../../components/ui/RefreshButton.jsx'
import { CreateAccountDialog, CredentialsDialog, EditAccessDialog, InviteAccountDialog } from './AccountDialogs.jsx'
import { AdminHeader, PageControls, Results, StatePill } from './AdminControls.jsx'
import { formatBytes, formatDate, permissionLabels, useAdminPage } from './adminData.js'

const panel = 'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm'
const tableHeading = 'px-4 py-3 text-left text-sm font-medium text-slate-500'
const tableCell = 'px-4 py-3.5 align-middle text-sm text-slate-700'

function UserIdentity({ user }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-sm font-semibold text-emerald-800">
        {user.username.slice(0, 2).toUpperCase()}
      </span>
      <p className="max-w-48 truncate font-medium text-slate-900" title={user.username}>{user.username}</p>
    </div>
  )
}

function UserPermissions({ permissions }) {
  if (!permissions?.length) return <span className="text-sm text-slate-500">无权限</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((permission) => <StatePill key={permission}>{permissionLabels[permission] ?? permission}</StatePill>)}
    </div>
  )
}

function UserQuota({ user }) {
  return (
    <div className="whitespace-nowrap">
      <div className="text-sm text-slate-700"><span className="font-medium">{formatBytes(user.usedBytes)}</span> <span className="text-slate-500">/ {formatBytes(user.quotaBytes)}</span></div>
      {user.reservedBytes > 0 && <p className="mt-0.5 text-xs text-slate-500">已预留 {formatBytes(user.reservedBytes)}</p>}
    </div>
  )
}

function UserActions({ user, select }) {
  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {user.role !== 'admin' && (
        <>
          <Button variant="ghost" size="sm" onClick={() => select('edit', user)}>编辑权限</Button>
          <Button variant="ghost" size="sm" disabled={!user.enabled} onClick={() => select('invite', user)}>邀请</Button>
        </>
      )}
      <Button variant="ghost" size="sm" onClick={() => select('credentials', user)}>Passkey</Button>
    </div>
  )
}

function EnabledState({ enabled }) {
  return enabled ? <StatePill tone="positive">已启用</StatePill> : <StatePill>已禁用</StatePill>
}

function UserList({ users, select, headingId }) {
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[860px] border-collapse" aria-labelledby={headingId}>
          <thead className="border-b border-slate-100 bg-slate-50/75">
            <tr>
              {['账号', '状态', '文件权限', '存储用量', '创建时间', '操作'].map((label) => <th key={label} scope="col" className={tableHeading}>{label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.map((user) => (
              <tr key={user.userId}>
                <td className={tableCell}><UserIdentity user={user} /></td>
                <td className={tableCell}><EnabledState enabled={user.enabled} /></td>
                <td className={tableCell}><UserPermissions permissions={user.permissions} /></td>
                <td className={tableCell}><UserQuota user={user} /></td>
                <td className={tableCell}><RecordTime value={user.createdAt} className="whitespace-nowrap text-slate-500" /></td>
                <td className={tableCell}><UserActions user={user} select={select} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-labelledby={headingId} className="divide-y divide-slate-100 lg:hidden">
        {users.map((user) => (
          <li key={user.userId} className="space-y-3 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <UserIdentity user={user} />
              <EnabledState enabled={user.enabled} />
            </div>
            <dl className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1"><dt className="text-sm text-slate-500">文件权限</dt><dd><UserPermissions permissions={user.permissions} /></dd></div>
              <div className="min-w-0 space-y-1"><dt className="text-sm text-slate-500">存储用量</dt><dd><UserQuota user={user} /></dd></div>
              <div className="col-span-2 min-w-0 space-y-1"><dt className="text-sm text-slate-500">创建时间</dt><dd className="text-sm text-slate-700"><RecordTime value={user.createdAt} /></dd></div>
            </dl>
            <UserActions user={user} select={select} />
          </li>
        ))}
      </ul>
    </>
  )
}

function UserGroup({ title, icon, page, select, children }) {
  const headingId = useId()
  const emptyTitle = page.search ? '未找到匹配的普通用户' : `暂无${title}`
  const emptyDescription = page.search ? `没有用户名包含「${page.search}」。` : undefined

  return (
    <section className={panel} aria-labelledby={headingId}>
      <header className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3.5 sm:px-5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-800">
          <Icon name={icon} size={18} />
        </span>
        <h2 className="text-base font-semibold text-slate-900" id={headingId}>{title}</h2>
      </header>
      {children}
      <Results page={page} emptyIcon={icon} emptyTitle={emptyTitle} emptyDescription={emptyDescription}>
        <UserList users={page.items} select={select} headingId={headingId} />
      </Results>
      <PageControls page={page} label={`${title}分页`} />
    </section>
  )
}

const usernameFragment = /^[a-z0-9._-]{0,64}$/

function UserSearch({ page }) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')

  function search(event) {
    event.preventDefault()
    const value = input.trim().toLowerCase()
    if (!usernameFragment.test(value)) {
      setError('搜索词可包含字母、数字、点、下划线和连字符，最多 64 个字符。')
      return
    }
    setError('')
    setInput(value)
    page.setSearch(value)
  }

  function clear() {
    setInput('')
    setError('')
    if (page.search) page.setSearch('')
  }

  return (
    <form role="search" aria-label="搜索普通用户" onSubmit={search} className="space-y-2 border-b border-slate-100 px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="用户名"
          icon="search"
          className="min-w-44 flex-1 sm:max-w-xs"
          type="search"
          placeholder="输入用户名或其中一部分"
          value={input}
          onChange={(event) => { setInput(event.target.value); setError('') }}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="secondary">搜索</Button>
        {(input || page.search) && <Button variant="ghost" onClick={clear}>清除搜索</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>
  )
}

export function AdminUsers() {
  const administrators = useAdminPage('users', { role: 'admin' })
  const members = useAdminPage('users', { role: 'user' })
  const [dialog, setDialog] = useState(null)

  function select(type, user) {
    setDialog({ type, user })
  }

  function close() {
    setDialog(null)
  }

  function updateList() {
    close()
    members.refresh()
  }

  function refresh() {
    administrators.refresh()
    members.refresh()
  }

  return (
    <section className="min-w-0 space-y-5">
      <AdminHeader title="用户管理" description="分配文件权限、签发登记邀请和管理 Passkey。">
        <RefreshButton onClick={refresh} loading={administrators.loading || members.loading} />
        <Button icon="add" onClick={() => select('create')}>创建账号</Button>
      </AdminHeader>
      <UserGroup title="管理员" icon="shield-check" page={administrators} select={select} />
      <UserGroup title="普通用户" icon="users" page={members} select={select}>
        <UserSearch page={members} />
      </UserGroup>
      {dialog?.type === 'create' && <CreateAccountDialog onClose={close} onSuccess={updateList} />}
      {dialog?.type === 'edit' && <EditAccessDialog user={dialog.user} onClose={close} onSuccess={updateList} />}
      {dialog?.type === 'invite' && <InviteAccountDialog user={dialog.user} onClose={close} />}
      {dialog?.type === 'credentials' && <CredentialsDialog user={dialog.user} onClose={close} />}
    </section>
  )
}

const auditActions = {
  'admin.bootstrap': '初始化管理员',
  'account.create': '创建账号',
  'account.set_access': '调整账号权限',
  'invite.issue': '签发登记邀请',
  'credential.revoke': '撤销 Passkey',
  'share.grant': '授予文件访问',
  'share.revoke': '撤销文件访问',
  'file.delete': '删除文件',
  'download.complete': '完成下载',
  ENROLL: '登记 Passkey',
  AUTH: 'Passkey 登录',
}

function AuditResult({ result }) {
  if (result === 'OK') return <StatePill tone="positive">成功</StatePill>
  if (result === 'COUNTER_WARNING') return <StatePill tone="warning">计数异常</StatePill>
  return <StatePill>{result}</StatePill>
}

function AuditID({ value, empty = '—' }) {
  return value ? <span className="block max-w-34 truncate font-mono text-xs text-slate-600" title={value}>{value}</span> : empty
}

function AuditDetail({ event, onClose }) {
  const fields = [
    ['记录编号', event.id],
    ['时间', formatDate(event.createdAt)],
    ['操作者 ID', event.actorId ?? '系统'],
    ['目标 ID', event.targetId ?? '—'],
    ['操作代码', event.action],
    ['结果', <AuditResult result={event.result} />],
  ]

  return (
    <Modal open onClose={onClose} title="审计详情" description={auditActions[event.action] ?? event.action} footer={<Button variant="secondary" onClick={onClose}>关闭</Button>}>
      <dl className="divide-y divide-slate-100 text-sm">
        {fields.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 py-2.5">
            <dt className="text-slate-500">{label}</dt>
            <dd className="wrap-anywhere text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
      {event.requestMeta != null && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium text-slate-800">附加信息</p>
          <pre className="max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-xs wrap-anywhere whitespace-pre-wrap text-slate-700">
            {JSON.stringify(event.requestMeta, null, 2)}
          </pre>
        </div>
      )}
    </Modal>
  )
}

function AuditList({ events, select }) {
  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[660px] border-collapse" aria-label="审计事件">
          <thead className="border-b border-slate-100 bg-slate-50/75">
            <tr>
              {['操作', '操作者 ID', '目标 ID', '时间', '结果', '详情'].map((label) => <th key={label} scope="col" className={tableHeading}>{label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {events.map((event) => (
              <tr key={event.id}>
                <td className={`${tableCell} font-medium text-slate-900`}>{auditActions[event.action] ?? event.action}</td>
                <td className={tableCell}><AuditID value={event.actorId} empty="系统" /></td>
                <td className={tableCell}><AuditID value={event.targetId} /></td>
                <td className={`${tableCell} whitespace-nowrap text-slate-500`}>{formatDate(event.createdAt)}</td>
                <td className={tableCell}><AuditResult result={event.result} /></td>
                <td className={tableCell}><Button variant="ghost" size="sm" onClick={() => select(event)}>查看</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-label="审计事件" className="divide-y divide-slate-100 lg:hidden">
        {events.map((event) => (
          <li key={event.id} className="flex items-start justify-between gap-3 px-4 py-4">
            <div className="min-w-0 space-y-1.5">
              <p className="wrap-anywhere font-medium text-slate-900">{auditActions[event.action] ?? event.action}</p>
              <p className="text-sm text-slate-500">{formatDate(event.createdAt)}</p>
              <AuditResult result={event.result} />
            </div>
            <Button variant="ghost" size="sm" onClick={() => select(event)}>查看详情</Button>
          </li>
        ))}
      </ul>
    </>
  )
}

export function AdminAudit() {
  const page = useAdminPage('audit')
  const [selected, setSelected] = useState(null)

  return (
    <section className="min-w-0 space-y-5">
      <AdminHeader title="操作审计" description="查看账号变更、登录和文件访问记录。">
        <RefreshButton onClick={page.refresh} loading={page.loading} />
      </AdminHeader>
      <div className={panel}>
        <Results page={page} emptyIcon="history" emptyTitle="暂无审计记录" emptyDescription="记录产生后会按时间从新到旧显示。">
          <AuditList events={page.items} select={setSelected} />
        </Results>
        <PageControls page={page} />
      </div>
      {selected && <AuditDetail event={selected} onClose={() => setSelected(null)} />}
    </section>
  )
}
