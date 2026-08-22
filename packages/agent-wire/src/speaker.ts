/**
 * SpeakerIdentity — 子 Agent 与多 Agent 协调中的"说话者"身份标识。
 *
 * SSoT 在 agent-wire；Python / Swift / Kotlin 各端镜像此定义。
 *
 * PRD 06 §5.1.2 / §4.7 约定：命名用 `speaker_id`（不叫 `sender_sub_id` /
 * `subagent_id`），定义域涵盖 user / main_agent / sub_agent / peer_agent
 * （二期保留）。
 */

/**
 * 说话者类型。
 * - `peer_agent`：一期 schema 预留但 runtime 不产出；
 *   Python / Swift / Kotlin 各端 enum 一期必须包含。
 */
export type SpeakerKind = 'user' | 'main_agent' | 'sub_agent' | 'peer_agent';

/**
 * 子 Agent 从父对话继承上下文的方式。
 *
 * - `full`：父完整 messages 深拷贝
 * - `filtered`（默认）：剔除 tool_use / tool_result / reasoning
 * - `summary`：父历史压缩成 summary
 * - `none`：只 task prompt
 *
 * 值域必须与 `prompt.ts::InheritModeSchema`（Zod enum）保持同步；
 * 后者是 runtime 校验的 SSoT，本处提供编译期类型约束。
 */
export type InheritMode = 'full' | 'filtered' | 'summary' | 'none';

/**
 * 说话者身份（完整快照），附在每条 stream event 和消息气泡上。
 *
 * 字段集覆盖 PRD 06 §5.1.2 所有维度；消费端可按需使用子集。
 * `display_name` 生成规则见 PRD 06 §5.1.2 命名规则（模板名 · short_id · task_hint）。
 */
export interface SpeakerIdentity {
  /** 全局唯一 speaker 标识（UUID） */
  speaker_id: string;
  kind: SpeakerKind;

  /** 父会话 ID（子 Agent 填写） */
  parent_session_id?: string;
  /** 父 thread ID（子 Agent 填写） */
  parent_thread_id?: string;

  /** 创建路径（template / inherit / blank） */
  source?: 'template' | 'inherit' | 'blank';
  /** 关联的模板 ID（source='template' 时必填） */
  template_id?: string;
  /** 引用式版本快照号 */
  template_version?: number;
  /**
   * 关联模板的显示名（source='template' 时填）。协作视图「源自模板 · {name}」
   * badge 直接展示它；缺省（非模板派发）时不展示 badge。与 `role`（可被主 Agent
   * 覆盖的 UI 标签）正交——`template_name` 恒为模板本名。
   */
  template_name?: string;
  /** 继承模式（source='inherit' 时有意义） */
  inherit_mode?: InheritMode;

  /** 人类可读名（"数据分析员 · 4f2a · 分析昨天销售异"） */
  display_name: string;
  /**
   * Mission 编排角色名（主 Agent 派发时经 `agent` 工具 `role` 参数显式指定，
   * 如「科普撰稿人」）。与 `display_name`（任务派生）正交——协作视图的 chip
   * 优先展示 `role` 作为子 Agent 身份，任务细节归 modal。缺省（非 group 派发 /
   * 主 Agent 未填）时消费端回落 `display_name` / label。
   */
  role?: string;
  /** 显示用颜色（hex 值） */
  display_color?: string;
  /** speaker_id 前 4 位 */
  display_short_id: string;

  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';
  /** Unix epoch ms */
  started_at: number;
  /** Unix epoch ms */
  ended_at?: number;

  /** 使用的模型 ID */
  model?: string;
  /** 可用工具列表 */
  tools?: string[];
  /** 最大迭代轮数 */
  max_turns?: number;
}
