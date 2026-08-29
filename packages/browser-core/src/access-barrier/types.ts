/**
 * AccessBarrier —— 访问障碍（登录墙 / 人机校验 / MFA）领域模型。
 *
 * 核心原则：访问障碍是**系统拦截**，不是模型意图确认——探测（browser-core）、
 * 策略（编排层 / 宿主 HITL）、展示（对话卡片）三层分离，模型只消费决议后的工具结果。
 */

/** 障碍种类。`geetest` 独立于通用 `captcha`，方便文案与前端图标区分（设计 §5.1 注）。 */
export type AccessBarrierKind =
  | 'login'
  | 'captcha'
  | 'geetest'
  | 'mfa'
  | 'unknown_wall'

/** 用户可选的处置动作。与 `AccessBarrierResolution.action` 的用户主动三选一一一对应。 */
export type AccessBarrierActionId =
  | 'resume_same_tab'
  | 'alternate_source'
  | 'abort_this_target'

/**
 * 归一后的访问障碍描述（设计 §5.1）。由 `buildAccessBarrierFromObserveRaw` 从
 * observe/act 引擎原始产出构造，供编排层 `resolveAccessBarrier` hook 与对话卡片消费。
 */
export interface AccessBarrier {
  kind: AccessBarrierKind
  reason: string
  /** hostname，未知则 `'unknown'`。 */
  domain: string
  pageUrl?: string
  /** 有则卡片可「提到前台」并要求复用同一 tab。 */
  tabId?: string
  /** 探测侧已有时透传（recaptcha-v2 / turnstile / geetest…）。 */
  captchaType?: string
  /** glance / act / open / run_terminal_command … */
  sourceTool?: string
  /** ISO 时间戳。 */
  detectedAt: string
  actions: AccessBarrierActionId[]
}

/**
 * 用户决议 / 系统结局的判别联合（设计 §5.1）。
 *
 * 前三种为用户主动三选一；`timeout` / `skipped` / `host_unavailable` 是系统结局
 * （超时、用户跳过、HITL 不可用/scheduled 无人值守），均须诚实失败、禁止假装成功。
 */
export type AccessBarrierResolution =
  | {
      action: 'resume_same_tab'
      tabId?: string
      note?: string
    }
  | {
      action: 'alternate_source'
    }
  | {
      action: 'abort_this_target'
    }
  | {
      action: 'timeout' | 'skipped' | 'host_unavailable'
    }
