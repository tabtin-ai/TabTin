/**
 * TS-18 设备路径修复：Electron forward 路径「双 id 模型」契约单测。
 *
 * 与 Daemon 侧 `apps/tabtin-daemon/tests/daemon-prompt-forward-validation.test.ts` 一致
 * 的「routes prompt.forward with task id for runtime and chat session id for
 * relay_events」用例 —— 断言同一条 wire envelope 在 Electron forward 路径上：
 *   1. relay 用真实 ChatSession UUID（从 `thread_id` 剥 `chat-session-` 前缀），
 *      **不是** task_id；
 *   2. done 事件透传前注入 `task_id`；
 *   3. IPC 路径（无 relaySessionId / taskId）行为不受影响。
 *
 * 测试形态（与本目录 `w7c-dispatcher-and-hitl.test.ts` 同款双轨）：
 *   - 行为单测：直接 import 纯函数 `deriveRelaySessionId`（抽到
 *     `conversation-identity.ts`，避免拉起 `ElectronAgentHost.ts` 的 main-process
 *     side effect）；
 *   - 源码契约：对 `ElectronAgentHost.ts` 关键 wiring 做 token 断言，让未来
 *     重构若拆掉 `relaySessionId ?? sessionId` / done 注入 / IPC fallback
 *     立刻被拦下。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  deriveRelaySessionId,
} from '../src/conversation/conversation-identity.js'

describe('TS-18 deriveRelaySessionId (Daemon-parity 纯函数)', () => {
  it('剥 chat-session- 前缀得真实 ChatSession UUID（relay 归属校验用）', () => {
    expect(deriveRelaySessionId('chat-session-session-123')).toBe('session-123')
    expect(
      deriveRelaySessionId('chat-session-3fa85f64-5717-4562-b3fc-2c963f66afa6'),
    ).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6')
  })

  it('task_id（prompt_xxxx）不带前缀 → undefined（绝不把 task_id 当 relay session）', () => {
    // 这是 H1 的核心：传 task_id 给 relay_events 会让 Django
    // `_verify_session_in_organizations` 的 `ChatSession.objects.filter(id=...)`
    // 失败 → 整批 relay PERMISSION_DENIED。
    expect(deriveRelaySessionId('prompt_abc123')).toBeUndefined()
  })

  it('缺省 / 空串 / 仅前缀 / 非字符串 → undefined（回落 sessionId，兼容 IPC 路径）', () => {
    expect(deriveRelaySessionId('')).toBeUndefined()
    expect(deriveRelaySessionId('chat-session-')).toBeUndefined()
    expect(deriveRelaySessionId(undefined)).toBeUndefined()
    expect(deriveRelaySessionId(null)).toBeUndefined()
    // @ts-expect-error 故意传非字符串，验证防御
    expect(deriveRelaySessionId(42)).toBeUndefined()
  })
})

describe('TS-18 ElectronAgentHost forward 路径双 id wiring（源码契约）', () => {
  const agentDir = resolve(
    __dirname,
    '..',
    '..',
    '..',
    'apps',
    'tabtin-electron',
    'src',
    'main',
    'agent',
  )
  const src = readFileSync(resolve(agentDir, 'ElectronAgentHost.ts'), 'utf-8')
  const typesSrc = readFileSync(resolve(agentDir, 'electron-agent-types.ts'), 'utf-8')
  const runtimeSrc = readFileSync(
    resolve(agentDir, 'runtime', 'electron-runtime-assembly.ts'),
    'utf-8',
  )
  const ingressSrc = readFileSync(
    resolve(__dirname, '..', 'src', 'conversation', 'forward-request-decoder.ts'),
    'utf-8',
  )

  it('QueryRequest 类型新增 relaySessionId? / taskId?（对照 DaemonQueryRequest）', () => {
    expect(typesSrc).toMatch(/relaySessionId\?\s*:\s*string/)
    expect(typesSrc).toMatch(/taskId\?\s*:\s*string/)
    expect(typesSrc).toMatch(/businessThreadId\?\s*:\s*string/)
    expect(typesSrc).toMatch(/organizationId\?\s*:\s*string/)
  })

  it('parse 函数只保留稳定会话 threadId 与单轮 taskId', () => {
    const fnStart = ingressSrc.indexOf('function decodeForwardRequest')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = ingressSrc.slice(fnStart, fnStart + 9000)
    expect(fnBody).toMatch(/deriveRelaySessionId\(envelope\.thread_id\)/)
    expect(fnBody).toMatch(/\btaskId\b/)
    expect(fnBody).toMatch(/const threadId\s*=\s*deriveRelaySessionId\(envelope\.thread_id\)\s*\?\?\s*taskId/)
    expect(fnBody).not.toMatch(/businessThreadId/)
    // relay_events 发送必须拿到本轮 forward 的 Organization 上下文。
    // wire schema 未定义 organization_id，共享 decoder 从 typed `payload`
    // 读取（wire schema 若未来正式登记此字段则直接生效；当前 wire 不含则
    // Legacy Django 通过 passthrough 透传亦兼容）。
    expect(fnBody).toMatch(/organization_id/)
  })

  it('runtime 装配用 businessThreadId ?? sessionId 作为跨端 HITL thread', () => {
    expect(runtimeSrc).toMatch(/const runtimeThreadId\s*=\s*businessThreadId\s*\?\?\s*sessionId/)
    expect(runtimeSrc).toMatch(/threadId:\s*runtimeThreadId/)
  })

  it('relay conversation id = relaySessionId ?? identity.conversationId（勿回落 prompt_*）', () => {
    expect(src).toMatch(/relaySessionId:\s*request\.relaySessionId/)
    const pipelineSrc = readFileSync(
      resolve(__dirname, '../src/conversation/query-turn-pipeline.ts'),
      'utf8',
    )
    expect(pipelineSrc).toMatch(
      /query\.turn\.relaySessionId\s*\?\?\s*query\.identity\.conversationId/,
    )
    expect(pipelineSrc).not.toMatch(
      /query\.turn\.relaySessionId\s*\?\?\s*query\.identity\.sessionId\b/,
    )
  })

  it('relay transport 用本轮 organizationId 兜底且缺 token 不静默丢事件', () => {
    // 迁移后：organizationIdOf 兜底 request.organizationId ?? getCLIOrganizationId()，
    // DeliveryTransportPort.sendRelayBatch 缺 token 抛错（交 buffer 重试/outbox）。
    expect(src).toMatch(/request\.organizationId\s*\?\?\s*getCLIOrganizationId\(\)/)
    expect(src).toMatch(/throw new Error\('relay_events missing access token'\)/)
  })

  it('done 事件透传前注入 task_id（cutover 后经 DeliveryCoordinator 终态屏障）', () => {
    // Electron mapToHostQuery 把 request.taskId 交给 HostQuery.turn；注入逻辑在
    // agent-host DeliveryCoordinator（openTurn 的 taskId → done payload.task_id）。
    expect(src).toMatch(/taskId:\s*request\.taskId/)

    const coordinatorSrc = readFileSync(
      resolve(__dirname, '../src/delivery/delivery-coordinator.ts'),
      'utf8',
    )
    expect(coordinatorSrc).toMatch(/agent\.stream\.done/)
    expect(coordinatorSrc).toMatch(/task_id/)
  })
})
