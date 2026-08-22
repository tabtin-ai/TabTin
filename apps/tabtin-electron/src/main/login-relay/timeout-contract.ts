import timeoutContract from '../../../../tabtin_django/apps/login_relay/timeout-contract.json'

// 与 Django 的 timeout_contract.py 共用同一 JSON。协议版本随构建产物发送给
// Django；旧构建继续发送 v1，服务端据此冻结其同步等待上限。
const MIN_UPLOAD_RESPONSE_GRACE_MS = 1_000

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new Error(`Invalid login relay timeout contract: ${field}`)
  }
  return value
}

function requireProtocolVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^v[1-9]\d*$/.test(value)) {
    throw new Error('Invalid login relay timeout contract: protocol_version')
  }
  return value
}

export const LOGIN_RELAY_PROTOCOL_VERSION = requireProtocolVersion(timeoutContract.protocol_version)
export const LOGIN_RELAY_IMPORT_WAIT_TIMEOUT_MS =
  requirePositiveInteger(timeoutContract.import_wait_timeout_seconds, 'import_wait_timeout_seconds') * 1_000
export const LOGIN_RELAY_UPLOAD_RESPONSE_GRACE_MS =
  requirePositiveInteger(timeoutContract.upload_response_grace_ms, 'upload_response_grace_ms')

if (LOGIN_RELAY_UPLOAD_RESPONSE_GRACE_MS < MIN_UPLOAD_RESPONSE_GRACE_MS) {
  throw new Error('Invalid login relay timeout contract: upload_response_grace_ms')
}

export const DEFAULT_LOGIN_RELAY_UPLOAD_TIMEOUT_MS =
  LOGIN_RELAY_IMPORT_WAIT_TIMEOUT_MS + LOGIN_RELAY_UPLOAD_RESPONSE_GRACE_MS
