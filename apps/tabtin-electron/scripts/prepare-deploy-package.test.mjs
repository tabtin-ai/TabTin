import assert from 'node:assert/strict'
import test from 'node:test'

import { applyDeployPackageTransforms } from './prepare-deploy-package.mjs'

test('community metadata disables inherited official publish config by default', () => {
  const result = applyDeployPackageTransforms(
    {
      tabtinDesktop: {},
      build: {
        publish: { provider: 'generic', url: 'https://cdn.example.com/releases' },
      },
    },
    {
      distributionKind: 'community',
      apiBaseUrl: 'https://api.example.org/api',
    },
  )

  assert.equal(result.build.publish, undefined)
  assert.deepEqual(result.tabtinDesktop.distribution, {
    kind: 'community',
    apiBaseUrl: 'https://api.example.org/api',
  })
  assert.deepEqual(
    result.build.extraMetadata.tabtinDesktop.distribution,
    result.tabtinDesktop.distribution,
  )
})

test('community metadata records only an explicitly declared update feed', () => {
  const result = applyDeployPackageTransforms(
    { build: {} },
    {
      distributionKind: 'community',
      apiBaseUrl: 'https://api.example.org/api',
      updateFeedUrl: 'https://downloads.example.org/desktop/',
      publishUrl: 'https://downloads.example.org/desktop/',
    },
  )

  assert.deepEqual(result.tabtinDesktop.distribution, {
    kind: 'community',
    apiBaseUrl: 'https://api.example.org/api',
    updateFeedUrl: 'https://downloads.example.org/desktop',
  })
  assert.deepEqual(result.build.publish, {
    provider: 'generic',
    url: 'https://downloads.example.org/desktop',
  })
})
