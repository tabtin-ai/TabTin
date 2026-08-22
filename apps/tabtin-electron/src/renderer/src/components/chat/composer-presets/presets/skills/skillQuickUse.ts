/**
 * Skill 快速使用泛化层（WC）
 *
 * 「快速使用」从硬编码 tabtin-widget 泛化为两套来源并存：
 * - builtin（platform / 非 marketplace app）：走代码内置注册表（BUILTIN_QUICK_USE），
 *   tabtin-widget 仍复用 tabtinWidgetQuickUse 的静态 descriptor。
 * - user（个人创建 / 市场）：读后端 SkillIndexEntry.quick_use（激活版本或草稿的快照），
 *   按 skill_key 动态注册一个 ComposerPresetDescriptor —— 卡片渲染与发送序列化全部
 *   复用既有 composer preset 基础设施（getComposerPreset / resolvePresetBlocks）。
 *
 * 发送链路自包含：动态 descriptor 的 serializeForSend 用自身 promptTemplate + 最终 state
 * 插值出 rendered_prompt，本地 runtime 直接读取（见 sendMessageAction.resolveComposerPresetPrompt）。
 * composer preset store 是内存态（不持久化），所以「打开详情即注册」不存在重启失忆问题。
 */
import {
  registerComposerPreset,
} from '../../registry/composerPresetRegistry'
import type {
  ComposerPresetBlock,
  ComposerPresetDescriptor,
  PromptVariable,
} from '../../registry/types'
import type { SkillIndexEntry } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { SKILL_QUICK_USE_PREVIEW_RENDERER } from './SkillQuickUsePreviewRenderer'
import {
  TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE,
  TABTIN_WIDGET_QUICK_USE_PRESET_ID,
  TABTIN_WIDGET_QUICK_USE_TEMPLATE,
  TABTIN_WIDGET_QUICK_USE_VARIABLES,
  TABTIN_WIDGET_SKILL_KEY,
} from './tabtinWidgetQuickUse'

export interface ResolvedSkillQuickUse {
  /** 注册表里的 preset id（builtin 用固定 id，user 用 skill_key 派生）。 */
  presetId: string
  skillKey: string
  /** Skill 详情页入口与 composer 卡片标签。 */
  label: string
  promptTemplate: string
  variables: PromptVariable[]
  defaultState: Record<string, unknown>
  /** 任一为空则不可提交；空数组 = 无强制必填。 */
  requiredKeys: string[]
}

interface RawQuickUsePreset {
  id?: unknown
  label?: unknown
  promptTemplate?: unknown
  variables?: unknown
  canSubmitKeys?: unknown
}

const USER_QUICK_USE_PRESET_PREFIX = 'skill.quickUse.user:'

function valueAsString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(v => valueAsString(v)).filter(Boolean).join('、')
  return ''
}

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && value !== ''
}

function autoTextForVariable(variable: PromptVariable): string {
  const key = variable.key.toLowerCase()
  const label = (variable.label || variable.placeholder || variable.key).trim()
  if (/(subject|topic|theme|title)/.test(key) || /主题|标题|对象/.test(label)) {
    return '上海近一周天气变化'
  }
  if (/(focus|scope|requirement|goal)/.test(key) || /重点|目标|要求|范围/.test(label)) {
    return '围绕天气趋势、风险提醒和下一步动作展开'
  }
  return label ? `以天气场景为例补全「${label}」` : '以上海天气为例自动判断'
}

function autoValueForVariable(variable: PromptVariable): unknown {
  if (variable.defaultValue !== undefined) return variable.defaultValue
  if (variable.type === 'select') return variable.options?.[0]?.value
  if (variable.type === 'multiselect') {
    const first = variable.options?.[0]?.value
    return first ? [first] : []
  }
  if (variable.type === 'number' || variable.type === 'slider') return 1
  if (variable.type === 'toggle') return true
  if (variable.type === 'upload') return undefined
  return autoTextForVariable(variable)
}

function withGeneratedDefaults(
  variables: PromptVariable[],
  state: Record<string, unknown>,
): PromptVariable[] {
  return variables.map(variable => (
    variable.defaultValue !== undefined || state[variable.key] === undefined
      ? variable
      : { ...variable, defaultValue: state[variable.key] }
  ))
}

// 与 skillProductState.isBuiltinCatalogSkill 同口径，复制以避免 composer-presets ↔
// context-space/skills 形成 import 环（SkillPanel 已 import 本模块）。
function isBuiltinCatalogSkill(skill: SkillIndexEntry): boolean {
  const source = normalizeSkillSource(skill.source)
  if (source === 'platform') return true
  return source === 'app' && skill.distribution !== 'marketplace'
}

function matchTabtinWidget(skill: SkillIndexEntry): boolean {
  if (skill.skill_key?.toLowerCase() === TABTIN_WIDGET_SKILL_KEY) return true
  if (!isBuiltinCatalogSkill(skill)) return false
  const canonicalValues = [skill.skill_id, skill.app_id, skill.slug]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase())
  return canonicalValues.some(value =>
    value === TABTIN_WIDGET_SKILL_KEY
    || value === 'visualization/tabtin-widget'
    || value === 'tabtin-widget',
  )
}

function skillCanonicalValues(skill: SkillIndexEntry): string[] {
  return [
    skill.skill_key,
    skill.skill_id,
    skill.app_id,
    skill.slug,
    skill.name,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase())
}

function matchBuiltinSkill(...aliases: string[]): (skill: SkillIndexEntry) => boolean {
  const set = new Set(aliases.map(alias => alias.toLowerCase()))
  return (skill: SkillIndexEntry) => {
    if (!isBuiltinCatalogSkill(skill)) return false
    return skillCanonicalValues(skill).some(value => set.has(value))
  }
}

interface BuiltinQuickUse {
  presetId: string
  match: (skill: SkillIndexEntry) => boolean
  /** 固定发送给 runtime 的 canonical skill key；省略时使用当前 skill.skill_key。 */
  skillKey?: string
  label: string
  promptTemplate: string
  variables: PromptVariable[]
  defaultState: Record<string, unknown>
  requiredKeys: string[]
  /** false 表示 descriptor 已由专用 preset 模块注册（如 tabtin-widget）。 */
  registerDescriptor?: boolean
}

function textareaVar(
  key: string,
  label: string,
  placeholder: string,
  defaultValue: string,
  rows = 2,
): PromptVariable {
  return { key, type: 'textarea', label, placeholder, defaultValue, config: { rows } }
}

function selectVar(
  key: string,
  label: string,
  defaultValue: string,
  options: string[],
): PromptVariable {
  return {
    key,
    type: 'select',
    label,
    defaultValue,
    options: options.map(value => ({ value, label: value })),
  }
}

/**
 * 内置 skill 的快速使用注册表。新增内置能力在这里登记即可（不进数据库）。
 */
const BUILTIN_QUICK_USE: BuiltinQuickUse[] = [
  {
    presetId: TABTIN_WIDGET_QUICK_USE_PRESET_ID,
    match: matchTabtinWidget,
    label: '快速使用 tabtin-widget',
    promptTemplate: TABTIN_WIDGET_QUICK_USE_TEMPLATE,
    variables: TABTIN_WIDGET_QUICK_USE_VARIABLES,
    defaultState: TABTIN_WIDGET_QUICK_USE_DEFAULT_STATE,
    requiredKeys: ['subject'],
    registerDescriptor: false,
  },
  {
    presetId: 'skill.tabdoc.quickUse.createDraft',
    match: matchBuiltinSkill('tabdoc', 'tabdoc-operator', 'app:tabdoc/tabdoc-operator'),
    skillKey: 'app:tabdoc/tabdoc-operator',
    label: '起草天气说明文档',
    promptTemplate:
      '请使用 TabDoc，帮我创建一篇 {{docType}}。\n' +
      '文档主题：{{subject}}\n' +
      '资料来源：{{source}}\n' +
      '写作重点：{{focus}}\n' +
      '输出要求：先检索是否已有同名或同主题文档；创建或更新后，在回复里给出可点击的 TabDoc 链接。',
    variables: [
      textareaVar('subject', '文档主题', '例：新用户 onboarding 指南 / 项目复盘 / 客户访谈总结', '上海近一周天气变化'),
      selectVar('docType', '文档类型', '结构化说明文档', ['结构化说明文档', '会议纪要', '项目复盘', '调研报告', '操作手册']),
      textareaVar('source', '资料来源', '例：当前对话、我上传的材料、某个已有文档', '以公开天气预报和常识为基础，不确定时请先说明假设'),
      textareaVar('focus', '写作重点', '例：先给结论，再列步骤；保留关键决策和待办', '按日期列出天气趋势、出行建议和需要关注的异常天气'),
    ],
    defaultState: {
      subject: '上海近一周天气变化',
      docType: '结构化说明文档',
      source: '以公开天气预报和常识为基础，不确定时请先说明假设',
      focus: '按日期列出天气趋势、出行建议和需要关注的异常天气',
    },
    requiredKeys: ['subject'],
  },
  {
    presetId: 'skill.tabdoc.quickUse.organizeConversation',
    match: matchBuiltinSkill('tabdoc', 'tabdoc-operator', 'app:tabdoc/tabdoc-operator'),
    skillKey: 'app:tabdoc/tabdoc-operator',
    label: '整理一份天气出行清单',
    promptTemplate:
      '请使用 TabDoc，把一组天气信息整理成一篇可沉淀的文档。\n' +
      '标题方向：{{subject}}\n' +
      '整理方式：{{structure}}\n' +
      '需要保留：{{focus}}\n' +
      '输出要求：文档落库后回复可点击链接，并简短说明你整理了哪些部分。',
    variables: [
      textareaVar('subject', '标题方向', '例：Quick use 交互改版方案 / 本周产品决策记录', '上海周末出行天气准备清单'),
      selectVar('structure', '整理方式', '结论 + 背景 + 决策 + 待办', ['结论 + 背景 + 决策 + 待办', '问题清单 + 方案 + 验证', '会议纪要 + 行动项', 'FAQ / 操作手册']),
      textareaVar('focus', '需要保留', '例：用户原话、关键取舍、验证结果、未覆盖风险', '天气趋势、穿衣建议、雨具提醒和可执行待办'),
    ],
    defaultState: {
      subject: '上海周末出行天气准备清单',
      structure: '结论 + 背景 + 决策 + 待办',
      focus: '天气趋势、穿衣建议、雨具提醒和可执行待办',
    },
    requiredKeys: ['subject'],
  },
  {
    presetId: 'skill.tabdoc.quickUse.findAndSummarize',
    match: matchBuiltinSkill('tabdoc', 'tabdoc-operator', 'app:tabdoc/tabdoc-operator'),
    skillKey: 'app:tabdoc/tabdoc-operator',
    label: '查找天气相关文档',
    promptTemplate:
      '请使用 TabDoc，帮我查找并总结相关文档。\n' +
      '检索主题：{{subject}}\n' +
      '总结目标：{{focus}}\n' +
      '输出形式：{{format}}\n' +
      '输出要求：必须用 TabDoc 规范的可点击文档链接引用结果；找不到时说明检索范围和下一步建议。',
    variables: [
      textareaVar('subject', '检索主题', '例：部署方案 / 客户访谈 / 设计系统规范', '上海天气'),
      textareaVar('focus', '总结目标', '例：找结论、找风险、找待办、对比几份方案', '找出温度变化、降雨风险和出行建议'),
      selectVar('format', '输出形式', '带链接的要点列表', ['带链接的要点列表', '对比表', '时间线', '执行清单']),
    ],
    defaultState: {
      subject: '上海天气',
      focus: '找出温度变化、降雨风险和出行建议',
      format: '带链接的要点列表',
    },
    requiredKeys: ['subject'],
  },
  {
    presetId: 'skill.tabdata.quickUse.designTable',
    match: matchBuiltinSkill(
      'tabdata',
      'table-modeling',
      'table-operator',
      'table-query',
      'table-import-export',
      'app:tabdata/table-modeling',
      'app:tabdata/table-operator',
      'app:tabdata/table-query',
      'app:tabdata/table-import-export',
    ),
    skillKey: 'app:tabdata/table-modeling',
    label: '设计天气记录表',
    promptTemplate:
      '请使用 TabData，帮我把这个场景设计成多维表。\n' +
      '业务场景：{{subject}}\n' +
      '数据形态：{{dataShape}}\n' +
      '是否需要关联/反查：{{relationNeed}}\n' +
      '交付范围：{{deliveryScope}}\n' +
      '真实性要求：需要填数据时，先逐字段核对可靠来源；来源没有的值留空，不得估算或编造。确定性换算可以做，但必须保留原始值并说明规则。\n' +
      '完成标准：只建结构时明确说明这是空表、本次写入 0 条；需要填真实数据时，必须完成真实写入并报告成功条数、数据来源和留空字段。dry-run 只算预览，不能表述为已经创建或写入。\n' +
      '输出要求：先说明建议是一张表、嵌套清单还是多表关联；再按交付范围执行，并告诉我每个字段怎么用。',
    variables: [
      textareaVar('subject', '业务场景', '例：客户跟进 / 内容选题池 / 招聘候选人管理', '上海未来 7 天每日天气记录'),
      selectVar('dataShape', '数据形态', '先按常见字段建一个可用版本', ['先按常见字段建一个可用版本', '我已有字段清单', '列表 + 详情/子项', '需要统计分析']),
      selectVar('relationNeed', '关联/反查', '不确定，先帮我判断', ['不确定，先帮我判断', '只要一张表', '需要关联表', '需要从子项反查主项']),
      selectVar('deliveryScope', '交付范围', '只创建表结构，不填业务数据', ['只创建表结构，不填业务数据', '创建表结构，并填入真实数据']),
    ],
    defaultState: {
      subject: '上海未来 7 天每日天气记录',
      dataShape: '先按常见字段建一个可用版本',
      relationNeed: '不确定，先帮我判断',
      deliveryScope: '只创建表结构，不填业务数据',
    },
    requiredKeys: ['subject', 'deliveryScope'],
  },
  {
    presetId: 'skill.tabdata.quickUse.analyzeTable',
    match: matchBuiltinSkill(
      'tabdata',
      'table-query',
      'table-operator',
      'app:tabdata/table-query',
      'app:tabdata/table-operator',
    ),
    skillKey: 'app:tabdata/table-query',
    label: '分析一张天气数据表',
    promptTemplate:
      '请使用 TabData，分析一张天气数据表或我指定的表。\n' +
      '分析目标：{{subject}}\n' +
      '关注指标：{{metrics}}\n' +
      '输出形式：{{format}}\n' +
      '输出要求：先确认表结构；查询要限制范围；结果用用户能看懂的语言解释，并指出可继续追问的方向。',
    variables: [
      textareaVar('subject', '分析目标', '例：找高优先级未完成任务 / 统计各渠道转化 / 看本月异常数据', '分析上海未来 7 天气温和降雨风险'),
      textareaVar('metrics', '关注指标', '例：状态、负责人、截止日期、金额、渠道', '最高/最低温、降雨概率、风力和出行风险'),
      selectVar('format', '输出形式', '结论 + 表格', ['结论 + 表格', '排行榜', '异常清单', '分组统计']),
    ],
    defaultState: {
      subject: '分析上海未来 7 天气温和降雨风险',
      metrics: '最高/最低温、降雨概率、风力和出行风险',
      format: '结论 + 表格',
    },
    requiredKeys: ['subject'],
  },
  {
    presetId: 'skill.tabdata.quickUse.importData',
    match: matchBuiltinSkill(
      'tabdata',
      'table-import-export',
      'table-modeling',
      'app:tabdata/table-import-export',
      'app:tabdata/table-modeling',
    ),
    skillKey: 'app:tabdata/table-import-export',
    label: '整理天气资料进表',
    promptTemplate:
      '请使用 TabData，把一批资料整理成可管理的数据表。\n' +
      '资料来源：{{source}}\n' +
      '要抽取的字段：{{fields}}\n' +
      '建表策略：{{strategy}}\n' +
      '真实性要求：逐字段核对资料来源；来源没有的值留空，不得用看似合理的估算补齐。确定性换算须保留原始值并说明规则。\n' +
      '完成标准：dry-run 或导入预览不算完成；只有真实写入成功后，才能报告已导入，并给出成功条数、失败条数、来源和留空字段。\n' +
      '输出要求：先给字段设计，再导入数据；如果信息来自网页，和 Browser 协作并保留来源链接和获取时间。',
    variables: [
      textareaVar('source', '资料来源', '例：当前网页、上传的 CSV、聊天里的清单、多个链接', '上海未来 7 天天气预报清单'),
      textareaVar('fields', '要抽取的字段', '例：名称、网址、状态、负责人、金额、备注', '日期、天气、最高温、最低温、降雨概率、出行建议'),
      selectVar('strategy', '建表策略', '先建一个扁平表，后续再扩展', ['先建一个扁平表，后续再扩展', '需要关联表', '需要按来源去重', '需要支持后续更新']),
    ],
    defaultState: {
      source: '上海未来 7 天天气预报清单',
      fields: '日期、天气、最高温、最低温、降雨概率、出行建议',
      strategy: '先建一个扁平表，后续再扩展',
    },
    requiredKeys: ['source'],
  },
  {
    presetId: 'skill.tabweb.quickUse.summarizePage',
    match: matchBuiltinSkill('tabweb', 'browser-operator', 'app:tabweb/browser-operator'),
    skillKey: 'app:tabweb/browser-operator',
    label: '打开天气网页并总结',
    promptTemplate:
      '请使用 Browser，帮我打开或复用网页并总结内容。\n' +
      '目标网页：{{target}}\n' +
      '我关心的问题：{{focus}}\n' +
      '输出形式：{{format}}\n' +
      '输出要求：优先复用已有同域标签页；需要登录态时不要用临时 URL 抽取；总结里标明来源。',
    variables: [
      textareaVar('target', '目标网页', '例：https://example.com/article 或 当前浏览器标签页', '中国天气网或天气预报页面'),
      textareaVar('focus', '关心的问题', '例：提炼结论、找价格、看更新点、提取联系人', '上海未来 7 天的温度、降雨和出行建议'),
      selectVar('format', '输出形式', '三点摘要 + 来源', ['三点摘要 + 来源', '详细笔记', '对比表', '行动清单']),
    ],
    defaultState: {
      target: '中国天气网或天气预报页面',
      focus: '上海未来 7 天的温度、降雨和出行建议',
      format: '三点摘要 + 来源',
    },
    requiredKeys: ['target'],
  },
  {
    presetId: 'skill.tabweb.quickUse.extractToTable',
    match: matchBuiltinSkill('tabweb', 'browser-operator', 'app:tabweb/browser-operator'),
    skillKey: 'app:tabweb/browser-operator',
    label: '采集天气网页数据到表',
    promptTemplate:
      '请使用 Browser 和 TabData，把网页里的结构化数据采集到多维表。\n' +
      '目标页面：{{target}}\n' +
      '要采集的数据：{{fields}}\n' +
      '采集方式：{{strategy}}\n' +
      '输出要求：先根据我的目标、页面标题/域名和采集字段判断一个清晰表名；如果目标页已经打开，先用 `tabtin browser tab list --format json` 找 tabId 复用已有页（保登录态），未打开时再 `tabtin browser open`；然后用 `tabtin browser network` / `eval` 拿接口数据、优先复刻 API，最后写入 TabData 表；命中「列表 + 详情」时拆成两阶段采集。写表前要抽样校验 3 条数据。',
    variables: [
      textareaVar('target', '目标页面', '例：商品列表页 / 招聘列表 / 新闻搜索结果页', '天气预报网页，例如中国天气网上海页面'),
      textareaVar('fields', '采集字段', '例：标题、价格、链接、日期、作者、摘要', '日期、天气、最高温、最低温、降雨概率、来源链接'),
      selectVar('strategy', '采集方式', '先找 API，再退回页面解析', ['先找 API，再退回页面解析', '复用当前登录态标签页', '只采当前页', '列表 + 详情两阶段']),
    ],
    defaultState: {
      target: '天气预报网页，例如中国天气网上海页面',
      fields: '日期、天气、最高温、最低温、降雨概率、来源链接',
      strategy: '先找 API，再退回页面解析',
    },
    requiredKeys: ['target'],
  },
  {
    presetId: 'skill.tabweb.quickUse.comparePages',
    match: matchBuiltinSkill('tabweb', 'browser-operator', 'app:tabweb/browser-operator'),
    skillKey: 'app:tabweb/browser-operator',
    label: '对比多个天气网页',
    promptTemplate:
      '请使用 Browser，帮我对比多个网页或资料页。\n' +
      '对比对象：{{target}}\n' +
      '对比维度：{{focus}}\n' +
      '输出形式：{{format}}\n' +
      '输出要求：每个结论都带来源链接；如果页面需要登录态，复用已打开标签页。',
    variables: [
      textareaVar('target', '对比对象', '例：三个竞品官网 / 两篇政策说明 / 几个价格页 URL', '中国天气、中央气象台和本地天气页面'),
      textareaVar('focus', '对比维度', '例：价格、功能、定位、优缺点、更新时间', '温度、降雨、风力预报差异和出行决策'),
      selectVar('format', '输出形式', '对比表 + 建议', ['对比表 + 建议', '差异清单', '优缺点矩阵', '时间线']),
    ],
    defaultState: {
      target: '中国天气、中央气象台和本地天气页面',
      focus: '温度、降雨、风力预报差异和出行决策',
      format: '对比表 + 建议',
    },
    requiredKeys: ['target'],
  },
  {
    presetId: 'skill.tabtracker.quickUse.createScheduled',
    match: matchBuiltinSkill('tabtracker', 'app:tabtracker/tabtracker'),
    skillKey: 'app:tabtracker/tabtracker',
    label: '创建天气提醒任务',
    promptTemplate:
      '请使用 TabTracker，帮我创建一个自动化任务。\n' +
      '任务目标：{{subject}}\n' +
      '触发频率：{{schedule}}\n' +
      '执行方式：{{execution}}\n' +
      '输出要求：先问清楚或确认执行 Agent 和 Skill；创建后默认保持 draft，除非我明确要求，别擅自激活。',
    variables: [
      textareaVar('subject', '任务目标', '例：每天早上总结昨日销售数据 / 每周五生成周报', '每天早上 8 点检查上海天气并提醒是否带伞'),
      selectVar('schedule', '触发频率', '每天固定时间', ['每天固定时间', '工作日固定时间', '每周固定时间', '手动触发', '事件触发']),
      textareaVar('execution', '执行方式', '例：用默认 Space；用某个数据分析 Skill；执行后发消息汇报', '使用 Browser 获取天气信息，执行后在当前 Space 发一条简短提醒'),
    ],
    defaultState: {
      subject: '每天早上 8 点检查上海天气并提醒是否带伞',
      schedule: '每天固定时间',
      execution: '使用 Browser 获取天气信息，执行后在当前 Space 发一条简短提醒',
    },
    requiredKeys: ['subject'],
  },
  {
    presetId: 'skill.tabtracker.quickUse.reviewRuns',
    match: matchBuiltinSkill('tabtracker', 'app:tabtracker/tabtracker'),
    skillKey: 'app:tabtracker/tabtracker',
    label: '查看天气提醒运行情况',
    promptTemplate:
      '请使用 TabTracker，帮我检查当前 Space 的自动化任务运行情况。\n' +
      '检查范围：{{scope}}\n' +
      '关注点：{{focus}}\n' +
      '输出形式：{{format}}\n' +
      '输出要求：先列出 Tracker，再查看最近运行记录；把失败原因、最近成功时间和建议动作讲清楚。',
    variables: [
      textareaVar('scope', '检查范围', '例：所有活跃任务 / 某个任务 / 最近失败的任务', '天气提醒相关的自动化任务'),
      textareaVar('focus', '关注点', '例：失败原因、是否按时执行、最近一次输出是否正常', '天气提醒是否按时运行、是否失败、最近一次提醒内容是否正常'),
      selectVar('format', '输出形式', '状态简报', ['状态简报', '失败清单', '运行时间线', '修复建议']),
    ],
    defaultState: {
      scope: '天气提醒相关的自动化任务',
      focus: '天气提醒是否按时运行、是否失败、最近一次提醒内容是否正常',
      format: '状态简报',
    },
    requiredKeys: ['scope'],
  },
  {
    presetId: 'skill.tabtracker.quickUse.dryRun',
    match: matchBuiltinSkill('tabtracker', 'app:tabtracker/tabtracker'),
    skillKey: 'app:tabtracker/tabtracker',
    label: '试运行天气提醒条件',
    promptTemplate:
      '请使用 TabTracker，帮我试运行一个自动化任务的触发条件。\n' +
      '目标任务：{{subject}}\n' +
      '试运行方式：{{mode}}\n' +
      '关注点：{{focus}}\n' +
      '输出要求：不要真的执行 Skill；只回放或合成触发事件，说明为什么会命中或不会命中。',
    variables: [
      textareaVar('subject', '目标任务', '例：某个表格变化触发任务 / 某个邮件触发任务', '每天早上 8 点上海天气提醒'),
      selectVar('mode', '试运行方式', '用最近事件回放', ['用最近事件回放', '用合成事件预览', '只检查配置', '对比多个任务']),
      textareaVar('focus', '关注点', '例：过滤条件、事件字段、触发频率、误触发风险', '确认它是否会在每天早上 8 点触发，且不会重复提醒'),
    ],
    defaultState: {
      subject: '每天早上 8 点上海天气提醒',
      mode: '用最近事件回放',
      focus: '确认它是否会在每天早上 8 点触发，且不会重复提醒',
    },
    requiredKeys: ['subject'],
  },
]

function normalizeVariables(raw: unknown): PromptVariable[] {
  if (!Array.isArray(raw)) return []
  const out: PromptVariable[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const key = rec.key
    if (typeof key !== 'string' || !key) continue
    const type = typeof rec.type === 'string' ? rec.type : 'input'
    const variable: PromptVariable = { key, type: type as PromptVariable['type'] }
    if (typeof rec.label === 'string') variable.label = rec.label
    if (typeof rec.placeholder === 'string') variable.placeholder = rec.placeholder
    if (rec.defaultValue !== undefined) variable.defaultValue = rec.defaultValue
    if (Array.isArray(rec.options)) {
      variable.options = rec.options
        .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
        .map(o => ({
          value: typeof o.value === 'string' ? o.value : String(o.value ?? ''),
          label: typeof o.label === 'string' ? o.label : String(o.value ?? ''),
        }))
        .filter(o => o.value.length > 0)
    }
    if (rec.config && typeof rec.config === 'object') {
      variable.config = rec.config as Record<string, unknown>
    }
    out.push(variable)
  }
  return out
}

function buildDefaultState(
  variables: PromptVariable[],
  requiredKeys: string[] = [],
): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const variable of variables) {
    if (variable.defaultValue !== undefined) state[variable.key] = variable.defaultValue
  }
  for (const key of requiredKeys) {
    if (hasValue(state[key])) continue
    const variable = variables.find(v => v.key === key)
    if (!variable) continue
    const value = autoValueForVariable(variable)
    if (hasValue(value)) state[key] = value
  }
  return state
}

export function buildSkillQuickUseGeneratedState(
  quickUse: Pick<ResolvedSkillQuickUse, 'variables' | 'defaultState' | 'requiredKeys'>,
): Record<string, unknown> {
  const state = { ...quickUse.defaultState }
  for (const key of quickUse.requiredKeys) {
    if (hasValue(state[key])) continue
    const variable = quickUse.variables.find(v => v.key === key)
    if (!variable) continue
    const value = autoValueForVariable(variable)
    if (hasValue(value)) state[key] = value
  }
  return state
}

/**
 * 用 {{key}} 模板 + 当前 state 插值出最终自然语言任务描述。空槽位回退默认值。
 */
export function buildSkillQuickUsePrompt(
  template: string,
  variables: PromptVariable[],
  state: Record<string, unknown>,
): string {
  const defaults = buildDefaultState(variables)
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const fromState = valueAsString(state[key])
    if (fromState) return fromState
    return valueAsString(defaults[key])
  })
}

function userPresetId(skillKey: string, presetKey: string): string {
  return `${USER_QUICK_USE_PRESET_PREFIX}${skillKey}#${presetKey}`
}

/**
 * 为 user 来源 skill 注册（或刷新）一个动态 descriptor。模板可能随版本变化，
 * 每次解析都覆盖注册即可（注册表内存态、幂等）。
 */
function registerUserQuickUsePreset(resolved: ResolvedSkillQuickUse): void {
  const { presetId, skillKey, label, promptTemplate, variables, defaultState, requiredKeys } = resolved
  const descriptor: ComposerPresetDescriptor = {
    id: presetId,
    labelKey: label,
    descriptionKey: '从 Skill 详情页自动生成可发送的提示词草稿',
    icon: '✨',
    category: 'skill',
    sessionStrategy: 'current',
    renderer: SKILL_QUICK_USE_PREVIEW_RENDERER,
    promptTemplate,
    variables: withGeneratedDefaults(variables, defaultState),
    canSubmit(state) {
      if (requiredKeys.length === 0) return true
      return requiredKeys.every(key => valueAsString(state[key]).length > 0)
    },
    serializeForSend(state, _uploadedSlots, triggerContext): ComposerPresetBlock {
      const params: Record<string, unknown> = {
        skill_key: skillKey,
        rendered_prompt: buildSkillQuickUsePrompt(promptTemplate, variables, state),
      }
      for (const variable of variables) {
        const val = state[variable.key]
        if (val !== undefined && val !== null && val !== '') params[variable.key] = val
      }
      return {
        type: 'composer_preset',
        preset_id: presetId,
        params,
        ...(triggerContext && Object.keys(triggerContext).length > 0
          ? { trigger_context: triggerContext }
          : {}),
      }
    },
  }
  registerComposerPreset(descriptor)
}

function registerBuiltinQuickUsePreset(resolved: ResolvedSkillQuickUse): void {
  const { presetId, skillKey, label, promptTemplate, variables, defaultState, requiredKeys } = resolved
  const descriptor: ComposerPresetDescriptor = {
    id: presetId,
    labelKey: label,
    descriptionKey: '从内置 App 能力快速生成可微调的任务草稿',
    icon: '✨',
    category: 'skill',
    sessionStrategy: 'current',
    renderer: SKILL_QUICK_USE_PREVIEW_RENDERER,
    promptTemplate,
    variables: withGeneratedDefaults(variables, defaultState),
    canSubmit(state) {
      if (requiredKeys.length === 0) return true
      return requiredKeys.every(key => valueAsString(state[key]).length > 0)
    },
    serializeForSend(state, _uploadedSlots, triggerContext): ComposerPresetBlock {
      const params: Record<string, unknown> = {
        skill_key: skillKey,
        rendered_prompt: buildSkillQuickUsePrompt(promptTemplate, variables, state),
      }
      for (const variable of variables) {
        const val = state[variable.key]
        if (val !== undefined && val !== null && val !== '') params[variable.key] = val
      }
      return {
        type: 'composer_preset',
        preset_id: presetId,
        params,
        ...(triggerContext && Object.keys(triggerContext).length > 0
          ? { trigger_context: triggerContext }
          : {}),
      }
    },
  }
  registerComposerPreset(descriptor)
}

/**
 * 解析某个 skill 的「快速使用」preset 列表。返回 [] = 该 skill 无快速使用。
 *
 * 副作用：user 来源命中时会为每个 preset 注册/刷新动态 composer preset descriptor，
 * 确保后续 ChatInput 卡片渲染与 resolvePresetBlocks 都能按 presetId 查到。
 */
export function resolveSkillQuickUse(skill: SkillIndexEntry): ResolvedSkillQuickUse[] {
  const builtinResolved: ResolvedSkillQuickUse[] = []
  for (const builtin of BUILTIN_QUICK_USE) {
    if (!builtin.match(skill)) continue
    const entry: ResolvedSkillQuickUse = {
        presetId: builtin.presetId,
        skillKey: builtin.skillKey || skill.skill_key || builtin.presetId,
        label: builtin.label,
        promptTemplate: builtin.promptTemplate,
        variables: builtin.variables,
        defaultState: builtin.defaultState,
        requiredKeys: builtin.requiredKeys,
    }
    if (builtin.registerDescriptor !== false) {
      registerBuiltinQuickUsePreset(entry)
    }
    builtinResolved.push(entry)
  }
  if (builtinResolved.length > 0) {
    return builtinResolved
  }

  if (normalizeSkillSource(skill.source) === 'user' && skill.skill_key) {
    const skillKey = skill.skill_key
    const list = Array.isArray(skill.quick_use) ? skill.quick_use : []
    const fallbackName = skill.display_name || skill.name || skill.slug || '快速使用'
    const resolved: ResolvedSkillQuickUse[] = []
    list.forEach((rawUnknown, index) => {
      const raw = rawUnknown as RawQuickUsePreset | null | undefined
      const promptTemplate = typeof raw?.promptTemplate === 'string' ? raw.promptTemplate.trim() : ''
      if (!promptTemplate) return
      const variables = normalizeVariables(raw?.variables)
      const requiredKeys = Array.isArray(raw?.canSubmitKeys)
        ? (raw.canSubmitKeys as unknown[]).filter((k): k is string => typeof k === 'string')
        : variables.slice(0, 1).map(v => v.key)
      const presetKey = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : String(index)
      const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : fallbackName
      const entry: ResolvedSkillQuickUse = {
        presetId: userPresetId(skillKey, presetKey),
        skillKey,
        label,
        promptTemplate,
        variables,
        defaultState: buildDefaultState(variables, requiredKeys),
        requiredKeys,
      }
      registerUserQuickUsePreset(entry)
      resolved.push(entry)
    })
    return resolved
  }

  return []
}

/** 校验单个 quick_use preset 是否可用（编辑器侧用：promptTemplate 必填）。 */
export function isValidQuickUseTemplate(preset: unknown): boolean {
  if (!preset || typeof preset !== 'object') return false
  const template = (preset as RawQuickUsePreset).promptTemplate
  return typeof template === 'string' && template.trim().length > 0
}
