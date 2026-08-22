import { describe, expect, it } from 'vitest'
import { resolveCurrentSkillVersionLabel } from '../skillCurrentVersion'
import type { SkillIndexEntry, SkillVersion } from '@/skills/types'

function skill(partial: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: 's1',
    name: 'Demo',
    source: 'user',
    ...partial,
  }
}

describe('resolveCurrentSkillVersionLabel', () => {
  it('优先用 installed_version_label', () => {
    expect(resolveCurrentSkillVersionLabel(skill({
      installed_version_label: '0.0.1',
      installed_version_seq: 1,
      latest_version_label: '0.0.2',
      latest_version_seq: 2,
    }))).toBe('v0.0.1')
  })

  it('缺 label 时从版本列表按 currentSeq 解析，绝不显示 v{seq}', () => {
    const versions: SkillVersion[] = [
      {
        version_seq: 1,
        version_label: '0.0.1',
        change_note: '',
        published_at: null,
        review_status: 'not_required',
        bundle_sha256: '',
      },
      {
        version_seq: 2,
        version_label: '0.0.2',
        change_note: '',
        published_at: null,
        review_status: 'not_required',
        bundle_sha256: '',
      },
    ]
    expect(resolveCurrentSkillVersionLabel(skill({
      installed_version_seq: 1,
      latest_version_seq: 2,
      latest_version_label: '0.0.2',
    }), versions)).toBe('v0.0.1')
  })

  it('钉在旧版且无 label、无版本列表时不回退成 v2', () => {
    expect(resolveCurrentSkillVersionLabel(skill({
      installed_version_seq: 2,
      latest_version_seq: 3,
      latest_version_label: '0.0.3',
    }))).toBeNull()
  })

  it('未安装时回退最新发布 label', () => {
    expect(resolveCurrentSkillVersionLabel(skill({
      installed_version_seq: null,
      latest_version_seq: 2,
      latest_version_label: '0.0.2',
    }))).toBe('v0.0.2')
  })
})
