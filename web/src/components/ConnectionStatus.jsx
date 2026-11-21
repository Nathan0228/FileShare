const labels = {
  idle: '待连接',
  connecting: '正在连接',
  online: '连接正常',
  reconnecting: '正在重连',
  offline: '连接已断开',
}

export default function ConnectionStatus({ status, onRetry }) {
  const content = <><span className="connection-dot" aria-hidden="true" />{labels[status] || labels.idle}</>
  const className = `connection-status ${status === 'online' ? 'is-online' : status === 'offline' ? 'is-offline' : ''}`
  if (onRetry && status === 'offline') {
    return <button type="button" className={className} onClick={onRetry} title="重新连接">{content} · 重试</button>
  }
  return <span className={className} role="status">{content}</span>
}
