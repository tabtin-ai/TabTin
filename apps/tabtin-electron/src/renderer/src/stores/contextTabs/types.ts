export type ContextActiveKey = string | null

/**
 * subagent_session tab 的 meta（v3 类型契约）。
 *
 * - parentSessionId：父 chat session ID，过滤可见性 + 解析归档路径必需
 * - parentToolCallId：父对话中触发该子 Agent 的 tool_use.id，反向定位用
 * - label：父 Agent Task.description 生成的简短标签（Tab 标题首选）
 * - task：用户最初下达的任务原文。**不进 persist**（`partialize` 剥离，PRD §4.16 隐私）；
 *   运行时从 SubagentRun 或 IPC 重新拉取，仅供内存中作为 Pane / Tab 标题 fallback
 * - speakerId：关联的 SpeakerIdentity，用于身份徽章渲染
 */
export type SubagentSessionMeta = {
  kind: 'subagent_session'
  parentSessionId: string
  parentToolCallId?: string
  /**
   * 子 Agent 身份名快照（speaker.display_name / run.role / run.label，打开 tab 时算好存入）。
   * tab 标签 + Pane header 优先显示它——这样 run 被 evict（跨重启 / 切 session）后仍能显示
   * 「测试助手」这类名字，而不是回落到 shortid。
   */
  displayName?: string
  label?: string
  task?: string
  speakerId?: string
}

/**
 * Context tab item 的 meta 类型。
 *
 * 设计取舍：保留 `[k: string]: unknown` index signature，让历史调用方（tabcode
 * 的 meta.path、tabwhiteboard 的 currentPageId 等）继续用 `meta?.path` 直接读，
 * 同时通过可选 `kind` 字段做 discriminant——`type === 'subagent_session'` 的
 * 消费方可 `cast as SubagentSessionMeta` 拿到精确字段（外加 `kind === 'subagent_session'`
 * runtime 校验）。
 *
 * 未来逐步迁移其他 type 到 typed 形态后，可改为 discriminated union。
 */
export type ContextItemMeta = {
  kind?: string
  [k: string]: unknown
}

export type ContextItemRecord = {
  tabKey: string
  type: string
  id: string
  title?: string
  meta?: ContextItemMeta
  /** replaceTabKey 保留的原始 tabKey，用于稳定 React key */
  originTabKey?: string
}

export type OpenResourceTabParams = {
  type: string
  id: string
  title?: string
  meta?: ContextItemMeta | SubagentSessionMeta
  /**
   * 静默打开：仅写 tabOrder + items，**不**切 active / 不写 displayKey。
   *
   * 典型场景（PRD 决策 13）：聚合视图首次 drill-in 后，同 session 再点其他行
   * 不抢焦点——避免一波派多个子 Agent 时焦点疯狂跳。
   *
   * 关键约束（PRD §4.14）：tabKey 已存在（dedup 命中）时 `silent: true` 也
   * **不**改 active；调用方必须依赖此契约。
   */
  silent?: boolean
}
