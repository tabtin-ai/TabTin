/**
 *  回归：清空 Agent 目录时 payload 不携带 working_dir_type。
 *
 * 后端 schema 的 working_dir_type 是 Optional[Literal["code","mixed","doc"]]，
 * 空字符串会 422；后端 service 收到 working_dir="" 时联动清空 type。
 */
import { describe, expect, it } from 'vitest'
import { buildWorkingDirUpdatePayload } from '../workingDirPayload'

describe('buildWorkingDirUpdatePayload ', () => {
  it('清空目录（dir="" + type=""）→ payload 不含 working_dir_type 键', () => {
    const payload = buildWorkingDirUpdatePayload('', '')
    expect(payload).toEqual({ working_dir: '' })
    expect('working_dir_type' in payload).toBe(false)
    // JSON 序列化后也不会出现该字段（API 层 JSON.stringify 直传）
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ working_dir: '' })
  })

  it('正常保存（dir + 合法 type）→ 成对携带', () => {
    expect(buildWorkingDirUpdatePayload('/Users/me/dev/proj', 'code')).toEqual({
      working_dir: '/Users/me/dev/proj',
      working_dir_type: 'code',
    })
  })

  it('dir 非空但 type 为空（理论上被 canSave 挡住）→ 仍不携带空串 type', () => {
    const payload = buildWorkingDirUpdatePayload('/Users/me/dev/proj', '')
    expect(payload).toEqual({ working_dir: '/Users/me/dev/proj' })
    expect('working_dir_type' in payload).toBe(false)
  })
})
