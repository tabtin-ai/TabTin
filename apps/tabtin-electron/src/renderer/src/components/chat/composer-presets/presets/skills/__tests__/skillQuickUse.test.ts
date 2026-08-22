import { describe, expect, it } from 'vitest'
import {
  buildSkillQuickUseGeneratedState,
  buildSkillQuickUsePrompt,
  isValidQuickUseTemplate,
  resolveSkillQuickUse,
} from '../skillQuickUse'
import { getComposerPreset } from '../../../registry/composerPresetRegistry'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import type { SkillIndexEntry } from '@/skills/types'

function entry(partial: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: 'sk',
    name: 'n',
    source: 'user',
    ...partial,
  } as SkillIndexEntry
}

describe('buildSkillQuickUsePrompt', () => {
  it('插值 {{key}} 槽位，缺省回退默认值', () => {
    const out = buildSkillQuickUsePrompt(
      '画一个 {{subject}}，风格 {{style}}',
      [
        { key: 'subject', type: 'input' },
        { key: 'style', type: 'select', defaultValue: '简洁' },
      ],
      { subject: '飞轮' },
    )
    expect(out).toBe('画一个 飞轮，风格 简洁')
  })
})

describe('resolveSkillQuickUse', () => {
  it('builtin tabtin-widget 命中代码注册表（按 skill_key），返回单项列表', () => {
    const resolved = resolveSkillQuickUse(entry({
      source: 'platform',
      skill_key: 'platform:visualization/tabtin-widget',
    }))
    expect(resolved).toHaveLength(1)
    expect(resolved[0].presetId).toBe('skill.tabtinWidget.quickUse')
  })

  it('builtin tabtin-widget 命中（按 slug 兜底）', () => {
    const resolved = resolveSkillQuickUse(entry({
      source: 'platform',
      skill_key: 'platform:something-else',
      slug: 'tabtin-widget',
    }))
    expect(resolved[0]?.presetId).toBe('skill.tabtinWidget.quickUse')
  })

  it('builtin 主打 App skills：文档 / 多维表 / 浏览器 / 自动化各暴露多条 quick use', () => {
    const tabdoc = resolveSkillQuickUse(entry({
      source: 'app',
      app_id: 'tabdoc',
      slug: 'tabdoc-operator',
      skill_key: 'app:tabdoc/tabdoc-operator',
    }))
    const tabdata = resolveSkillQuickUse(entry({
      source: 'app',
      app_id: 'tabdata',
      slug: 'table-modeling',
      skill_key: 'app:tabdata/table-modeling',
    }))
    const tabweb = resolveSkillQuickUse(entry({
      source: 'app',
      app_id: 'tabweb',
      slug: 'browser-operator',
      skill_key: 'app:tabweb/browser-operator',
    }))
    const tabtracker = resolveSkillQuickUse(entry({
      source: 'app',
      app_id: 'tabtracker',
      slug: 'tabtracker',
      skill_key: 'app:tabtracker/tabtracker',
    }))

    expect(tabdoc.map(item => item.presetId)).toEqual([
      'skill.tabdoc.quickUse.createDraft',
      'skill.tabdoc.quickUse.organizeConversation',
      'skill.tabdoc.quickUse.findAndSummarize',
    ])
    expect(tabdata.map(item => item.presetId)).toEqual([
      'skill.tabdata.quickUse.designTable',
      'skill.tabdata.quickUse.analyzeTable',
      'skill.tabdata.quickUse.importData',
    ])
    expect(tabweb.map(item => item.presetId)).toEqual([
      'skill.tabweb.quickUse.summarizePage',
      'skill.tabweb.quickUse.extractToTable',
      'skill.tabweb.quickUse.comparePages',
    ])
    expect(tabtracker.map(item => item.presetId)).toEqual([
      'skill.tabtracker.quickUse.createScheduled',
      'skill.tabtracker.quickUse.reviewRuns',
      'skill.tabtracker.quickUse.dryRun',
    ])

    const descriptor = getComposerPreset('skill.tabdoc.quickUse.createDraft')
    expect(descriptor?.renderer).toBe('skillQuickUsePreview')
    expect(descriptor?.canSubmit?.({ subject: '项目复盘' })).toBe(true)
    const block = descriptor!.serializeForSend!(
      {
        subject: '项目复盘',
        docType: '项目复盘',
        source: '当前对话',
        focus: '结论和待办',
      },
      {},
      undefined,
    )
    expect(block.params.skill_key).toBe('app:tabdoc/tabdoc-operator')
    expect(block.params.rendered_prompt).toContain('项目复盘')
    expect(block.params.rendered_prompt).toContain('可点击的 TabDoc 链接')

    const expectedSkillKeys: Record<string, string> = {
      'skill.tabdoc.quickUse.createDraft': 'app:tabdoc/tabdoc-operator',
      'skill.tabdoc.quickUse.organizeConversation': 'app:tabdoc/tabdoc-operator',
      'skill.tabdoc.quickUse.findAndSummarize': 'app:tabdoc/tabdoc-operator',
      'skill.tabdata.quickUse.designTable': 'app:tabdata/table-modeling',
      'skill.tabdata.quickUse.analyzeTable': 'app:tabdata/table-query',
      'skill.tabdata.quickUse.importData': 'app:tabdata/table-import-export',
      'skill.tabweb.quickUse.summarizePage': 'app:tabweb/browser-operator',
      'skill.tabweb.quickUse.extractToTable': 'app:tabweb/browser-operator',
      'skill.tabweb.quickUse.comparePages': 'app:tabweb/browser-operator',
      'skill.tabtracker.quickUse.createScheduled': 'app:tabtracker/tabtracker',
      'skill.tabtracker.quickUse.reviewRuns': 'app:tabtracker/tabtracker',
      'skill.tabtracker.quickUse.dryRun': 'app:tabtracker/tabtracker',
    }
    for (const item of [...tabdoc, ...tabdata, ...tabweb, ...tabtracker]) {
      const desc = getComposerPreset(item.presetId)
      const state = buildSkillQuickUseGeneratedState(item)
      const serialized = desc!.serializeForSend!(state, {}, undefined)
      const stateText = Object.values(state).map(String).join('\n')
      expect(item.label).toMatch(/天气|上海/)
      expect(stateText).not.toMatch(/当前上下文|当前页面|当前浏览器|当前对话|当前工作内容|当前讨论/)
      expect(desc?.renderer).toBe('skillQuickUsePreview')
      expect(desc?.canSubmit?.(state)).toBe(true)
      expect(serialized.params.skill_key).toBe(expectedSkillKeys[item.presetId])
      expect(serialized.params.rendered_prompt).toContain(String(Object.values(state)[0]))
    }

    const extractToTableDescriptor = getComposerPreset('skill.tabweb.quickUse.extractToTable')
    const extractToTableBlock = extractToTableDescriptor!.serializeForSend!(
      {
        target: 'https://pitchhub.36kr.com/projects?sort=3',
        fields: '项目名称、项目 ID、轮次、地区',
        strategy: '先找 API，再退回页面解析',
      },
      {},
      undefined,
    )
    const prompt = String(extractToTableBlock.params.rendered_prompt)
    expect(prompt).toContain('先根据我的目标、页面标题/域名和采集字段判断一个清晰表名')
    expect(prompt).toContain('tabtin browser tab list --format json')
    expect(prompt).toContain('tabtin browser network')
    expect(prompt).toContain('写入 TabData 表')
    // 已下线的高层命令不应再出现在预设提示里。
    expect(prompt).not.toContain('collect table')
  })

  it('TabData 设计表预设明确区分空表与真实填数，并约束完成口径', () => {
    const [quickUse] = resolveSkillQuickUse(entry({
      source: 'app',
      app_id: 'tabdata',
      slug: 'table-modeling',
      skill_key: 'app:tabdata/table-modeling',
    })).filter(item => item.presetId === 'skill.tabdata.quickUse.designTable')
    const descriptor = getComposerPreset(quickUse.presetId)

    expect(quickUse.defaultState.deliveryScope).toBe('只创建表结构，不填业务数据')
    expect(quickUse.requiredKeys).toContain('deliveryScope')

    const structureBlock = descriptor!.serializeForSend!(
      {
        subject: '客户名单',
        dataShape: '先按常见字段建一个可用版本',
        relationNeed: '只要一张表',
        deliveryScope: '只创建表结构，不填业务数据',
      },
      {},
      undefined,
    )
    const structurePrompt = String(structureBlock.params.rendered_prompt)
    expect(structurePrompt).toContain('交付范围：只创建表结构，不填业务数据')
    expect(structurePrompt).toContain('明确说明这是空表、本次写入 0 条')
    expect(structurePrompt).toContain('来源没有的值留空，不得估算或编造')
    expect(structurePrompt).toContain('dry-run 只算预览')

    const dataBlock = descriptor!.serializeForSend!(
      {
        subject: '商品资料',
        dataShape: '我已有字段清单',
        relationNeed: '只要一张表',
        deliveryScope: '创建表结构，并填入真实数据',
      },
      {},
      undefined,
    )
    const dataPrompt = String(dataBlock.params.rendered_prompt)
    expect(dataPrompt).toContain('交付范围：创建表结构，并填入真实数据')
    expect(dataPrompt).toContain('必须完成真实写入并报告成功条数、数据来源和留空字段')
  })

  it('TabData 导入预设要求按真实回执汇报，缺失字段不得补合理估值', () => {
    const [quickUse] = resolveSkillQuickUse(entry({
      source: 'app',
      app_id: 'tabdata',
      slug: 'table-import-export',
      skill_key: 'app:tabdata/table-import-export',
    })).filter(item => item.presetId === 'skill.tabdata.quickUse.importData')
    const descriptor = getComposerPreset(quickUse.presetId)
    const block = descriptor!.serializeForSend!(
      {
        source: '一批公开网页',
        fields: '名称、价格、联系方式',
        strategy: '先建一个扁平表，后续再扩展',
      },
      {},
      undefined,
    )
    const prompt = String(block.params.rendered_prompt)

    expect(prompt).toContain('来源没有的值留空，不得用看似合理的估算补齐')
    expect(prompt).toContain('dry-run 或导入预览不算完成')
    expect(prompt).toContain('成功条数、失败条数、来源和留空字段')
    expect(prompt).toContain('保留来源链接和获取时间')
  })

  it('user 来源：读 quick_use 列表 → 每项动态注册 descriptor，serializeForSend 产出 rendered_prompt', () => {
    const resolved = resolveSkillQuickUse(entry({
      source: 'user',
      skill_key: 'user:doc-writer',
      display_name: 'Doc Writer',
      quick_use: [
        {
          id: 'doc',
          label: '写文档',
          promptTemplate: '写一份 {{topic}} 文档',
          variables: [{ key: 'topic', type: 'input', label: '主题' }],
          canSubmitKeys: ['topic'],
        },
        {
          id: 'outline',
          label: '列大纲',
          promptTemplate: '给 {{topic}} 列个大纲',
          variables: [{ key: 'topic', type: 'input' }],
        },
      ],
    }))
    expect(resolved).toHaveLength(2)
    expect(resolved[0].presetId).toBe('skill.quickUse.user:user:doc-writer#doc')
    expect(resolved[0].label).toBe('写文档')
    expect(resolved[1].presetId).toBe('skill.quickUse.user:user:doc-writer#outline')

    // 动态注册后，注册表里能按 presetId 查到（卡片渲染 + resolvePresetBlocks 共用）。
    const descriptor = getComposerPreset(resolved[0].presetId)
    expect(descriptor).not.toBeNull()
    expect(descriptor!.canSubmit?.({})).toBe(false)
    expect(descriptor!.canSubmit?.({ topic: '季度复盘' })).toBe(true)

    const block = descriptor!.serializeForSend!({ topic: '季度复盘' }, {}, undefined)
    expect(block.type).toBe('composer_preset')
    expect(block.params.skill_key).toBe('user:doc-writer')
    expect(block.params.rendered_prompt).toBe('写一份 季度复盘 文档')
  })

  it('user 来源：裸 addPreset 不传 initialState 时，也带天气示例默认值', () => {
    const resolved = resolveSkillQuickUse(entry({
      source: 'user',
      skill_key: 'user:auto-store-default',
      quick_use: [{
        id: 'doc',
        label: '写文档',
        promptTemplate: '写一份 {{topic}} 文档',
        variables: [{ key: 'topic', type: 'input', label: '主题' }],
        canSubmitKeys: ['topic'],
      }],
    }))
    const descriptor = getComposerPreset(resolved[0].presetId)
    const scopeId = '__test__:quick-use-auto-default'
    const store = useComposerPresetStore.getState()

    store.clearAllPresets(scopeId)
    store.addPreset(scopeId, resolved[0].presetId)

    const [instance] = store.getPresets(scopeId)
    expect(instance.state.topic).toBe('上海近一周天气变化')
    expect(descriptor?.canSubmit?.(instance.state)).toBe(true)

    store.clearAllPresets(scopeId)
  })

  it('空模板项被跳过；缺 id 时按序号生成 presetId', () => {
    const resolved = resolveSkillQuickUse(entry({
      source: 'user',
      skill_key: 'user:mixed',
      quick_use: [
        { label: '空', promptTemplate: '  ' },
        { label: '有效', promptTemplate: '做 {{x}}', variables: [{ key: 'x', type: 'input' }] },
      ],
    }))
    expect(resolved).toHaveLength(1)
    expect(resolved[0].presetId).toBe('skill.quickUse.user:user:mixed#1')
  })

  it('user 来源缺 quick_use → 返回空列表', () => {
    expect(resolveSkillQuickUse(entry({ source: 'user', skill_key: 'user:x' }))).toEqual([])
    expect(resolveSkillQuickUse(entry({
      source: 'user',
      skill_key: 'user:y',
      quick_use: [{ label: 'x', promptTemplate: '  ' }],
    }))).toEqual([])
  })
})

describe('isValidQuickUseTemplate', () => {
  it('promptTemplate 非空才有效', () => {
    expect(isValidQuickUseTemplate({ promptTemplate: 'x' })).toBe(true)
    expect(isValidQuickUseTemplate({ promptTemplate: '' })).toBe(false)
    expect(isValidQuickUseTemplate(null)).toBe(false)
    expect(isValidQuickUseTemplate({})).toBe(false)
  })
})
