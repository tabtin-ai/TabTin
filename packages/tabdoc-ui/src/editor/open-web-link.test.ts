import { describe, expect, it } from 'vitest'

import { resolveTabDocWebLinkInput } from './open-web-link'

describe('resolveTabDocWebLinkInput', () => {
  it('把正文附件名作为打开意图提示传给宿主', () => {
    const anchor = document.createElement('a')
    anchor.href = 'https://assets.example.com/object'
    anchor.download = '36氪简报-样例.md'
    anchor.textContent = '查看附件'

    expect(resolveTabDocWebLinkInput(anchor)).toEqual({
      url: 'https://assets.example.com/object',
      openIntentHints: {
        filename: '36氪简报-样例.md',
      },
    })
  })

  it('依次回退到 title 和可见文本，并忽略非 http(s) 链接', () => {
    const titled = document.createElement('a')
    titled.setAttribute('href', 'https://assets.example.com/object')
    titled.title = '报告.pdf'
    titled.textContent = '查看附件'
    expect(resolveTabDocWebLinkInput(titled)?.openIntentHints?.filename).toBe('报告.pdf')

    const textOnly = document.createElement('a')
    textOnly.setAttribute('href', 'https://assets.example.com/object')
    textOnly.textContent = ' 数据表.xlsx '
    expect(resolveTabDocWebLinkInput(textOnly)?.openIntentHints?.filename).toBe('数据表.xlsx')

    const internal = document.createElement('a')
    internal.setAttribute('href', 'tabtin://resource/document/doc-1')
    expect(resolveTabDocWebLinkInput(internal)).toBeNull()
  })

  it('支持点击链接内部元素', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'https://example.com')
    anchor.textContent = 'Example'
    const child = document.createElement('span')
    anchor.appendChild(child)

    expect(resolveTabDocWebLinkInput(child)).toEqual({
      url: 'https://example.com',
      openIntentHints: {
        filename: 'Example',
      },
    })
  })
})
