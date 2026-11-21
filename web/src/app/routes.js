export const workspaceLinks = [
  { to: '/files', label: '我的文件', icon: 'files' },
  { to: '/shared', label: '共享给我', icon: 'shared' },
  { to: '/transfers', label: '传输中心', icon: 'transfer' },
]

export const adminLinks = [
  { to: '/admin/users', label: '用户管理', icon: 'users' },
  { to: '/admin/audit', label: '操作审计', icon: 'history' },
]

export function workspaceDestination(path, role) {
  const links = role === 'admin' ? [...workspaceLinks, ...adminLinks] : workspaceLinks
  const safePath = typeof path === 'string' ? path.replace(/\/+$/, '').toLowerCase() : ''
  return links.find(({ to }) => to === safePath)?.to || '/files'
}
