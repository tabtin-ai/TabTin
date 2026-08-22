/**
 * 扫描出口对称性：发现 IPC 与注入共用 scanWorkspaceForSurface（源码契约）。
 * 行为断言见 workspace-skills-context.test.ts。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))

const contextSource = readFileSync(
  resolve(__dirname, '../workspace-skills-context.ts'),
  'utf8',
)
const ipcRegistrySource = readFileSync(
  resolve(__dirname, '../../ipc-registry.ts'),
  'utf8',
)

describe('workspace skills 扫描出口对称性契约', () => {
  it('注入侧走 scanWorkspaceForSurface，不直接调裸 scanWorkspaceSkills', () => {
    expect(contextSource).toContain('export async function scanWorkspaceForSurface(')
    expect(contextSource).toContain('await scanWorkspaceForSurface(workspaceRoot, { onWarn })')
    expect(contextSource).not.toContain('scanWorkspaceSkills(workspaceRoot')
    expect(contextSource).toContain('scanWorkspaceSkillsGuarded(workspaceRoot, {')
    expect(contextSource).toContain('allowedRoots: allowedScanRoots()')
  })

  it('发现侧 IPC 走同一出口', () => {
    expect(ipcRegistrySource).toContain(
      "await import('./agent/workspace-skills-context')",
    )
    expect(ipcRegistrySource).toContain('await scanWorkspaceForSurface(workspaceRoot, {')
    const handlerStart = ipcRegistrySource.indexOf("guardedHandle('skill:workspace-scan'")
    expect(handlerStart).toBeGreaterThan(-1)
    const handlerSlice = ipcRegistrySource.slice(handlerStart, handlerStart + 2200)
    expect(handlerSlice).not.toContain('isPathSafe(')
    expect(handlerSlice).not.toContain('scanWorkspaceSkills(')
    expect(handlerSlice).toContain('content_hash: s.contentHash')
    expect(handlerSlice).toContain('realpath: s.realpath')
  })

  it('工具路径与出口同边界', () => {
    expect(contextSource).toContain(
      'if (!isWorkspaceRootAllowed(workspaceRoot, allowedScanRoots())) return []',
    )
  })
})
