import { describe, it, expect } from 'vitest'
import {
  buildCompactSnapshot,
  formatCompactSnapshot,
  buildRefMap,
  buildBackendRefEntries,
} from '../compact-snapshot'

/**
 * BR-14 风格的 a11y 文本（`AccessibilityTreeBuilder.toText` 产出格式：
 * `[role] 名字 [attrs]`，名字**不带引号**；无名节点形如 `[button] [disabled]`）。
 */
const BR14_TREE = [
  '[RootWebArea] Example Domain',
  '  [link] Home',
  '  [textbox] Search [focused]',
  '  [button] [disabled]', // 无名 → 解不出 selector → 不进
  '  [generic] Some wrapper text', // 非交互 → 不进
  '  [link] About Us',
].join('\n')

describe('compact-snapshot.buildCompactSnapshot（BR-16：解析不带引号名字 + 每个 eN 有真 selector）', () => {
  it('从不带引号的 a11y 文本抽出交互元素、连续编号 eN、且每个 eN 有非空 selector', () => {
    const snap = buildCompactSnapshot('https://example.com', 'Example', BR14_TREE, {})

    // ① 只抽出可解析出 selector 的交互元素：link Home / textbox Search / link About Us。
    expect(snap.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3'])
    expect(snap.elements.map((e) => e.name)).toEqual(['Home', 'Search', 'About Us'])

    // ② 核心：修前名字解析失败 → name='' → selector 全空；修后每个 eN 都有非空 selector。
    for (const el of snap.elements) {
      expect(el.selector, `${el.ref} selector 不应为空`).not.toBe('')
    }
    // 名字落到 tag:has-text(name)（link → a、textbox → input）。
    expect(snap.elements[0].selector).toBe('a:has-text("Home")')
    expect(snap.elements[1].selector).toBe('input:has-text("Search")')
    expect(snap.elements[2].selector).toBe('a:has-text("About Us")')
  })

  it('③ 无名交互节点（[button] [disabled]）与非交互节点（[generic]）都不进', () => {
    const snap = buildCompactSnapshot('https://example.com', 'Example', BR14_TREE, {})
    // 无名 button 解不出 selector → 跳过；generic 非交互 → 跳过。
    expect(snap.elements.some((e) => e.tag === 'button')).toBe(false)
    expect(snap.elements.some((e) => e.tag === 'generic')).toBe(false)
    expect(snap.elements.length).toBe(3)
  })

  it('xpathMap 命中时 selector 用真 xpath（优先于 has-text 兜底）', () => {
    const snap = buildCompactSnapshot('https://example.com', 'Example', BR14_TREE, {
      '/html/body/nav/a[1]': 'Home',
    })
    const home = snap.elements.find((e) => e.name === 'Home')
    expect(home?.selector).toBe('xpath=/html/body/nav/a[1]')
  })

  it('属性括号里的 value="..." 不会被误当成名字', () => {
    const tree = '[textbox] Username [value="admin"]'
    const snap = buildCompactSnapshot('u', 't', tree, {})
    expect(snap.elements).toHaveLength(1)
    expect(snap.elements[0].name).toBe('Username')
    expect(snap.elements[0].selector).toBe('input:has-text("Username")')
  })

  it('兼容老的带引号名字格式（有引号优先取引号内）', () => {
    const tree = '[link] "Legacy Link" [focused]'
    const snap = buildCompactSnapshot('u', 't', tree, {})
    expect(snap.elements).toHaveLength(1)
    expect(snap.elements[0].name).toBe('Legacy Link')
    expect(snap.elements[0].selector).toBe('a:has-text("Legacy Link")')
  })
})

describe('compact-snapshot.buildRefMap（eN → selector 映射）', () => {
  it('每个 eN 映射到非空 selector', () => {
    const snap = buildCompactSnapshot('https://example.com', 'Example', BR14_TREE, {})
    const refMap = buildRefMap(snap)

    expect(refMap.size).toBe(3)
    for (const [ref, info] of refMap) {
      expect(info.selector, `${ref} selector 不应为空`).not.toBe('')
    }
    expect(refMap.get('e1')?.selector).toBe('a:has-text("Home")')
  })

  it('xpath 类 selector 会拆出 xpath 字段', () => {
    const snap = buildCompactSnapshot('u', 't', BR14_TREE, { '/html/body/a[2]': 'About Us' })
    const refMap = buildRefMap(snap)
    const about = refMap.get(snap.elements.find((e) => e.name === 'About Us')!.ref)
    expect(about?.selector).toBe('xpath=/html/body/a[2]')
    expect(about?.xpath).toBe('/html/body/a[2]')
  })
})

/**
 * BR-17：a11y 文本带行尾稳定句柄 `{b<backendDOMNodeId>}`，xpathMap 为 `Record<backendId, xpath>`。
 * 这是 `AccessibilityTreeBuilder.buildWithXPath` 的真实产出形状。
 */
const BR17_TREE = [
  '[RootWebArea] News {b1}', // 非交互 → 不进
  '[link] Hacker News {b10}',
  '[link] Hacker News {b11}', // 与上一条同名（重复文本）——必须拿到不同的精确 selector
  '[button] Submit {b12}',
  '[link] No Handle Link', // 无句柄、无 id → 退回 has-text
].join('\n')

const BR17_MAP: Record<string, string> = {
  '1': '/html[1]',
  '10': '/html[1]/body[1]/a[1]',
  '11': '/html[1]/body[1]/a[2]',
  '12': '/html[1]/body[1]/button[1]',
}

describe('compact-snapshot.buildCompactSnapshot（BR-17：句柄直取精确唯一 xpath）', () => {
  it('重复文本元素按 backendId 句柄各拿到不同的精确 xpath（核心修复）', () => {
    const snap = buildCompactSnapshot('https://news.ycombinator.com', 'HN', BR17_TREE, BR17_MAP)

    const links = snap.elements.filter((e) => e.name === 'Hacker News')
    expect(links).toHaveLength(2)
    // 同名但 selector 必须不同、且都是精确 xpath（修前两者都退化到同一 `a:has-text("Hacker News")`）。
    expect(links[0].selector).toBe('xpath=/html[1]/body[1]/a[1]')
    expect(links[1].selector).toBe('xpath=/html[1]/body[1]/a[2]')
    expect(links[0].selector).not.toBe(links[1].selector)
  })

  it('句柄不会污染名字；button 也走精确 xpath', () => {
    const snap = buildCompactSnapshot('u', 't', BR17_TREE, BR17_MAP)
    const submit = snap.elements.find((e) => e.tag === 'button')
    expect(submit?.name).toBe('Submit') // 名字里不该残留 {b12}
    expect(submit?.selector).toBe('xpath=/html[1]/body[1]/button[1]')
  })

  it('无句柄的交互元素仍退回 has-text 兜底（行为不回退）', () => {
    const snap = buildCompactSnapshot('u', 't', BR17_TREE, BR17_MAP)
    const noHandle = snap.elements.find((e) => e.name === 'No Handle Link')
    expect(noHandle?.selector).toBe('a:has-text("No Handle Link")')
  })

  it('句柄存在但 xpathMap 缺该 backendId 时不硬塞，退回 has-text', () => {
    const tree = '[link] Ghost {b999}'
    const snap = buildCompactSnapshot('u', 't', tree, BR17_MAP)
    expect(snap.elements).toHaveLength(1)
    expect(snap.elements[0].name).toBe('Ghost')
    expect(snap.elements[0].selector).toBe('a:has-text("Ghost")')
  })

  it('句柄与属性括号共存：先剥句柄，名字/属性解析不受影响', () => {
    const tree = '[textbox] Search [focused] {b7}'
    const snap = buildCompactSnapshot('u', 't', tree, { '7': '/html[1]/body[1]/input[1]' })
    expect(snap.elements).toHaveLength(1)
    expect(snap.elements[0].name).toBe('Search')
    expect(snap.elements[0].selector).toBe('xpath=/html[1]/body[1]/input[1]')
  })

  it('句柄与 value 属性共存：value 不被误当名字，selector 走精确 xpath', () => {
    const tree = '[textbox] Username [value="admin"] {b8}'
    const snap = buildCompactSnapshot('u', 't', tree, { '8': '/html[1]/body[1]/input[2]' })
    expect(snap.elements[0].name).toBe('Username')
    expect(snap.elements[0].selector).toBe('xpath=/html[1]/body[1]/input[2]')
  })

  it('buildRefMap 从精确 xpath selector 拆出 xpath 字段', () => {
    const snap = buildCompactSnapshot('u', 't', BR17_TREE, BR17_MAP)
    const refMap = buildRefMap(snap)
    const e1 = refMap.get('e1')
    expect(e1?.selector).toBe('xpath=/html[1]/body[1]/a[1]')
    expect(e1?.xpath).toBe('/html[1]/body[1]/a[1]')
  })

  it('buildBackendRefEntries：按 bN 键登记，指向与 eN 同一精确 xpath（一套寻址）', () => {
    const snap = buildCompactSnapshot('u', 't', BR17_TREE, BR17_MAP)
    const backendRefs = buildBackendRefEntries(snap)
    // 有句柄的元素按 b<backendId> 登记
    expect(backendRefs.get('b10')?.selector).toBe('xpath=/html[1]/body[1]/a[1]')
    expect(backendRefs.get('b11')?.selector).toBe('xpath=/html[1]/body[1]/a[2]')
    expect(backendRefs.get('b12')?.selector).toBe('xpath=/html[1]/body[1]/button[1]')
    expect(backendRefs.get('b10')?.xpath).toBe('/html[1]/body[1]/a[1]')
    // eN 与 bN 指向同一元素同一 selector
    const eRefs = buildRefMap(snap)
    expect(backendRefs.get('b10')?.selector).toBe(eRefs.get('e1')?.selector)
  })

  it('buildBackendRefEntries：无 backendId 的兜底元素（has-text）不登记 bN', () => {
    const snap = buildCompactSnapshot('u', 't', BR17_TREE, BR17_MAP)
    const backendRefs = buildBackendRefEntries(snap)
    // No Handle Link 无句柄 → 不进 bN 映射（键都是 b 开头且对应 backendId）
    for (const key of backendRefs.keys()) expect(key).toMatch(/^b\d+$/)
    expect(backendRefs.has('b999')).toBe(false)
  })

  it('BW-1：buildRefMap 写入 semantic 指纹与 backendId', () => {
    const snap = buildCompactSnapshot('u', 't', BR17_TREE, BR17_MAP)
    const refMap = buildRefMap(snap)
    const links = snap.elements.filter((e) => e.name === 'Hacker News')
    expect(links).toHaveLength(2)
    const first = refMap.get(links[0].ref)
    const second = refMap.get(links[1].ref)
    expect(first?.backendId).toBe('10')
    expect(first?.semantic).toEqual({ role: 'link', name: 'Hacker News', nth: 0 })
    expect(second?.semantic).toEqual({ role: 'link', name: 'Hacker News', nth: 1 })
  })
})

describe('compact-snapshot.formatCompactSnapshot（YAML-like 渲染）', () => {
  it('渲染出 url/title/elements + 每行 eN 带名字', () => {
    const snap = buildCompactSnapshot('https://example.com', 'Example', BR14_TREE, {})
    const text = formatCompactSnapshot(snap)
    expect(text).toContain('url: https://example.com')
    expect(text).toContain('title: Example')
    expect(text).toContain('e1: a "Home"')
    expect(text).toContain('e2: input "Search"')
  })
})
