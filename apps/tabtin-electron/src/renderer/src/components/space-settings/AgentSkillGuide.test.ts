import { describe, expect, it } from 'vitest'
import { splitSkillGuideCopy } from './AgentSkillGuide'

describe('splitSkillGuideCopy', () => {
  it('拆出能力摘要和「用户提到…时使用」', () => {
    const result = splitSkillGuideCopy(
      '代码项目操作——读写编辑文件、搜索代码。用户提到"读文件""写代码"时使用。',
    )
    expect(result.capability).toBe('代码项目操作——读写编辑文件、搜索代码')
    expect(result.trigger).toBe('用户提到"读文件""写代码"时使用。')
  })

  it('识别「用户要…时激活」并避开描述中间的「用户说」', () => {
    const result = splitSkillGuideCopy(
      '生成办公文件——用户说 ppt 时按 pptx 处理。用户要"导出 Excel"时激活。',
    )
    expect(result.capability).toBe('生成办公文件——用户说 ppt 时按 pptx 处理')
    expect(result.trigger).toBe('用户要"导出 Excel"时激活。')
  })

  it('没有触发句时整段当作能力说明', () => {
    expect(splitSkillGuideCopy('本机发现的能力')).toEqual({
      capability: '本机发现的能力',
      trigger: null,
    })
  })

  it('空描述不编造内容', () => {
    expect(splitSkillGuideCopy('   ')).toEqual({
      capability: '',
      trigger: null,
    })
  })
})
