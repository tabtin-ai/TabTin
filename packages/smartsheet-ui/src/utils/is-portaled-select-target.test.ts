import { describe, expect, it } from 'vitest'
import { isPortaledSelectTarget } from './is-portaled-select-target'

describe('isPortaledSelectTarget', () => {
  it('detects select content and popper wrapper', () => {
    const content = document.createElement('div')
    content.setAttribute('data-radix-select-content', '')
    const item = document.createElement('div')
    content.appendChild(item)
    document.body.appendChild(content)

    expect(isPortaledSelectTarget(item)).toBe(true)
    content.remove()
  })

  it('returns false for unrelated nodes', () => {
    const node = document.createElement('div')
    document.body.appendChild(node)
    expect(isPortaledSelectTarget(node)).toBe(false)
    node.remove()
  })
})
