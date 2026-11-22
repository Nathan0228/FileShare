import { useState } from 'react'
import { Button } from '../../components/ui/Button.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { Alert } from '../../components/ui/Feedback.jsx'
import { Field } from '../../components/ui/Field.jsx'
import { Type } from '../../services/protocol.js'
import { useSession } from '../auth/session.js'
import { useToast } from '../feedback/toast.js'
import { FriendPicker } from '../friends/FriendPicker.jsx'
import { accountNamePattern } from '../friends/useFriends.js'
import { useFileBatch } from './fileActions.js'

const maxShareRecipients = 20

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
  const { request, status, user } = useSession()
  const toast = useToast()
  const [manualRecipients, setManualRecipients] = useState('')
  const [friends, setFriends] = useState([])
  const [allow, setAllow] = useState(true)
  const [problem, setProblem] = useState('')
  const batch = useFileBatch(files)
  const multiple = files.length > 1
  const locked = batch.busy || batch.completed > 0

  function toggleFriend(friend) {
    setFriends((current) => current.some(({ userId }) => userId === friend.userId)
      ? current.filter(({ userId }) => userId !== friend.userId)
      : [...current, friend])
    setProblem('')
  }

  async function submit(event) {
    event.preventDefault()
    if (status !== 'online' || batch.busy) return
    const manual = manualRecipients.split(/[,，、\s]+/u).filter(Boolean)
    const grantees = [...new Set([...manual, ...friends.map(({ username }) => username)])]
    if (!grantees.length || grantees.length > maxShareRecipients) {
      setProblem(`请选择或输入 1–${maxShareRecipients} 个不同的接收账号。`)
      return
    }
    if (grantees.some((name) => !accountNamePattern.test(name))) {
      setProblem('请检查账号名格式，多个账号用逗号或空格分隔。')
      return
    }
    if (grantees.includes(user.username) || (allow && friends.some((friend) => !friend.enabled))) {
      setProblem('请选择其他已启用的接收账号。')
      return
    }
    setProblem('')
    const recipients = grantees.length === 1 ? { grantee: grantees[0] } : { grantees }
    const result = await batch.apply(async (file, signal) => {
      try {
        await request(Type.SHARE_SET, { body: { fileId: file.fileId, ...recipients, allow }, signal })
      } catch (error) {
        if (error?.code === 'DENIED') throw new Error('请检查文件共享权限和接收账号。', { cause: error })
        throw error
      }
    })
    if (!result) return
    if (result.succeeded.length) onApplied(result.succeeded)
    if (!result.failures.length) {
      toast({
        title: multiple ? (allow ? `已共享 ${files.length} 个文件` : `已撤销 ${files.length} 个文件的访问权限`) : (allow ? '文件已共享' : '访问权限已撤销'),
        description: grantees.length > 1 ? `接收账号共 ${grantees.length} 个` : grantees[0],
        tone: 'success',
      })
      onClose()
    }
  }

  return (
    <Modal open onClose={() => { if (!batch.busy) onClose() }} title={multiple ? '批量管理共享权限' : '管理共享权限'} description="手动输入或从好友中选择接收账号，最多 20 个。" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={batch.busy}>取消</Button>
      <Button type="submit" form="share-file" icon={allow ? 'shared' : 'lock'} busy={batch.busy} disabled={status !== 'online'} variant={allow ? 'primary' : 'danger'}>
        {multiple && batch.failures.length ? '重试失败项' : allow ? '授权共享' : '撤销权限'}
      </Button>
    </>}>
      <form id="share-file" className="space-y-4" onSubmit={submit}>
        <SelectedFiles files={batch.remaining} />
        <Field label="手动输入接收账号" icon="user" value={manualRecipients} onChange={(event) => { setManualRecipients(event.target.value); setProblem('') }} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={1400} disabled={locked} placeholder="多个账号用逗号或空格分隔" />
        <FriendPicker selected={friends} onToggle={toggleFriend} disabled={locked} allow={allow} />
        <fieldset className="space-y-2" disabled={locked}>
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
