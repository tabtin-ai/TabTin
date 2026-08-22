import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appLayoutSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'AppLayout.tsx'),
  'utf8',
)

describe('AppLayout sidebar collapse workspace shell ', () => {
  it('已登录态一律走 ShellSpaceWorkspaceSplit，不再保留 legacy ShellSidebarMainSplit', () => {
    expect(appLayoutSource).toContain('const useUnifiedWorkspaceShell = isAuthenticated')
    expect(appLayoutSource).not.toContain('ShellSidebarMainSplit')
    expect(appLayoutSource).toMatch(
      /isAuthenticated \?\s*\(\s*<ShellSpaceWorkspaceSplit/,
    )
  })

  it('进入正式会话时不再从 conversation:draft 拷贝标签', () => {
    expect(appLayoutSource).not.toMatch(
      /ensureScopeInitializedFromLegacy\(\s*workspaceContext\.key,\s*`conversation:draft:\$\{workspaceContext\.executionSpaceId\}`/,
    )
    expect(appLayoutSource).toMatch(
      /workspaceContext\.kind !== ['"]desktop['"]/,
    )
  })

  it('关闭最后一个标签不自动切换到 chat-focus', () => {
    expect(appLayoutSource).not.toContain('shouldAutoCollapseEmptyCanvas')
    expect(appLayoutSource).not.toContain('canvasCloseRevision')
  })

  it('折叠侧栏时仍走 ShellSpaceWorkspaceSplit，并传入 sidebarContentCollapsed', () => {
    expect(appLayoutSource).toContain('sidebarContentCollapsed={effectiveSidebarCollapsed}')
    expect(appLayoutSource).toContain('header={taskHeaderNode}')
    expect(appLayoutSource).not.toMatch(
      /effectiveSidebarCollapsed[\s\S]{0,120}ShellActivityRailShell/,
    )
  })

  it('展开/折叠侧栏投影不读写 task view mode', () => {
    const collapseRelated = appLayoutSource.match(
      /effectiveSidebarCollapsed[\s\S]{0,200}/g,
    ) ?? []
    expect(collapseRelated.length).toBeGreaterThan(0)
    for (const snippet of collapseRelated) {
      expect(snippet).not.toMatch(/setTaskViewMode|taskViewMode\s*=/)
    }
    expect(appLayoutSource).not.toMatch(
      /sidebarCollapsed[\s\S]{0,80}setTaskViewMode/,
    )
  })

  it('任务三态期间不在聊天列并行停放 contentPortalHost（跨域白屏护栏）', () => {
    expect(appLayoutSource).toContain('parkContentPortalInChatColumn')
    expect(appLayoutSource).toContain('taskLayoutState.effectiveTaskViewMode == null')
    expect(appLayoutSource).toContain('owner="shell-content-canvas"')
  })
})
