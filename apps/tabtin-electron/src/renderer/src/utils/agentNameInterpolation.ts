/**
 * Agent 名字插值（ 分身版命名体系，阵容提案 v2 §2.7）。
 *
 * 契约（与后端 seed 线并行约定）：
 * - 模板 API（GET /agents/templates）返回的 name 是插值串，占位符 token
 *   固定 `{owner}`（如 `{owner}代码版`）；前端预览展示时用当前用户昵称展开。
 * - 已实例化的 Agent 名后端序列化时已展开，前端直接用（expandAgentName
 *   对无 token 的串原样返回，天然兼容）。
 * - 老数据（现有 dev 环境的 Agent）名字不是插值格式，直接显示。
 * - persona / 开场白 / 推荐问题文本不内嵌名字（名字归 name 插值层管理），
 *   本 util 只处理 name 字段。
 */

/** 名字插值占位符（后端 manifest `name` 字段约定，勿改）。 */
export const AGENT_NAME_OWNER_TOKEN = '{owner}'

/**
 * 后端 onboarding 默认伙伴名（见 `onboarding_defaults.py`）。
 * 历史实例仅在展示时兼容旧工厂名，不改写用户保存的名称。
 */
export const DEFAULT_ONBOARDING_AGENT_NAME = 'NiiNii'
export const LEGACY_ONBOARDING_AGENT_NAME_XIAOTIN_ZH = '小Tin'
/** 历史 onboarding 名，未迁完的存量展示仍识别。 */
export const LEGACY_ONBOARDING_AGENT_NAME_ZH = '默认 Workspace 执行身份'
export const LEGACY_ONBOARDING_AGENT_NAME_WANNENG_ZH = '万能Tin'

const KNOWN_DEFAULT_AGENT_NAMES_ZH = new Set([
  DEFAULT_ONBOARDING_AGENT_NAME,
  LEGACY_ONBOARDING_AGENT_NAME_XIAOTIN_ZH,
  LEGACY_ONBOARDING_AGENT_NAME_ZH,
  LEGACY_ONBOARDING_AGENT_NAME_WANNENG_ZH,
  '默认 Space 执行身份',
])

/** 仅识别精确工厂名；带旧品牌前缀的用户自定义名仍原样展示。 */
const LEGACY_TEMPLATE_AGENT_DISPLAY_NAMES: Record<string, string> = {
  '小Tin 日常版': 'NiiNii 日常版',
  '小Tin 代码版': 'NiiNii 代码版',
  '小Tin 文书版': 'NiiNii 文书版',
  '小Tin 数据版': 'NiiNii 数据版',
  '小Tin 冲浪版': 'NiiNii 冲浪版',
  '小Tin PPT 版': 'NiiNii PPT 版',
  '小Tin 跑腿版': 'NiiNii 跑腿版',
  '小Tin 代碼版': 'NiiNii 代碼版',
  '小Tin 文書版': 'NiiNii 文書版',
  '小Tin 數據版': 'NiiNii 數據版',
  '小Tin 衝浪版': 'NiiNii 衝浪版',
}

export function normalizeKnownAgentDisplayName(rawName: string | null | undefined): string {
  const name = rawName?.trim() ?? ''
  if (KNOWN_DEFAULT_AGENT_NAMES_ZH.has(name)) return DEFAULT_ONBOARDING_AGENT_NAME
  return Object.hasOwn(LEGACY_TEMPLATE_AGENT_DISPLAY_NAMES, name)
    ? LEGACY_TEMPLATE_AGENT_DISPLAY_NAMES[name]
    : name
}

/**
 * 已知系统默认 Agent 名的展示本地化。未知名字原样返回（自定义名不受影响）。
 */
export function localizeKnownAgentDisplayName(
  rawName: string | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const name = normalizeKnownAgentDisplayName(rawName)
  if (!name) return ''
  if (name === DEFAULT_ONBOARDING_AGENT_NAME) {
    return t('myAgents.defaultExecutionIdentityName', {
      defaultValue: DEFAULT_ONBOARDING_AGENT_NAME,
    })
  }
  return name
}

export function hasOwnerToken(rawName: string | null | undefined): boolean {
  return Boolean(rawName?.includes(AGENT_NAME_OWNER_TOKEN))
}

/**
 * 展开插值串：`{owner}代码版` + 「进宝」→「进宝代码版」。
 * - 无 token（已实例化 Agent / 老数据）原样返回。
 * - ownerName 为空时移除 token 并 trim（「代码版」）——比露出 `{owner}`
 *   字面量体面；调用方应尽量传昵称（nickname → username 逐级兜底）。
 */
export function expandAgentName(rawName: string, ownerName: string | null | undefined): string {
  if (!hasOwnerToken(rawName)) return normalizeKnownAgentDisplayName(rawName)
  const owner = ownerName?.trim() ?? ''
  return rawName.split(AGENT_NAME_OWNER_TOKEN).join(owner).trim()
}

export interface AgentDisplayNameParts {
  /** 名字里的归属前缀（= 用户昵称）；名字不含昵称前缀时为 null（老数据 / 自定义名） */
  ownerPrefix: string | null
  /** 版后缀（「代码版」）；无归属前缀时为完整名 */
  suffix: string
}

/**
 * 把 Agent 名拆成「归属前缀 + 版后缀」，供身份切换器做「昵称恒定、只动
 * 后缀」的展示（分身版心智：我不变、赛道变）。
 *
 * 兼容三类输入：插值串（先展开）、已展开的分身名（按昵称前缀拆）、
 * 老数据 / 自定义名（整名作为 suffix，ownerPrefix=null）。
 */
export function splitAgentDisplayName(
  rawName: string,
  ownerName: string | null | undefined,
): AgentDisplayNameParts {
  const expanded = expandAgentName(rawName, ownerName)
  const owner = ownerName?.trim() ?? ''
  if (owner && expanded.startsWith(owner)) {
    const suffix = expanded.slice(owner.length).trim()
    if (suffix) {
      return { ownerPrefix: owner, suffix }
    }
  }
  return { ownerPrefix: null, suffix: expanded }
}
