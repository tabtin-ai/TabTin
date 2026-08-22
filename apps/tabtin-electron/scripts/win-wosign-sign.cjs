/**
 * electron-builder Windows 自定义签名钩子（WoSign wosigncodecmd 参数模式）。
 *
 * 文档：docs/windows-codesign.md
 * 官方参数模式：https://bbs.wosign.com/?p=25
 *
 * 仅 production（网关正式 / stable）在 build-packaged-app.sh 里注入 WIN_CODESIGN_*。
 * preprod（beta）与 local 不注入凭据 → 全部跳过。
 *
 * 范围（控制打包时长）：只签用户会碰到的入口二进制：
 *   - tabtin-desktop.exe（主程序，装完后运行）
 *   - *Setup*.exe（NSIS 安装包）
 * 不签 ffmpeg / winpty / clipboard / rg 等依赖 exe。
 *
 * 环境变量（由 build-packaged-app.sh 从 ~/.config/tabtin-codesign/secrets.env 加载）：
 *   WIN_WOSIGN_CMD              wosigncodecmd.exe 绝对路径（可省略，走常见路径探测）
 *   WIN_CODESIGN_THUMBPRINT     证书指纹（无空格），如 142B79CFD2AFAABEC948D48802FFC58C9F756F1D
 *   WIN_CODESIGN_PIN            UKey User PIN（勿提交到 git）
 *   WIN_CODESIGN_TIMESTAMP_URL  可选，默认 GlobalSign R6 TSA
 *   WIN_CODESIGN_REQUIRED       "1" 时缺凭据/工具则失败（正式包）
 *
 * 日志不打印 PIN。
 */

'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_TIMESTAMP_URL = 'http://timestamp.globalsign.com/tsa/r6advanced1'

const CANDIDATE_CMDS = [
  process.env.WIN_WOSIGN_CMD,
  'C:\\Tools\\WoSign\\wosigncodecmd.exe',
  'C:\\Program Files\\WoSign\\CodeSign\\wosigncodecmd.exe',
  'C:\\Program Files\\WoSign\\wosigncodecmd.exe',
  'C:\\Program Files (x86)\\WoSign\\CodeSign\\wosigncodecmd.exe',
  'C:\\Program Files (x86)\\WoSign\\wosigncodecmd.exe',
  'C:\\WoSign\\wosigncodecmd.exe',
].filter(Boolean)

function normalizeThumbprint(value) {
  return String(value || '')
    .replace(/[\s:\-]/g, '')
    .toUpperCase()
}

/**
 * 只签主程序 + NSIS Setup，跳过依赖里的 exe（否则每个都打 TSA，正式包可拖到 1h+）。
 * @param {string} filePath
 */
function windowsBasename(filePath) {
  // electron-builder 传入的是 Windows 路径；在 macOS/Linux 上跑单测时
  // path.basename 不会把 `\` 当分隔符，必须用 win32 语义。
  return path.win32.basename(filePath || '')
}

function shouldSignFile(filePath) {
  const basename = windowsBasename(filePath)
  if (!basename || !basename.toLowerCase().endsWith('.exe')) {
    return false
  }
  if (basename.toLowerCase() === 'tabtin-desktop.exe') {
    return true
  }
  // electron-builder NSIS：如 "TabTin Setup 0.7.36.exe"
  if (/setup/i.test(basename)) {
    return true
  }
  return false
}

function resolveWosignCmd() {
  for (const candidate of CANDIDATE_CMDS) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
      // ignore
    }
  }

  // PATH 探测（不抛错）
  try {
    const out = execFileSync('where.exe', ['wosigncodecmd'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const first = String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (first && fs.existsSync(first)) {
      return first
    }
  } catch {
    // not on PATH
  }

  return null
}

function buildSignArgs({ thumbprint, pin, timestampUrl, filePath }) {
  return [
    'sign',
    '/tp',
    thumbprint,
    '/p',
    pin,
    '/hide',
    '/c',
    '/dig',
    'sha256',
    '/tr',
    timestampUrl,
    '/file',
    filePath,
  ]
}

/**
 * @param {{ path: string }} configuration
 */
async function signWithWosign(configuration) {
  const filePath = configuration && configuration.path
  if (!filePath) {
    throw new Error('win-wosign-sign: missing configuration.path')
  }

  const thumbprint = normalizeThumbprint(process.env.WIN_CODESIGN_THUMBPRINT)
  const pin = process.env.WIN_CODESIGN_PIN || ''
  const required = process.env.WIN_CODESIGN_REQUIRED === '1'
  const timestampUrl = process.env.WIN_CODESIGN_TIMESTAMP_URL || DEFAULT_TIMESTAMP_URL
  const basename = windowsBasename(filePath)

  if (!shouldSignFile(filePath)) {
    console.log(`  · skip Windows codesign (not main/Setup): ${basename}`)
    return
  }

  if (!thumbprint || !pin) {
    if (required) {
      throw new Error(
        'win-wosign-sign: formal package requires WIN_CODESIGN_THUMBPRINT and WIN_CODESIGN_PIN ' +
          '(see docs/windows-codesign.md)'
      )
    }
    console.log(`  · skip Windows codesign (no WIN_CODESIGN_*): ${basename}`)
    return
  }

  const cmd = resolveWosignCmd()
  if (!cmd) {
    const message =
      'win-wosign-sign: wosigncodecmd.exe not found. Set WIN_WOSIGN_CMD or install WoSign tools ' +
      '(https://www.wosign.com/marketing/2015_WoSign_sign_tools/index.htm)'
    if (required) {
      throw new Error(message)
    }
    console.warn(`  ⚠ ${message}; skip ${basename}`)
    return
  }

  const args = buildSignArgs({ thumbprint, pin, timestampUrl, filePath })
  console.log(`  · wosigncodecmd sign ${basename} (tp=${thumbprint.slice(0, 8)}… tr=${timestampUrl})`)

  try {
    execFileSync(cmd, args, {
      stdio: 'inherit',
      windowsHide: true,
    })
  } catch (error) {
    const code = error && typeof error.status === 'number' ? error.status : 'unknown'
    throw new Error(`win-wosign-sign: failed signing ${basename} (exit=${code})`)
  }
}

module.exports = signWithWosign
module.exports.default = signWithWosign
module.exports.buildSignArgs = buildSignArgs
module.exports.normalizeThumbprint = normalizeThumbprint
module.exports.resolveWosignCmd = resolveWosignCmd
module.exports.shouldSignFile = shouldSignFile
module.exports.DEFAULT_TIMESTAMP_URL = DEFAULT_TIMESTAMP_URL
