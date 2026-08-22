import { describe, expect, it } from 'vitest'
import { unwrapApprovalPreferences } from '../approval-prefs-envelope'

/**
 * 审批偏好 WS 信封解包回归（SIA-4）。
 *
 * 锁死根因：后端 `build_envelope(..., {"data": preferences})` 使 renderer 收到的
 * 信封为 `{type, payload:{data:preferences}}`，旧 `envelope.data ?? envelope.payload`
 * 取到 `{data:preferences}`（多包一层）→ 喂给 syncFromRemote 的是垃圾 map → 实时同步
 * no-op。这里把"剥 payload.data 拿到扁平 preferences"这条形态钉死。
 */
describe('unwrapApprovalPreferences', () => {
  const prefs = {
    execute_in_terminal: { approved: true, updatedAt: 123 },
    'write_file:src/components': { approved: true, updatedAt: 456 },
  }

  it('WS envelope {type,payload:{data:preferences}} → 剥到扁平 preferences（SIA-4 锁）', () => {
    const env = { type: 'approval_preferences_changed', payload: { data: prefs } }
    expect(unwrapApprovalPreferences(env)).toEqual(prefs)
  })

  it('不多包一层：结果直接含 scopeKey、不含 data 壳', () => {
    const env = { type: 'approval_preferences_changed', payload: { data: prefs } }
    const out = unwrapApprovalPreferences(env)
    expect(out).not.toBeNull()
    expect(out).not.toHaveProperty('data')
    expect(out?.execute_in_terminal).toEqual({ approved: true, updatedAt: 123 })
  })

  it('payload 无 data 包裹 {payload:preferences} → 回退取 payload', () => {
    expect(unwrapApprovalPreferences({ payload: prefs })).toEqual(prefs)
  })

  it('顶层 data {data:preferences} → 回退取 data', () => {
    expect(unwrapApprovalPreferences({ data: prefs })).toEqual(prefs)
  })

  it('空 / 非对象 → null', () => {
    expect(unwrapApprovalPreferences(null)).toBeNull()
    expect(unwrapApprovalPreferences(undefined)).toBeNull()
    expect(unwrapApprovalPreferences('nope')).toBeNull()
    expect(unwrapApprovalPreferences(42)).toBeNull()
  })

  it('payload / data 都缺失 → null（不喂垃圾给 syncFromRemote）', () => {
    expect(unwrapApprovalPreferences({ type: 'approval_preferences_changed' })).toBeNull()
  })
})
