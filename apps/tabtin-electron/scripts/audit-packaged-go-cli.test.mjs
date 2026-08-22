import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluatePackagedGoCliProvenance,
  parseGoBuildInfo,
  resolvePackagedGoCliBinaryName,
} from './audit-packaged-artifact.mjs'

const CURRENT_REVISION = '31fb996c27b18852c943c3da662fd53b6fd1b492'

function buildInfo(revision = CURRENT_REVISION) {
  return [
    'tabtin: go1.26.1',
    '\tpath\tgithub.com/TabTin/tabtin-cli',
    '\tbuild\tGOOS=darwin',
    '\tbuild\tGOARCH=arm64',
    `\tbuild\tvcs.revision=${revision}`,
  ].join('\n')
}

test('parseGoBuildInfo reads target and source revision from the binary', () => {
  assert.deepEqual(parseGoBuildInfo(buildInfo()), {
    goos: 'darwin',
    goarch: 'arm64',
    revision: CURRENT_REVISION,
  })
})

test('packaged CLI provenance accepts the current release revision', () => {
  assert.deepEqual(
    evaluatePackagedGoCliProvenance({
      buildInfo: buildInfo(),
      expectedRevision: CURRENT_REVISION,
      expectedGoos: 'darwin',
      expectedGoarch: 'arm64',
    }),
    [],
  )
})

test('packaged CLI provenance rejects a same-architecture binary from an older commit', () => {
  const hits = evaluatePackagedGoCliProvenance({
    buildInfo: buildInfo('161c3007a586f4b2819327c925d373ca41b5725d'),
    expectedRevision: CURRENT_REVISION,
    expectedGoos: 'darwin',
    expectedGoarch: 'arm64',
  })

  assert.equal(hits.length, 1)
  assert.match(hits[0], /CLI 源码版本不匹配/)
  assert.match(hits[0], /161c3007/)
  assert.match(hits[0], /31fb996c/)
})

test('packaged CLI provenance rejects missing VCS identity', () => {
  const hits = evaluatePackagedGoCliProvenance({
    buildInfo: buildInfo().replace(/\n\tbuild\tvcs\.revision=.*$/, ''),
    expectedRevision: CURRENT_REVISION,
    expectedGoos: 'darwin',
    expectedGoarch: 'arm64',
  })

  assert.deepEqual(hits, [
    'CLI 构建信息缺少 vcs.revision，无法证明来自当前 release',
  ])
})

test('manual audit infers Windows from the sole tabtin.exe artifact', () => {
  assert.deepEqual(
    resolvePackagedGoCliBinaryName({ target: '', hasBare: false, hasExe: true }),
    { binaryName: 'tabtin.exe', inferredGoos: 'windows' },
  )
})

test('manual audit rejects an ambiguous CLI layout instead of guessing', () => {
  assert.deepEqual(
    resolvePackagedGoCliBinaryName({ target: '', hasBare: true, hasExe: true }),
    { binaryName: '', inferredGoos: '' },
  )
})
