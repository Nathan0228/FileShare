import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icon.jsx'
import { Button } from '../../components/ui/Button.jsx'
import { EmptyState } from '../../components/ui/Feedback.jsx'
import { Field } from '../../components/ui/Field.jsx'
import { Modal } from '../../components/ui/Modal.jsx'
import { RefreshButton } from '../../components/ui/RefreshButton.jsx'
import { getErrorMessage } from '../../services/errors.js'
import { Type } from '../../services/protocol.js'
import { useSession } from '../auth/session.js'
import { useToast } from '../feedback/toast.js'
import { FriendListStatus, FriendName, FriendPagination } from './FriendList.jsx'
import { useFriends } from './useFriends.js'

function FriendNoteDialog({ friend, onClose, onSaved }) {
  const { request, status } = useSession()
  const [note, setNote] = useState(friend.note)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef(null)
  const toast = useToast()

  useEffect(() => () => operation.current?.abort(), [])

  async function save(event) {
    event.preventDefault()
    if (status !== 'online' || operation.current) return
    const value = note.trim()
    if ([...value].length > 80 || /\p{Cc}/u.test(value)) {
      setError('请输入最多 80 个字符的单行备注。')
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    try {
      await request(Type.FRIEND_NOTE, { body: { friendId: friend.userId, note: value }, signal: controller.signal })
      if (!controller.signal.aborted) {
        toast({ title: value ? '备注已保存' : '备注已清除', tone: 'success' })
        onSaved()
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(getErrorMessage(cause))
    } finally {
      operation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <Modal open title="编辑好友备注" description={friend.username} onClose={() => { if (!operation.current) onClose() }} footer={<>
      <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
      <Button type="submit" form="friend-note" busy={busy} disabled={status !== 'online'}>保存备注</Button>
    </>}>
      <form id="friend-note" onSubmit={save}>
        <Field label="备注" hint="仅自己可见，留空即可清除。" value={note} maxLength={160} disabled={busy} error={error}
          onChange={(event) => { setNote(event.target.value); setError('') }} />
      </form>
    </Modal>
  )
}

export function FriendsPage() {
  const page = useFriends()
  const [selected, setSelected] = useState(null)

  return (
    <section className="space-y-5">
      <header>
        <h1 className="page-title">好友列表</h1>
        <p className="page-description">互相共享过文件的账号会自动成为好友。你可以给好友添加备注，方便下次共享时查找。</p>
      </header>
      <div className="panel overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <span className="text-sm font-semibold">我的好友</span>
          <RefreshButton size="sm" label="刷新好友列表" iconOnly disabled={!page.ready} loading={page.loading} onClick={page.refresh} />
        </div>
        {page.loading || page.error || !page.ready ? (
          <div className="p-4 sm:p-5"><FriendListStatus page={page} /></div>
        ) : page.items.length ? (
          <ul className="divide-y divide-line" aria-label="好友">
            {page.items.map((friend) => (
              <li key={friend.userId} className="flex min-w-0 items-center gap-3 px-4 py-3 sm:px-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-mint text-primary"><Icon name="user" size={18} /></span>
                <div className="min-w-0 flex-1">
                  <FriendName friend={friend} />
                  {!friend.enabled && <p className="mt-0.5 text-xs text-muted">账号已停用</p>}
                </div>
                <Button size="sm" variant="secondary" aria-label={`编辑 ${friend.username} 的备注`} onClick={() => setSelected(friend)}>编辑备注</Button>
              </li>
            ))}
          </ul>
        ) : <EmptyState icon="users" title="暂无好友" description="你们互相共享文件后，这里就会显示对方的账号。" />}
        {(page.number > 1 || page.hasNext) && <div className="border-t border-line p-3.5 sm:px-5"><FriendPagination page={page} /></div>}
      </div>
      {selected && <FriendNoteDialog friend={selected} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); page.reload() }} />}
    </section>
  )
}
