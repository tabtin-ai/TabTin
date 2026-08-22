#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appDir = path.resolve(__dirname, '..')
const repoDir = path.resolve(appDir, '..', '..')

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoDir,
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${String(code)}`))
    })
  })

const assertSourceGuards = async () => {
  const appSource = await readFile(path.join(appDir, 'src', 'App.tsx'), 'utf8')
  const pageSource = await readFile(path.join(appDir, 'src', 'pages', 'table-host-web.tsx'), 'utf8')
  const moduleSource = await readFile(
    path.join(appDir, 'src', 'table-host', 'TableHostWebModule.tsx'),
    'utf8'
  )
  const viewEditorSource = await readFile(
    path.join(appDir, 'src', 'table-host', 'TableHostViewEditorPanel.tsx'),
    'utf8'
  )
  const viewEditorStateSource = await readFile(
    path.join(appDir, 'src', 'table-host', 'useTableHostViewEditorState.ts'),
    'utf8'
  )

  assert(
    appSource.includes('path="table-host-web/:workspaceId/:agentSpaceId"'),
    '缺少参数化路由：/table-host-web/:workspaceId/:agentSpaceId'
  )

  assert(moduleSource.includes('未检测到 access_token'), '缺少 access_token 失效兜底提示')

  assert(pageSource.includes("navigate('/login'"), '缺少鉴权失效后跳转登录入口')

  const requiredPayloadKeys = ['filters', 'sorts', 'groups', 'visible_fields', 'field_order']
  for (const key of requiredPayloadKeys) {
    const sourceBundle = `${moduleSource}\n${viewEditorSource}\n${viewEditorStateSource}`
    const hasKeyToken = sourceBundle.includes(`${key}:`) || sourceBundle.includes(`${key},`)
    assert(hasKeyToken, `ViewApiService.updateView payload 缺少关键字段: ${key}`)
  }

  assert(moduleSource.includes('setRefreshTick(prev => prev + 1)'), '视图保存后缺少刷新回刷逻辑')
}

const assertBuildArtifacts = async () => {
  const distDir = path.join(appDir, 'dist')
  const indexHtmlPath = path.join(distDir, 'index.html')
  const assetsDir = path.join(distDir, 'assets')
  const html = await readFile(indexHtmlPath, 'utf8')

  assert(html.includes('<div id="root"></div>'), 'dist/index.html 缺少前端挂载节点')

  const assets = await readdir(assetsDir)
  assert(
    assets.some((filename) => filename.startsWith('table-host-web-') && filename.endsWith('.js')),
    '构建产物中缺少 table-host-web 入口 chunk'
  )
}

const main = async () => {
  console.log('[smoke] 1/4 构建 admindash...')
  await runCommand('pnpm', ['-C', appDir, 'build'])

  console.log('[smoke] 2/4 校验关键源码守卫...')
  await assertSourceGuards()

  console.log('[smoke] 3/4 校验构建产物守卫...')
  await assertBuildArtifacts()

  console.log('[smoke] 4/4 完成: 构建、鉴权兜底、深链路由代码守卫、视图保存关键逻辑检查通过')
}

main().catch((error) => {
  console.error('[smoke] 失败:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
