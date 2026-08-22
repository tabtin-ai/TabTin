/**
 * Tests for CE-P1 remaining media-capabilities / tabslide wiring.
 *
 * - CE-P1-02: daemon declares @tabtin/media-capabilities
 * - CE-P1-06: tabvideo_build_and_export removed from manifest
 * - CE-P1-08: @tabtin/tabslide headless.ts re-exports exportToPPTXBlob
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..')

describe('CE-P1-02: daemon declares media-capabilities', () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'apps/tabtin-daemon/package.json'), 'utf-8'),
  )

  it('has @tabtin/media-capabilities in dependencies', () => {
    expect(pkg.dependencies['@tabtin/media-capabilities']).toBe('workspace:*')
  })

  it('does not declare retired @tabtin/tabvideo-engine', () => {
    expect(pkg.dependencies['@tabtin/tabvideo-engine']).toBeUndefined()
  })

  it('still has @tabtin/action-tools (transitive host)', () => {
    expect(pkg.dependencies['@tabtin/action-tools']).toBe('workspace:*')
  })
})

describe('CE-P1-06: tabvideo_build_and_export removed (dead tool cleanup)', () => {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/action-tools/manifest.json'), 'utf-8'),
  )
  const tool = manifest.tools.find(
    (t: any) => t.name === 'tabvideo_build_and_export',
  )

  it('tool no longer exists in manifest', () => {
    expect(tool).toBeUndefined()
  })
})

describe('CE-P1-08: tabslide headless.ts exports PPTX helpers', () => {
  const headlessSrc = readFileSync(
    join(REPO_ROOT, 'packages/tabslide/src/headless.ts'),
    'utf-8',
  )

  it('re-exports exportToPPTXBlob', () => {
    expect(headlessSrc).toContain('exportToPPTXBlob')
  })

  it('re-exports PPTXExportOptions type', () => {
    expect(headlessSrc).toContain('PPTXExportOptions')
  })

  it('re-exports PPTXExportWarning type', () => {
    expect(headlessSrc).toContain('PPTXExportWarning')
  })
})
