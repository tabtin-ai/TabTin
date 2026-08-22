/**
 * 跨端路径契约：与 Django ``tests/workspace_file/test_path_contract.py`` 同构。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalizeArtifactRelativePath,
  isDeliverableRelativePath,
} from '@/components/chat/turn/turnArtifactPathOps'
import { MATERIALIZE_MAX_BYTES, SIGNED_URL_TTL_SECONDS } from '@shared/session-share-preview-contract'

const CANONICALIZE_CASES: Array<[string, string | null]> = [
  ['./artifacts/report.xlsx', 'artifacts/report.xlsx'],
  ['artifacts/../artifacts/a.md', 'artifacts/a.md'],
  ['foo\\bar.txt', 'foo/bar.txt'],
  ['/etc/passwd', null],
  ['~/secret.txt', null],
  ['C:\\Users\\a.txt', null],
  ['tabtin://resource/file/a.txt', null],
  ['../escape.txt', null],
  ['', null],
]

const DELIVERABLE_CASES: Array<[string, boolean]> = [
  ['artifacts/a.xlsx', true],
  ['tmp/a.xlsx', false],
  ['.hidden/a.xlsx', false],
  ['artifacts/README', false],
  ['artifacts/.env', false],
]

describe('session-share preview path contract ', () => {
  it.each(CANONICALIZE_CASES)('canonicalize %# %s', (raw, expected) => {
    expect(canonicalizeArtifactRelativePath(raw)).toBe(expected)
  })

  it.each(DELIVERABLE_CASES)('deliverable %# %s', (raw, expected) => {
    expect(isDeliverableRelativePath(raw)).toBe(expected)
  })

  it('materialize / signed-url limits match Django constants', () => {
    expect(MATERIALIZE_MAX_BYTES).toBe(50 * 1024 * 1024)
    expect(SIGNED_URL_TTL_SECONDS).toBe(15 * 60)
  })
})
