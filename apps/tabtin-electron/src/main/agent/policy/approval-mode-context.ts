/**
 * ：按 thread 发布「生效审批档」的进程内共享上下文。
 *
 * 背景——审批不是一套系统：
 *   1. runtime judge（LocalPermissionHandler）：读 EffectivePolicy.approvalMode（auto/full 旁路）。
 *   2. 浏览器路由策略（browser-policy-middleware → ApprovalManager）：按 URL/动作风险 confirm。
 *   3. FrontendActionBridge 终端/文件（ApprovalManager）：按本地策略 approvalRequired。
 * 后两套历史上**不读** approvalMode/grant，导致用户切「自动通过/全部允许」对浏览器/设备
 * 动作无效（ 现象）。
 *
 * 本模块让 host 把每个 thread 的**生效审批档**（deriveApprovalMode 的结果，与 judge 同源）
 * 发布出来，后两套审批据此统一旁路。旁路分两档，对齐 judge 的分层语义
 * （judge：risk 级硬红线 always_ask deny / auto 转 ask / full_access 放行；
 *   普通 confirm 在 Step 3 由 auto / full_access 直接 allow）：
 *   - 普通 confirm 级（浏览器打开页面等）：auto / full_access 旁路 → shouldBypassConfirmApproval。
 *   - 本机安全底线（LocalSandboxPolicy 的 relaxed 高危命令 / file_delete / 敏感文件写）：
 *     仅 full_access 旁路，auto 仍须人工确认 → shouldBypassSecurityFloorApproval。
 * 硬红线 block 永远拦，不受任何档影响。
 * 与 `interaction-mode-context` 同款（host 写、各处读、thread 别名归一）。
 */
import type { ApprovalMode } from '@tabtin/security-policy'
import { normalizeThreadAliases } from './thread-alias'

const effectiveApprovalModes = new Map<string, ApprovalMode>()

export function setThreadEffectiveApprovalMode(
  threadId: string | undefined | null,
  mode: ApprovalMode,
): void {
  for (const key of normalizeThreadAliases(threadId)) {
    effectiveApprovalModes.set(key, mode)
  }
}

export function clearThreadEffectiveApprovalMode(threadId: string | undefined | null): void {
  for (const key of normalizeThreadAliases(threadId)) {
    effectiveApprovalModes.delete(key)
  }
}

export function getThreadEffectiveApprovalMode(
  threadId: string | undefined | null,
): ApprovalMode | undefined {
  for (const key of normalizeThreadAliases(threadId)) {
    const mode = effectiveApprovalModes.get(key)
    if (mode) return mode
  }
  return undefined
}

/**
 * 生效档是否旁路「普通 confirm 级」审批（auto / full_access）。
 * 用于浏览器打开页面等普通风险动作；硬红线 block / deny 不受此影响——
 * 调用方在 block 判定通过后才问本函数。
 */
export function shouldBypassConfirmApproval(threadId: string | undefined | null): boolean {
  const mode = getThreadEffectiveApprovalMode(threadId)
  return mode === 'auto' || mode === 'full_access'
}

/**
 * 生效档是否旁路「本机安全底线」审批（仅 full_access）。
 * LocalSandboxPolicy 把 relaxed rule 放行的高危 shell、file_delete、
 * `.env` / `.ssh` 等敏感文件写固定为 approvalRequired——这类属 judge 语义里的
 * risk 级（auto 转 ask），故 auto 不旁路，只有 full_access（全部允许）放行。
 */
export function shouldBypassSecurityFloorApproval(threadId: string | undefined | null): boolean {
  return getThreadEffectiveApprovalMode(threadId) === 'full_access'
}
