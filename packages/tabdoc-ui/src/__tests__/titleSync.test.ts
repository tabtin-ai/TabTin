import { describe, it, expect } from 'vitest'
import {
  UNTITLED_DOCUMENT_FALLBACK,
  MAX_DOCUMENT_TITLE_LENGTH,
  isUntitledTitle,
  displayTitleFromDoc,
  normalizeTitleInputValue,
  decideTitleSync,
} from '../editor/titleSync'

describe('MAX_DOCUMENT_TITLE_LENGTH', () => {
  it('与后端 Document.title max_length=255 对齐', () => {
    expect(MAX_DOCUMENT_TITLE_LENGTH).toBe(255)
  })
})

describe('isUntitledTitle', () => {
  it('空 / 哨值视为未命名', () => {
    expect(isUntitledTitle('')).toBe(true)
    expect(isUntitledTitle(null)).toBe(true)
    expect(isUntitledTitle(undefined)).toBe(true)
    expect(isUntitledTitle(UNTITLED_DOCUMENT_FALLBACK)).toBe(true)
    expect(isUntitledTitle(`  ${UNTITLED_DOCUMENT_FALLBACK}  `)).toBe(true)
  })

  it('真实标题不算未命名', () => {
    expect(isUntitledTitle('Hello')).toBe(false)
  })
})

describe('displayTitleFromDoc', () => {
  it('未命名映射为空字符串以露出 placeholder', () => {
    expect(displayTitleFromDoc(UNTITLED_DOCUMENT_FALLBACK)).toBe('')
    expect(displayTitleFromDoc(null)).toBe('')
  })

  it('真实标题原样返回', () => {
    expect(displayTitleFromDoc('Hello')).toBe('Hello')
  })
})

describe('normalizeTitleInputValue', () => {
  it('把 textarea 产生的硬换行归一为空格，保持标题业务值为单行', () => {
    expect(normalizeTitleInputValue('第一行\n第二行\r\n第三行')).toBe('第一行 第二行 第三行')
  })
})

describe('decideTitleSync（ 回归）', () => {
  it('切换 / 重新打开文档：doc.id 变化时无条件 reset（即使本地有未提交编辑）', () => {
    expect(decideTitleSync({ prevDocId: 'a', nextDocId: 'b', hasPendingEdit: false })).toBe('reset')
    expect(decideTitleSync({ prevDocId: 'a', nextDocId: 'b', hasPendingEdit: true })).toBe('reset')
  })

  it('首次挂载（prev 为 undefined → 真实 id）也按切换处理', () => {
    expect(decideTitleSync({ prevDocId: undefined, nextDocId: 'a', hasPendingEdit: false })).toBe('reset')
  })

  it('同文档内、本地正在编辑标题：忽略外部回写（防止旧值灌回跳变）', () => {
    expect(decideTitleSync({ prevDocId: 'a', nextDocId: 'a', hasPendingEdit: true })).toBe('ignore')
    expect(decideTitleSync({ prevDocId: 'a', nextDocId: 'a', hasPendingEdit: false, hasLocalEdit: true })).toBe('ignore')
  })

  it('同文档内、本地无待提交编辑：采纳外部值（协作改名 / 自己提交成功的回写）', () => {
    expect(decideTitleSync({ prevDocId: 'a', nextDocId: 'a', hasPendingEdit: false })).toBe('adopt')
    expect(decideTitleSync({ prevDocId: 'a', nextDocId: 'a', hasPendingEdit: false, hasLocalEdit: false })).toBe('adopt')
  })

  it('debounce 清空 timer 后、commit 尚未置 pending 的窗口仍视为本地编辑', () => {
    expect(decideTitleSync({
      prevDocId: 'a',
      nextDocId: 'a',
      hasPendingEdit: false,
      hasLocalEdit: true,
    })).toBe('ignore')
  })
})
