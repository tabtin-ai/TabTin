/**
 * trackerArtifactMap — Tracker(Goal) 的 skill_key → 产物 app 映射
 *
 * Wave 6 (charter v1.8 §4.4 产物呈现分层):
 *   Tracker 跑完后 Inbox 通知点击应**默认跳产物**,而非 Run 详情。
 *   "对应 app" 由 skill_key 推断 —— skill_key 命名约定 "<app>-<role>" 或
 *   "<app>.<action>",取首段作为 app id 候选;命中已知 app 则跳那个 app,
 *   命中失败 → 调用方降级到 Run 详情(原行为)。
 *
 * 命中策略（D1 manifest 驱动）：候选 app id 直接走
 * `contextRegistry.getHandlerByAppId(...)` 查询 — manifest 即 SSOT。新 app
 * 加 manifest 即被自动识别，零 PR 维护成本（任何 app id 写死的常量都是反例）。
 */

// 直接 import 单例而非 barrel — 避免 vitest 环境下 registry/index.ts 启动时
// 拉起整条 handler 加载链路（含 crawlspace-core 等只在 main 进程可用的依赖）。
import { contextRegistry } from '@components/context-space/registry/instance'

/**
 * 把 skill_key 拆出"对应 app id"。
 *
 * 拆分规则(charter §4.4 关键路径):
 *   1. 优先按 "." 拆(如 ``tabdata.append_row`` → ``tabdata``)
 *   2. 再按 "-" 拆(如 ``tabdata-skill-field`` → ``tabdata``)
 *   3. 整 key 命中(如 ``tabdoc`` 直接作为 skill_key)
 *
 * 命中条件：候选 app id 在 contextRegistry 内有注册 handler（manifest 即
 * SSOT）。
 *
 * 返回 undefined → 调用方应降级为"跳 Run 详情"(原 type='goal' 路径)。
 */
export function resolveArtifactAppFromSkill(
  skillKey: string | null | undefined,
): string | undefined {
  if (!skillKey || typeof skillKey !== 'string') return undefined
  const trimmed = skillKey.trim().toLowerCase()
  if (!trimmed) return undefined

  // 优先按 "."(命名空间风格,如 tabdata.append_row)
  const dotIdx = trimmed.indexOf('.')
  if (dotIdx > 0) {
    const head = trimmed.slice(0, dotIdx)
    if (contextRegistry.getHandlerByAppId(head)) return head
  }

  // 再按 "-"(短横线风格,如 tabdata-skill-field)
  const dashIdx = trimmed.indexOf('-')
  if (dashIdx > 0) {
    const head = trimmed.slice(0, dashIdx)
    if (contextRegistry.getHandlerByAppId(head)) return head
  }

  // 整 key 命中(如 ``tabdoc`` 直接作为 skill_key)
  if (contextRegistry.getHandlerByAppId(trimmed)) return trimmed

  return undefined
}
