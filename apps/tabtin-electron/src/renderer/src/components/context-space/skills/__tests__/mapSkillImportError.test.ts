import { describe, expect, it } from 'vitest'
import { mapSkillImportError } from '../mapSkillImportError'

const t = (key: string, options?: Record<string, unknown>) =>
  String(options?.defaultValue ?? key)

describe('mapSkillImportError', () => {
  it('maps missing SKILL.md / frontmatter / name / size / HTTP errors to human copy', () => {
    expect(mapSkillImportError('未找到 SKILL.md', t)).toContain('SKILL.md')
    expect(mapSkillImportError('SKILL.md frontmatter 缺少 name', t)).toContain('说明信息')
    expect(mapSkillImportError('name 必须是 kebab-case', t)).toContain('weekly-report')
    expect(mapSkillImportError('bundle too large over 20MB', t)).toContain('20MB')
    expect(mapSkillImportError('下载被上游服务限流 HTTP 429', t)).toContain('限流')
    expect(mapSkillImportError('HTTP 404 Not Found while downloading', t)).toContain('链接')
    expect(mapSkillImportError('Skills API error: 400 Bad Request', t)).toContain('导入失败')
  })

  it('maps request timeout / socket hang up to network copy (not fake format errors)', () => {
    expect(mapSkillImportError('Request timeout', t)).toContain('超时')
    expect(mapSkillImportError(new Error('Network error: socket hang up'), t)).toContain('网络')
    expect(mapSkillImportError('Request absolute timeout (90s)', t)).toContain('超时')
    expect(mapSkillImportError('从 GitHub 拉取 Skill 失败（网络中断）。源：x', t)).toContain('网络')
  })

  it('maps invalid npm / GitHub title paste errors ', () => {
    expect(mapSkillImportError('「GitHub」不是有效的 Skill 源。请填写仓库路径', t)).toContain('Skill 源')
    expect(mapSkillImportError("Failed to clone GitHub: fatal: repository 'GitHub' does not exist", t)).toContain('Skill 源')
  })

  it('keeps Chinese backend messages that are already human-readable', () => {
    expect(mapSkillImportError('组织不存在或无权访问', t)).toBe('组织不存在或无权访问')
  })
})
