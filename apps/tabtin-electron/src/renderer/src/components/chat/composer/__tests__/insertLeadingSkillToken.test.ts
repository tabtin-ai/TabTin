import { describe, expect, it } from 'vitest'
import type { SkillSlashCommandOption } from '../../skill/skillSlashCommand'
import { insertLeadingSkillToken } from '../insertLeadingSkillToken'

function option(token: string, key: string): SkillSlashCommandOption {
  return {
    kind: 'skill',
    token,
    slug: token.slice(1),
    canonicalKey: key,
    label: key,
    description: '',
    skill: { skill_id: key, skill_key: key } as SkillSlashCommandOption['skill'],
  }
}

const research = option('/research', 'device:research')
const review = option('/review', 'device:review')
const options = [research, review]

describe('insertLeadingSkillToken', () => {
  it('为空输入插入 leading token', () => {
    expect(insertLeadingSkillToken('', research, options)).toEqual({
      value: '/research ',
      cursor: 10,
    })
  })

  it('把普通正文保留为 Skill 参数', () => {
    expect(insertLeadingSkillToken('分析这份报告', research, options).value)
      .toBe('/research 分析这份报告')
  })

  it('替换已有可识别的 leading Skill token 并保留参数', () => {
    expect(insertLeadingSkillToken('/review  分析这份报告', research, options).value)
      .toBe('/research 分析这份报告')
  })

  it('不把正文中间的 slash 当 leading token', () => {
    expect(insertLeadingSkillToken('请用 /review 检查', research, options).value)
      .toBe('/research 请用 /review 检查')
  })
})
