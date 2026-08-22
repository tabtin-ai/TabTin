/**
 * 字段映射配置
 * 基于 docs/crawlspace/devlogs/SDG_FIELD.md
 */

export interface FieldConfig {
  label: string // 中文标签
  description: string // 详细说明（hover 显示）
  category?: string // 字段分类
}

/**
 * 字段映射表
 * 格式：{ 字段英文名: { label: "中文名", description: "详细说明" } }
 */
export const FIELD_LABELS: Record<string, FieldConfig> = {
  // 1️⃣ 基础信息
  thread_id: {
    label: '会话 ID',
    description: '一次 SDG 任务的唯一标识。用于断点续跑、回放、WS 订阅。',
    category: '基础信息',
  },
  user_id: {
    label: '用户 ID',
    description: '发起任务的用户标识，用于权限隔离。',
    category: '基础信息',
  },
  url: {
    label: '目标网址',
    description: '当前分析的页面 URL。',
    category: '基础信息',
  },
  mode: {
    label: '运行模式',
    description: 'flash=极速模式（列表+翻页）；deep=深度模式（列表+翻页+详情页）。',
    category: '基础信息',
  },
  model_id: {
    label: '模型 ID',
    description: '运行时指定的 LLM 模型 UUID。',
    category: '基础信息',
  },
  user_intent: {
    label: '用户意图',
    description: '用户自然语言目标。为空表示全自动识别。',
    category: '基础信息',
  },

  // 2️⃣ 页面输入与快照
  skeleton: {
    label: '页面骨架',
    description: 'cleanhtml 后的页面快照，供 LLM 解析。包含 HTML、URL、标题等。',
    category: '页面快照',
  },
  'skeleton.html': {
    label: '页面 HTML',
    description: '清洗后的 HTML 字符串（可能很长）。',
    category: '页面快照',
  },
  'skeleton.url': {
    label: '页面 URL',
    description: '采样时的页面地址。',
    category: '页面快照',
  },
  'skeleton.title': {
    label: '页面标题',
    description: 'HTML <title> 或前端采集的标题。',
    category: '页面快照',
  },
  page_diff: {
    label: '页面差异',
    description: '前端滚动/操作后的 DOM 差异检测结果，用于判断是否有滚动加载。',
    category: '页面快照',
  },

  // 3️⃣ 运行状态与进度
  status: {
    label: '运行状态',
    description:
      '核心状态字段：running（运行中）、waiting_for_input（等待输入）、completed（已完成）、error（失败）。',
    category: '运行状态',
  },
  pause_reason: {
    label: '暂停原因',
    description:
      '等待输入时的具体原因：select_region（选择区域）、detail_samples（采集详情样本）、confirm_schema（确认 schema）。',
    category: '运行状态',
  },
  next: {
    label: 'Agent 路由',
    description:
      'Agent 内部路由字段：coordinator（继续执行）、null（暂停）、END（结束）。仅供调试使用。',
    category: '运行状态',
  },
  user_visible_phase: {
    label: '当前阶段',
    description:
      '用户可见的执行阶段：initializing（初始化）、identifying_region（识别区域）、analyzing_fields（分析字段）等。',
    category: '运行状态',
  },
  user_visible_progress: {
    label: '进度详情',
    description: '实时进度文案，如"正在分析字段结构（已识别 5 个字段）..."',
    category: '运行状态',
  },
  error: {
    label: '错误信息',
    description: '任务失败时的错误描述。',
    category: '运行状态',
  },
  last_error_type: {
    label: '错误类型',
    description: '错误分类：llm_failure、parse_error、network_error、timeout、user_cancelled 等。',
    category: '运行状态',
  },
  retry_count: {
    label: '重试次数',
    description: '当前阶段累计重试次数。',
    category: '运行状态',
  },

  // 4️⃣ 任务队列
  todo_list: {
    label: '任务队列',
    description: 'SDG 执行计划，包含待办任务列表及其状态、依赖关系。',
    category: '任务队列',
  },

  // 5️⃣ 核心业务数据
  schema: {
    label: '采集规则',
    description: '最终产出的 TabtinSchema，包含站点信息、抽取规则、字段定义、翻页策略等。',
    category: '核心数据',
  },
  'schema.metadata': {
    label: '元数据',
    description: 'Schema 基本信息（ID、版本、创建者、状态等）。',
    category: '核心数据',
  },
  'schema.site': {
    label: '站点信息',
    description: '站点名称、域名、base_url 等。',
    category: '核心数据',
  },
  'schema.extraction': {
    label: '抽取规则',
    description: '核心：列表选择器、字段定义、翻页策略、详情页规则。',
    category: '核心数据',
  },
  candidate_regions: {
    label: '候选区域',
    description: 'identify_region 阶段产出的候选列表区域，包含选择器、描述、置信度等。',
    category: '核心数据',
  },
  selected_region_id: {
    label: '选中区域 ID',
    description: '用户选择或系统自动选择的区域 ID。',
    category: '核心数据',
  },
  detail_samples: {
    label: '详情页样本',
    description: 'DeepMode 专用，采集的详情页 HTML 样本列表。',
    category: '核心数据',
  },
  detail_link_selector: {
    label: '详情页链接选择器',
    description: 'DeepMode 专用，详情页入口的 CSS 选择器。',
    category: '核心数据',
  },
  detail_samples_collected: {
    label: '详情样本已采集',
    description: 'DeepMode 专用，标记详情页样本是否采集完成。',
    category: '核心数据',
  },
  schema_validation: {
    label: '校验结果',
    description: '最终质检结果，包含是否通过、错误列表、警告、质量指标等。',
    category: '核心数据',
  },
  pre_actions_detected: {
    label: '页面前置动作已检测',
    description: '标记页面级前置动作检测是否完成（如关闭弹窗、展开折叠等）。',
    category: '核心数据',
  },
  field_pre_actions_detected: {
    label: '字段前置动作已检测',
    description: '标记字段级前置动作检测是否完成（如 hover 显示价格等）。',
    category: '核心数据',
  },

  // 通用字段（可能出现在多个地方）
  name: {
    label: '名称',
    description: '字段或对象的名称。',
  },
  type: {
    label: '类型',
    description: '字段类型或数据类型。',
  },
  selector: {
    label: '选择器',
    description: 'CSS 选择器，用于定位页面元素。',
  },
  description: {
    label: '描述',
    description: '详细说明或描述文本。',
  },
  confidence: {
    label: '置信度',
    description: '0-1 之间的置信度评分，越高表示越可靠。',
  },
  title: {
    label: '标题',
    description: '页面或内容的标题。',
  },
  content: {
    label: '内容',
    description: '文本内容或数据内容。',
  },
  html: {
    label: 'HTML',
    description: 'HTML 内容字符串。',
  },
  result: {
    label: '结果',
    description: '执行结果或输出数据。',
  },
  messages: {
    label: '消息列表',
    description: 'LLM 对话消息列表，包含 user、system、assistant 角色的消息。',
  },
  model: {
    label: '模型',
    description: 'LLM 模型名称或标识。',
  },
  params: {
    label: '参数',
    description: 'LLM 调用参数，如 temperature、max_tokens 等。',
  },
  usage: {
    label: 'Token 用量',
    description: 'LLM Token 使用统计，包含 prompt_tokens、completion_tokens、total_tokens。',
  },
  decision: {
    label: '决策',
    description: 'Coordinator 节点的决策结果。',
  },
  args: {
    label: '参数',
    description: '函数或工具调用的参数。',
  },
  metadata: {
    label: '元数据',
    description: '附加的元数据信息。',
  },
}

/**
 * 获取字段的中文标签
 * @param fieldKey 字段英文名
 * @returns 中文标签（如果没有配置则返回原字段名）
 */
export function getFieldLabel(fieldKey: string): string {
  const config = FIELD_LABELS[fieldKey]
  return config?.label || fieldKey
}

/**
 * 获取字段的详细说明
 * @param fieldKey 字段英文名
 * @returns 详细说明（如果没有配置则返回空字符串）
 */
export function getFieldDescription(fieldKey: string): string {
  const config = FIELD_LABELS[fieldKey]
  return config?.description || ''
}

/**
 * 检查字段是否有说明
 * @param fieldKey 字段英文名
 * @returns 是否有详细说明
 */
export function hasFieldDescription(fieldKey: string): boolean {
  const config = FIELD_LABELS[fieldKey]
  return !!config?.description
}
