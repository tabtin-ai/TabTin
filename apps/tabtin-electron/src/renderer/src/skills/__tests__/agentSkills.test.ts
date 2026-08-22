/**
 * agentSkills 回归测试（Wave 1 重写，PRD V3.3 §11.5）。
 *
 * Wave 1 起 ``syncAgentSkills`` / ``SKILLS_SYNC_ERROR_EVENT`` 已删除（草稿不上云），
 * 仅保留 ``scanAgentSkills``（本地扫描工具）+ watcher no-op deprecation。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFileSystem = {
  readDir: vi.fn(),
  readFilePreview: vi.fn(),
  watch: vi.fn(),
  onWatchEvent: vi.fn(),
  unwatch: vi.fn(),
}

beforeEach(() => {
  vi.stubGlobal('tabtin', { fileSystem: mockFileSystem })
  Object.defineProperty(window, 'tabtin', {
    value: { fileSystem: mockFileSystem },
    writable: true,
    configurable: true,
  })
  mockFileSystem.readDir.mockResolvedValue({ success: true, entries: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scanAgentSkills', () => {
  it('空 sandbox 返回空数组', async () => {
    const { scanAgentSkills } = await import('../agentSkills')
    const skills = await scanAgentSkills('/tmp/sandbox')
    expect(Array.isArray(skills)).toBe(true)
    expect(skills).toHaveLength(0)
  })
})

describe('startAgentSkillsWatcher / stopAgentSkillsWatcher (deprecated no-op)', () => {
  it('start/stop 应安全退出不报错', async () => {
    const { startAgentSkillsWatcher, stopAgentSkillsWatcher } = await import('../agentSkills')

    await expect(startAgentSkillsWatcher('space-1', '/tmp/sandbox')).resolves.toBeUndefined()
    await expect(stopAgentSkillsWatcher('space-1')).resolves.toBeUndefined()

    expect(mockFileSystem.watch).not.toHaveBeenCalled()
    expect(mockFileSystem.unwatch).not.toHaveBeenCalled()
  })
})
