import { useState } from 'react'
import { Button } from '../../components/ui/Button.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { Alert } from '../../components/ui/Feedback.jsx'
import { Field } from '../../components/ui/Field.jsx'
import { Type } from '../../services/protocol.js'
import { useSession } from '../auth/session.js'
import { useToast } from '../feedback/toast.js'
import { useFileBatch } from './fileActions.js'

function SelectedFiles({ files }) {
  return (
    <ul aria-label="待处理文件" className="max-h-36 divide-y divide-line overflow-auto rounded-xl border border-line bg-canvas">
      {files.map((file) => <li key={file.fileId} className="wrap-anywhere px-3.5 py-2 text-sm font-medium text-ink">{file.name}</li>)}
    </ul>
  )
}

function BatchFeedback({ completed, failures }) {
  if (!failures.length) return null
  return (
    <Alert tone={completed ? 'warning' : 'error'} title={completed ? `已完成 ${completed} 项，另有 ${failures.length} 项失败` : '操作失败'}>
      <ul className="max-h-28 space-y-1 overflow-auto">
        {failures.map(({ file, message }) => <li key={file.fileId} className="wrap-anywhere"><strong>{file.name}</strong> · {message}</li>)}
      </ul>
    </Alert>
  )
}

export function ShareDialog({ files, onClose, onApplied }) {
  const { request, status } = useSession()
  const toast = useToast()
  const [grantee, setGrantee] = useState('')
  const [allow, setAllow] = useState(true)
  const [problem, setProblem] = useState('')
  const batch = useFileBatch(files)
  const multiple = files.length > 1

  async function submit(event) {
    event.preventDefault()
    const username = grantee.trim()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) {
      setProblem('请输入有效的账号名。')
      return
    }
    setProblem('')
    const result = await batch.apply((file, signal) => request(Type.SHARE_SET, { body: { fileId: file.fileId, grantee: username, allow }, signal }))
    if (!result) return
    if (result.succeeded.length) onApplied(result.succeeded)
    if (!result.failures.length) {
      toast({
        title: multiple ? (allow ? `已共享 ${files.length} 个文件` : `已撤销 ${files.length} 个文件的访问权限`) : (allow ? '文件已共享' : '访问权限已撤销'),
        description: multiple ? username : files[0].name,
        tone: 'success',
      })
      onClose()
    }
  }

  return (
    <Modal open onClose={() => { if (!batch.busy) onClose() }} title={multiple ? '批量管理共享权限' : '管理共享权限'} description="为指定账号授予或撤销文件读取权限。" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={batch.busy}>取消</Button>
      <Button type="submit" form="share-file" icon={allow ? 'shared' : 'lock'} busy={batch.busy} disabled={status !== 'online'} variant={allow ? 'primary' : 'danger'}>
        {multiple && batch.failures.length ? '重试失败项' : allow ? '授权共享' : '撤销权限'}
      </Button>
    </>}>
      <form id="share-file" className="space-y-4" onSubmit={submit}>
        <SelectedFiles files={batch.remaining} />
        <Field label="接收者账号" icon="user" value={grantee} onChange={(event) => { setGrantee(event.target.value); setProblem('') }} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} required disabled={batch.busy || batch.completed > 0} placeholder="输入接收者的账号名" />
        <fieldset className="space-y-2" disabled={batch.busy || batch.completed > 0}>
          <legend className="form-label mb-2">访问权限</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm has-checked:border-primary has-checked:bg-mint">
              <input type="radio" name="sharing-action" checked={allow} onChange={() => setAllow(true)} className="accent-primary" /> 允许读取
            </label>
            <label className="flex items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm has-checked:border-primary has-checked:bg-mint">
              <input type="radio" name="sharing-action" checked={!allow} onChange={() => setAllow(false)} className="accent-primary" /> 撤销读取
            </label>
          </div>
        </fieldset>
        {problem && <Alert tone="error">{problem}</Alert>}
        <BatchFeedback completed={batch.completed} failures={batch.failures} />
      </form>
    </Modal>
  )
}

export function DeleteFileDialog({ files, onClose, onDeleted }) {
  const { request, status } = useSession()
  const toast = useToast()
  const batch = useFileBatch(files)
  const multiple = files.length > 1

  async function remove() {
    const result = await batch.apply((file, signal) => request(Type.FILE_DELETE, { body: { fileId: file.fileId }, signal }))
    if (!result) return
    if (result.succeeded.length) onDeleted(result.succeeded)
    if (!result.failures.length) {
      toast({ title: multiple ? `已删除 ${files.length} 个文件` : '文件已删除', description: multiple ? undefined : files[0].name, tone: 'success' })
      onClose()
    }
  }

  return (
    <Modal open onClose={() => { if (!batch.busy) onClose() }} title={multiple ? `删除 ${files.length} 个文件？` : '删除文件？'} description="删除后，共享接收者也将无法继续访问文件。" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={batch.busy}>取消</Button>
      <Button icon="trash" variant="danger" busy={batch.busy} disabled={status !== 'online'} onClick={remove}>
        {multiple && batch.failures.length ? '重试失败项' : '删除文件'}
      </Button>
    </>}>
      <div className="space-y-3">
        <SelectedFiles files={batch.remaining} />
        <BatchFeedback completed={batch.completed} failures={batch.failures} />
      </div>
    </Modal>
  )
}
