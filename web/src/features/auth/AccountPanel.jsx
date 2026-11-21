import Icon from '../../components/Icon.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { Alert } from '../../components/ui/Feedback.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { RefreshButton } from '../../components/ui/RefreshButton.jsx'
import { formatBytes } from '../transfers/file-data.js'
import { useSession } from './session.js'
import { useAccountProfile } from './useAccountProfile.js'

const permissions = [
  ['UPLOAD', '上传文件'],
  ['DOWNLOAD', '下载文件'],
  ['SHARE', '共享文件'],
]

function StorageUsage({ quotaBytes, usedBytes, reservedBytes }) {
  const availableBytes = Math.max(0, quotaBytes - usedBytes - reservedBytes)
  const usage = quotaBytes > 0 ? Math.min(100, 100 * (usedBytes + reservedBytes) / quotaBytes) : 0
  const used = quotaBytes > 0 ? Math.min(usage, 100 * usedBytes / quotaBytes) : 0
  const fields = [
    ['总配额', quotaBytes], ['已用', usedBytes], ['预留', reservedBytes], ['可用', availableBytes],
  ]

  return (
    <div className="rounded-xl border border-line p-3.5">
      {quotaBytes > 0 && (
        <div className="mb-3.5">
          <div className="mb-2 flex items-center justify-between gap-2 text-sm text-muted">
            <span>配额占用</span><span className="tabular-nums">{Math.round(usage)}%</span>
          </div>
          <div
            className="flex h-2 overflow-hidden rounded-full bg-[#e8eeea]"
            role="progressbar"
            aria-label="配额占用"
            aria-valuenow={Math.round(usage)}
            aria-valuetext={`已用 ${formatBytes(usedBytes)}，预留 ${formatBytes(reservedBytes)}，总配额 ${formatBytes(quotaBytes)}`}
          >
            <div className="shrink-0 bg-primary" style={{ width: `${used}%` }} />
            <div className="shrink-0 bg-[#8cc3a6]" style={{ width: `${usage - used}%` }} />
          </div>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
        {fields.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="mt-0.5 break-words text-sm font-semibold tabular-nums text-ink">{formatBytes(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function ProfileContents() {
  const { user } = useSession()
  const { profile, loading, error, refresh } = useAccountProfile()
  const account = profile ?? user
  if (!account) return null

  const role = account.role === 'admin' ? '管理员' : '普通用户'

  return (
    <div className="space-y-5">
      <div className="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-canvas px-3.5 py-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-mint text-primary"><Icon name="user" size={24} /></span>
        <div className="min-w-0">
          <p title={account.username} className="truncate text-base font-semibold text-ink">{account.username || role}</p>
          <p className="mt-0.5 text-sm text-muted">{role}</p>
        </div>
      </div>

      <section aria-label="权限">
        <h3 className="mb-2 text-sm font-semibold text-ink">权限</h3>
        <ul className="grid grid-cols-3 gap-2">
          {permissions.map(([key, label]) => {
            const granted = account.permissions.includes(key)
            return (
              <li key={key} className="min-w-0 rounded-lg border border-line px-2 py-2 sm:px-3">
                <p className="text-sm text-ink">{label}</p>
                <span className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${granted ? 'text-primary' : 'text-muted'}`}>
                  <Icon name={granted ? 'check' : 'lock'} size={13} />{granted ? '已授权' : '未授权'}
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-label="存储用量" aria-busy={loading || undefined}>
        <h3 className="mb-2 text-sm font-semibold text-ink">存储用量</h3>
        {profile ? <StorageUsage {...profile} /> : loading ? (
          <div role="status" className="flex items-center gap-2.5 rounded-xl border border-line px-3.5 py-4 text-sm text-muted">
            <Icon name="refresh" size={17} className="text-primary motion-safe:animate-spin" />正在获取存储用量…
          </div>
        ) : (
          <Alert tone="warning" title="暂时无法获取存储用量" action={<RefreshButton size="sm" label="重试" onClick={refresh} />}>{error}</Alert>
        )}
      </section>
    </div>
  )
}

export function AccountPanel({ open, onClose, onLogout }) {
  return (
    <Modal open={open} onClose={onClose} title="账户信息" footer={<Button icon="logout" variant="secondary" onClick={onLogout}>退出登录</Button>}>
      {open && <ProfileContents />}
    </Modal>
  )
}
