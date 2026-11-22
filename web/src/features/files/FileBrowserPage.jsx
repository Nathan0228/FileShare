import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import FileIcon from '../../components/FileIcon.jsx'
import Icon from '../../components/Icon.jsx'
import RecordTime from '../../components/RecordTime.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { Alert, EmptyState } from '../../components/ui/Feedback.jsx'
import { RefreshButton } from '../../components/ui/RefreshButton.jsx'
import { getErrorMessage } from '../../services/errors.js'
import { useSession } from '../auth/session.js'
import { useToast } from '../feedback/toast.js'
import { useTransfers } from '../transfers/index.js'
import { formatBytes } from '../transfers/file-data.js'
import { applyToFiles } from './fileActions.js'
import { DeleteFileDialog, ShareDialog } from './FileDialogs.jsx'
import { useFileList } from './useFileList.js'

function FileSelection({ label, checked, mixed = false, disabled, onChange }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      ref={(input) => { if (input) input.indeterminate = mixed }}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="size-4 cursor-pointer rounded accent-primary disabled:cursor-not-allowed"
    />
  )
}

function FileRow({ file, owned, timeLabel, canDownload, canShare, ready, selected, onSelect, onDownload, onShare, onDelete }) {
  const parts = file.name.split('.')
  const extension = parts.length > 1 && parts.at(-1).length <= 5 ? parts.at(-1).toUpperCase() : ''
  const time = owned ? file.createdAt : file.sharedAt
  return (
    <li className={`file-row transition-colors ${selected ? 'bg-[#f0f8f3]' : 'hover:bg-[#f8faf9]'}`}>
      <FileSelection label={`选择 ${file.name}`} checked={selected} onChange={(checked) => onSelect(file.fileId, checked)} />
      <div className="flex min-w-0 items-center gap-3">
        <FileIcon filename={file.name} />
        <div className="min-w-0">
          <p title={file.name} className="truncate text-sm font-semibold text-ink">{file.name}</p>
          {extension && <p className="mt-0.5 hidden text-xs text-muted lg:block">{extension}</p>}
        </div>
      </div>
      <span className="hidden text-sm tabular-nums text-muted lg:block">{formatBytes(file.size)}</span>
      <span className="hidden truncate text-sm text-muted lg:block" title={file.owner}>{file.owner}</span>
      <RecordTime value={time} className="hidden min-w-0 text-sm tabular-nums text-muted lg:block" />
      <div className="flex justify-end gap-0.5">
        <Button variant="ghost" size="sm" icon="download" className="icon-button" disabled={!canDownload} title={canDownload ? '下载' : '下载需有效连接与权限'} aria-label={`下载 ${file.name}`} onClick={() => onDownload(file)} />
        {owned && canShare && <Button variant="ghost" size="sm" icon="shared" className="icon-button" disabled={!ready} title="共享权限" aria-label={`共享 ${file.name}`} onClick={() => onShare(file)} />}
        {owned && <Button variant="ghost" size="sm" icon="trash" className="icon-button" disabled={!ready} title="删除" aria-label={`删除 ${file.name}`} onClick={() => onDelete(file)} />}
      </div>
      <div className="col-span-2 col-start-2 min-w-0 space-y-1 text-xs text-muted lg:hidden">
        <p className="truncate" title={file.owner}>{formatBytes(file.size)} · {file.owner}</p>
        <p className="flex min-w-0 flex-wrap gap-x-1.5">
          <span>{timeLabel}</span>
          <RecordTime value={time} className="min-w-0 wrap-anywhere tabular-nums" />
        </p>
      </div>
    </li>
  )
}

export function FileBrowserPage({ scope }) {
  const { user } = useSession()
  const { enqueueUploads, enqueueDownload, storageReady, completedUploads } = useTransfers()
  const toast = useToast()
  const location = useLocation()
  const navigate = useNavigate()
  const input = useRef(null)
  const downloadRequest = useRef(null)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [selection, setSelection] = useState(() => new Set())
  const [batchDownloading, setBatchDownloading] = useState(false)
  const owned = scope === 'owned'
  const timeLabel = owned ? '上传时间' : '共享时间'
  const page = useFileList(scope, owned ? completedUploads : 0)
  const canUpload = owned && user.permissions.includes('UPLOAD')
  const canTransfer = Boolean(page.ready && storageReady)
  const canDownload = canTransfer && user.permissions.includes('DOWNLOAD')
  const canShare = user.permissions.includes('SHARE')
  const search = query.trim().toLocaleLowerCase()
  const files = page.items.filter((file) => !search || [file.name, file.owner].some((value) => value.toLocaleLowerCase().includes(search)))
  const selectedFiles = files.filter((file) => selection.has(file.fileId))
  const allSelected = files.length > 0 && selectedFiles.length === files.length

  useEffect(() => () => downloadRequest.current?.abort(), [])

  function setFilesSelected(ids, checked) {
    setSelection((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function clearAppliedSelection(applied) {
    setFilesSelected(applied.map(({ fileId }) => fileId), false)
  }

  async function downloadSelected() {
    if (!canDownload || downloadRequest.current || !selectedFiles.length) return
    const controller = new AbortController()
    const { signal } = controller
    downloadRequest.current = controller
    setBatchDownloading(true)
    try {
      const { succeeded, failures } = await applyToFiles(selectedFiles, enqueueDownload, signal)
      if (signal.aborted) return
      if (succeeded.length) clearAppliedSelection(succeeded)
      if (failures.length) {
        const failure = failures[0]
        toast({
          title: `已提交 ${succeeded.length} 项下载，${failures.length} 项失败`,
          description: `${failure.file.name} · ${failure.message}`,
          tone: succeeded.length ? 'warning' : 'error',
        })
      } else {
        toast({ title: `已提交 ${succeeded.length} 项下载`, description: '可在传输中心查看进度。', tone: 'success' })
      }
    } finally {
      downloadRequest.current = null
      if (!signal.aborted) setBatchDownloading(false)
    }
  }

  async function upload(selected) {
    if (!canUpload || !canTransfer || !selected.length) return
    try {
      const count = await enqueueUploads(selected)
      if (count) toast({ title: `已添加 ${count} 个上传任务`, description: '可在传输中心查看进度。', tone: 'success' })
    } catch (error) {
      toast({ title: '无法添加上传任务', description: getErrorMessage(error), tone: 'error' })
    }
  }

  async function download(file) {
    try {
      await enqueueDownload(file)
      toast({ title: '已添加下载任务', description: '传输中心会在校验完成后提供保存操作。', tone: 'success' })
    } catch (error) {
      toast({ title: '无法添加下载任务', description: getErrorMessage(error), tone: 'error' })
    }
  }

  function dragOver(event) {
    if (!canUpload || !canTransfer || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  function drop(event) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDragging(false)
    void upload(Array.from(event.dataTransfer.files))
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">{owned ? '我的文件' : '共享给我'}</h1>
          <p className="page-description">{owned ? '上传文件，按账号设置谁可以访问。' : '查看其他用户授权给你的文件。'}</p>
        </div>
        {canUpload && <div className="flex gap-2">
          <input ref={input} type="file" multiple hidden onChange={(event) => {
            const selected = Array.from(event.target.files || [])
            event.target.value = ''
            void upload(selected)
          }} />
          <Button icon="upload" disabled={!canTransfer} onClick={() => input.current?.click()}>上传文件</Button>
        </div>}
      </header>

      {location.state?.accessDenied && <Alert tone="warning" title="此页面仅管理员可访问" action={<Button size="sm" variant="secondary" onClick={() => navigate('/files', { replace: true })}>知道了</Button>}>已返回我的文件。</Alert>}
      {!page.ready && <Alert tone="info" title="等待连接">连接恢复后会重新获取文件列表。</Alert>}
      {page.ready && !storageReady && <Alert tone="info" title="传输存储未就绪">请稍候。若一直无法添加任务，请检查浏览器是否允许站点存储。</Alert>}

      <div className={`panel relative overflow-hidden ${dragging ? 'outline-2 outline-offset-2 outline-primary' : ''}`} onDragOver={dragOver} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false) }} onDrop={drop}>
        {dragging && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[#eefaf2ed] p-4 text-center text-lg font-bold text-primary">松开以上传文件</div>}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
          <div className="search-input relative min-w-0 flex-1 sm:max-w-xs">
            <Icon name="search" size={17} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
            <input type="search" aria-label="搜索已加载文件" placeholder="搜索已加载文件" className="ui-input" value={query} onChange={(event) => { setQuery(event.target.value); setSelection(new Set()) }} />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted sm:block">{search ? `匹配 ${files.length} 个` : `已加载 ${page.items.length} 个文件`}</span>
            <RefreshButton size="sm" label="刷新列表" iconOnly disabled={!page.ready} loading={page.loading} onClick={page.refresh} />
          </div>
        </div>
        {selectedFiles.length > 0 && (
          <div role="group" aria-label="批量操作" className="flex flex-wrap items-center gap-2.5 border-t border-line bg-[#f0f8f3] px-4 py-3 sm:px-5">
            <span role="status" className="mr-1 text-sm font-semibold text-primary">已选 {selectedFiles.length} 项</span>
            <Button variant="secondary" size="sm" icon="download" busy={batchDownloading} disabled={!canDownload} onClick={downloadSelected}>批量下载</Button>
            {owned && canShare && <Button variant="secondary" size="sm" icon="shared" disabled={!page.ready || batchDownloading} onClick={() => setDialog({ kind: 'share', files: selectedFiles })}>批量共享</Button>}
            {owned && <Button variant="secondary" size="sm" icon="trash" disabled={!page.ready || batchDownloading} onClick={() => setDialog({ kind: 'delete', files: selectedFiles })}>批量删除</Button>}
            <Button variant="ghost" size="sm" onClick={() => setSelection(new Set())}>清除选择</Button>
          </div>
        )}
        <div className="file-row file-row-heading border-y border-line">
          <FileSelection label="全选当前显示的文件" checked={allSelected} mixed={!allSelected && selectedFiles.length > 0} disabled={!files.length} onChange={(checked) => setFilesSelected(files.map(({ fileId }) => fileId), checked)} />
          <span>文件名称</span><span className="hidden lg:block">大小</span><span className="hidden lg:block">所有者</span><span className="hidden lg:block">{timeLabel}</span><span className="text-right">操作</span>
        </div>
        {page.loading && !page.items.length ? (
          <div role="status" className="flex min-h-60 items-center justify-center gap-3 text-sm text-muted"><span className="button-spinner text-primary" />正在获取文件…</div>
        ) : page.error ? (
          <div className="p-4 sm:p-5"><Alert tone="error" title="无法获取文件" action={<RefreshButton size="sm" label="重试" disabled={!page.ready} loading={page.loading} onClick={page.refresh} />}>{page.error}</Alert></div>
        ) : files.length ? (
          <ul className="divide-y divide-line" aria-label={owned ? '个人文件列表' : '接收文件列表'}>
            {files.map((file) => <FileRow key={file.fileId} file={file} owned={owned} timeLabel={timeLabel} canDownload={canDownload} canShare={canShare} ready={page.ready} selected={selection.has(file.fileId)} onSelect={(id, checked) => setFilesSelected([id], checked)} onDownload={download} onShare={(entry) => setDialog({ kind: 'share', files: [entry] })} onDelete={(entry) => setDialog({ kind: 'delete', files: [entry] })} />)}
          </ul>
        ) : search ? <EmptyState icon="search" title="没有匹配的文件" description="试试其他关键词，或加载更多文件继续搜索。" /> : (
          <EmptyState icon={owned ? 'folder' : 'shared'} title={owned ? '还没有文件' : '暂无共享文件'} description={owned ? (canUpload ? '把文件拖到这里，或使用上方的上传按钮。单个文件最大 512 MiB。' : '管理员开通上传权限后，你可以在这里管理个人文件。') : '其他用户授权后，共享文件会显示在这里。'} />
        )}
        {(page.nextCursor || page.pagination.error) && <footer className="flex flex-wrap items-center justify-center gap-2 border-t border-line p-3.5">
          {page.pagination.error && <span role="alert" className="text-sm text-red-700">{page.pagination.error}</span>}
          <Button variant="secondary" size="sm" busy={page.pagination.busy} disabled={page.loading || !page.ready} onClick={page.loadMore}>加载更多</Button>
        </footer>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span className="inline-flex items-center gap-2"><Icon name="shield-check" size={17} className="text-primary" />下载完成后会校验整个文件的 SHA-256 摘要。</span>
        <Link to="/transfers" className="ui-link"><Icon name="transfer" size={17} />查看传输中心</Link>
      </div>

      {dialog?.kind === 'share' && <ShareDialog files={dialog.files} onClose={() => setDialog(null)} onApplied={clearAppliedSelection} />}
      {dialog?.kind === 'delete' && <DeleteFileDialog files={dialog.files} onClose={() => setDialog(null)} onDeleted={(deleted) => {
        clearAppliedSelection(deleted)
        page.removeFiles(deleted.map(({ fileId }) => fileId))
      }} />}
    </section>
  )
}
