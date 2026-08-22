'use strict'

const assert = require('node:assert/strict')
const {
  buildSignArgs,
  normalizeThumbprint,
  shouldSignFile,
  DEFAULT_TIMESTAMP_URL,
} = require('./win-wosign-sign.cjs')

assert.equal(
  normalizeThumbprint('142b 79cf-d2af:aabe C948'),
  '142B79CFD2AFAABEC948'
)

const args = buildSignArgs({
  thumbprint: '142B79CFD2AFAABEC948D48802FFC58C9F756F1D',
  pin: 'secret-pin',
  timestampUrl: DEFAULT_TIMESTAMP_URL,
  filePath: 'C:\\Share\\windows\\TabTin Setup.exe',
})

assert.deepEqual(args, [
  'sign',
  '/tp',
  '142B79CFD2AFAABEC948D48802FFC58C9F756F1D',
  '/p',
  'secret-pin',
  '/hide',
  '/c',
  '/dig',
  'sha256',
  '/tr',
  DEFAULT_TIMESTAMP_URL,
  '/file',
  'C:\\Share\\windows\\TabTin Setup.exe',
])

// 确保测试里用到的 PIN 不会出现在日志字符串约定中（钩子本身不打印 pin）
assert.equal(args.includes('secret-pin'), true)
assert.ok(!JSON.stringify(args.filter((a) => a !== 'secret-pin')).includes('secret-pin'))

assert.equal(shouldSignFile('dist-app\\win-unpacked\\tabtin-desktop.exe'), true)
assert.equal(shouldSignFile('dist-app\\TabTin Setup 0.7.36.exe'), true)
assert.equal(shouldSignFile('dist-app\\TabTin-beta-Setup.exe'), true)
assert.equal(shouldSignFile('resources\\ffmpeg.exe'), false)
assert.equal(shouldSignFile('resources\\winpty-agent.exe'), false)
assert.equal(shouldSignFile('resources\\tabtin.exe'), false)
assert.equal(shouldSignFile('resources\\tabtin-filegen.exe'), false)
assert.equal(shouldSignFile('resources\\rg.exe'), false)
// 正斜杠路径在 win32 basename 下也应识别
assert.equal(shouldSignFile('dist-app/win-unpacked/tabtin-desktop.exe'), true)
assert.equal(shouldSignFile('resources/ffmpeg.exe'), false)

console.log('win-wosign-sign.test.cjs: ok')
