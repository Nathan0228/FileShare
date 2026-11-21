const base64Url = /^[A-Za-z0-9_-]*$/

export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !base64Url.test(value) || value.length % 4 === 1) {
    throw new TypeError('Invalid base64url string')
  }
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (byte) => byte.charCodeAt(0))
}

export function encodeBase64Url(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
