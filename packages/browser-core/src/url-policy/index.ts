/**
 * @tabtin/browser-core/url-policy — 浏览器 URL 安全策略
 *
 * 统一的 SSRF 防护 + 脚本安全检查，Electron 和 Daemon 共享此实现。
 * 禁止任何一端本地重复实现这些功能。
 */

export {
  isPrivateIPv4,
  parseAlternativeIPv4,
  isPrivateHost,
} from './private-host';

export {
  validateNavigationUrl,
  validateUrl,
  isAllowedScheme,
} from './url-validator';
export type { ValidationResult } from './url-validator';

export {
  isBlockedScript,
  BLOCKED_SCRIPT_PATTERNS,
} from './script-policy';
