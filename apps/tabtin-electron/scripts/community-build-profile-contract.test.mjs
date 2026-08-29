import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const scriptDirectory = new URL('./', import.meta.url)
const buildScript = readFileSync(new URL('build-packaged-app.sh', scriptDirectory), 'utf8')
const example = readFileSync(new URL('../.env.community.example', scriptDirectory), 'utf8')
const localDevExample = readFileSync(new URL('../.env.localdev.example', scriptDirectory), 'utf8')
const packageConfig = JSON.parse(readFileSync(new URL('../package.json', scriptDirectory), 'utf8'))

const COMMUNITY_ENDPOINTS = {
  TABTIN_COMMUNITY_API_BASE_URL: [
    'TABTIN_API_BASE_URL',
    'VITE_API_BASE_URL',
  ],
  TABTIN_COMMUNITY_COLLAB_WS_BASE: ['VITE_COLLAB_WS_BASE'],
  TABTIN_COMMUNITY_CENTRIFUGO_WS_URL: ['VITE_CENTRIFUGO_WS_URL'],
  TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL: [
    'TABTIN_PUBLIC_WEB_BASE_URL',
    'VITE_PUBLIC_WEB_BASE_URL',
  ],
}

test('community profile declares every public self-hosted endpoint', () => {
  for (const [input, outputs] of Object.entries(COMMUNITY_ENDPOINTS)) {
    assert.match(example, new RegExp(`^${input}=`, 'm'), `${input} must be documented`)
    assert.match(buildScript, new RegExp(`\\b${input}\\b`), `${input} must be read by the build`)
    for (const output of outputs) {
      assert.match(
        buildScript,
        new RegExp(`export ${output}=`),
        `${input} must populate ${output}`,
      )
    }
  }
})

test('community profile validates endpoint inputs before packaging', () => {
  for (const input of Object.keys(COMMUNITY_ENDPOINTS)) {
    assert.match(
      buildScript,
      new RegExp(`validate_community_endpoint ${input}\\b`),
      `${input} must have a fail-fast validation error`,
    )
  }
  assert.match(buildScript, /echo "Invalid \$\{name\}/, 'shared validator must fail with the input name')
})

test('Mac packages declare why Community needs local-network access', () => {
  assert.match(
    packageConfig.build.mac.extendInfo.NSLocalNetworkUsageDescription ?? '',
    /Community.*局域网|Community.*本地网络/,
  )
})

test('local packaged profile points public invitation links at tabtin-web port 5176', () => {
  assert.match(localDevExample, /^VITE_PUBLIC_WEB_BASE_URL=http:\/\/<YOUR_LAN_IP>:5176$/m)
  assert.match(localDevExample, /^TABTIN_PUBLIC_WEB_BASE_URL=\$\{VITE_PUBLIC_WEB_BASE_URL\}$/m)
})
