import { describe, expect, it } from 'vitest'
import { getCollapsedToolLabel, isCompleteToolInput } from '../../tool/toolCollapsedLabel'

describe('tool collapsed label stability during partial JSON streaming', () => {
  it('被中断的 finalized block 不得被当作完整参数', () => {
    expect(isCompleteToolInput(true, true)).toBe(false)
    expect(isCompleteToolInput(true, false)).toBe(true)
  })

  it('参数流式生成时始终显示工具名，不消费不完整 description', () => {
    expect(getCollapsedToolLabel({
      input: { description: '检查 git 状' },
      inputFinalized: false,
      compactSummary: 'git status',
      fallbackLabel: '终端',
    })).toBe('终端')
  })

  it('参数封口后优先显示完整 description，避免 path basename 分段跳变', () => {
    expect(getCollapsedToolLabel({
      input: {
        description: '读取工具卡实现',
        path: '/Users/user/PycharmProjects/TabTin/apps/tabtin-electron/src/ToolStepCard.tsx',
      },
      inputFinalized: true,
      compactSummary: 'ToolStepCard.tsx',
      fallbackLabel: '读取文件',
    })).toBe('读取工具卡实现')
  })

  it('runtime intent 优先于旧 description，避免同一卡片两处意图不一致', () => {
    expect(getCollapsedToolLabel({
      input: { description: '旧参数描述' },
      inputFinalized: true,
      compactSummary: 'git status --short',
      intent: '检查工作区状态',
      fallbackLabel: '终端',
    })).toBe('检查工作区状态')
  })
})
