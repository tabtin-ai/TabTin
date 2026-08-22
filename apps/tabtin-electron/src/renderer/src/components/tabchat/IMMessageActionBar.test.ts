import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('IMMessageActionBar stacking', () => {
  it('悬停操作条使用 z-floating，不得抬到 dropdown/modal 以免盖住续接向导弹窗', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'IMMessageActionBar.tsx'),
      'utf8',
    )
    expect(source).toContain('data-im-message-action-bar')
    expect(source).toContain('IM_MESSAGE_ACTION_BAR_CLASS')
    const tokens = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'tabchatUi.ts'),
      'utf8',
    )
    const className = tokens.match(/export const IM_MESSAGE_ACTION_BAR_CLASS =\s*'([^']+)'/)?.[1]
    expect(className).toBeTruthy()
    expect(className).toContain('absolute top-0')
    expect(className).toContain('z-floating')
    expect(className).not.toMatch(/z-(dropdown|modal|toast|global|overlay)/)
  })

  it('弹层打开时用 CSS 收起消息悬停条，避免半透明遮罩下仍露出操作条', () => {
    const globals = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../styles/globals.css'),
      'utf8',
    )
    expect(globals).toContain(
      'body:has([data-radix-dialog-overlay][data-state="open"]) [data-im-message-action-bar]',
    )
  })
})
