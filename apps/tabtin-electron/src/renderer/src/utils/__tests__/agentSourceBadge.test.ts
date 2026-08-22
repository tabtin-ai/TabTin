import { describe, expect, it } from 'vitest'
import {
  resolveAgentSourceBadge,
  SYSTEM_DEFAULT_PROVISION_SOURCE,
} from '../agentSourceBadge'

const LABELS = {
  defaultBadge: '默认',
  customBadge: '自建',
  templateBadgeFallback: '模板',
}

const systemDefaultSettings = {
  provision_source: SYSTEM_DEFAULT_PROVISION_SOURCE,
}

describe('resolveAgentSourceBadge ', () => {
  it('列表：系统默认 Agent 显示「默认」而非「自建」', () => {
    expect(
      resolveAgentSourceBadge(
        { is_default: true, template_id: '', settings: systemDefaultSettings },
        LABELS,
      ),
    ).toBe('默认')
  })

  it('列表：历史误标 is_default、无 system provenance 时显示「自建」', () => {
    expect(
      resolveAgentSourceBadge(
        { is_default: true, template_id: '', settings: {} },
        LABELS,
      ),
    ).toBe('自建')
  })

  it('详情：系统默认无模板时不返回来源文案（避免与默认角标重复）', () => {
    expect(
      resolveAgentSourceBadge(
        { is_default: true, template_id: '', settings: systemDefaultSettings },
        LABELS,
        null,
        'detail',
      ),
    ).toBeNull()
  })

  it('详情：系统默认有模板时只显示模板名', () => {
    expect(
      resolveAgentSourceBadge(
        {
          is_default: true,
          template_id: 'code-engineer',
          settings: systemDefaultSettings,
        },
        LABELS,
        '代码工程师',
        'detail',
      ),
    ).toBe('代码工程师')
  })

  it('非默认空白自建显示「自建」', () => {
    expect(
      resolveAgentSourceBadge({ is_default: false, template_id: '' }, LABELS),
    ).toBe('自建')
  })

  it('非默认模板实例显示模板名', () => {
    expect(
      resolveAgentSourceBadge(
        { is_default: false, template_id: 'code-engineer' },
        LABELS,
        '代码工程师',
      ),
    ).toBe('代码工程师')
  })

  it('模板名已出现在分身名称中时不重复展示小灰字', () => {
    expect(
      resolveAgentSourceBadge(
        { is_default: false, template_id: 'web-researcher' },
        LABELS,
        '冲浪版',
        'list',
        '冲浪版',
      ),
    ).toBeNull()
    expect(
      resolveAgentSourceBadge(
        { is_default: false, template_id: 'web-researcher' },
        LABELS,
        '冲浪版',
        'list',
        'user_3017冲浪版',
      ),
    ).toBeNull()
  })

  it('用户改成不含角色名的新名字时保留模板来源', () => {
    expect(
      resolveAgentSourceBadge(
        { is_default: false, template_id: 'web-researcher' },
        LABELS,
        '冲浪版',
        'list',
        '资料侦察员',
      ),
    ).toBe('冲浪版')
  })
})
