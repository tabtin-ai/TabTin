import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { applyDeployPackageTransforms } from '../../../scripts/prepare-deploy-package.mjs'

function extraResourceFilter(from: string): string[] {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    build: { extraResources: Array<{ from?: string; filter?: string[] }> }
  }
  const entry = packageJson.build.extraResources.find((item) => item.from === from)
  if (!entry?.filter) {
    throw new Error(`missing extraResources filter for ${from}`)
  }
  return entry.filter
}

describe('prepare-deploy-package office preview runtime resources', () => {
  it('requires the packaged office runtime extraResources to include both archive and manifest', () => {
    expect(extraResourceFilter('../../packages/office-preview-runtime/runtime')).toEqual(
      expect.arrayContaining(['manifest.json', 'office-preview-runtime.tar.gz']),
    )
  })

  it('rewrites the office preview runtime extraResource into the deploy package source', () => {
    const pkg = {
      build: {
        extraResources: [
          {
            from: '../../packages/office-preview-runtime/runtime',
            to: 'native/office-preview-runtime',
            filter: ['manifest.json', 'office-preview-runtime.tar.gz'],
          },
        ],
      },
    }

    const patched = applyDeployPackageTransforms(pkg)

    expect(patched.build.extraResources).toContainEqual({
      from: './office-preview-runtime-src',
      to: 'native/office-preview-runtime',
      filter: ['manifest.json', 'office-preview-runtime.tar.gz'],
    })
  })

  it('rewrites the Python runtime manifest source into the deploy package', () => {
    const pkg = {
      build: {
        extraResources: [
          {
            from: '../../packages/python-runtime/runtime',
            to: 'native/tabtin-python-runtime',
            filter: ['manifest.json', 'tabtin-python-runtime.tar.gz'],
          },
        ],
      },
    }

    const patched = applyDeployPackageTransforms(pkg)

    expect(patched.build.extraResources).toContainEqual({
      from: './tabtin-python-runtime-src',
      to: 'native/tabtin-python-runtime',
      filter: ['manifest.json', 'tabtin-python-runtime.tar.gz'],
    })
  })

  it('ships WinRT toast icon as a physical extraResource (not only asar) ', () => {
    const packageJsonPath = resolve(process.cwd(), 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

    expect(packageJson.build.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'static/icon.png',
          to: 'static/icon.png',
        }),
      ]),
    )
  })
})

function extraResourceFilterMatches(filter: string[], fileName: string): boolean {
  const includes = filter.filter((pattern) => !pattern.startsWith('!'))
  return includes.some((pattern) => {
    if (!pattern.includes('*')) return pattern === fileName
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(fileName)
  })
}

describe('prepare-deploy-package python runtime resources', () => {
  it('packs every archive name declared in python runtime.config.json', () => {
    const configPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../packages/python-runtime/runtime.config.json',
    )
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { archives: Record<string, string> }
    const filter = extraResourceFilter('../../packages/python-runtime/runtime')
    const archiveNames = Object.values(config.archives)
    expect(archiveNames.length).toBeGreaterThan(0)
    for (const archiveName of archiveNames) {
      expect(extraResourceFilterMatches(filter, archiveName), archiveName).toBe(true)
    }
  })

  it('rewrites the python runtime extraResource into the deploy package source', () => {
    const pkg = {
      build: {
        extraResources: [
          {
            from: '../../packages/python-runtime/runtime',
            to: 'native/tabtin-python-runtime',
            filter: ['manifest.json', 'tabtin-python-runtime.tar.gz'],
          },
        ],
      },
    }

    const patched = applyDeployPackageTransforms(pkg)

    expect(patched.build.extraResources).toContainEqual({
      from: './tabtin-python-runtime-src',
      to: 'native/tabtin-python-runtime',
      filter: ['manifest.json', 'tabtin-python-runtime.tar.gz'],
    })
  })
})

describe('extraResources skill examples packaging', () => {
  it('re-includes app skill examples after the global examples exclude', () => {
    const filter = extraResourceFilter('../../packages/apps')
    const excludeAt = filter.indexOf('!**/examples/**')
    const includeAt = filter.indexOf('**/skills/**/examples/**')
    expect(excludeAt).toBeGreaterThan(-1)
    expect(includeAt).toBeGreaterThan(excludeAt)
  })

  it('packs bundled skill examples instead of stripping the whole examples tree', () => {
    const filter = extraResourceFilter('../../packages/skills/bundled')
    const excludeAt = filter.indexOf('!**/examples/**')
    if (excludeAt === -1) return
    const includeAt = filter.indexOf('**/examples/**')
    expect(includeAt).toBeGreaterThan(excludeAt)
  })

  it('still excludes TabSite template examples', () => {
    const filter = extraResourceFilter('../../packages/tabsite-templates')
    expect(filter).toContain('!**/examples/**')
    expect(filter).not.toContain('**/skills/**/examples/**')
  })
})
