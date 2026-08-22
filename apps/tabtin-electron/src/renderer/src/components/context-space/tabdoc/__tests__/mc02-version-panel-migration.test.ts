/**
 * MC02 回归测试：TabDoc 前端版本历史统一到 useVersionPanel
 *
 * 验证点：
 * 1. useDocEditor 不再暴露 histories/revisions 相关状态和方法
 * 2. UseDocEditorReturn 类型正确（无 histories/revisions 等字段）
 * 3. useCollaborativeDocEditor 暴露 triggerForceReconnect
 * 4. 旧版 DocHistoryPanel 已被移除，版本历史统一由 useVersionPanel 承担
 */
import { describe, it, expect } from 'vitest'

async function readWorkspaceFile(relativeFromAppRoot: string) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const filePath = path.resolve(process.cwd(), relativeFromAppRoot)
  return fs.readFileSync(filePath, 'utf-8')
}

describe('MC02: useDocEditor 接口变更', () => {
  it('UseDocEditorReturn 不包含 histories/revisions 相关字段', async () => {
    const source = await readWorkspaceFile('../../packages/tabdoc-ui/src/useDocEditor.ts')
    const interfaceBlock = source.match(/export interface UseDocEditorReturn \{[\s\S]*?\n\}/)
    expect(interfaceBlock).not.toBeNull()

    const block = interfaceBlock![0]
    expect(block).not.toContain('histories')
    expect(block).not.toContain('revisions')
    expect(block).not.toContain('isLoadingHistories')
    expect(block).not.toContain('isLoadingRevisions')
    expect(block).not.toContain('restoringVersion')
    expect(block).not.toContain('refreshHistories')
    expect(block).not.toContain('refreshRevisions')
    expect(block).not.toContain('restoreFromHistory')
    expect(block).not.toContain('createNamedVersion')
    expect(block).not.toContain('renameVersion')
    expect(block).not.toContain('deleteNamedVersion')
    expect(block).not.toContain('restoreHistoryItem')
    expect(block).not.toContain('restoreToVersion')
  })

  it('UseDocEditorReturn 保留核心编辑字段', async () => {
    const source = await readWorkspaceFile('../../packages/tabdoc-ui/src/useDocEditor.ts')
    const interfaceBlock = source.match(/export interface UseDocEditorReturn \{[\s\S]*?\n\}/)
    expect(interfaceBlock).not.toBeNull()

    const block = interfaceBlock![0]
    expect(block).toContain('currentDocument:')
    expect(block).toContain('saveState:')
    expect(block).toContain('handleEditorUpdate:')
    expect(block).toContain('manualSave:')
    expect(block).toContain('patchCurrentDocument:')
    expect(block).toContain('retryLoad:')
    expect(block).toContain('loadError:')
  })

  it('UseDocEditorInput 不包含 onRestoreSuccess', async () => {
    const source = await readWorkspaceFile('../../packages/tabdoc-ui/src/useDocEditor.ts')
    const interfaceBlock = source.match(/export interface UseDocEditorInput \{[\s\S]*?\n\}/)
    expect(interfaceBlock).not.toBeNull()
    expect(interfaceBlock![0]).not.toContain('onRestoreSuccess')
  })
})

describe('MC02: UseCollaborativeDocEditorReturn 接口', () => {
  it('暴露 triggerForceReconnect 方法', async () => {
    const source = await readWorkspaceFile('../../packages/tabdoc-ui/src/useCollaborativeDocEditor.ts')
    const interfaceBlock = source.match(/export interface UseCollaborativeDocEditorReturn[\s\S]*?\n\}/)
    expect(interfaceBlock).not.toBeNull()
    expect(interfaceBlock![0]).toContain('triggerForceReconnect:')
  })

  it('不再暴露已删除的 histories/revisions 字段', async () => {
    const source = await readWorkspaceFile('../../packages/tabdoc-ui/src/useCollaborativeDocEditor.ts')
    const interfaceBlock = source.match(/export interface UseCollaborativeDocEditorReturn[\s\S]*?\n\}/)
    expect(interfaceBlock).not.toBeNull()

    const block = interfaceBlock![0]
    expect(block).not.toContain('histories')
    expect(block).not.toContain('revisions')
    expect(block).not.toContain('restoreFromHistory')
  })
})

describe('MC02: DocHistoryPanel 已移除', () => {
  it('不再保留旧版 DocHistoryPanel.tsx 文件', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const filePath = path.resolve(
      __dirname,
      '..',
      'components',
      'DocHistoryPanel.tsx',
    )
    expect(fs.existsSync(filePath)).toBe(false)
  })
})
