import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import { TodoEvent } from '../event/events/proposal-events.js'
import { jsonError } from '../capability/core/_utils.js'
import { createAskTools } from './ask-tools.js'
import {
  deriveOpenTodoList,
  type TodoSessionAnchor,
} from '../todo/todo-replay.js'
import { applyTodoAction } from '../todo/todo-state-machine.js'
import type { SkillCredentialResolver, SkillCredentialInjection } from './skill-credential-types.js'
export type { SkillCredentialResolver, SkillCredentialInjection }

// ─── Schemas ─────────────────────────────────────────────────────────

const openTodoItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, description: '唯一标识符。' },
    content: { type: 'string', minLength: 1, description: 'todo 描述。' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'cancelled'],
    },
  },
  required: ['id', 'content', 'status'],
} as const

// action 判别：open 必带 items；其余字段按 action 在 execute 校验（弱模型对 oneOf 支持差）。
const todoInputSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['open', 'add', 'update', 'remove', 'close'],
      description:
        'open=建新列表（必带 items）；add/update/remove=改当前未关闭列表；close=封存当前列表。',
    },
    items: {
      type: 'array',
      description: 'open 必填：初始完整列表（至少 1 项）。',
      items: openTodoItemSchema,
      minItems: 1,
    },
    item: {
      type: 'object',
      description: 'add 必填：新增项（status 仅 pending|in_progress，默认可省略为 pending）。',
      properties: {
        id: { type: 'string', minLength: 1 },
        content: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['pending', 'in_progress'] },
      },
      required: ['id', 'content'],
    },
    id: { type: 'string', description: 'update / remove 必填：目标项 id。' },
    content: { type: 'string', description: 'update 可选：新文案。' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'paused', 'completed', 'cancelled'],
      description: 'update 可选：新状态。阻塞等待时用 paused；completed 项之后不可再改。',
    },
  },
  required: ['action'],
} as unknown as Tool['inputSchema']

// ─── Factory ─────────────────────────────────────────────────────────

export interface CoreToolsDeps {
  emitStreamEvent?: (event: StreamEvent) => void
  /**
   *  / ：与 `buildTodoStateHook` 共用的会话锚。
   * 窗口内 todo 事件被截断后，execute 仍能以锚为种子做 update/close。
   */
  todoSessionAnchor?: TodoSessionAnchor
}

export function createCoreTools(deps: CoreToolsDeps): Tool[] {
  return [
    ...createAskTools(deps),
    createTodoTool(deps),
  ]
}

// ─── todo（ 生命周期 CRUD）─────────────────────────────────────

function createTodoTool(deps: CoreToolsDeps): Tool {
  return {
    name: 'todo',
    policyActionKind: 'object_write',
    // ：Agent 自身任务状态（进度看板），不碰用户资产——judge 对
    // riskLevel='safe' 的 object_write 直接放行，不弹审批。
    riskLevel: 'safe',
    description:
      '管理当前任务的 todo 列表（显式开闭）。' +
      'open 必须带 items[] 创建列表；add/update/remove 只改当前未关闭列表；' +
      '等待用户、授权、登录或外部系统时把当前项更新为 paused；' +
      'completed 项不可再改；全部完成后自动关闭，也可 close 弃单。' +
      '新计划必须先 close 再 open。',
    inputSchema: todoInputSchema,
    isReadOnly: false,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      // ：execute 前当前 tool_use 已在 messages；回放须排除自身，
      // 否则第一次 open 会被当成 already_open。失败 result 由 derive 侧跳过。
      // ：seed = 会话锚（仅窗口内已无 todo 事件时生效，见 derive）。
      const seed = deps.todoSessionAnchor?.current ?? undefined
      const current = deriveOpenTodoList(context.messages ?? [], seed, {
        excludeToolUseIds: context.toolUseId ? [context.toolUseId] : undefined,
      })
      const result = applyTodoAction(current, input)

      if (!result.ok) {
        return jsonError(result.message, {
          error_kind: result.error_kind,
          field: result.field,
          hint: result.hint,
        })
      }

      if (deps.todoSessionAnchor) {
        deps.todoSessionAnchor.current = result.snapshot.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status,
        }))
      }

      const emitter = context.emitStreamEvent ?? deps.emitStreamEvent
      if (emitter) {
        emitter(
          new TodoEvent({
            action: result.action,
            todos: result.snapshot,
            closed: result.closed,
          }).toStreamEvent(),
        )
      }

      const hasPausedItem = result.snapshot.some((t) => t.status === 'paused')
      const nextStepNote = result.closed
        ? ' List is now closed. Open a new list with action=open before planning the next task.'
        : hasPausedItem
          ? ' End the current turn without closing the list. Resume the paused item with status=in_progress when the blocking condition is resolved; pending follow-up items remain open for then.'
          : ' Continue with the current in_progress item if any.'

      return {
        content:
          `Todo ${result.action} succeeded (${result.snapshot.length} item(s), closed=${result.closed}).` +
          nextStepNote,
      }
    },
  }
}
