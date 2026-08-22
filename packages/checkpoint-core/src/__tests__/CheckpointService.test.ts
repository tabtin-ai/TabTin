import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import {
  CheckpointService,
  normalizeWorktreePathForComparison,
  parseShadowCoreWorktreeFromConfig,
  readShadowCoreWorktree,
  type CheckpointLogger,
} from '../CheckpointService.js'

const logger: CheckpointLogger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
}

describe('CheckpointService', () => {
  let projectDir: string
  let checkpointsRoot: string
  let service: CheckpointService

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-project-'))
    checkpointsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-root-'))
    service = new CheckpointService(projectDir, checkpointsRoot, logger)
  })

  afterEach(async () => {
    await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(checkpointsRoot, { recursive: true, force: true }).catch(() => {})
  })

  // ── init ────────────────────────────────────────────────────

  describe('init', () => {
    it('should create .git directory', async () => {
      await service.init()
      expect(fs.existsSync(service.gitPath)).toBe(true)
    })

    it('should set core.worktree to project directory', async () => {
      await service.init()
      const config = fs.readFileSync(path.join(service.gitPath, 'config'), 'utf-8')
      expect(parseShadowCoreWorktreeFromConfig(config)).toBe(projectDir)
    })

    it('should set commit.gpgSign to false', async () => {
      await service.init()
      const config = fs.readFileSync(path.join(service.gitPath, 'config'), 'utf-8')
      expect(config).toContain('gpgSign = false')
    })

    it('should write info/exclude file with checkpoint patterns', async () => {
      await service.init()
      const excludePath = path.join(service.gitPath, 'info', 'exclude')
      expect(fs.existsSync(excludePath)).toBe(true)
      const content = fs.readFileSync(excludePath, 'utf-8')
      expect(content).toContain('node_modules/')
    })

    it('should return the same path on repeated init calls', async () => {
      const path1 = await service.init()
      const path2 = await service.init()
      expect(path1).toBe(path2)
    })
  })

  // ── writeTree ──────────────────────────────────────────────

  describe('writeTree', () => {
    it('should return a non-empty tree hash after creating files', async () => {
      await service.init()
      fs.writeFileSync(path.join(projectDir, 'test.txt'), 'hello')
      const hash = await service.writeTree()
      expect(hash).toBeDefined()
      expect(hash!.length).toBeGreaterThan(0)
    })

    it('should return the same hash for identical content', async () => {
      await service.init()
      fs.writeFileSync(path.join(projectDir, 'test.txt'), 'hello')
      const hash1 = await service.writeTree()
      const hash2 = await service.writeTree()
      expect(hash1).toBe(hash2)
    })

    it('should return a different hash after file modification', async () => {
      await service.init()
      fs.writeFileSync(path.join(projectDir, 'test.txt'), 'hello')
      const hash1 = await service.writeTree()
      fs.writeFileSync(path.join(projectDir, 'test.txt'), 'world')
      const hash2 = await service.writeTree()
      expect(hash1).not.toBe(hash2)
    })
  })

  // ── commit ─────────────────────────────────────────────────

  describe('commit', () => {
    it('should return a non-empty commit hash', async () => {
      await service.init()
      fs.writeFileSync(path.join(projectDir, 'test.txt'), 'hello')
      const hash = await service.commit()
      expect(hash).toBeDefined()
      expect(hash!.length).toBeGreaterThan(0)
    })

    it('should create a new entry in git log', async () => {
      await service.init()
      const beforeCommits = await service.listCommits()

      fs.writeFileSync(path.join(projectDir, 'test.txt'), 'hello')
      await service.commit()

      const afterCommits = await service.listCommits()
      expect(afterCommits.length).toBe(beforeCommits.length + 1)
      expect(afterCommits[0].message).toMatch(/^checkpoint:/)
    })
  })

  // ── getDiffSummary ─────────────────────────────────────────

  describe('getDiffSummary', () => {
    it('should report changes between two commits', async () => {
      await service.init()

      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'initial')
      const hash1 = await service.commit()

      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'modified content\nwith new lines')
      const hash2 = await service.commit()

      const result = await service.getDiffSummary(hash2!, hash1!)
      expect(result.summary.changed).toBeGreaterThan(0)
    })

    it('should work with tree hash as baseHash', async () => {
      await service.init()

      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'baseline')
      const treeHash = await service.writeTree()

      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'updated content')
      const commitHash = await service.commit()

      const result = await service.getDiffSummary(commitHash!, treeHash!)
      expect(result.summary.changed).toBeGreaterThan(0)
    })

    it('should skip a normal checkpoint when nothing changed', async () => {
      await service.init()

      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'content')
      const hash1 = await service.commit()

      const hash2 = await service.commit()

      expect(hash1).toBeDefined()
      expect(hash2).toBeUndefined()
    })

    it('should report per-file status: added / modified / deleted ', async () => {
      await service.init()

      fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'v1')
      fs.writeFileSync(path.join(projectDir, 'doomed.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
      const hash1 = await service.commit()

      fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'v2 changed')
      fs.writeFileSync(path.join(projectDir, 'fresh.txt'), 'new file')
      fs.unlinkSync(path.join(projectDir, 'doomed.bin'))
      const hash2 = await service.commit()

      const result = await service.getDiffSummary(hash2!, hash1!)
      const byFile = new Map(result.files.map((f) => [f.file, f]))
      expect(byFile.get('keep.txt')?.status).toBe('modified')
      expect(byFile.get('fresh.txt')?.status).toBe('added')
      // binary 删除：numstat 行数是 0/0，只有 name-status 能识别
      expect(byFile.get('doomed.bin')?.status).toBe('deleted')
      expect(byFile.get('doomed.bin')?.binary).toBe(true)
    })

    it('should allow explicit empty safety checkpoints', async () => {
      await service.init()

      const hash1 = await service.commit({
        kind: 'safety_before_restore',
        trigger: 'safety_before_restore',
        allowEmpty: true,
        visibleInHistory: false,
      })
      const hash2 = await service.commit({
        kind: 'safety_before_restore',
        trigger: 'safety_before_restore',
        allowEmpty: true,
        visibleInHistory: false,
      })

      const result = await service.getDiffSummary(hash2!, hash1!)
      expect(result.summary.changed).toBe(0)
      expect(result.summary.insertions).toBe(0)
      expect(result.summary.deletions).toBe(0)
    })
  })

  // ── restore ────────────────────────────────────────────────

  describe('restore', () => {
    it('should restore deleted files', async () => {
      await service.init()

      const filePath = path.join(projectDir, 'restore-me.txt')
      fs.writeFileSync(filePath, 'important data')
      const commitHash = await service.commit()

      fs.unlinkSync(filePath)
      expect(fs.existsSync(filePath)).toBe(false)

      await service.restore(commitHash!)
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('important data')
    })

    it('should remove files added after the target commit', async () => {
      await service.init()

      const file1 = path.join(projectDir, 'file1.txt')
      fs.writeFileSync(file1, 'original')
      const commitA = await service.commit()

      const file2 = path.join(projectDir, 'file2.txt')
      fs.writeFileSync(file2, 'new file')
      await service.commit()

      await service.restore(commitA!)

      expect(fs.existsSync(file1)).toBe(true)
      expect(fs.existsSync(file2)).toBe(false)
    })

    it('should preserve later commits in version history when restoring an older commit', async () => {
      await service.init()

      const file1 = path.join(projectDir, 'file1.txt')
      fs.writeFileSync(file1, 'original')
      const commitA = await service.commit()

      const file2 = path.join(projectDir, 'file2.txt')
      fs.writeFileSync(file2, 'new file')
      const commitB = await service.commit()

      await service.restore(commitA!)

      expect(fs.existsSync(file1)).toBe(true)
      expect(fs.existsSync(file2)).toBe(false)

      const head = (await simpleGit(service.gitPath).revparse(['HEAD'])).trim()
      expect(head).toBe(commitB)

      const commits = await service.listCommits()
      const hashes = commits.map(commit => commit.hash)
      expect(hashes).toContain(commitA)
      expect(hashes).toContain(commitB)
      expect(hashes.indexOf(commitB!)).toBeLessThan(hashes.indexOf(commitA!))
    })

    it('should move the visible history cursor when requested', async () => {
      await service.init()

      const file = path.join(projectDir, 'file.txt')
      fs.writeFileSync(file, 'V6\n')
      const commitV6 = await service.commit()

      fs.writeFileSync(file, 'V6\nV7\n')
      const commitV7 = await service.commit()

      fs.writeFileSync(file, 'V6\nV7\nV8\n')
      const commitV8 = await service.commit()

      fs.writeFileSync(file, 'V6\nV7\nV8\nV9\n')
      const commitV9 = await service.commit()

      await service.restore(commitV6!, { moveHead: true })
      fs.writeFileSync(file, 'V6\nV7------change-----------------\n')
      const commitV7Changed = await service.commit()

      const head = (await simpleGit(service.gitPath).revparse(['HEAD'])).trim()
      expect(head).toBe(commitV7Changed)
      expect(fs.readFileSync(file, 'utf-8')).toBe('V6\nV7------change-----------------\n')

      const commits = await service.listCommits()
      const hashes = commits.map(commit => commit.hash)
      expect(hashes).toContain(commitV6)
      expect(hashes).toContain(commitV7Changed)
      expect(hashes).not.toContain(commitV7)
      expect(hashes).not.toContain(commitV8)
      expect(hashes).not.toContain(commitV9)
    })
  })

  // ── withLock serialization ─────────────────────────────────

  describe('withLock serialization', () => {
    it('should handle concurrent writeTree and commit without errors', async () => {
      await service.init()
      fs.writeFileSync(path.join(projectDir, 'concurrent.txt'), 'data')

      const results = await Promise.all([
        service.writeTree(),
        service.commit(),
      ])

      expect(results[0]).toBeDefined()
      expect(results[1]).toBeDefined()
    })
  })

  // ── projectPath missing 防御 ─────────────────────────────
  //
  // 项目目录在 init 后被外部移走/删除（外接盘 unmount、用户 mv）的场景。
  // 期望：再次 init 时（譬如重启后冷启动）能给出可识别的错误，让 IPC 层
  // 归类为 'project_path_not_exist'，UI 据此降级，而不是把 git fatal 冒上来。

  describe('projectPath disappearance', () => {
    it('throws "Project path does not exist" when projectPath was deleted before first init', async () => {
      const ghostDir = path.join(checkpointsRoot, 'ghost-project-never-existed')
      const ghostService = new CheckpointService(ghostDir, checkpointsRoot, logger)
      await expect(ghostService.init()).rejects.toThrow(/Project path does not exist/)
    })

    it('throws "Project path does not exist" when projectPath is removed between sessions', async () => {
      // 模拟：第一次 init 成功（项目目录存在）→ 用户外部删掉项目目录 →
      // 重启后新建一个 service 实例（同样 projectDir + checkpointsRoot），再 init
      await service.init()
      expect(fs.existsSync(service.gitPath)).toBe(true)

      await fsp.rm(projectDir, { recursive: true, force: true })

      const reopened = new CheckpointService(projectDir, checkpointsRoot, logger)
      await expect(reopened.init()).rejects.toThrow(/Project path does not exist/)
    })
  })

  // ── readShadowCoreWorktree —— 直接 parse INI 不走 git 子进程 ──
  //
  // 这是 _doInit 解开"git config 在 worktree 路径不存在时也跑不动"
  // 死结的关键 helper。必须能正确处理常见 INI 形态，且对 worktree 不存在
  // 的孤儿 shadow git 也能稳定返回 worktree 字符串。

  describe('readShadowCoreWorktree', () => {
    it('returns the worktree value from a real shadow git config', async () => {
      await service.init()
      const wt = await readShadowCoreWorktree(service.gitPath)
      expect(wt).toBe(projectDir)
    })

    it('returns the worktree value even when the worktree path no longer exists', async () => {
      // 这是 18fe0fa 那个 bug 的最小复现 —— shadow git 还在，项目目录已删
      await service.init()
      await fsp.rm(projectDir, { recursive: true, force: true })

      const wt = await readShadowCoreWorktree(service.gitPath)
      expect(wt).toBe(projectDir)
    })

    it('returns null when the [core] section has no worktree key', async () => {
      const tmpGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bare-git-'))
      fs.writeFileSync(
        path.join(tmpGit, 'config'),
        '[core]\n\trepositoryformatversion = 0\n[user]\n\tname = ghost\n',
        'utf-8',
      )
      try {
        const wt = await readShadowCoreWorktree(tmpGit)
        expect(wt).toBeNull()
      } finally {
        await fsp.rm(tmpGit, { recursive: true, force: true })
      }
    })

    it('returns null when the .git/config file is missing entirely', async () => {
      const wt = await readShadowCoreWorktree('/nonexistent/.git')
      expect(wt).toBeNull()
    })
  })

  describe('normalizeWorktreePathForComparison', () => {
    it('treats Windows slash variants as the same path', () => {
      expect(normalizeWorktreePathForComparison('C:/workspace/TabTin/')).toBe(
        normalizeWorktreePathForComparison('c:\\workspace\\TabTin'),
      )
    })

    it('preserves POSIX case-sensitive comparison semantics', () => {
      expect(normalizeWorktreePathForComparison('/tmp/Project')).not.toBe(
        normalizeWorktreePathForComparison('/tmp/project'),
      )
    })
  })

  // ── parseShadowCoreWorktreeFromConfig —— 纯函数版本，复用同一组规则 ──
  //
  // listFn 用纯函数版（自己掌握 fs.readFile）来精确区分"读不到 config 文件"
  // 和"读到了但没 worktree 项"两种语义。这里覆盖几种容易踩坑的 INI 形态。

  describe('parseShadowCoreWorktreeFromConfig', () => {
    it('parses standard tab-indented form', () => {
      const wt = parseShadowCoreWorktreeFromConfig('[core]\n\tworktree = /Users/x/proj\n')
      expect(wt).toBe('/Users/x/proj')
    })

    it('parses space-indented form', () => {
      const wt = parseShadowCoreWorktreeFromConfig('[core]\n  worktree = /tmp/p\n')
      expect(wt).toBe('/tmp/p')
    })

    it('strips surrounding double quotes', () => {
      const wt = parseShadowCoreWorktreeFromConfig('[core]\n\tworktree = "/path with space/x"\n')
      expect(wt).toBe('/path with space/x')
    })

    it('ignores worktree key in non-[core] section', () => {
      // 防止 `[remote "x"]\n\tworktree = ...` 这种异常配置被误当成 core.worktree
      const wt = parseShadowCoreWorktreeFromConfig('[remote "x"]\n\tworktree = /should-be-ignored\n')
      expect(wt).toBeNull()
    })

    it('returns null for empty content', () => {
      expect(parseShadowCoreWorktreeFromConfig('')).toBeNull()
    })

    it('skips comments and blank lines', () => {
      const wt = parseShadowCoreWorktreeFromConfig(
        '# leading comment\n\n[core]\n; another comment\n\tworktree = /Users/x/proj\n',
      )
      expect(wt).toBe('/Users/x/proj')
    })
  })
})
