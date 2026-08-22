/**
 * codegen-surface-preload.ts 输出验证测试（Wave 4 C2）。
 *
 * 不直接调用 codegen 脚本（它写文件有副作用），而是验证
 * 基于当前 registry 的"预期输出"与 codegen 生成逻辑一致。
 *
 * 覆盖：
 *   - chat-export-md surface 文件能正确解析出 module/verb/Input/Output
 *   - 生成的类型文件结构与 surface 定义一致
 *   - kebab-case → camelCase 转换正确
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SURFACES_DIR = path.resolve(__dirname, '..')

/** 复现 codegen 脚本的 kebab → camelCase 转换 */
function _kebabToCamel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** 复现 codegen 脚本的 surface 文件解析 */
function _parseSurfaceFile(filePath: string): {
  module: string
  verb: string
  inputType: string | null
  outputType: string | null
} | null {
  const content = fs.readFileSync(filePath, 'utf-8')
  const moduleMatch = content.match(/module:\s*['"]([a-z][a-z0-9-]*)['"]/)
  if (!moduleMatch) return null
  const verbMatch = content.match(/verb:\s*['"]([a-z][a-z0-9-]*)['"]/)
  if (!verbMatch) return null
  const inputMatch = content.match(/export\s+interface\s+(\w+Input)\b/)
  const outputMatch = content.match(/export\s+interface\s+(\w+Output)\b/)
  return {
    module: moduleMatch[1],
    verb: verbMatch[1],
    inputType: inputMatch?.[1] ?? null,
    outputType: outputMatch?.[1] ?? null,
  }
}

describe('codegen surface preload 验证', () => {
  it('chat-export-md.ts 能正确解析出 module/verb/Input/Output', () => {
    const filePath = path.resolve(SURFACES_DIR, 'chat-export-md.ts')
    expect(fs.existsSync(filePath)).toBe(true)

    const info = _parseSurfaceFile(filePath)
    expect(info).not.toBeNull()
    expect(info!.module).toBe('chat')
    expect(info!.verb).toBe('export-md')
    expect(info!.inputType).toBe('ChatExportMdInput')
    expect(info!.outputType).toBe('ChatExportMdOutput')
  })

  it('kebab-case → camelCase 转换正确', () => {
    expect(_kebabToCamel('export-md')).toBe('exportMd')
    expect(_kebabToCamel('list')).toBe('list')
    expect(_kebabToCamel('get-snapshot')).toBe('getSnapshot')
    expect(_kebabToCamel('export-all-data')).toBe('exportAllData')
    expect(_kebabToCamel('a-b-c')).toBe('aBC')
  })

  it('surfaces 目录下所有 .ts 文件都能解析', () => {
    const files = fs
      .readdirSync(SURFACES_DIR)
      .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'))
      // 排除 __tests__ 目录下的文件
      .filter((f) => !f.includes('__tests__'))

    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const filePath = path.resolve(SURFACES_DIR, file)
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) continue

      const info = _parseSurfaceFile(filePath)
      expect(info).not.toBeNull()
      expect(info!.module).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(info!.verb).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('每个 surface 都导出了 Input 和 Output 类型', () => {
    const files = fs
      .readdirSync(SURFACES_DIR)
      .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'))
      .filter((f) => !f.includes('__tests__'))

    for (const file of files) {
      const filePath = path.resolve(SURFACES_DIR, file)
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) continue

      const info = _parseSurfaceFile(filePath)
      if (!info) continue

      expect(info.inputType).not.toBeNull()
      expect(info.outputType).not.toBeNull()
    }
  })

  it('生成的类型文件存在且结构正确', () => {
    const generatedPath = path.resolve(
      __dirname,
      '../../../../../apps/tabtin-electron/src/preload/surface-types.generated.ts',
    )

    if (!fs.existsSync(generatedPath)) {
      console.warn('⚠️  surface-types.generated.ts 不存在，跳过结构验证（需先运行 pnpm codegen:surface）')
      return
    }

    const content = fs.readFileSync(generatedPath, 'utf-8')

    // 文件头标记
    expect(content).toContain('AUTO-GENERATED')
    expect(content).toContain('codegen-surface-preload.ts')

    // 包含 SurfacePreloadTypes 接口
    expect(content).toContain('export interface SurfacePreloadTypes')

    // 包含 chat namespace 和 exportMd 方法
    expect(content).toContain('chat: {')
    expect(content).toContain('exportMd(')

    // 引用了正确的类型
    expect(content).toContain('ChatExportMdInput')
    expect(content).toContain('ChatExportMdOutput')

    // import type 使用正确的包路径
    expect(content).toContain("from '@tabtin/cli-server-core/surfaces/chat-export-md'")
  })
})
