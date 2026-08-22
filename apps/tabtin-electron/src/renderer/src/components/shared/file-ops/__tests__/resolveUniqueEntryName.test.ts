import { describe, expect, it, vi } from 'vitest'
import { resolveUniqueEntryName } from '../useFileTreeActions'

/**
 * 构造一个可控的 existsFn：传入「已存在的路径集合」，返回是否命中。
 * 默认按字符串匹配；用 `joinPath` 风格的 `/parent/name` 拼接。
 */
function makeExistsFn(existing: string[]): (p: string) => Promise<boolean> {
  return async (p: string) => existing.includes(p)
}

describe('resolveUniqueEntryName', () => {
  const parent = '/space/workdir'

  it('returns original name when no conflict', async () => {
    const exists = makeExistsFn([])
    const result = await resolveUniqueEntryName(parent, '11', exists)
    expect(result).toEqual({ name: '11', renamed: false })
  })

  it('appends -1 when name collides with a file (folder create case)', async () => {
    //  场景：已有文件 `11`，再建文件夹 `11`
    const exists = makeExistsFn([`${parent}/11`])
    const result = await resolveUniqueEntryName(parent, '11', exists)
    expect(result).toEqual({ name: '11-1', renamed: true })
  })

  it('appends -1 when name collides with a folder (file create case)', async () => {
    const exists = makeExistsFn([`${parent}/11`])
    const result = await resolveUniqueEntryName(parent, '11', exists)
    expect(result).toEqual({ name: '11-1', renamed: true })
  })

  it('skips taken candidates and returns next free index', async () => {
    const exists = makeExistsFn([`${parent}/11`, `${parent}/11-1`, `${parent}/11-2`])
    const result = await resolveUniqueEntryName(parent, '11', exists)
    expect(result).toEqual({ name: '11-3', renamed: true })
  })

  it('preserves file extension when deduping', async () => {
    const exists = makeExistsFn([`${parent}/report.pdf`])
    const result = await resolveUniqueEntryName(parent, 'report.pdf', exists)
    expect(result).toEqual({ name: 'report-1.pdf', renamed: true })
  })

  it('preserves only the last extension for double-extension names', async () => {
    const exists = makeExistsFn([`${parent}/archive.tar.gz`])
    const result = await resolveUniqueEntryName(parent, 'archive.tar.gz', exists)
    expect(result).toEqual({ name: 'archive.tar-1.gz', renamed: true })
  })

  it('treats dotfiles as having no extension (suffix appended whole)', async () => {
    // `.gitignore` 的 `.` 在 index 0，getExtension 返回 ''，所以 base 是 `.gitignore`
    const exists = makeExistsFn([`${parent}/.gitignore`])
    const result = await resolveUniqueEntryName(parent, '.gitignore', exists)
    expect(result).toEqual({ name: '.gitignore-1', renamed: true })
  })

  it('returns original name (renamed=false) when all candidates up to maxAttempts are taken', async () => {
    // 极端：1..99 全占用，应回退原名交给 OS 创建拿真实错误
    const existing: string[] = [`${parent}/11`]
    for (let i = 1; i <= 99; i++) existing.push(`${parent}/11-${i}`)
    const exists = makeExistsFn(existing)
    const result = await resolveUniqueEntryName(parent, '11', exists)
    expect(result).toEqual({ name: '11', renamed: false })
  })

  it('respects custom maxAttempts boundary', async () => {
    // maxAttempts=3，1..3 全占用 → 回退原名
    const existing = [`${parent}/11`, `${parent}/11-1`, `${parent}/11-2`, `${parent}/11-3`]
    const exists = makeExistsFn(existing)
    const result = await resolveUniqueEntryName(parent, '11', exists, 3)
    expect(result).toEqual({ name: '11', renamed: false })
  })

  it('invokes existsFn with joined parent/name paths', async () => {
    const exists = vi.fn(async () => false)
    await resolveUniqueEntryName(parent, 'foo.txt', exists)
    expect(exists).toHaveBeenCalledWith(`${parent}/foo.txt`)
  })
})
