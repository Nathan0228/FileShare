import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import FileIcon from '../../components/FileIcon.jsx'
import Icon from '../../components/Icon.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { Alert, EmptyState, Hint } from '../../components/ui/Feedback.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { useSession } from '../auth/session.js'
import { useToast } from '../feedback/toast.js'
import { useTransfers } from './context.js'
import { formatBytes } from './file-data.js'
import { workingStatuses } from './queue.js'

const statusLabels = {
  queued: '排队中', hashing: '正在计算摘要', transferring: '传输中', verifying: '正在校验',
  pausing: '正在暂停', paused: '已暂停', waiting: '等待重新连接', 'needs-file': '需要原文件',
  'cancel-pending': '等待取消', cancelling: '正在取消', cancelled: '已取消',
  ready: '待保存', complete: '已完成', error: '需要处理',
}

const statusColors = {
  hashing: 'bg-sky-50 text-sky-700', transferring: 'bg-emerald-50 text-emerald-800',
  verifying: 'bg-sky-50 text-sky-700', ready: 'bg-emerald-50 text-emerald-800',
  complete: 'bg-emerald-50 text-emerald-800', waiting: 'bg-amber-50 text-amber-800',
  'needs-file': 'bg-amber-50 text-amber-800', error: 'bg-red-50 text-red-700',
}

const filters = [
  { id: 'all', label: '全部' }, { id: 'upload', label: '上传' }, { id: 'download', label: '下载' },
]

export function TransferPage() {
  const navigate = useNavigate()
  const notify = useToast()
  const { user, status } = useSession()
  const transfers = useTransfers()
  const uploadInput = useRef(null)
  const reselectInput = useRef(null)
  const reselectId = useRef(null)
  const [filter, setFilter] = useState('all')
  const [confirmation, setConfirmation] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const allowed = user?.permissions?.includes('UPLOAD')
  const filtered = transfers.tasks.filter((task) => filter === 'all' || filter === task.kind)
  const completed = transfers.tasks.filter((task) => ['complete', 'ready'].includes(task.status)).length
  const needsAction = transfers.tasks.filter((task) => ['paused', 'error', 'needs-file', 'queued', 'waiting', 'cancel-pending'].includes(task.status)).length

  async function action(job, failureTitle) {
    try {
      await job()
      return true
    } catch (error) {
      if (error?.name !== 'AbortError') notify({ title: failureTitle, description: error.message, tone: 'error' })
      return false
    }
  }

  function upload(event) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length) return
    void action(async () => {
      const count = await transfers.enqueueUploads(files)
      setFilter('all')
      notify({ title: `已添加 ${count} 个上传任务`, tone: 'success' })
    }, '无法添加上传任务')
  }

  function selectOriginal(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void action(() => transfers.reselect(reselectId.current, file), '无法续传')
  }

  async function confirm() {
    if (!confirmation) return
    setConfirming(true)
    const remove = confirmation.kind === 'remove'
    const ok = await action(() => remove ? transfers.remove(confirmation.task.id) : transfers.cancel(confirmation.task.id),
      remove ? '无法清理任务' : '无法取消任务')
    setConfirming(false)
    if (ok) setConfirmation(null)
  }

  return (
    <section aria-labelledby="transfers-title" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="transfers-title" className="page-title">传输中心</h1>
          <p className="page-description">跟踪文件上传与下载，随时暂停并继续。</p>
        </div>
        {allowed && (
          <Button icon="upload" disabled={!transfers.storageReady} onClick={() => uploadInput.current?.click()}>
            添加上传
          </Button>
        )}
      </div>

      <input ref={uploadInput} type="file" multiple aria-label="选择上传文件" hidden onChange={upload} />
      <input ref={reselectInput} type="file" aria-label="选择续传原文件" hidden onChange={selectOriginal} />

      {transfers.storageError && <Alert tone="error" title="本地存储不可用">{transfers.storageError}</Alert>}
      {status !== 'online' && !transfers.storageError && (
        <Alert tone="info" title="等待连接">
          恢复连接并通过身份验证后，将自动继续队列中的任务。
        </Alert>
      )}

      <dl className="grid gap-3 sm:grid-cols-3">
        <Metric icon="transfer" label="进行中" value={transfers.activeCount} />
        <Metric icon="clock" label="待处理" value={needsAction} />
        <Metric icon="check" label="已校验" value={completed} />
      </dl>

      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 px-4 py-4 sm:px-6">
          <h2 className="text-base font-semibold text-slate-900">传输记录</h2>
          <div aria-label="按传输方向筛选" className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {filters.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${filter === id
                  ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon="transfer"
            title={transfers.storageReady
              ? (filter === 'all' ? '暂无传输任务' : '暂无符合条件的任务')
              : transfers.storageError ? '无法读取传输记录' : '正在读取传输记录'}
            description={transfers.storageReady ? '在文件页面选择要下载的文件，或添加新的上传。' : undefined}
            action={transfers.storageReady && <Button variant="secondary" icon="folder" onClick={() => navigate('/files')}>浏览文件</Button>}
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtered.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                saving={transfers.saving.includes(task.id)}
                onPause={() => void action(() => transfers.pause(task.id), '无法暂停任务')}
                onResume={() => void action(() => transfers.resume(task.id), '无法继续任务')}
                onReselect={() => {
                  reselectId.current = task.id
                  reselectInput.current?.click()
                }}
                onSave={() => void action(() => transfers.save(task.id), '无法保存文件')}
                onCancel={() => setConfirmation({ task, kind: 'cancel' })}
                onRemove={() => setConfirmation({ task, kind: 'remove' })}
              />
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={Boolean(confirmation)}
        onClose={() => { if (!confirming) setConfirmation(null) }}
        title={confirmation?.kind === 'remove' ? '清理传输记录' : '取消传输任务'}
        description={confirmation?.task.name}
        footer={(
          <>
            <Button variant="secondary" disabled={confirming} onClick={() => setConfirmation(null)}>返回</Button>
            <Button variant="danger" disabled={confirming} onClick={() => void confirm()}>
              {confirmation?.kind === 'remove' ? '清理记录' : '取消任务'}
            </Button>
          </>
        )}
      >
        <p className="mb-2 text-sm text-slate-600">
          {confirmation?.kind === 'cancel' ? '取消后会清理该任务的断点。'
            : confirmation?.task.status === 'ready' ? '此文件仍未保存。清理记录会一并移除本地缓存。'
              : '这条记录将从传输中心移除。'}
        </p>
      </Modal>
    </section>
  )
}

function Metric({ icon, label, value }) {
  return (
    <div className="panel flex items-center gap-3 px-4 py-4 sm:px-5">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
        <Icon name={icon} size={19} />
      </span>
      <dt className="min-w-0 flex-1 text-sm font-medium text-slate-600">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-slate-950">{value}</dd>
    </div>
  )
}

function TaskRow({ task, saving, onPause, onResume, onReselect, onSave, onCancel, onRemove }) {
  const finished = task.status === 'complete' || task.status === 'ready'
  const progress = task.size ? Math.min(100, Math.round(100 * task.completedBytes / task.size)) : finished ? 100 : 0
  const label = statusLabels[task.status] || statusLabels.error
  const direction = task.kind === 'upload' ? '上传' : '下载'
  const canPause = ['queued', 'hashing', 'transferring', 'waiting'].includes(task.status) && !task.cancelRequested
  const canResume = task.status === 'paused' || task.status === 'error'
  const canCancel = !task.cancelRequested && !['verifying', 'pausing', 'ready', 'complete', 'cancelled'].includes(task.status)

  return (
    <li className="grid gap-3 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(9rem,16rem)_minmax(9rem,auto)] lg:items-center lg:gap-5">
      <div className="flex min-w-0 items-start gap-3">
        <FileIcon filename={task.name} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900" title={task.name}>{task.name}</p>
          <p className="mt-1 text-sm text-slate-500">{direction} · {formatBytes(task.size)}</p>
          {task.error && <p role="status" className="mt-1 text-sm text-red-700">{task.error}</p>}
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${statusColors[task.status] || 'bg-slate-100 text-slate-600'}`}>
            {label}
          </span>
          {task.status !== 'cancelled' && <span className="tabular-nums text-slate-500">{progress}%</span>}
        </div>
        {task.status !== 'cancelled' && (
          <progress
            className="block h-1.5 w-full overflow-hidden rounded-full bg-slate-100 accent-emerald-600 [&::-moz-progress-bar]:bg-emerald-600 [&::-webkit-progress-bar]:bg-slate-100 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-emerald-600"
            max="100"
            value={progress}
            aria-label={`${task.name} ${direction}进度`}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
        {task.status === 'ready' && <Button size="sm" icon="download" disabled={saving} onClick={onSave}>{saving ? '正在保存' : '保存文件'}</Button>}
        {canResume && <Button size="sm" variant="secondary" icon="play" onClick={onResume}>{task.cancelRequested ? '重试取消' : task.status === 'error' ? '重试' : '继续'}</Button>}
        {task.status === 'needs-file' && <Button size="sm" variant="secondary" icon="file" onClick={onReselect}>选择原文件</Button>}
        {canPause && <TaskIcon name="pause" label="暂停任务" onClick={onPause} />}
        {canCancel && <TaskIcon name="x" label="取消任务" onClick={onCancel} />}
        {['complete', 'ready', 'cancelled'].includes(task.status) && <TaskIcon name="trash" label="清理记录" disabled={saving} onClick={onRemove} />}
        {workingStatuses.has(task.status) && !canPause && !canCancel && <span className="text-sm text-slate-500">{label}</span>}
      </div>
    </li>
  )
}

function TaskIcon({ name, label, onClick, disabled }) {
  return (
    <Hint text={label}>
      <Button size="sm" variant="ghost" className="icon-button" aria-label={label} icon={name} disabled={disabled} onClick={onClick} />
    </Hint>
  )
}
