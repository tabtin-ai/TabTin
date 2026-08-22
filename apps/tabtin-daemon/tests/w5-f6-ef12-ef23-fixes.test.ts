/**
 * Regression tests for W5-F6 fixes:
 *
 * EF-12 (P2): emitAuditLog in policy-intercept path must include executionPath='policy'
 * EF-23 (P2): _truncated alias field added to ActionResultSchema (Python side, verified via source)
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ACTION_BRIDGE_PATH = path.resolve(__dirname, '../src/application/execution/action-bridge.ts')
const DJANGO_SCHEMA_PATH = path.resolve(
  __dirname,
  '../../tabtin_django/apps/services/agent_engine/api/action_api.py',
)
const DJANGO_HANDLER_PATH = path.resolve(
  __dirname,
  '../../tabtin_django/apps/services/common/ws/handlers/action.py',
)

// ────────────────────────────────────────────────────────────────────────────
// EF-12: emitAuditLog in policy-intercept path
// ────────────────────────────────────────────────────────────────────────────

describe('EF-12 — emitAuditLog executionPath in policy-intercept path', () => {
  const source = fs.readFileSync(ACTION_BRIDGE_PATH, 'utf-8')

  it("policy-intercept emitAuditLog call passes 'policy' as executionPath", () => {
    // policyResult 分支中必须传 'policy'
    const policyBlock = source.match(
      /policyResult[\s\S]{0,400}?emitAuditLog\([^)]+\)/,
    )
    expect(policyBlock).not.toBeNull()
    expect(policyBlock![0]).toContain("'policy'")
  })

  it("emitAuditLog signature includes 'policy' in executionPath union type", () => {
    expect(source).toContain("'adapter' | 'legacy' | 'policy'")
  })

  it('normal execution path still passes executionPath (not undefined)', () => {
    // 正常路径仍然传 executionPath 变量
    expect(source).toContain('this.emitAuditLog(actionType, params, result, threadId, traceId, executionPath)')
  })

  it('policy-intercept path does NOT call emitAuditLog without executionPath arg', () => {
    // 确保策略拦截路径中没有只传5个参数的 emitAuditLog 调用
    const lines = source.split('\n')
    const policyBlockStart = lines.findIndex(l => l.includes('policyResult'))
    const policyBlockEnd = lines.findIndex((l, i) => i > policyBlockStart && l.includes('return;') && i < policyBlockStart + 10)

    const policyBlock = lines.slice(policyBlockStart, policyBlockEnd + 1).join('\n')
    // 如果有 emitAuditLog 调用，必须包含 'policy'
    if (policyBlock.includes('emitAuditLog')) {
      expect(policyBlock).toContain("'policy'")
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// EF-23: _truncated field in Django ActionResultSchema (source-level check)
// ────────────────────────────────────────────────────────────────────────────

describe('EF-23 — _truncated field in Django ActionResultSchema', () => {
  const schemaSource = fs.readFileSync(DJANGO_SCHEMA_PATH, 'utf-8')
  const handlerSource = fs.readFileSync(DJANGO_HANDLER_PATH, 'utf-8')

  it("ActionResultSchema imports Field from pydantic", () => {
    expect(schemaSource).toMatch(/from pydantic import Field/)
  })

  it("ActionResultSchema declares truncated field with alias '_truncated'", () => {
    expect(schemaSource).toMatch(/truncated.*Field\(.*alias=['"]_truncated['"]\)/)
  })

  it("WS handler passes _truncated through to result_data", () => {
    expect(handlerSource).toContain("result_data['_truncated'] = data.truncated")
  })

  it("WS handler checks truncated with 'is not None' guard", () => {
    expect(handlerSource).toContain('data.truncated is not None')
  })
})
