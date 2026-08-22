import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ：目录/文件选择必须用持久挂载 hidden input，禁止临时 createElement + click()。
 * 系统文件选择器本身无法在单测里断言；这里锁住调用形态，防止回退到静默失败路径。
 */
describe('ImportDialog folder picker contract ', () => {
  const source = readFileSync(
    resolve(__dirname, '../ImportDialog.tsx'),
    'utf8',
  )

  it('uses persistent hidden inputs instead of ephemeral createElement', () => {
    expect(source).toContain('folderInputRef')
    expect(source).toContain('fileInputRef')
    expect(source).toContain("setAttribute('webkitdirectory', '')")
    expect(source).toContain('folderInputRef.current?.click()')
    expect(source).toContain('fileInputRef.current?.click()')
    expect(source).not.toMatch(/document\.createElement\(\s*['"]input['"]\s*\)/)
  })

  it('keeps directory/file inputs outside the folder-tab conditional', () => {
    const scrollBodyIdx = source.indexOf('<DialogScrollBody')
    const folderTabIdx = source.indexOf("{tab === 'folder'")
    const webkitIdx = source.indexOf("setAttribute('webkitdirectory'")
    expect(scrollBodyIdx).toBeGreaterThan(-1)
    expect(folderTabIdx).toBeGreaterThan(scrollBodyIdx)
    expect(webkitIdx).toBeGreaterThan(scrollBodyIdx)
    expect(webkitIdx).toBeLessThan(folderTabIdx)
  })

  it('disables the import form while submitting', () => {
    expect(source).toContain('if (isSubmitting) return')
    expect(source).toContain('onPointerDownOutside=')
    expect(source).toContain('onEscapeKeyDown=')
    expect(source).toContain("closeClassName={isSubmitting ? 'pointer-events-none opacity-50' : undefined}")

    // 关键控件必须各自绑 disabled，避免只断言「某处出现过 disabled={isSubmitting}」。
    const disabledBindings = [
      "onClick={() => setTab('folder')}",
      "onClick={() => setTab('url')}",
      "onClick={() => setTab('npm')}",
      'folderInputRef.current?.click()',
      'fileInputRef.current?.click()',
      'placeholder="https://github.com/user/repo/raw/main/skills/my-skill/SKILL.md"',
      'placeholder="https://github.com/anthropics/skills --skill algorithmic-art"',
      "t('skills.importDialog.cancel')",
    ]
    for (const anchor of disabledBindings) {
      const idx = source.indexOf(anchor)
      expect(idx, `missing anchor: ${anchor}`).toBeGreaterThan(-1)
      // disabled 可能写在属性列表前部或后部，取锚点两侧窗口断言绑定存在。
      const nearby = source.slice(Math.max(0, idx - 220), idx + 220)
      expect(nearby, `disabled not near: ${anchor}`).toContain('disabled={isSubmitting}')
    }
  })

  it('imports without an enable-after-import control or enablement payload', () => {
    expect(source).not.toContain('enableAfterImport')
    expect(source).not.toContain('enableSpaceIds')
    expect(source).not.toContain('SkillSpacePicker')
  })
})
