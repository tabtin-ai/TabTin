/**
 * subagentPreviewMocks — ChatComponentPreview 专用 mock 数据
 */

import type { SpeakerIdentity } from '@tabtin/agent-wire'
import type { SubagentRun } from '../../../stores/chat/shared/types'

export const PREVIEW_SESSION_ID = 'preview-session-001'
export const PREVIEW_RUN_ID = 'run-preview-001'
export const PREVIEW_RUN_ERROR_ID = 'run-preview-error'

const NOW = Date.now()

export const MOCK_TOOL_HISTORY = [
  {
    tool_name: 'code_grep',
    tool_call_id: 'tc-1',
    success: true,
    elapsed_ms: 120,
    input_summary: 'pattern: SubagentProgressCard',
    output_summary: '8 matches',
    input_detail: '{"pattern":"SubagentProgressCard","path":"apps/tabtin-electron"}',
    output_detail: 'SubagentProgressCard.tsx:365\nSubagentAggregateView.tsx:475',
  },
  {
    tool_name: 'file_read',
    tool_call_id: 'tc-2',
    success: true,
    elapsed_ms: 45,
    input_summary: 'SubagentProgressCard.tsx',
    output_summary: '836 lines',
  },
  {
    tool_name: 'bash',
    tool_call_id: 'tc-3',
    success: false,
    elapsed_ms: 2100,
    input_summary: 'pnpm test SubagentProgressCard',
    error: 'Command failed',
    input_detail: '{"command":"pnpm test SubagentProgressCard"}',
    output_detail: 'FAIL  1 test failed',
  },
] as const

export const MOCK_AGGREGATE_RUNS: SubagentRun[] = [
  {
    subagentRunId: 'run-4f2a0001',
    status: 'running',
    label: '分析昨天销售',
    task: '分析昨天销售数据并输出 Top 10 SKU',
    speakerId: 'spk-analyst',
    startedAt: NOW - 72_000,
    stepCount: 3,
    latestTool: 'file_read',
    latestToolInput: 'data/sales_2026-05-28.csv',
    latestToolStatus: 'pending',
  },
  {
    subagentRunId: 'run-8c910002',
    status: 'running',
    label: '查竞品 X',
    task: '搜索竞品 X 的最新定价策略',
    speakerId: 'spk-researcher',
    startedAt: NOW - 23_000,
    stepCount: 1,
    latestTool: 'web_search',
    latestToolInput: 'competitor X pricing 2026',
    latestToolStatus: 'completed',
  },
  {
    subagentRunId: 'run-2d010003',
    status: 'queued',
    label: '生成季度汇总',
    task: '生成 Q1 季度汇总报告',
    speakerId: 'spk-analyst',
  },
  {
    subagentRunId: 'run-6e100004',
    status: 'completed',
    label: '查竞品 Y',
    task: '搜索竞品 Y 的功能对比',
    speakerId: 'spk-researcher',
    stats: { duration_ms: 32_000 },
    stepCount: 4,
  },
  {
    subagentRunId: 'run-af330005',
    status: 'failed',
    label: '查竞品 Z',
    task: '搜索竞品 Z 的 API 文档',
    speakerId: 'spk-researcher',
    error: 'timeout',
    errorKind: 'timeout',
    timeoutMs: 300_000,
    stats: { duration_ms: 18_000 },
    stepCount: 2,
    latestTool: 'web_fetch',
  },
]

/** 2 个均完成——对齐 dogfood 截图「2 个任务 · 2 完成」的常见简单场景 */
export const MOCK_AGGREGATE_RUNS_TWO_DONE: SubagentRun[] = [
  {
    subagentRunId: 'run-two-001',
    status: 'completed',
    label: '子任务 1：回答 1',
    task: '验证子 Agent dogfood 回答 1',
    speakerId: 'spk-analyst',
    stats: { duration_ms: 3_500 },
    stepCount: 2,
  },
  {
    subagentRunId: 'run-two-002',
    status: 'completed',
    label: '子任务 2：回答 2',
    task: '验证子 Agent dogfood 回答 2',
    speakerId: 'spk-researcher',
    stats: { duration_ms: 5_400 },
    stepCount: 3,
  },
]

export const MOCK_AGGREGATE_RUNS_ALL_DONE: SubagentRun[] = [
  {
    subagentRunId: 'run-done-001',
    status: 'completed',
    label: '代码审查',
    stats: { duration_ms: 12_000 },
  },
  {
    subagentRunId: 'run-done-002',
    status: 'completed',
    label: '文档润色',
    stats: { duration_ms: 8_500 },
  },
  {
    subagentRunId: 'run-done-003',
    status: 'cancelled',
    label: '已取消任务',
    stats: { duration_ms: 2_100 },
  },
]

export const MOCK_DRAWER_MESSAGES = [
  {
    role: 'user',
    content: [{ type: 'text', text: '分析 src/components/chat 下的子 Agent 相关组件' }],
  },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先 glob 找文件，再读关键组件…' },
      { type: 'tool_use', name: 'code_glob', input: { glob_pattern: '**/Subagent*.tsx' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'SubagentProgressCard.tsx\nSubagentAggregateView.tsx' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '找到 3 个核心组件：ProgressCard、AggregateView、DetailDrawer。' }],
  },
]

export const MOCK_DRAWER_SNAPSHOTS = [
  {
    system: 'You are a code exploration sub-agent…',
    messages: [{ role: 'user', content: '分析 chat 组件' }],
    tools: [{ name: 'code_glob' }, { name: 'file_read' }],
  },
  {
    system: 'You are a code exploration sub-agent…',
    messages: [
      { role: 'user', content: '分析 chat 组件' },
      { role: 'assistant', content: '找到 3 个核心组件' },
    ],
    tools: [{ name: 'code_glob' }, { name: 'file_read' }],
  },
]

export const MOCK_DRAWER_EVENTS = [
  { type: 'SUBAGENT_STARTED', ts: NOW - 60_000, payload: { label: '代码探索' } },
  { type: 'SUBAGENT_PROGRESS', ts: NOW - 45_000, payload: { step_count: 1, latest_tool: 'code_glob' } },
  { type: 'SUBAGENT_PROGRESS', ts: NOW - 30_000, payload: { step_count: 2, latest_tool: 'file_read' } },
  { type: 'SUBAGENT_COMPLETED', ts: NOW - 5_000, payload: { summary: '找到 3 个核心组件' } },
]

function mockSpeaker(
  speakerId: string,
  displayName: string,
  displayColor: string,
  overrides: Partial<SpeakerIdentity> = {},
): SpeakerIdentity {
  return {
    speaker_id: speakerId,
    kind: 'sub_agent',
    display_name: displayName,
    display_color: displayColor,
    display_short_id: speakerId.slice(0, 4),
    status: 'running',
    started_at: NOW,
    ...overrides,
  }
}

export const MOCK_SPEAKERS: Record<string, Record<string, SpeakerIdentity>> = {
  [PREVIEW_SESSION_ID]: {
    [PREVIEW_RUN_ID]: mockSpeaker(PREVIEW_RUN_ID, '代码审查员', '#6366f1', {
      source: 'template',
      template_id: 'code-reviewer-v2',
      model: 'claude-4-sonnet',
    }),
    'spk-analyst': mockSpeaker('spk-analyst', '数据分析员', '#0ea5e9', {
      source: 'template',
      template_id: 'data-analyst',
      model: 'claude-4-sonnet',
    }),
    'spk-researcher': mockSpeaker('spk-researcher', '研究员', '#10b981', {
      source: 'inherit',
      inherit_mode: 'filtered',
      model: 'gpt-5-mini',
    }),
    'run-4f2a0001': mockSpeaker('run-4f2a0001', '数据分析员', '#0ea5e9'),
    'run-8c910002': mockSpeaker('run-8c910002', '研究员', '#10b981'),
  },
}
