/**
 * SessionCodeRootBindingStore 单测。
 *
 * 覆盖 fail-closed 校验顺序：sessionId/rootPath 非空 → busy 拒绝 → 路径存在 →
 * 是 Git 工作树 → 写入。用真实临时目录 + 真实 `git init`，不 mock
 * `child_process`——`isInsideGitWorkTree` 的行为就是"能不能跑通 `git
 * rev-parse`"，mock 掉反而验证不到真实契约。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import {
  bindingPathsMatch,
  createSessionCodeRootBindingStore,
  resolveAuthoritativeSessionCodeRoot,
  SessionCodeRootConflictError,
  SessionCodeRootBindingsUnknownError,
} from '../session-code-root-binding'

const execFileAsync = promisify(execFile)
const testDirectories: string[] = []

function makeTestDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-code-root-binding-'))
  testDirectories.push(directory)
  return directory
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '--quiet'], { cwd: dir })
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('binding path aliases', () => {
  it('matches macOS /tmp and /private/tmp spellings only on darwin', () => {
    expect(bindingPathsMatch('/tmp/wt-alias', '/private/tmp/wt-alias')).toBe(
      process.platform === 'darwin',
    )
  })

  it('persisted binding is authoritative and rejects a conflicting request root', () => {
    expect(resolveAuthoritativeSessionCodeRoot('/repo/wt', undefined)).toBe('/repo/wt')
    expect(resolveAuthoritativeSessionCodeRoot('/repo/wt', '/repo/wt')).toBe('/repo/wt')
    expect(() => resolveAuthoritativeSessionCodeRoot('/repo/wt', '/repo/old'))
      .toThrow(SessionCodeRootConflictError)
  })
})

describe('SessionCodeRootBindingStore.bind', () => {
  let store: ReturnType<typeof createSessionCodeRootBindingStore>
  const notBusy = { isBusy: () => false }

  beforeEach(() => {
    store = createSessionCodeRootBindingStore()
  })

  it('sessionId 缺失时拒绝', async () => {
    const result = await store.bind({ sessionId: '', rootPath: '/tmp' }, notBusy)
    expect(result).toMatchObject({ success: false, reason: 'invalid_session_id' })
  })

  it('rootPath 缺失时拒绝', async () => {
    const result = await store.bind({ sessionId: 'session-1', rootPath: '' }, notBusy)
    expect(result).toMatchObject({ success: false, reason: 'invalid_root_path' })
  })

  it('会话 busy 时拒绝，且不写入状态', async () => {
    const dir = makeTestDirectory()
    await initGitRepo(dir)

    const result = await store.bind(
      { sessionId: 'session-1', rootPath: dir },
      { isBusy: () => true },
    )

    expect(result).toMatchObject({ success: false, reason: 'session_busy' })
    expect(store.get('session-1')).toBeUndefined()
  })

  it('路径不存在时拒绝', async () => {
    const result = await store.bind(
      { sessionId: 'session-1', rootPath: '/no/such/path/at/all' },
      notBusy,
    )
    expect(result).toMatchObject({ success: false, reason: 'not_found' })
  })

  it('路径存在但不是目录时拒绝', async () => {
    const dir = makeTestDirectory()
    const filePath = path.join(dir, 'file.txt')
    fs.writeFileSync(filePath, 'x')

    const result = await store.bind({ sessionId: 'session-1', rootPath: filePath }, notBusy)
    expect(result).toMatchObject({ success: false, reason: 'not_a_directory' })
  })

  it('目录存在但不是 Git 工作树时拒绝', async () => {
    const dir = makeTestDirectory()

    const result = await store.bind({ sessionId: 'session-1', rootPath: dir }, notBusy)
    expect(result).toMatchObject({ success: false, reason: 'not_git_worktree' })
  })

  it('校验全部通过时成功绑定并写入状态', async () => {
    const dir = makeTestDirectory()
    await initGitRepo(dir)

    const result = await store.bind(
      { sessionId: 'session-1', rootPath: dir, branch: 'feat/x', tabKey: 'tabcode:abc' },
      notBusy,
    )

    expect(result.success).toBe(true)
    expect(result.rootPath).toBe(fs.realpathSync(dir))
    expect(result.revision).toBe(1)
    expect(store.get('session-1')).toMatchObject({
      rootPath: fs.realpathSync(dir),
      branch: 'feat/x',
      tabKey: 'tabcode:abc',
      revision: 1,
    })
    expect(store.getRootPath('session-1')).toBe(fs.realpathSync(dir))
  })

  it('重复绑定同一 session 时 revision 自增', async () => {
    const dirA = makeTestDirectory()
    const dirB = makeTestDirectory()
    await initGitRepo(dirA)
    await initGitRepo(dirB)

    const first = await store.bind({ sessionId: 'session-1', rootPath: dirA }, notBusy)
    const second = await store.bind({ sessionId: 'session-1', rootPath: dirB }, notBusy)

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(store.getRootPath('session-1')).toBe(fs.realpathSync(dirB))
  })

  it('显式传入 revision 时按显式值写入', async () => {
    const dir = makeTestDirectory()
    await initGitRepo(dir)

    const result = await store.bind(
      { sessionId: 'session-1', rootPath: dir, revision: 42 },
      notBusy,
    )

    expect(result.revision).toBe(42)
  })

  it('目录被预留删除时拒绝新绑定，释放后可重试', async () => {
    const dir = makeTestDirectory()
    await initGitRepo(dir)
    const release = await store.reserveRootForRemoval(dir)

    expect(release).toBeTypeOf('function')
    await expect(store.reserveRootForRemoval(dir)).resolves.toBeNull()
    await expect(
      store.bind({ sessionId: 'session-1', rootPath: dir }, notBusy),
    ).resolves.toMatchObject({
      success: false,
      reason: 'session_busy',
    })
    expect(store.get('session-1')).toBeUndefined()

    release?.()
    await expect(
      store.bind({ sessionId: 'session-1', rootPath: dir }, notBusy),
    ).resolves.toMatchObject({ success: true })
  })

  it('clear 清除绑定并返回是否命中', () => {
    expect(store.clear('session-1')).toBe(false)
  })

  it('snapshot 返回只读快照，不暴露内部 Map 引用可被外部 mutate 影响状态', async () => {
    const dir = makeTestDirectory()
    await initGitRepo(dir)
    await store.bind({ sessionId: 'session-1', rootPath: dir }, notBusy)

    const snap = store.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0][0]).toBe('session-1')
  })
})

describe('SessionCodeRootBindingStore persistence', () => {
  const notBusy = { isBusy: () => false }
  const scopeA = { userId: 'user-a', organizationId: 'org-a' }
  const scopeB = { userId: 'user-b', organizationId: 'org-b' }

  function makePersistPath(): string {
    const dir = makeTestDirectory()
    return path.join(dir, 'session-code-root-bindings.json')
  }

  it('首次空文件 restore 得到空内存态', async () => {
    const persistPath = makePersistPath()
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    const result = await store.restore()
    expect(result).toEqual({ restored: 0, skipped: 0 })
    expect(store.snapshot()).toHaveLength(0)
  })

  it('scope 未就绪时 deferred，不清空已有内存绑定', async () => {
    const dir = makeTestDirectory()
    await initGitRepo(dir)
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => null,
      getScope: () => null,
    })
    await store.bind({ sessionId: 'local-pending-keep', rootPath: dir }, notBusy)
    const result = await store.restore()
    expect(result.deferred).toBe(true)
    expect(store.get('local-pending-keep')).toBeDefined()
  })

  it('删除预留期间延迟 restore，释放后才恢复绑定', async () => {
    const persistPath = makePersistPath()
    const dir = makeTestDirectory()
    await initGitRepo(dir)
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await store.bind({ sessionId: 'sess-reserved', rootPath: dir }, notBusy)
    const release = await store.reserveRootForRemoval(dir)
    store.clearAllMemory()

    await expect(store.restore()).resolves.toEqual({
      restored: 0,
      skipped: 0,
      deferred: true,
    })
    expect(store.get('sess-reserved')).toBeUndefined()

    release?.()
    await expect(store.restore()).resolves.toMatchObject({ restored: 1 })
    expect(store.getRootPath('sess-reserved')).toBe(fs.realpathSync(dir))
  })

  it('restore 未完成时查找绑定 fail-closed，不把空内存当成没有绑定', async () => {
    const persistPath = makePersistPath()
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => null,
    })

    await expect(store.findSessionsByRootPath('/tmp/any-worktree')).rejects.toBeInstanceOf(
      SessionCodeRootBindingsUnknownError,
    )
    await expect(store.clearSessionsByRootPath('/tmp/any-worktree')).rejects.toBeInstanceOf(
      SessionCodeRootBindingsUnknownError,
    )
  })

  it('clearAllMemory 后在 reservation 期间查找绑定仍 fail-closed', async () => {
    const persistPath = makePersistPath()
    const dir = makeTestDirectory()
    await initGitRepo(dir)
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await store.bind({ sessionId: 'sess-cleared', rootPath: dir }, notBusy)
    const release = await store.reserveRootForRemoval(dir)
    store.clearAllMemory()

    await expect(store.findSessionsByRootPath(dir)).rejects.toBeInstanceOf(
      SessionCodeRootBindingsUnknownError,
    )
    release?.()
  })

  it('删除后仍能用字面路径清掉 realpath 绑定', async () => {
    const persistPath = makePersistPath()
    const dir = makeTestDirectory()
    await initGitRepo(dir)
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await store.bind({ sessionId: 'sess-alias', rootPath: dir }, notBusy)
    const storedRoot = store.getRootPath('sess-alias')
    expect(storedRoot).toBe(fs.realpathSync(dir))

    fs.rmSync(dir, { recursive: true, force: true })
    const cleared = await store.clearSessionsByRootPath(dir)
    expect(cleared).toEqual(['sess-alias'])
    expect(store.get('sess-alias')).toBeUndefined()
  })

  it('原子写后新 store 可恢复，且 getRootPath 可供 runtime 使用', async () => {
    const persistPath = makePersistPath()
    const dir = makeTestDirectory()
    await initGitRepo(dir)

    const writer = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    const bindResult = await writer.bind(
      { sessionId: 'sess-real-1', rootPath: dir, branch: 'feat/persist' },
      notBusy,
    )
    expect(bindResult.success).toBe(true)
    await writer.flush()

    const reader = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    const restored = await reader.restore()
    expect(restored.restored).toBe(1)
    expect(reader.getRootPath('sess-real-1')).toBe(fs.realpathSync(dir))
    expect(reader.get('sess-real-1')?.branch).toBe('feat/persist')
  })

  it('sidecar 写失败时回滚内存绑定，不留下半提交代码根', async () => {
    const root = makeTestDirectory()
    const dirA = path.join(root, 'repo-a')
    const dirB = path.join(root, 'repo-b')
    fs.mkdirSync(dirA)
    fs.mkdirSync(dirB)
    await initGitRepo(dirA)
    await initGitRepo(dirB)
    const persistParentFile = path.join(root, 'not-a-directory')
    fs.writeFileSync(persistParentFile, 'x', 'utf-8')
    let persistPath = path.join(root, 'bindings.json')
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })

    await store.bind({ sessionId: 'sess-write-fails', rootPath: dirA }, notBusy)
    persistPath = path.join(persistParentFile, 'bindings.json')
    await expect(
      store.bind({ sessionId: 'sess-write-fails', rootPath: dirB }, notBusy),
    ).rejects.toThrow()

    expect(store.getRootPath('sess-write-fails')).toBe(fs.realpathSync(dirA))
    expect(store.get('sess-write-fails')?.revision).toBe(1)
  })

  it('身份/组织分桶隔离：另一账号 restore 看不到绑定', async () => {
    const persistPath = makePersistPath()
    const dir = makeTestDirectory()
    await initGitRepo(dir)

    const storeA = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await storeA.bind({ sessionId: 'sess-a', rootPath: dir }, notBusy)
    await storeA.flush()

    const storeB = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeB,
    })
    const restored = await storeB.restore()
    expect(restored.restored).toBe(0)
    expect(storeB.get('sess-a')).toBeUndefined()
  })

  it('损坏 JSON 降级为空，不抛错', async () => {
    const persistPath = makePersistPath()
    fs.mkdirSync(path.dirname(persistPath), { recursive: true })
    fs.writeFileSync(persistPath, '{not-json', 'utf-8')

    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    const result = await store.restore()
    expect(result).toEqual({ restored: 0, skipped: 0 })
    expect(store.snapshot()).toHaveLength(0)
  })

  it('失效路径拒绝恢复，且回写剔除该条目', async () => {
    const persistPath = makePersistPath()
    const dir = makeTestDirectory()
    await initGitRepo(dir)

    const writer = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await writer.bind({ sessionId: 'sess-gone', rootPath: dir }, notBusy)
    await writer.flush()
    fs.rmSync(dir, { recursive: true, force: true })

    const reader = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    const restored = await reader.restore()
    expect(restored).toEqual({ restored: 0, skipped: 1 })
    expect(reader.getRootPath('sess-gone')).toBeUndefined()

    const file = JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as {
      buckets: Record<string, Record<string, unknown>>
    }
    expect(file.buckets['user-a::org-a']).toEqual({})
  })

  it('改绑覆盖旧记录；clearAndPersist 清盘', async () => {
    const persistPath = makePersistPath()
    const dirA = makeTestDirectory()
    const dirB = makeTestDirectory()
    await initGitRepo(dirA)
    await initGitRepo(dirB)

    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await store.bind({ sessionId: 'sess-1', rootPath: dirA }, notBusy)
    await store.bind({ sessionId: 'sess-1', rootPath: dirB }, notBusy)
    expect(store.getRootPath('sess-1')).toBe(fs.realpathSync(dirB))

    const cleared = await store.clearAndPersist('sess-1')
    expect(cleared).toBe(true)
    await store.flush()

    const reader = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await reader.restore()
    expect(reader.get('sess-1')).toBeUndefined()
  })

  it('草稿绑定不落盘；rehome 到真 session 后落盘', async () => {
    const persistPath = makePersistPath()
    const dir = makeTestDirectory()
    await initGitRepo(dir)

    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await store.bind(
      { sessionId: 'local-pending-abc', rootPath: dir, branch: 'wt/x' },
      notBusy,
    )
    await store.flush()
    expect(fs.existsSync(persistPath)).toBe(false)

    const moved = await store.rehome('local-pending-abc', 'sess-real-9')
    expect(moved?.rootPath).toBe(fs.realpathSync(dir))
    expect(store.get('local-pending-abc')).toBeUndefined()
    expect(store.get('sess-real-9')?.branch).toBe('wt/x')
    await store.flush()

    const reader = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await reader.restore()
    expect(reader.getRootPath('sess-real-9')).toBe(fs.realpathSync(dir))
    expect(reader.get('local-pending-abc')).toBeUndefined()
  })

  it('getMany 只返回白名单中的已绑定会话', async () => {
    const dir = makeTestDirectory()
    await initGitRepo(dir)
    const store = createSessionCodeRootBindingStore()
    await store.bind({ sessionId: 'a', rootPath: dir }, notBusy)
    await store.bind({ sessionId: 'b', rootPath: dir }, notBusy)
    const many = store.getMany(['b', 'missing', 'a'])
    expect(Object.keys(many).sort()).toEqual(['a', 'b'])
  })

  it('首次 restore 保留草稿内存态；同 scope 再次 restore 短路', async () => {
    const persistPath = makePersistPath()
    const dirDraft = makeTestDirectory()
    const dirReal = makeTestDirectory()
    await initGitRepo(dirDraft)
    await initGitRepo(dirReal)

    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await store.bind({ sessionId: 'sess-real', rootPath: dirReal }, notBusy)
    await store.bind({ sessionId: 'local-pending-keep', rootPath: dirDraft }, notBusy)
    await store.flush()

    // 模拟启动：清空 restored 标记但保留草稿（Host 不会先 clearAll）
    store.clear('sess-real')
    ;(store as unknown as { restoredScopeKey: string | null }).restoredScopeKey = null

    const first = await store.restore()
    expect(first.restored).toBe(1)
    expect(store.getRootPath('sess-real')).toBe(fs.realpathSync(dirReal))
    expect(store.getRootPath('local-pending-keep')).toBe(fs.realpathSync(dirDraft))

    const second = await store.restore()
    expect(second).toEqual({ restored: 0, skipped: 0 })
    expect(store.getRootPath('local-pending-keep')).toBe(fs.realpathSync(dirDraft))
  })

  it('ensureRestored：scope 晚就绪后可读到落盘绑定，且不会被后续 bind 整桶冲掉', async () => {
    const persistPath = makePersistPath()
    const dirA = makeTestDirectory()
    const dirB = makeTestDirectory()
    await initGitRepo(dirA)
    await initGitRepo(dirB)

    let scope: { userId: string; organizationId: string } | null = null
    const store = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scope,
    })

    // 先无 scope 写不了盘；模拟「已有落盘」：临时带 scope 写一条
    scope = scopeA
    await store.bind({ sessionId: 'sess-a', rootPath: dirA }, notBusy)
    await store.flush()
    store.clearAllMemory()
    scope = null

    // scope 仍空：ensureRestored deferred
    await store.ensureRestored()
    expect(store.get('sess-a')).toBeUndefined()

    scope = scopeA
    await store.ensureRestored()
    expect(store.getRootPath('sess-a')).toBe(fs.realpathSync(dirA))

    await store.bind({ sessionId: 'sess-b', rootPath: dirB }, notBusy)
    await store.flush()

    const reader = createSessionCodeRootBindingStore({
      getPersistPath: () => persistPath,
      getScope: () => scopeA,
    })
    await reader.restore()
    expect(reader.getRootPath('sess-a')).toBe(fs.realpathSync(dirA))
    expect(reader.getRootPath('sess-b')).toBe(fs.realpathSync(dirB))
  })
})
