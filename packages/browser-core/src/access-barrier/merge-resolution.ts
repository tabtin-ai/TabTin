/**
 * 把 `AccessBarrier` + 决议合并进工具响应 payload（设计 §5.2 / plan Task 2）。
 *
 * 置顶写入 `access_barrier` / `access_barrier_resolution`（大响应截断 preview 也能第一眼
 * 看到）；过渡期双写旧 `login_required` / `captcha_required`（旧客户端/旧测试仍可读），
 * 新路径只认 barrier + resolution（设计 §5.2 表）。
 */
import { CAPTCHA_REQUIRED_HINT } from '../captcha/CaptchaDetector.js'
import type { AccessBarrier, AccessBarrierResolution } from './types.js'

/**
 * 与 `BrowserOrchestrator.ts` 的 `LOGIN_REQUIRED_HINT` 同文案。此处不直接 import 该文件的
 * 常量，避免 `BrowserOrchestrator.ts` → `access-barrier` → `BrowserOrchestrator.ts` 循环依赖
 * （access-barrier 是被 orchestration 消费的下游领域模块）。
 */
const ACCESS_BARRIER_LOGIN_REQUIRED_HINT =
  '检测到登录墙：立即停下并把选择权交给用户，不要静默改用其他来源，更不能拿别处内容冒充本站结果。'
  + '用 ask_user 卡片向用户说明此页需要登录，并让其二选一：'
  + '① 在 TabTin 浏览器当前标签页手动完成登录（手机号验证码 / 扫码 / OAuth 等），登录后复用同一 --tab-id 继续在本站获取；'
  + '② 明确同意后改从其他公开来源获取（须诚实标注真实来源、不得标为本站结果）。'
  + '不要代填账号 / 密码 / 验证码，不要改用 print --url（会丢登录态）。'

/**
 * HITL 已结束（超时 / 跳过 / 宿主不可用）时的 hint：禁止再教模型弹 ask_user，
 * 避免「卡已关 + 工具结果仍写请 ask_user」→ 文字软问 + 孤儿卡挡发送。
 */
export const ACCESS_BARRIER_HITL_ENDED_HINT =
  '访问障碍人机确认已结束（见 access_barrier_resolution.action）。'
  + '不要再次用 ask_user / 自由文本追问登录或验证；按决议诚实收束、换公开来源（须标注真实来源）或说明本站本次不可用。'
  + '禁止拿别处内容冒充本站结果，不要代填账号 / 密码 / 验证码。'

/**
 * 用户点「继续」且复检已无墙：勿再教 ask_user；用同一 tabId 接着干。
 */
export const ACCESS_BARRIER_RESUME_CLEARED_HINT =
  '用户已确认在当前标签页完成登录/验证，且复检后页面已不再是访问障碍。'
  + '请用 access_barrier_resolution.tabId（或本结果中的 tabId）继续 glance/act/print；'
  + '不要再次 ask_user，不要静默换源冒充本站结果。'

/**
 * 用户点「继续」但复检仍见墙：诚实说明，勿重复弹同类三选一。
 */
export const ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT =
  '用户已确认继续，但对同一标签页复检后仍检测到登录/验证墙。'
  + '请对同一 tabId 再 glance 确认，或请用户完成登录/验证后再试；'
  + '不要再次用 ask_user 重复同一套三选一，不要拿别处内容冒充本站结果。'

export interface MergeBarrierOptions {
  /**
   * `resume_same_tab` 后强制复检的结果：
   * - `cleared`：复检无墙，用新观察覆盖，双写用 cleared hint（或不强调墙）
   * - `still_blocked`：复检仍有墙，双写用 still_blocked hint
   * - 缺省：未做复检（如换源/放弃/系统结局），沿用原逻辑
   */
  postResumeRecheck?: 'cleared' | 'still_blocked'
}

function isSystemEndedResolution(resolution: AccessBarrierResolution): boolean {
  return (
    resolution.action === 'timeout'
    || resolution.action === 'skipped'
    || resolution.action === 'host_unavailable'
  )
}

function resolveDualWriteHint(
  barrier: AccessBarrier,
  resolution: AccessBarrierResolution,
  options?: MergeBarrierOptions,
): string {
  if (options?.postResumeRecheck === 'cleared') {
    return ACCESS_BARRIER_RESUME_CLEARED_HINT
  }
  if (options?.postResumeRecheck === 'still_blocked') {
    return ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT
  }
  if (isSystemEndedResolution(resolution)) {
    return ACCESS_BARRIER_HITL_ENDED_HINT
  }
  if (resolution.action === 'resume_same_tab') {
    // 未走复检的兜底（缺 exec 等）：仍勿教 ask_user，引导用同一 tab 再观察。
    return ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT
  }
  if (barrier.kind === 'login') {
    return ACCESS_BARRIER_LOGIN_REQUIRED_HINT
  }
  return CAPTCHA_REQUIRED_HINT
}

function buildLegacyDualWrite(
  barrier: AccessBarrier,
  resolution: AccessBarrierResolution,
  options?: MergeBarrierOptions,
): Record<string, unknown> {
  // 复检已清墙：不再双写 login_required/captcha_required，避免模型以为还在墙上。
  if (options?.postResumeRecheck === 'cleared') {
    return {}
  }
  const hint = resolveDualWriteHint(barrier, resolution, options)
  if (barrier.kind === 'login') {
    return {
      login_required: {
        reason: barrier.reason,
        hint,
        // 保留 opensource/v1 observe 投影的 tab_id，避免 HITL 双写冲掉定位字段。
        ...(barrier.tabId ? { tab_id: barrier.tabId } : {}),
      },
    }
  }
  // captcha / geetest / mfa / unknown_wall：过渡期统一落旧 captcha_required 键。
  return {
    captcha_required: {
      reason: barrier.reason,
      hint,
      ...(barrier.captchaType ? { type: barrier.captchaType } : {}),
    },
  }
}

export function mergeBarrierIntoPayload(
  data: Record<string, unknown>,
  barrier: AccessBarrier,
  resolution: AccessBarrierResolution,
  options?: MergeBarrierOptions,
): Record<string, unknown> {
  // 观测投影可能已带旧 login_required / captcha_required；以本函数双写为准覆盖，
  // 避免 timeout 等系统结局仍残留「请 ask_user」开卡 hint。
  const {
    login_required: _dropLogin,
    captcha_required: _dropCaptcha,
    access_barrier: _dropBarrier,
    access_barrier_resolution: _dropResolution,
    ...rest
  } = data

  const topHint =
    options?.postResumeRecheck === 'cleared'
      ? ACCESS_BARRIER_RESUME_CLEARED_HINT
      : options?.postResumeRecheck === 'still_blocked'
        ? ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT
        : undefined

  return {
    access_barrier: barrier,
    access_barrier_resolution: resolution,
    ...buildLegacyDualWrite(barrier, resolution, options),
    ...(topHint ? { access_barrier_hint: topHint } : {}),
    ...rest,
  }
}
