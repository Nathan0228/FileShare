export class SftError extends Error {
  constructor(code, retryable = false, options) {
    super(code, options)
    this.name = 'SftError'
    this.code = code
    this.retryable = retryable
  }
}

const messages = {
  BUSY: '服务或任务正忙，请稍后重试。',
  RATE_LIMIT: '操作太频繁，请稍后重试。',
  INCOMPLETE: '仍有分片未确认，请恢复任务再重试。',
  STORAGE_UNAVAILABLE: '服务端存储暂不可用，请稍后重试。',
  UNAUTH: '身份验证失败、邀请无效或会话已过期。',
  DENIED: '该文件或操作不可访问，请检查权限。',
  BAD_REQUEST: '请求内容无效，请检查输入。',
  CONFLICT: '数据与已有记录冲突，请检查后重试。',
  HASH_MISMATCH: '文件校验失败，请重新选择或下载文件。',
  QUOTA: '已达账号或存储配额，请联系管理员。',
  EXPIRED: '上传任务已过期，请重新创建。',
  CONNECTION_LOST: '连接已断开，请检查网络或稍后重试。',
  CONNECTION_TIMEOUT: '等待服务响应超时，请稍后重试。',
  ENDPOINT_INVALID: '服务器连接地址无效，请检查部署配置。',
  PROTOCOL_ERROR: '服务返回了无法识别的数据，请重新连接。',
  PASSKEY_UNAVAILABLE: '当前环境无法使用 Passkey。请在 HTTPS 或本机开发环境中使用支持的浏览器。',
  PASSKEY_CANCELLED: '验证已取消、超时或没有可用的 Passkey，请重试。',
  PASSKEY_EXISTS: '当前设备上的 Passkey 已登记，请直接登录。',
  PASSKEY_FAILED: '无法完成 Passkey 验证，请检查设备和浏览器设置。',
  USERNAME_INVALID: '账号名应包含 1–64 个小写字母、数字、点、下划线或连字符，并以字母或数字开头。',
  INVITE_INVALID: '请输入管理员提供的完整邀请令牌。',
}

export function getErrorMessage(error) {
  if (error?.name === 'AbortError') return '操作已取消。'
  if (error instanceof SftError) return messages[error.code] ?? '服务暂时无法完成此操作，请稍后重试。'
  if (error instanceof Error && error.message) return error.message
  return '操作失败，请稍后重试。'
}
