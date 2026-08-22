/**
 * Security guards shared by Electron and Daemon CLI Servers.
 *
 * §6.2: Anti-CSRF / DNS Rebinding — reject requests with Origin/Referer
 * headers and validate Host header against a safe-list.
 */

import type http from 'node:http'
import { errResponse } from '@tabtin/agent-wire'
import { sendJSON } from './http-utils.js'

const ALLOWED_HOSTS = ['tabtin-engine.sock', 'localhost', '127.0.0.1', '[::1]']

/**
 * Reject requests with Origin/Referer (browser-originated) or
 * invalid Host header (DNS rebinding). Returns true if blocked.
 */
export function validateCSRFHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.headers.origin || req.headers.referer) {
    sendJSON(res, 403, errResponse('FORBIDDEN', 'Browser requests not allowed'))
    return true
  }

  const host = req.headers.host
  if (host && !ALLOWED_HOSTS.some(h => host.startsWith(h))) {
    sendJSON(res, 403, errResponse('FORBIDDEN', 'Invalid Host header'))
    return true
  }

  return false
}

/**
 * Validate `x-tabtin-token` header against the server's expected token.
 * Returns true if authentication failed (response already sent).
 */
export function validateTokenAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expectedToken: string | null,
  suggestions?: string[],
): boolean {
  const token = req.headers['x-tabtin-token']
  if (!expectedToken || token !== expectedToken) {
    sendJSON(res, 401, errResponse('UNAUTHORIZED', '未授权：缺少有效的访问令牌', {
      suggestions: suggestions ?? ['确保在 TabTin 内置终端中运行命令'],
    }))
    return true
  }
  return false
}
