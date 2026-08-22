#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VALID_UPDATE_CHANNELS = ['stable', 'beta', 'alpha']

export function normalizeUpdateChannel(channel, fallback = 'stable') {
  const normalized = String(channel || '').trim().toLowerCase()
  if (VALID_UPDATE_CHANNELS.includes(normalized)) {
    return normalized
  }
  return fallback
}

export function normalizePublishUrl(url) {
  const normalized = String(url || '').trim()
  if (!normalized) {
    return null
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

export function applyDeployPackageTransforms(pkg, options = {}) {
  const updateChannel = normalizeUpdateChannel(options.updateChannel)
  const publishUrl = normalizePublishUrl(options.publishUrl)
  const distributionKind = options.distributionKind === 'community' ? 'community' : 'official'
  const apiBaseUrl = normalizePublishUrl(options.apiBaseUrl)
  const updateFeedUrl = normalizePublishUrl(options.updateFeedUrl)
  const extraResources = Array.isArray(pkg.build?.extraResources) ? pkg.build.extraResources : []
  const extraMetadata = pkg.build?.extraMetadata && typeof pkg.build.extraMetadata === 'object'
    ? pkg.build.extraMetadata
    : {}
  const existingDesktopMetadata = extraMetadata.tabtinDesktop && typeof extraMetadata.tabtinDesktop === 'object'
    ? extraMetadata.tabtinDesktop
    : {}
  const topLevelDesktopMetadata = pkg.tabtinDesktop && typeof pkg.tabtinDesktop === 'object'
    ? pkg.tabtinDesktop
    : {}
  const buildConfig = { ...pkg.build }
  if (distributionKind === 'community' && !publishUrl) {
    delete buildConfig.publish
  }
  const distribution = {
    kind: distributionKind,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(updateFeedUrl ? { updateFeedUrl } : {}),
  }

  return {
    ...pkg,
    tabtinDesktop: {
      ...topLevelDesktopMetadata,
      updateChannel,
      distribution,
    },
    build: {
      ...buildConfig,
      ...(publishUrl
        ? {
          publish: {
            provider: 'generic',
            url: publishUrl,
          },
        }
        : {}),
      extraResources: extraResources.map((entry) => {
        if (entry && entry.from === '../../packages/tabsite-templates') {
          return { ...entry, from: './tabsite-templates-src' }
        }
        if (entry && entry.from === '../../packages/skills/bundled') {
          return { ...entry, from: './bundled-skills-src' }
        }
        if (entry && entry.from === '../../packages/skills/tabtracker') {
          return { ...entry, from: './package-skills-tabtracker-src' }
        }
        if (entry && entry.from === '../../packages/apps') {
          return { ...entry, from: './packages-apps-src' }
        }
        if (entry && entry.from === '../../packages/tabtin-cli-go/dist') {
          return { ...entry, from: './tabtin-cli-go-dist-src' }
        }
        if (entry && entry.from === '../../packages/tabtin-filegen-python/dist') {
          return { ...entry, from: './tabtin-filegen-python-dist-src' }
        }
        if (entry && entry.from === '../../packages/office-preview-runtime/runtime') {
          return { ...entry, from: './office-preview-runtime-src' }
        }
        if (entry && entry.from === '../../packages/python-runtime/runtime') {
          return { ...entry, from: './tabtin-python-runtime-src' }
        }
        if (entry && entry.from === 'resources/models') {
          return { ...entry, from: './embedding-models-src' }
        }
        return entry
      }),
      extraMetadata: {
        ...extraMetadata,
        tabtinDesktop: {
          ...existingDesktopMetadata,
          updateChannel,
          distribution,
        },
      },
    },
  }
}

export function patchDeployPackageJson(packageJsonPath, options = {}) {
  const raw = readFileSync(packageJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  const patched = applyDeployPackageTransforms(pkg, options)
  writeFileSync(packageJsonPath, `${JSON.stringify(patched, null, 2)}\n`)
  return patched
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) continue
    const key = current.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }
    parsed[key] = value
    index += 1
  }
  return parsed
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const packageJsonPath = args['package-json']

  if (!packageJsonPath) {
    console.error('Usage: prepare-deploy-package.mjs --package-json <path> [--update-channel <stable|beta|alpha>] [--publish-url <url>]')
    process.exit(1)
  }

  patchDeployPackageJson(resolve(packageJsonPath), {
    updateChannel: args['update-channel'],
    publishUrl: args['publish-url'],
    distributionKind: args['distribution-kind'],
    apiBaseUrl: args['api-base-url'],
    updateFeedUrl: args['update-feed-url'],
  })
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main()
}
