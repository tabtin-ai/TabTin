import { describe, expect, it } from 'vitest'
import {
  formatSkillPanelTitle,
  formatUserSkillSlashName,
  isValidKebabSlug,
  resolveSkillCarryTitle,
  resolveSkillDisplayName,
  resolveUserSkillSlug,
  slugifySkillName,
  userCanonicalKeyFromSlug,
} from '../skillSlug'

describe('skillSlug', () => {
  it('slugifySkillName matches backend conventions', () => {
    expect(slugifySkillName('My Weekly Report')).toBe('my-weekly-report')
    expect(slugifySkillName('Plan Mode')).toBe('plan-mode')
    expect(slugifySkillName('/code-review/')).toBe('code-review')
    expect(slugifySkillName('')).toBe('skill')
  })

  it('userCanonicalKeyFromSlug', () => {
    expect(userCanonicalKeyFromSlug('code-review')).toBe('user:code-review')
  })

  it('isValidKebabSlug', () => {
    expect(isValidKebabSlug('code-review')).toBe(true)
    expect(isValidKebabSlug('-bad')).toBe(false)
  })

  it('formatUserSkillSlashName uses user slug only', () => {
    expect(formatUserSkillSlashName({
      slug: 'deep-explain',
      name: 'Deep Explain',
      skill_key: 'user:deep-explain',
    })).toBe('/deep-explain')
    expect(resolveUserSkillSlug({ name: 'Plan Mode' })).toBe('plan-mode')
    expect(formatUserSkillSlashName({ name: 'Plan Mode' })).toBe('/plan-mode')
  })

  it('formatSkillPanelTitle keeps domain for platform keys, last segment for app/user', () => {
    expect(formatSkillPanelTitle({
      source: 'app',
      skill_key: 'app:tabcode/tabcode-operator',
      name: 'TabCode Operator',
    })).toBe('/tabcode-operator')
    // platform 保留 domain，区分 device/mcp/tabslide 三个同名 operations
    expect(formatSkillPanelTitle({
      source: 'platform',
      skill_key: 'platform:device/operations',
      name: 'Device Operations',
    })).toBe('/device-operations')
    expect(formatSkillPanelTitle({
      source: 'platform',
      skill_key: 'platform:mcp/operations',
      name: 'MCP Operations',
    })).toBe('/mcp-operations')
    expect(formatSkillPanelTitle({
      source: 'user',
      skill_key: 'user:deep-explain',
      name: 'Deep Explain',
    })).toBe('/deep-explain')
  })

  it('resolveSkillCarryTitle 去掉 pack 前缀，保留人话名字', () => {
    expect(resolveSkillCarryTitle({
      name: 'tabtin-data-ai-pack/table-data-production',
      skill_key: 'app:tabtin-data-ai-pack/table-data-production',
    })).toBe('table-data-production')
    expect(resolveSkillCarryTitle({
      name: 'tabtin-document-ai-pack/ppt-master',
      skill_key: 'app:tabtin-document-ai-pack/ppt-master',
    })).toBe('ppt-master')
    expect(resolveSkillCarryTitle({
      display_name: 'Table Operator',
      name: 'tabdata/table-operator',
      skill_key: 'app:tabdata/table-operator',
    })).toBe('Table Operator')
    expect(resolveSkillDisplayName({
      name: 'tabtin-data-ai-pack/table-data-production',
      skill_key: 'app:tabtin-data-ai-pack/table-data-production',
    })).toBe('Table Data Production')
  })
})
