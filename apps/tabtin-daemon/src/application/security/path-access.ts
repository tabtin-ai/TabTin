/**
 * daemon-path-access — Daemon 端三家入口共享的路径权限判定 helper。
 *
 * 路径权限治理 Wave 4：把 Daemon `action-bridge.ts` / `mcp-server.ts` /
 * `cli-server.ts` 三家入口当前各自调 `validateProjectPath(single workspace_root)`
 * + `checkHardlinePath` 的散点收敛——它们都消费同一份 v3
 * `WorkspaceSnapshot.allowedPaths`，与 Electron 端 path-access-checker 严格
 * 同语义（修 01 图谱 §断层 5 "Daemon 三家都不消费 snapshot"）。
 *
 * 设计要点：
 *   1. **薄包装**——直接复用 `@tabtin/security-policy` 的
 *      `isPathInAllowedRoots` / `checkHardlinePath` / `checkSensitivePath`
 *      （Daemon 三家入口少 + headless 环境无 platform IPC 路径），不重复造
 *      Electron 那边的工厂 + singleton。
 *   2. **session-scoped 路由**——caller 通过 `WorkspaceSnapshotResolver`
 *      闭包按 spaceId 查当前活跃 session 的 snapshot；snapshot 缺失走
 *      `daemon.config.workspace_root` 兜底（与 Electron platformAllowedDirs
 *      语义对应——daemon 上 workspace_root 是 sandbox 等价）。
 *   3. **alreadyJudged 透传**——LLM 主路径下 daemon 端 tabcode-adapter
 *      已经在 input.params 注入 `_already_judged: true`（adapter 端 Wave 1
 *      已实装）；本 helper 让三家入口也消费这个字段，防止 boundary 在
 *      已 judge 的路径上二次拦截。
 *   4. **fail-closed actionable 文案**——拒绝时返回 result envelope，
 *      message 与 Electron path-access-checker 对齐（"Open this folder in
 *      TabFolder/TabCode to authorize, or toggle Super Permissions in
 *      Agent Security settings."）。
 */

import {
  checkHardlinePath,
  checkSensitivePath,
  isPathInAllowedRoots,
  type WorkspaceSnapshot,
} from '@tabtin/security-policy'

/**
 * 当前活跃 Space 的 workspaceSnapshot 解析器。
 *
 * 由 daemon container 在装配 host 后注入到三家入口。spaceId 从 wire
 * payload / action params 取（譬如 action-bridge 的 `params._space_id`）。
 *
 * 找不到匹配 session 时返回 null —— 三家入口此时退化到 daemon 启动期的
 * `config.workspace_root` 单条目录兜底，与 Wave 4 之前的行为对齐。
 */
export type WorkspaceSnapshotResolver = (spaceId?: string) => WorkspaceSnapshot | null

export type DaemonPathAccessAction = 'read' | 'write' | 'delete'

export interface DaemonPathAccessReason {
  reasonCode: 'hardline' | 'sensitive' | 'outside_workspace' | 'invalid_path'
  message: string
}

export interface DaemonPathAccessResult {
  allowed: boolean
  reason?: DaemonPathAccessReason
}

export interface DaemonPathAccessOptions {
  /**
   * v3 SSoT：当前活跃 session 的 workspaceSnapshot。
   *
   * caller 应在调用前用 `WorkspaceSnapshotResolver` 拿到（譬如
   * `resolver(params._space_id)`），缺省 null（fall through 到 fallbackRoots）。
   */
  snapshot: WorkspaceSnapshot | null
  /**
   * 已通过 v3 judge 管线（来自 LLM 主路径 `_already_judged` 注入）。
   *
   * `true` 时跳过 boundary 检查（信任 judge 决策）；红线 + 敏感路径仍执行
   * （与 Electron path-access-checker / action-tools `checkFilePathSecurity`
   * 同语义——judge 已通过仅意味着"工作区/yolo/memo 决策放行"，不等于
   * "红线解锁"）。
   *
   * 缺省 false：daemon 远端推过来的 frontend_action（mobile 主控端无 judge
   * 引擎）走完整 boundary 检查。
   */
  alreadyJudged?: boolean
  /**
   * snapshot 缺失时的 fallback 路径列表（通常 daemon `config.workspace_root`
   * 一条）。与 Electron 上 platformAllowedDirs 同模式。
   */
  fallbackRoots?: readonly string[]
}

/**
 * 判定一条绝对路径在 daemon 端是否允许做指定 action。
 *
 * 核心流程（与 Electron path-access-checker 严格对齐）：
 *   1. 红线（`checkHardlinePath` + 敏感路径黑名单）—— 无论 snapshot / alreadyJudged
 *   2. 敏感路径四态（`checkSensitivePath`）—— 用真值 inWorkspace 算（与 v3
 *      judge step 4 同语义）
 *   3. workspace boundary —— alreadyJudged=true 时跳过；否则要求 path 命中
 *      snapshot.allowedPaths 或 fallbackRoots
 *
 * 不抛异常——所有边界情况转 result envelope，让 caller（三家入口）按需
 * 包装成自家的错误格式（HTTP / MCP / wire）。
 */
export function checkDaemonPathAccess(
  filePath: string,
  action: DaemonPathAccessAction,
  options: DaemonPathAccessOptions,
): DaemonPathAccessResult {
  if (!filePath || typeof filePath !== 'string') {
    return {
      allowed: false,
      reason: {
        reasonCode: 'invalid_path',
        message: 'Path is required and must be a non-empty string.',
      },
    }
  }

  const isWrite = action === 'write' || action === 'delete'

  // 1) 红线：永远先执行
  const hardline = checkHardlinePath(filePath, 'file')
  if (hardline.hit) {
    return {
      allowed: false,
      reason: {
        reasonCode: 'hardline',
        message:
          hardline.description ??
          `Operation blocked: path '${filePath}' hits the system hardline.`,
      },
    }
  }

  // 2) 敏感路径四态：用真值 inWorkspace
  const allowedPaths: readonly string[] = options.snapshot
    ? options.snapshot.allowedPaths
    : (options.fallbackRoots ?? [])
  const allowedFiles: readonly string[] = options.snapshot?.allowedFiles ?? []
  const inWorkspace = isPathInAllowedRoots(filePath, allowedPaths, allowedFiles)

  const sensitive = checkSensitivePath(filePath, 'file', inWorkspace, isWrite)
  if (sensitive.hit && sensitive.action === 'deny') {
    return {
      allowed: false,
      reason: {
        reasonCode: 'sensitive',
        message:
          sensitive.description ??
          `Operation blocked: path '${filePath}' resolves to a sensitive location.`,
      },
    }
  }

  // 3) alreadyJudged 跳过 boundary（红线已先于跳过执行）
  if (options.alreadyJudged) {
    return { allowed: true }
  }

  // 4) workspace boundary
  if (!inWorkspace) {
    return {
      allowed: false,
      reason: {
        reasonCode: 'outside_workspace',
        message:
          `Path '${filePath}' is outside your workspace. ` +
          `Open this folder in TabFolder/TabCode to authorize, ` +
          `or toggle Super Permissions in Agent Security settings.`,
      },
    }
  }

  return { allowed: true }
}

// ─────────────────────────────────────────────────────────────────
// 路径权限治理 Wave 4 P1-3：跨端 wire envelope `_already_judged` 防御
// ─────────────────────────────────────────────────────────────────
//
// **背景**：tabcode-adapter `enrichWithWorkspaceRoot` 在本机 LLM 主路径
// （同进程内 ctx → tool input）显式 `delete base._already_judged` 后再
// 从 `ctx.permissionContext.judgedDecision === 'allow'` 派生——这条防御
// 只在**本机内存信任域**有效。
//
// **跨端边界**（DaemonActionBridge.handleAction）的 input 来自 wire
// envelope——任何能塞 wire 的客户端（移动端 / 受 XSS 的 Web 端 / 恶意客户端）
// 都能伪造 `params._already_judged: true` 绕过 boundary。这是 W1 P1-3
// 安全裂缝的跨端复刻。
//
// **W4 修法 + W7 / B6 收口**：
//   1. DaemonActionBridge.handleAction **入口** `delete params._already_judged`
//      （强制 strip，唯一防御点）
//   2. 三家入口 caller（action-bridge / mcp-server / cli-server）**不再
//      读取也不再透传** `_already_judged`——D3 反例"永远 false 的字段挂在
//      签名上"清退；本机 LLM 主路径走 tabcode-adapter / checkFilePathSecurity
//      独立链路（不经过本模块），不受影响
//
// `checkDaemonPathAccess.options.alreadyJudged` 字段**保留**——它是合法的
// helper 设计（caller 决定是否传），只是 daemon 三家入口当前都不传。未来
// 若有 trusted judge_decision 子结构（譬如 wire 携带 trace_id）需要让 daemon
// 端跳过 boundary 时再用。
