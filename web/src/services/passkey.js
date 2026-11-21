import { decodeBase64Url, encodeBase64Url } from './encoding.js'
import { SftError } from './errors.js'

function credentialDescriptors(entries) {
  return entries?.map((entry) => ({ ...entry, id: decodeBase64Url(entry.id) }))
}

function parseOptions(Credential, options, enrollment) {
  if (enrollment && Credential.parseCreationOptionsFromJSON) return Credential.parseCreationOptionsFromJSON(options)
  if (!enrollment && Credential.parseRequestOptionsFromJSON) return Credential.parseRequestOptionsFromJSON(options)

  const challenge = decodeBase64Url(options.challenge)
  if (enrollment) {
    return {
      ...options,
      challenge,
      user: { ...options.user, id: decodeBase64Url(options.user.id) },
      excludeCredentials: credentialDescriptors(options.excludeCredentials),
    }
  }
  return { ...options, challenge, allowCredentials: credentialDescriptors(options.allowCredentials) }
}

function serializeCredential(credential, enrollment) {
  if (typeof credential.toJSON === 'function') return credential.toJSON()

  const response = { clientDataJSON: encodeBase64Url(credential.response.clientDataJSON) }
  if (enrollment) {
    response.attestationObject = encodeBase64Url(credential.response.attestationObject)
    response.transports = credential.response.getTransports?.() ?? []
  } else {
    response.authenticatorData = encodeBase64Url(credential.response.authenticatorData)
    response.signature = encodeBase64Url(credential.response.signature)
    if (credential.response.userHandle != null) response.userHandle = encodeBase64Url(credential.response.userHandle)
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response,
  }
}

export function verifyPasskeySupport() {
  if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !globalThis.navigator?.credentials) {
    throw new SftError('PASSKEY_UNAVAILABLE')
  }
}

export async function answerPasskeyChallenge(options, { enrollment, signal }) {
  verifyPasskeySupport()
  let credential
  try {
    const publicKey = parseOptions(globalThis.PublicKeyCredential, options, enrollment)
    credential = enrollment
      ? await globalThis.navigator.credentials.create({ publicKey, signal })
      : await globalThis.navigator.credentials.get({ publicKey, signal })
  } catch (cause) {
    if (signal?.aborted) throw signal.reason
    if (cause?.name === 'NotAllowedError') throw new SftError('PASSKEY_CANCELLED', false, { cause })
    if (cause?.name === 'InvalidStateError' && enrollment) throw new SftError('PASSKEY_EXISTS', false, { cause })
    if (cause?.name === 'SecurityError' || cause?.name === 'NotSupportedError') {
      throw new SftError('PASSKEY_UNAVAILABLE', false, { cause })
    }
    throw new SftError('PASSKEY_FAILED', false, { cause })
  }
  if (!credential) throw new SftError('PASSKEY_CANCELLED')
  return serializeCredential(credential, enrollment)
}
