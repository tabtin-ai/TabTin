import { describe, it, expect } from 'vitest'
import { hotkeyLabel, HOTKEYS } from './hotkeys'

describe('hotkeys', () => {
  it('cycleAgentMode hotkey is defined', () => {
    expect(HOTKEYS.cycleAgentMode).toEqual({ key: '.', mod: true, shift: true })
  })

  it('hotkeyLabel formats cycleAgentMode correctly', () => {
    const label = hotkeyLabel(HOTKEYS.cycleAgentMode)
    expect(label).toContain('.')
    expect(label.length).toBeGreaterThan(1)
  })

  it('hotkeyLabel formats quickOpen correctly', () => {
    const label = hotkeyLabel(HOTKEYS.quickOpen)
    expect(label).toContain('P')
  })
})
