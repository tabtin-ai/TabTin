/**
 * CG-004 回归测试：Daemon 版 addFiles 必须在 toggleNestedGitRepos 前调用 repairDisabledGitDirs
 *
 * 问题：Daemon 版 addFiles 缺少 repairDisabledGitDirs 调用，崩溃后 .git_disabled 残留
 * 无法自愈，导致子仓库 .git 永久处于 disabled 状态。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CORE_CHECKPOINT_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../../packages/checkpoint-core/src/CheckpointService.ts',
)

const DAEMON_CHECKPOINT_WRAPPER_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  '../src/platform/workspace/checkpoint/CheckpointService.ts',
)

const ELECTRON_CHECKPOINT_WRAPPER_PATH = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../tabtin-electron/src/main/checkpoint/CheckpointService.ts',
)

describe('CG-004: Daemon addFiles includes repairDisabledGitDirs', () => {
  const coreSource = fs.readFileSync(CORE_CHECKPOINT_PATH, 'utf-8')

  it('addFiles repairs disabled git dirs before disabling active ones', () => {
    const addFilesMatch = coreSource.match(
      /private\s+async\s+addFiles\s*\([\s\S]*?\n\s{2}\}/m,
    )
    expect(addFilesMatch).not.toBeNull()

    const addFilesBody = addFilesMatch![0]
    expect(addFilesBody).toContain('const { active, disabled } = await this.findAllNestedGitDirs')
    expect(addFilesBody).toContain('for (const dir of disabled)')
    expect(addFilesBody).toContain('const allGitDirs = [...active, ...repaired]')
    expect(addFilesBody).toContain('for (const d of allGitDirs)')

    const repairIdx = addFilesBody.indexOf('for (const dir of disabled)')
    const disableIdx = addFilesBody.indexOf('for (const d of allGitDirs)')
    expect(repairIdx).toBeGreaterThan(-1)
    expect(disableIdx).toBeGreaterThan(-1)
    expect(repairIdx).toBeLessThan(disableIdx)
  })

  it('daemon and electron adapters both reuse @tabtin/checkpoint-core', () => {
    if (!fs.existsSync(DAEMON_CHECKPOINT_WRAPPER_PATH) || !fs.existsSync(ELECTRON_CHECKPOINT_WRAPPER_PATH)) {
      return
    }
    const daemonWrapper = fs.readFileSync(DAEMON_CHECKPOINT_WRAPPER_PATH, 'utf-8')
    const electronWrapper = fs.readFileSync(ELECTRON_CHECKPOINT_WRAPPER_PATH, 'utf-8')

    expect(daemonWrapper).toContain("export { CheckpointService } from '@tabtin/checkpoint-core'")
    expect(electronWrapper).toContain("export { CheckpointService } from '@tabtin/checkpoint-core'")
  })
})
