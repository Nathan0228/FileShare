import { Button } from '../../components/ui/Button.jsx'
import { FriendListStatus, FriendName, FriendPagination } from './FriendList.jsx'
import { useFriends } from './useFriends.js'

export function FriendPicker({ selected, onToggle, disabled, allow }) {
  const page = useFriends()

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="form-label mb-2">从好友列表选择</legend>
      {page.loading || page.error || !page.ready ? <FriendListStatus page={page} /> : page.items.length ? (
        <ul className="max-h-40 divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {page.items.map((friend) => (
            <li key={friend.userId}>
              <label className="flex min-w-0 items-center gap-3 px-3 py-2.5 hover:bg-canvas">
                <input type="checkbox" className="size-4 shrink-0 accent-primary"
                  aria-label={`选择 ${friend.username}`}
                  checked={selected.some(({ userId }) => userId === friend.userId)}
                  disabled={allow && !friend.enabled}
                  onChange={() => onToggle(friend)} />
                <span className="min-w-0 flex-1"><FriendName friend={friend} /></span>
                {!friend.enabled && <span className="shrink-0 text-xs text-muted">已停用</span>}
              </label>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">互相共享后，对方的账号会显示在这里。</p>}
      <FriendPagination page={page} />
      {selected.length > 0 && (
        <ul aria-label="已选好友" className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
          {selected.map((friend) => (
            <li key={friend.userId} className="max-w-full">
              <Button size="sm" variant="secondary" icon="x" aria-label={`移除 ${friend.username}`} onClick={() => onToggle(friend)}>
                <span className="truncate">{friend.note || friend.username}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}
