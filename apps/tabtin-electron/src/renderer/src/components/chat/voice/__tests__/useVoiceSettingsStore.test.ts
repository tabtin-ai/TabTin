import { describe, expect, it, beforeEach } from 'vitest'
import {
  useVoiceSettingsStore,
  parseShortcut,
  formatShortcut,
  eventToShortcut,
  matchesShortcut,
  DEFAULT_VOICE_SHORTCUT,
} from '@/stores/useVoiceSettingsStore'

function resetStore() {
  useVoiceSettingsStore.setState({
    enabled: true,
    enableAppContext: true,
    enableDialogContext: true,
    customHotwords: [],
    replacementRules: [],
    voiceShortcut: DEFAULT_VOICE_SHORTCUT,
  })
}

describe('useVoiceSettingsStore', () => {
  beforeEach(resetStore)

  describe('hotwords', () => {
    it('should add a hotword', () => {
      expect(useVoiceSettingsStore.getState().addHotword('TabTin')).toBe('added')
      expect(useVoiceSettingsStore.getState().customHotwords).toEqual(['TabTin'])
    })

    it('should trim whitespace', () => {
      expect(useVoiceSettingsStore.getState().addHotword('  hello  ')).toBe('added')
      expect(useVoiceSettingsStore.getState().customHotwords).toEqual(['hello'])
    })

    it('should ignore empty strings', () => {
      expect(useVoiceSettingsStore.getState().addHotword('')).toBe('empty')
      expect(useVoiceSettingsStore.getState().addHotword('   ')).toBe('empty')
      expect(useVoiceSettingsStore.getState().customHotwords).toEqual([])
    })

    it('should deduplicate and report duplicate', () => {
      expect(useVoiceSettingsStore.getState().addHotword('word')).toBe('added')
      expect(useVoiceSettingsStore.getState().addHotword('word')).toBe('duplicate')
      expect(useVoiceSettingsStore.getState().customHotwords).toEqual(['word'])
    })

    it('should enforce max limit (100)', () => {
      for (let i = 0; i < 100; i++) {
        expect(useVoiceSettingsStore.getState().addHotword(`word${i}`)).toBe('added')
      }
      expect(useVoiceSettingsStore.getState().addHotword('overflow')).toBe('full')
      expect(useVoiceSettingsStore.getState().customHotwords).toHaveLength(100)
    })

    it('should remove by index', () => {
      useVoiceSettingsStore.getState().addHotword('a')
      useVoiceSettingsStore.getState().addHotword('b')
      useVoiceSettingsStore.getState().addHotword('c')
      useVoiceSettingsStore.getState().removeHotword(1)
      expect(useVoiceSettingsStore.getState().customHotwords).toEqual(['a', 'c'])
    })

    it('should ignore invalid index', () => {
      useVoiceSettingsStore.getState().addHotword('a')
      useVoiceSettingsStore.getState().removeHotword(-1)
      useVoiceSettingsStore.getState().removeHotword(5)
      expect(useVoiceSettingsStore.getState().customHotwords).toEqual(['a'])
    })
  })

  describe('replacementRules', () => {
    it('should add a rule', () => {
      expect(useVoiceSettingsStore.getState().addReplacementRule('从', '到')).toBe('added')
      const rules = useVoiceSettingsStore.getState().replacementRules
      expect(rules).toHaveLength(1)
      expect(rules[0].from).toBe('从')
      expect(rules[0].to).toBe('到')
      expect(rules[0].isEnabled).toBe(true)
    })

    it('should ignore empty from', () => {
      expect(useVoiceSettingsStore.getState().addReplacementRule('', '到')).toBe('empty')
      expect(useVoiceSettingsStore.getState().addReplacementRule('  ', '到')).toBe('empty')
      expect(useVoiceSettingsStore.getState().replacementRules).toHaveLength(0)
    })

    it('should allow empty to (deletion rule)', () => {
      expect(useVoiceSettingsStore.getState().addReplacementRule('bad', '')).toBe('added')
      const rules = useVoiceSettingsStore.getState().replacementRules
      expect(rules).toHaveLength(1)
      expect(rules[0].to).toBe('')
    })

    it('should reject when from equals to', () => {
      expect(useVoiceSettingsStore.getState().addReplacementRule('哈哈', '哈哈')).toBe('same')
      expect(useVoiceSettingsStore.getState().addReplacementRule('  同  ', '同')).toBe('same')
      expect(useVoiceSettingsStore.getState().replacementRules).toHaveLength(0)
    })

    it('should deduplicate by from and report duplicate', () => {
      expect(useVoiceSettingsStore.getState().addReplacementRule('from', 'to1')).toBe('added')
      expect(useVoiceSettingsStore.getState().addReplacementRule('from', 'to2')).toBe('duplicate')
      expect(useVoiceSettingsStore.getState().replacementRules).toHaveLength(1)
      expect(useVoiceSettingsStore.getState().replacementRules[0].to).toBe('to1')
    })

    it('should enforce max limit (50)', () => {
      for (let i = 0; i < 50; i++) {
        expect(useVoiceSettingsStore.getState().addReplacementRule(`from${i}`, `to${i}`)).toBe('added')
      }
      expect(useVoiceSettingsStore.getState().addReplacementRule('overflow', 'x')).toBe('full')
      expect(useVoiceSettingsStore.getState().replacementRules).toHaveLength(50)
    })

    it('should toggle a rule', () => {
      useVoiceSettingsStore.getState().addReplacementRule('a', 'b')
      const id = useVoiceSettingsStore.getState().replacementRules[0].id
      useVoiceSettingsStore.getState().toggleReplacementRule(id)
      expect(useVoiceSettingsStore.getState().replacementRules[0].isEnabled).toBe(false)
      useVoiceSettingsStore.getState().toggleReplacementRule(id)
      expect(useVoiceSettingsStore.getState().replacementRules[0].isEnabled).toBe(true)
    })

    it('should remove a rule', () => {
      useVoiceSettingsStore.getState().addReplacementRule('a', 'b')
      useVoiceSettingsStore.getState().addReplacementRule('c', 'd')
      const id = useVoiceSettingsStore.getState().replacementRules[0].id
      useVoiceSettingsStore.getState().removeReplacementRule(id)
      expect(useVoiceSettingsStore.getState().replacementRules).toHaveLength(1)
      expect(useVoiceSettingsStore.getState().replacementRules[0].from).toBe('c')
    })
  })

  describe('mergedHotwords', () => {
    it('should include platform hotwords', () => {
      const merged = useVoiceSettingsStore.getState().mergedHotwords()
      expect(merged).toContain('TabTin')
      expect(merged).toContain('TabData')
    })

    it('should include app hotwords when enableAppContext=true', () => {
      const merged = useVoiceSettingsStore.getState().mergedHotwords(['MyProject', 'MySpace'])
      expect(merged).toContain('MyProject')
      expect(merged).toContain('MySpace')
    })

    it('should exclude app hotwords when enableAppContext=false', () => {
      useVoiceSettingsStore.setState({ enableAppContext: false })
      const merged = useVoiceSettingsStore.getState().mergedHotwords(['MyProject'])
      expect(merged).not.toContain('MyProject')
    })

    it('should include custom hotwords', () => {
      useVoiceSettingsStore.getState().addHotword('CustomWord')
      const merged = useVoiceSettingsStore.getState().mergedHotwords()
      expect(merged).toContain('CustomWord')
    })

    it('should deduplicate', () => {
      useVoiceSettingsStore.getState().addHotword('TabTin')
      const merged = useVoiceSettingsStore.getState().mergedHotwords()
      const count = merged.filter(w => w === 'TabTin').length
      expect(count).toBe(1)
    })
  })

  describe('applyReplacements', () => {
    it('should apply enabled rules', () => {
      useVoiceSettingsStore.getState().addReplacementRule('hello', 'hi')
      const result = useVoiceSettingsStore.getState().applyReplacements('hello world hello')
      expect(result).toBe('hi world hi')
    })

    it('should skip disabled rules', () => {
      useVoiceSettingsStore.getState().addReplacementRule('hello', 'hi')
      const id = useVoiceSettingsStore.getState().replacementRules[0].id
      useVoiceSettingsStore.getState().toggleReplacementRule(id)
      const result = useVoiceSettingsStore.getState().applyReplacements('hello world')
      expect(result).toBe('hello world')
    })

    it('should apply multiple rules in order', () => {
      useVoiceSettingsStore.getState().addReplacementRule('a', 'b')
      useVoiceSettingsStore.getState().addReplacementRule('b', 'c')
      const result = useVoiceSettingsStore.getState().applyReplacements('a')
      expect(result).toBe('c')
    })

    it('should handle empty text', () => {
      useVoiceSettingsStore.getState().addReplacementRule('a', 'b')
      const result = useVoiceSettingsStore.getState().applyReplacements('')
      expect(result).toBe('')
    })

    it('should return original text when no rules', () => {
      const result = useVoiceSettingsStore.getState().applyReplacements('hello')
      expect(result).toBe('hello')
    })

    it('should handle deletion rules (empty to)', () => {
      useVoiceSettingsStore.getState().addReplacementRule('嗯', '')
      const result = useVoiceSettingsStore.getState().applyReplacements('嗯好的嗯')
      expect(result).toBe('好的')
    })

    // ：渐进 interim 片段上的 replace 语义（接线见 useVoiceRecording.replacements）。
    it('should correct progressive interim-like fragments', () => {
      useVoiceSettingsStore.getState().addReplacementRule('嗯', '')
      const apply = (text: string) => useVoiceSettingsStore.getState().applyReplacements(text)
      expect(apply('嗯')).toBe('')
      expect(apply('嗯好')).toBe('好')
      expect(apply('嗯好的')).toBe('好的')
    })
  })

  describe('toggles', () => {
    it('should toggle enableAppContext', () => {
      useVoiceSettingsStore.getState().setEnableAppContext(false)
      expect(useVoiceSettingsStore.getState().enableAppContext).toBe(false)
      useVoiceSettingsStore.getState().setEnableAppContext(true)
      expect(useVoiceSettingsStore.getState().enableAppContext).toBe(true)
    })

    it('should toggle enableDialogContext', () => {
      useVoiceSettingsStore.getState().setEnableDialogContext(false)
      expect(useVoiceSettingsStore.getState().enableDialogContext).toBe(false)
    })
  })

  describe('enabled (master switch)', () => {
    it('should default to enabled=true', () => {
      expect(useVoiceSettingsStore.getState().enabled).toBe(true)
    })

    it('should toggle via setEnabled', () => {
      useVoiceSettingsStore.getState().setEnabled(false)
      expect(useVoiceSettingsStore.getState().enabled).toBe(false)
      useVoiceSettingsStore.getState().setEnabled(true)
      expect(useVoiceSettingsStore.getState().enabled).toBe(true)
    })

    it('should preserve hotwords and rules when toggling enabled', () => {
      useVoiceSettingsStore.getState().addHotword('keep-me')
      useVoiceSettingsStore.getState().addReplacementRule('a', 'b')
      useVoiceSettingsStore.getState().setEnabled(false)
      expect(useVoiceSettingsStore.getState().customHotwords).toEqual(['keep-me'])
      expect(useVoiceSettingsStore.getState().replacementRules).toHaveLength(1)
    })
  })

  describe('voiceShortcut', () => {
    it('should have default shortcut', () => {
      expect(useVoiceSettingsStore.getState().voiceShortcut).toBe(DEFAULT_VOICE_SHORTCUT)
    })

    it('should set a valid shortcut', () => {
      useVoiceSettingsStore.getState().setVoiceShortcut('mod+shift+v')
      expect(useVoiceSettingsStore.getState().voiceShortcut).toBe('mod+shift+v')
    })

    it('should reject shortcut without mod key', () => {
      useVoiceSettingsStore.getState().setVoiceShortcut('shift+v')
      expect(useVoiceSettingsStore.getState().voiceShortcut).toBe(DEFAULT_VOICE_SHORTCUT)
    })

    it('should reject shortcut without main key', () => {
      useVoiceSettingsStore.getState().setVoiceShortcut('mod+shift+')
      expect(useVoiceSettingsStore.getState().voiceShortcut).toBe(DEFAULT_VOICE_SHORTCUT)
    })

    it('should reset to default', () => {
      useVoiceSettingsStore.getState().setVoiceShortcut('mod+alt+k')
      useVoiceSettingsStore.getState().resetVoiceShortcut()
      expect(useVoiceSettingsStore.getState().voiceShortcut).toBe(DEFAULT_VOICE_SHORTCUT)
    })
  })
})

describe('parseShortcut', () => {
  it('should parse mod+shift+m', () => {
    const result = parseShortcut('mod+shift+m')
    expect(result).toEqual({ mod: true, shift: true, alt: false, key: 'm' })
  })

  it('should parse mod+alt+shift+k', () => {
    const result = parseShortcut('mod+alt+shift+k')
    expect(result).toEqual({ mod: true, shift: true, alt: true, key: 'k' })
  })

  it('should parse mod+v (no shift)', () => {
    const result = parseShortcut('mod+v')
    expect(result).toEqual({ mod: true, shift: false, alt: false, key: 'v' })
  })

  it('should handle case insensitivity', () => {
    const result = parseShortcut('MOD+SHIFT+M')
    expect(result).toEqual({ mod: true, shift: true, alt: false, key: 'm' })
  })

  it('should parse "plus" as key name', () => {
    const result = parseShortcut('mod+plus')
    expect(result).toEqual({ mod: true, shift: false, alt: false, key: 'plus' })
  })

  it('should parse "space" as key name', () => {
    const result = parseShortcut('mod+shift+space')
    expect(result).toEqual({ mod: true, shift: true, alt: false, key: 'space' })
  })

  it('should handle trailing empty parts from split', () => {
    const result = parseShortcut('mod+shift+')
    expect(result.key).toBe('')
  })
})

describe('eventToShortcut', () => {
  function fakeEvent(overrides: Partial<globalThis.KeyboardEvent>): globalThis.KeyboardEvent {
    return {
      key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      ...overrides,
    } as any
  }

  it('should return null for modifier-only keys', () => {
    expect(eventToShortcut(fakeEvent({ key: 'Control', ctrlKey: true }))).toBeNull()
    expect(eventToShortcut(fakeEvent({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(eventToShortcut(fakeEvent({ key: 'Meta', metaKey: true }))).toBeNull()
  })

  it('should return null when no modifier is pressed', () => {
    expect(eventToShortcut(fakeEvent({ key: 'm' }))).toBeNull()
  })

  it('should build shortcut string from event (non-Mac: ctrlKey = mod)', () => {
    const result = eventToShortcut(fakeEvent({ key: 'm', ctrlKey: true, shiftKey: true }))
    expect(result).toBe('mod+shift+m')
  })

  it('should normalize Space key', () => {
    const result = eventToShortcut(fakeEvent({ key: ' ', ctrlKey: true }))
    expect(result).toBe('mod+space')
  })

  it('should normalize + key to "plus"', () => {
    const result = eventToShortcut(fakeEvent({ key: '+', ctrlKey: true, shiftKey: true }))
    expect(result).toBe('mod+shift+plus')
  })

  it('should normalize arrow keys', () => {
    const result = eventToShortcut(fakeEvent({ key: 'ArrowUp', ctrlKey: true }))
    expect(result).toBe('mod+up')
  })

  it('should reject dead keys', () => {
    expect(eventToShortcut(fakeEvent({ key: 'Dead', ctrlKey: true }))).toBeNull()
  })
})

describe('matchesShortcut', () => {
  function fakeEvent(overrides: Partial<globalThis.KeyboardEvent>): globalThis.KeyboardEvent {
    return {
      key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      ...overrides,
    } as any
  }

  it('should match correct shortcut', () => {
    const e = fakeEvent({ key: 'm', ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(e, 'mod+shift+m')).toBe(true)
  })

  it('should not match when key differs', () => {
    const e = fakeEvent({ key: 'v', ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(e, 'mod+shift+m')).toBe(false)
  })

  it('should not match when modifier missing', () => {
    const e = fakeEvent({ key: 'm', shiftKey: true })
    expect(matchesShortcut(e, 'mod+shift+m')).toBe(false)
  })

  it('should not match when extra modifier pressed', () => {
    const e = fakeEvent({ key: 'm', ctrlKey: true, shiftKey: true, altKey: true })
    expect(matchesShortcut(e, 'mod+shift+m')).toBe(false)
  })

  it('should not match empty shortcut', () => {
    const e = fakeEvent({ key: 'm', ctrlKey: true })
    expect(matchesShortcut(e, '')).toBe(false)
  })

  it('should match Space key via normalized name', () => {
    const e = fakeEvent({ key: ' ', ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(e, 'mod+shift+space')).toBe(true)
  })

  it('should match arrow key via normalized name', () => {
    const e = fakeEvent({ key: 'ArrowUp', ctrlKey: true })
    expect(matchesShortcut(e, 'mod+up')).toBe(true)
  })
})
