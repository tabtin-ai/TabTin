import { describe, expect, it } from 'vitest'
import {
  STARTER_SUGGESTION_MODULES,
  resolveStarterContextLabelKey,
  resolveStarterSuggestionAppKey,
  resolveStarterSuggestions,
} from '../starterSuggestions'

describe('resolveStarterSuggestionAppKey', () => {
  it('maps known apps and falls back to default', () => {
    expect(resolveStarterSuggestionAppKey(null)).toBe('default')
    expect(resolveStarterSuggestionAppKey(undefined)).toBe('default')
    expect(resolveStarterSuggestionAppKey('terminal')).toBe('default')
    expect(resolveStarterSuggestionAppKey('tabdoc')).toBe('tabdoc')
    expect(resolveStarterSuggestionAppKey('tabdata')).toBe('tabdata')
    expect(resolveStarterSuggestionAppKey('tabweb')).toBe('tabweb')
    expect(resolveStarterSuggestionAppKey('tabcode')).toBe('tabcode')
    expect(resolveStarterSuggestionAppKey('tabfolder')).toBe('tabcode')
  })
})

describe('resolveStarterSuggestions', () => {
  it('returns the fallback app key when no app is focused', () => {
    const result = resolveStarterSuggestions(null)
    expect(result.appKey).toBe('default')
    expect(result.suggestions).toHaveLength(4)
  })

  it('exposes four suggestions in each empty-state module', () => {
    expect(STARTER_SUGGESTION_MODULES).toHaveLength(3)
    expect(STARTER_SUGGESTION_MODULES.map(module => module.key)).toEqual([
      'tabdoc',
      'tabdata',
      'tabweb',
    ])
    expect(STARTER_SUGGESTION_MODULES.every(module => module.suggestions.length === 4)).toBe(true)
  })

  it('returns app-specific sets without changing on unknown types', () => {
    expect(resolveStarterSuggestions('tabdoc').suggestions[0]?.id).toBe('tabdoc-outline')
    expect(resolveStarterSuggestions('tabdata').suggestions[0]?.id).toBe('tabdata-design')
    expect(resolveStarterSuggestions('tabweb').suggestions[0]?.id).toBe('tabweb-summarize')
    expect(resolveStarterSuggestions('tabcode').suggestions[0]?.id).toBe('tabcode-structure')
    expect(resolveStarterSuggestions('tabfolder').appKey).toBe('tabcode')
  })

  it('keeps the same appKey when only resource title would change', () => {
    const a = resolveStarterSuggestions('tabdoc')
    const b = resolveStarterSuggestions('tabdoc')
    expect(a.appKey).toBe(b.appKey)
    expect(a.suggestions).toEqual(b.suggestions)
  })
})

describe('resolveStarterContextLabelKey', () => {
  it('returns null for default and keys for known apps', () => {
    expect(resolveStarterContextLabelKey('default')).toBeNull()
    expect(resolveStarterContextLabelKey('tabdoc')).toBe(
      'input.starterSuggestions.contextLabel.tabdoc',
    )
  })
})
