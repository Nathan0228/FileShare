import { useState } from 'react'
import { Button } from '../../components/ui/Button.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { Alert } from '../../components/ui/Feedback.jsx'
import { Field } from '../../components/ui/Field.jsx'
import { getErrorMessage } from '../../services/errors.js'
import { Type } from '../../services/protocol.js'
import { useSession } from '../auth/session.js'
import { useToast } from '../feedback/toast.js'

export function ShareDialog({ file, onClose }) {
  const { request, status } = useSession()
  const toast = useToast()
  const [grantee, setGrantee] = useState('')
  const [allow, setAllow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  async function submit(event) {
    event.preventDefault()
    const username = grantee.trim()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) {
      setProblem('请输入有效的账号名。')
      return
    }
    setBusy(true)
    setProblem('')
    try {
      await request(Type.SHARE_SET, { body: { fileId: file.fileId, grantee: username, allow } })
      toast({ title: allow ? '文件已共享' : '访问权限已撤销', description: file.name, tone: 'success' })
      onClose()
    } catch (error) {
      setProblem(getErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose() }} title="管理共享权限" description="为指定账号授予或撤销文件读取权限。" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
      <Button type="submit" form="share-file" icon={allow ? 'shared' : 'lock'} busy={busy} disabled={status !== 'online'} variant={allow ? 'primary' : 'danger'}>
        {allow ? '授权共享' : '撤销权限'}
      </Button>
    </>}>
      <form id="share-file" className="space-y-4" onSubmit={submit}>
        <p title={file.name} className="truncate rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-sm font-medium">{file.name}</p>
        <Field label="接收者账号" icon="user" value={grantee} onChange={(event) => { setGrantee(event.target.value); setProblem('') }} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} required disabled={busy} placeholder="输入接收者的账号名" />
        <fieldset className="space-y-2" disabled={busy}>
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
      </form>
    </Modal>
  )
}

export function DeleteFileDialog({ file, onClose, onDeleted }) {
  const { request, status } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  async function remove() {
    setBusy(true)
    setProblem('')
    try {
      await request(Type.FILE_DELETE, { body: { fileId: file.fileId } })
      toast({ title: '文件已删除', description: file.name, tone: 'success' })
      onDeleted()
    } catch (error) {
      setProblem(getErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose() }} title="删除文件？" description="删除后，共享接收者也将无法继续访问文件。" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
      <Button icon="trash" variant="danger" busy={busy} disabled={status !== 'online'} onClick={remove}>删除文件</Button>
    </>}>
      <p title={file.name} className="break-all rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-sm font-medium">{file.name}</p>
      {problem && <div className="mt-3"><Alert tone="error">{problem}</Alert></div>}
    </Modal>
  )
}
