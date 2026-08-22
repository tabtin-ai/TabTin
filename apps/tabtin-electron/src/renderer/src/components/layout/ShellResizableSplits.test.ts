import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LayoutConstraints } from '@/constants/layout'
import {
  SHELL_CONVERSATION_CANVAS_MIN_WIDTH,
  SHELL_SECONDARY_CANVAS_RAIL_MAX_WIDTH,
  SHELL_SECONDARY_RAIL_MAX_WIDTH,
  SHELL_WORKBENCH_MIN_WIDTH,
  buildShellWorkspaceSecondaryRailMaxWidth,
  resolveEnteringChatPrimaryWidth,
  resolvePrimaryFlipTransition,
} from './ShellResizableSplits'

describe('ShellResizableSplits workbench width constraints', () => {
  it('右侧画布可以紧凑显示，但不能把中间聊天区压到参考最小宽度以下', () => {
    expect(SHELL_CONVERSATION_CANVAS_MIN_WIDTH).toBeLessThan(LayoutConstraints.chatSidePanel.minWidth)
    expect(SHELL_WORKBENCH_MIN_WIDTH).toBeLessThan(LayoutConstraints.chatSidePanel.minWidth)
    expect(LayoutConstraints.chatSidePanel.minWidth).toBe(435)
    expect(SHELL_SECONDARY_RAIL_MAX_WIDTH).toBe(
      `min(${LayoutConstraints.chatSidePanel.maxWidth}px, calc(100% - ${SHELL_WORKBENCH_MIN_WIDTH}px))`,
    )
    // 右侧应用/画布辅位只保留对话区最小宽，不设硬性像素上限
    expect(SHELL_SECONDARY_CANVAS_RAIL_MAX_WIDTH).toBe(
      `calc(100% - ${LayoutConstraints.chatSidePanel.minWidth}px)`,
    )
  })

  it('统一卡片辅位 maxWidth：聊天辅位保留硬上限，画布辅位仅扣主位最小宽', () => {
    expect(buildShellWorkspaceSecondaryRailMaxWidth(SHELL_WORKBENCH_MIN_WIDTH)).toBe(
      `min(${LayoutConstraints.chatSidePanel.maxWidth}px, calc(100% - ${SHELL_WORKBENCH_MIN_WIDTH + 4}px))`,
    )
    expect(buildShellWorkspaceSecondaryRailMaxWidth(LayoutConstraints.chatSidePanel.minWidth, null)).toBe(
      `calc(100% - ${LayoutConstraints.chatSidePanel.minWidth + 4}px)`,
    )
  })
})

describe('ShellSpaceWorkspaceSplit collapsed canvas rail', () => {
  it('支持固定宽度收起栏辅位（无拖拽、可覆盖 minWidth）', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    expect(source).toContain('secondaryResizable')
    expect(source).toContain('secondaryRailMinWidthOverride')
    expect(source).toContain('resolvedSecondaryRailMaxWidth')
    // 退出过渡期间 secondary prop 已空，手柄只在 liveSecondary 时出现。
    expect(source).toContain('liveSecondary && secondaryResizable')
  })
})

describe('ShellSpaceWorkspaceSplit task header placement', () => {
  it('任务顶栏包在对话列 wrapper 内，不再全宽压在 primary+secondary 外层', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    expect(source).toContain('wrapShellChatColumnWithHeader')
    expect(source).toContain('attachHeaderToPrimary')
    expect(source).toContain('attachHeaderToSecondary')
    expect(source).not.toMatch(
      /const mainRow = \(\s*<div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">\s*\{header\}/,
    )
  })

  it('视图切换保持原绝对定位，并把真实宽度暴露给标题栏动态避让', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    expect(source).toContain('viewModeSwitch?: React.ReactNode')
    expect(source).toContain('data-testid="task-view-mode-switch-overlay"')
    expect(source).toContain('absolute right-4 top-0 z-banner')
    expect(source).toContain('useScopedResizeObserver(viewModeSwitchElement')
    expect(source).toContain("'--task-view-mode-switch-width'")
  })
})

describe('ShellSpaceWorkspaceSplit secondary width transition', () => {
  it('辅位有↔无复用 morph 时长/缓动，拖拽时禁用 transition，并暴露最终宽给 ghost', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    expect(source).toContain('MORPH_DURATION_MS')
    expect(source).toContain('MORPH_EASING')
    expect(source).toContain('data-shell-secondary-rail')
    expect(source).toContain('data-morph-final-width')
    expect(source).toContain('setExitSecondary')
    expect(source).toContain('setEnterColumnWidth')
    // 拖拽跟手：secondaryDragWidth !== null 时不得开 width transition
    expect(source).toMatch(
      /secondaryDragWidth\s*===\s*null\s*&&\s*!prefersShellReducedMotion\(\)/,
    )
    expect(source).toContain('SECONDARY_WIDTH_TRANSITION_FALLBACK_MS')
  })

  it('辅位入场保留 maxWidth，避免把主位对话列挤窄后再弹回', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    // 旧实现：secondaryWidthAnimating 时 maxWidth=undefined（入场会碾主位）
    expect(source).not.toMatch(
      /maxWidth:\s*secondaryWidthAnimating\s*\?\s*undefined\s*:\s*resolvedSecondaryRailMaxWidth/,
    )
    // 仅出场（收到 0）时放开上限；入场始终受 resolvedSecondaryRailMaxWidth 约束
    expect(source).toMatch(
      /maxWidth:\s*isExitingSecondary\s*\?\s*undefined\s*:\s*resolvedSecondaryRailMaxWidth/,
    )
  })
})

describe('ShellSpaceWorkspaceSplit sidebar content collapse ', () => {
  it('支持只折叠第二列内容栏，保留窄栏、主区 card fill 与侧栏宿主保活', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    expect(source).toContain('sidebarContentCollapsed')
    expect(source).toMatch(/sidebarContentCollapsed\s*\?/)
    // 折叠时主区仍走带 surface-canvas-card-fill 的 ShellSidebarPrimaryCard 路径
    expect(source).toContain('SHELL_WORKSPACE_MAIN_FILL_CLASS')
    expect(source).toContain('ShellSidebarPrimaryCard')
    // 第二列宿主保活，避免 StableSlot / portal host 因折叠卸载
    expect(source).toMatch(/sidebarContentCollapsed[\s\S]*?aria-hidden[\s\S]*?\{sidebar\}/)
    // 保活树不可继续参与键盘焦点与辅助技术导航。
    expect(source).toMatch(/sidebarContentCollapsed[\s\S]*?aria-hidden[\s\S]*?inert[\s\S]*?\{sidebar\}/)
  })
})

describe('ShellColResizeHandle stacking', () => {
  it('列分割手柄使用 z-sticky，不得抬到 dropdown/modal 浮层层级', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    const handleDecl = source.match(
      /function ShellColResizeHandle[\s\S]*?className=\{cn\(\s*([\s\S]*?),\s*edge ===/,
    )?.[1]
    expect(handleDecl).toBeTruthy()
    // 只看 className 字符串字面量，避免注释里提到旧 token 误伤。
    const classLiterals = [...(handleDecl?.matchAll(/'([^']+)'/g) ?? [])].map((m) => m[1]).join(' ')
    expect(classLiterals).toContain('z-sticky')
    expect(classLiterals).not.toMatch(/z-(dropdown|modal|toast|global|overlay)/)
  })
})

describe('resolvePrimaryFlipTransition', () => {
  const chatNode = 'chat-primary'
  const base = {
    presenceMounted: true,
    reduced: false,
    dragging: false,
    rowWidth: 1200,
    prevSecondary: 'canvas' as unknown,
    lastLiveSecondaryWidth: 400,
    nextSecondary: 'canvas' as unknown,
    displaySecondaryWidth: 400,
    secondaryResizable: true,
    exitPrimaryActive: false,
    enterPrimaryActive: false,
  }

  it('只在 flipIsCanvas 边沿翻转，忽略布局 primaryIsCanvas 误伤路径', () => {
    const none = resolvePrimaryFlipTransition({
      ...base,
      snapshot: { flipIsCanvas: false, primaryContent: chatNode },
      flipIsCanvas: false,
    })
    expect(none.flipped).toBe(false)

    const toApp = resolvePrimaryFlipTransition({
      ...base,
      snapshot: { flipIsCanvas: false, primaryContent: chatNode },
      flipIsCanvas: true,
    })
    expect(toApp.flipped).toBe(true)
    expect(toApp.exit?.width).toBe(800)
    expect(toApp.enter).toBeNull()
  })

  it('app-focus→split 播 enter；→chat-focus（折叠 rail / 无辅位）瞬切', () => {
    const toSplit = resolvePrimaryFlipTransition({
      ...base,
      snapshot: { flipIsCanvas: true, primaryContent: 'canvas' },
      flipIsCanvas: false,
      secondaryResizable: true,
    })
    expect(toSplit.enter?.contentWidth).toBe(resolveEnteringChatPrimaryWidth(1200, 400))
    expect(toSplit.enter?.width).toBe(0)

    const toChatFocusRail = resolvePrimaryFlipTransition({
      ...base,
      snapshot: { flipIsCanvas: true, primaryContent: 'canvas' },
      flipIsCanvas: false,
      nextSecondary: 'collapsed-rail',
      secondaryResizable: false,
    })
    expect(toChatFocusRail.flipped).toBe(true)
    expect(toChatFocusRail.enter).toBeNull()

    const toChatFocusEmpty = resolvePrimaryFlipTransition({
      ...base,
      snapshot: { flipIsCanvas: true, primaryContent: 'canvas' },
      flipIsCanvas: false,
      nextSecondary: null,
    })
    expect(toChatFocusEmpty.enter).toBeNull()
  })

  it('rowWidth=0 时 flipped 但无 exit/enter，供调用方落入辅位进出场', () => {
    const result = resolvePrimaryFlipTransition({
      ...base,
      snapshot: { flipIsCanvas: false, primaryContent: chatNode },
      flipIsCanvas: true,
      rowWidth: 0,
    })
    expect(result.flipped).toBe(true)
    expect(result.exit).toBeNull()
    expect(result.enter).toBeNull()
  })
})

describe('ShellSpaceWorkspaceSplit primary flip guards', () => {
  it('flip 门控用 taskViewMode/flipIsCanvas，rAF 不进 effect cleanup，fallback 覆盖起点卡住', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ShellResizableSplits.tsx'),
      'utf8',
    )
    expect(source).toContain('taskViewMode?: TaskViewMode | null')
    expect(source).toContain('flipIsCanvas')
    expect(source).toContain('schedulePrimaryFlipRaf')
    expect(source).toContain('primaryFlipRafRef')
    // deps 不得列入 exitPrimary / enterPrimary
    expect(source).toMatch(
      /cancelPrimaryFlipRaf,[\s\S]*?secondary,[\s\S]*?flipIsCanvas,[\s\S]*?secondaryResizable,[\s\S]*?schedulePrimaryFlipRaf,[\s\S]*?usesStableTaskCanvas,[\s\S]*?\]\)/,
    )
    // 起点卡住也要清：不得再要求 width===0 / width!==0 才武装 fallback
    expect(source).not.toMatch(/if \(!exitPrimary \|\| exitPrimary\.width !== 0\) return/)
    expect(source).not.toMatch(/if \(!enterPrimary \|\| enterPrimary\.width === 0\) return/)
  })
})
