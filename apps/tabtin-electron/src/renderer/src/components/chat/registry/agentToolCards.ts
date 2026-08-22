/**
 * Agent 工具（思考、子 Agent、提问、待办、技能、RAG、记忆、日程、终止）
 */

import type { ToolCardDescriptor } from '@tabtin/chat-client'
import i18n from '@/i18n'
import { truncate, getNestedArgs } from './toolCardUtils'

export const AGENT_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  /* ── 子 Agent ─── */
  task: { id: 'subagent', category: 'tool', labelKey: 'chat.card.subagent', icon: 'Bot', riskLevel: 'strict', defaultCollapsed: false, renderer: 'SubagentProgressCard' },
  Task: { id: 'subagent', category: 'tool', labelKey: 'chat.card.subagent', icon: 'Bot', riskLevel: 'strict', defaultCollapsed: false, renderer: 'SubagentProgressCard' },
  agent: { id: 'subagent', category: 'tool', labelKey: 'chat.card.subagent', icon: 'Bot', riskLevel: 'strict', defaultCollapsed: false, renderer: 'SubagentProgressCard' },

  /* ── 提问 ─── */
  // W4 R3 (2026-05-11)：ask 三件套并存——ask_user（多选问答 HITL）+ ask_form
  // （多字段填表）+ request_approval（已决方案审批，必带 risk_level；UI 强警示）。
  // 三个 entry 共享 id 'ask_user'（统一卡片 id），但分别按工具名索引、各自的
  // labelKey 和 compactSummary。
  ask_user: {
    id: 'ask_user', category: 'tool', labelKey: 'chat.card.ask_user', icon: 'HelpCircle',
    riskLevel: 'safe', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      if (!args) return null
      const questions = args.questions as Array<{ prompt?: string }> | undefined
      if (!questions?.length) return args.title ? String(args.title) : null
      if (questions.length === 1) return truncate(String(questions[0]?.prompt ?? ''), 50)
      return i18n.t('chat:card.questionsCount', { count: questions.length, defaultValue: '{{count}} questions' })
    },
  },
  ask_form: {
    id: 'ask_user', category: 'tool', labelKey: 'chat.card.ask_form', icon: 'HelpCircle',
    riskLevel: 'safe', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      return args?.title ? truncate(String(args.title), 50) : null
    },
  },
  // W4 R3 修正：HEAD 写为 'safe' 是漏改——request_approval 是用户审批高风险动作
  // 的入口（删数据 / 不可逆 / 跨账号写），UI 必须高警示等级，对齐 ApprovalPanel。
  request_approval: {
    id: 'ask_user', category: 'tool', labelKey: 'chat.card.request_approval', icon: 'HelpCircle',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      return args?.title ? truncate(String(args.title), 50) : null
    },
  },

  /* ── 待办 ─── */
  todo: { id: 'todo', category: 'tool', labelKey: 'chat.card.todo', icon: 'CheckCircle2', riskLevel: 'safe', defaultCollapsed: false, renderer: 'TodoCard' },
  TodoRead: { id: 'todo', category: 'tool', labelKey: 'chat.card.todo', icon: 'CheckCircle2', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },

  /* ── 技能 / RAG ─── */
  'skills_read': { id: 'skills', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Search', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  'skills_search': { id: 'skills', category: 'tool', labelKey: 'chat.card.generic_tool', icon: 'Search', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },
  rag_search: { id: 'rag_search', category: 'tool', labelKey: 'chat.card.code_search', icon: 'Search', riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard' },

  /* ── 记忆 ─── */
  memory_write: {
    id: 'memory', category: 'tool', labelKey: 'chat.card.memory_write', icon: 'NotebookPen',
    riskLevel: 'safe', defaultCollapsed: false, renderer: 'MemoryCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.title ?? args?.key ? truncate(String(args.title ?? args.key), 40) : null },
  },
  memory_search: {
    id: 'memory', category: 'tool', labelKey: 'chat.card.memory_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: false, renderer: 'MemoryCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.query ?? args?.keyword ? truncate(String(args.query ?? args.keyword), 40) : null },
  },
  memory_delete: {
    id: 'memory', category: 'tool', labelKey: 'chat.card.memory_delete', icon: 'Trash2',
    riskLevel: 'review', defaultCollapsed: false, renderer: 'MemoryCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.memory_id ?? args?.key ? truncate(String(args.memory_id ?? args.key), 20) : null },
  },

  /*
   * TabTracker / TabAgenda FC 卡片注册项已删除（Tracker 模块收敛波次 1，2026-05-20）：
   * 方案 B 决议把 FC 工具实现整体下线，Agent 通过 `tabtin tracker` CLI（即
   * `run_terminal_command`）调用 Tracker 域能力；LLM 不会再产出
   * `create_tracked_task` / `trigger_task` / `list_tracked_tasks` / `query_agenda`
   * 等 tool_call，因此对应卡片注册项删除是清理死代码。
   *
   * 如未来重新为 Tracker 启用 FC 工具，需同时：
   *   1. 在 apps/tabtin_django/apps/services/tools/domains/tabtracker/ 重新实现
   *   2. 在 ToolHub 注册（更新 test_tool_contract_cleanup forbidden 列表）
   *   3. 在此重新注册渲染卡片
   *
   * 历史卡片渲染器 `GoalPreviewCard.tsx` 已一并删除（FC 工具下线后无人能再
   * 产出对应的 tool_call）。如需在 Chat 流中回放旧 session 的 tracker 工具卡，
   * 会自动 fallback 到 `GenericToolCard`，行为可接受。
   */
}
