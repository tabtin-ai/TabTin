import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const appRoot = new URL('../', import.meta.url)
const buildScript = new URL('build-packaged-app.sh', import.meta.url)

function validateProfile(extraEnv = {}) {
  return spawnSync('bash', [buildScript.pathname, 'mac', 'community'], {
    cwd: appRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TABTIN_COMMUNITY_PROFILE_VALIDATE_ONLY: '1',
      ...extraEnv,
    },
  })
}

test('Community profile defaults every connection endpoint to localhost', () => {
  const result = validateProfile()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /API=http:\/\/127\.0\.0\.1:6060\/api/)
  assert.match(result.stdout, /WS=ws:\/\/127\.0\.0\.1:6060/)
  assert.match(result.stdout, /IM=http:\/\/127\.0\.0\.1:6060\/api/)
  assert.match(result.stdout, /Centrifugo=ws:\/\/127\.0\.0\.1:8100\/connection\/websocket/)

  const envFile = readFileSync(new URL('../.env.community', import.meta.url), 'utf8')
  for (const endpoint of ['api.example.com', 'ws.example.com', 'xmov.ai', 'example.com']) {
    assert.doesNotMatch(envFile, new RegExp(endpoint.replaceAll('.', '\\.')))
  }
})

test('Community profile rejects company endpoints but accepts explicit third-party hosts', () => {
  for (const url of [
    'https://api.example.com/api',
    'https://ws.example.com/api',
    'https://gptapi.xmov.ai/v1',
    'https://api.example.com/api',
  ]) {
    const result = validateProfile({ TABTIN_COMMUNITY_API_BASE_URL: url })
    assert.notEqual(result.status, 0, `${url} must be rejected`)
  }

  const thirdParty = validateProfile({
    TABTIN_COMMUNITY_API_BASE_URL: 'https://selfhost.example.org/api',
    TABTIN_COMMUNITY_CENTRIFUGO_WS_URL: 'wss://events.example.org/connection/websocket',
  })
  assert.equal(thirdParty.status, 0, thirdParty.stderr)

  const companyFeed = validateProfile({
    TABTIN_COMMUNITY_UPDATE_FEED_URL: 'https://downloads.example.com/community',
  })
  assert.notEqual(companyFeed.status, 0, 'company update feeds must not be inherited')
})
