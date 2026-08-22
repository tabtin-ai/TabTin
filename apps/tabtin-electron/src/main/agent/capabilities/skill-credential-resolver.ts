/**
 * Skill 运行时密钥注入 — Electron 主进程的宿主胶水（Wave 1.5）。
 *
 * **历史背景**：Wave 1.5 初次交付时本文件内联了一整份 resolver
 * 实现；Wave 1.5 收尾（PROD-3 拍板 Daemon 补接入）时搬到共享位置
 * `@tabtin/agent-host/credentials`，
 * Electron 与 Daemon 共用一份实现。
 *
 * 本文件只剩"把 Electron 主进程的 logger / token 注入方式"适配到
 * 共享 resolver —— 业务逻辑（HTTP / 缓存 / 失效 / warnings 透传）
 * 全在共享模块里，改动只改共享版即两端同步。
 *
 * 调用方：`ElectronAgentHost` 在构造 `ElectronToolProvider` 时调
 * `createSkillCredentialResolver(...)` 拿 `resolver` 注入。
 */
import type {
  SkillCredentialResolverHandle,
  SkillCredentialResolverLogger,
} from '@tabtin/agent-host/credentials'
import { createSkillCredentialResolver as createSharedResolver } from '@tabtin/agent-host/credentials'
import { createLogger } from '../../logger.js'

const log = createLogger('skill-credential-resolver')

/** Electron 侧 Logger 适配：把 `createLogger` 的 fields 风格桥到共享 Logger 接口。 */
const electronLogger: SkillCredentialResolverLogger = {
  debug: (message, fields) => {
    if (fields) log.debug(message, fields)
    else log.debug(message)
  },
  info: (message, fields) => {
    if (fields) log.info(message, fields)
    else log.info(message)
  },
  warn: (message, fields) => {
    if (fields) log.warn(message, fields)
    else log.warn(message)
  },
}

export interface SkillCredentialResolverDeps {
  /** 后端 API 根 URL，如 `https://api.example.com`（不含 `/api` 前缀）。 */
  apiBaseUrl: string
  /**
   * 当前用户的 JWT —— **构造时一次性快照**（注意与 Daemon 的"getter 随
   * token 刷新动态取最新值"策略有**有意的行为差异**）。
   *
   * Electron 走"快照"的理由：`ElectronAgentHost` 在每次 `createRuntimeForSession`
   * 时从上游注入当前 token 构造新 resolver；一旦用户的登录态被 TokenManager
   * 刷新（token 值变化），上游会自动触发 runtime 重建 → 新的
   * `ElectronToolProvider` + 新的 resolver → 新的快照。所以 resolver 自身
   * 不需要响应"同一生命周期内的 token 刷新"——runtime 重建就是刷新路径。
   *
   * 三视角 Review 修复（技术 1）：字段名显式带 `Snapshot` 后缀，配合注释
   * 把"为什么签名看起来像 getter 但行为是快照"写透——避免未来接别的宿主
   * 时误以为会动态跟随。
   */
  apiAuthTokenSnapshot: string | undefined
  /** Organization ID —— 后端审计 / 多租户路由需要；未配置时不注入 header。 */
  organizationId?: string
  /**
   * 缓存 key 的用户命名空间。缺省时共享模块用 token 的哈希前缀充当
   * "谁在调"的指纹，保证同进程多个 Agent Host（用户切换 / 多 session）
   * 不会串 key。
   */
  userCacheNamespace?: string
}

/**
 * 构造注入给 `ElectronToolProvider.coreTools.skillCredentialResolver` 的回调 +
 * 暴露缓存失效入口（供 Wave 5 UI "改完密钥刷新缓存"用）。
 */
export function createSkillCredentialResolver(
  deps: SkillCredentialResolverDeps,
): SkillCredentialResolverHandle {
  // Electron 走 snapshot 模式：getter 永远返回同一个字符串，和直接传值等价；
  // 实时性靠上层 runtime 重建兜底（见 `apiAuthTokenSnapshot` 注释）。
  const snapshot = deps.apiAuthTokenSnapshot
  return createSharedResolver({
    apiBaseUrl: deps.apiBaseUrl,
    getApiAuthToken: () => snapshot,
    organizationId: deps.organizationId,
    userCacheNamespace: deps.userCacheNamespace,
    logger: electronLogger,
  })
}
