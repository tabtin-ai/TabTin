#!/usr/bin/env tsx
/**
 * PlatformSurface preload 类型自动生成脚本（Wave 4 C2）。
 *
 * 纯源码文本解析——不需要先 build，不 import 运行时模块。
 * 扫描 packages/cli-server-core/src/surfaces/ 下的 surface 定义文件，
 * 提取元信息（module/verb/Input/Output 类型名），按 module 分组
 * 生成方法签名，输出到 apps/tabtin-electron/src/preload/surface-types.generated.ts。
 *
 * 运行方式：pnpm codegen:surface
 * CI 校验：pnpm codegen:surface && git diff --exit-code surface-types.generated.ts
 *
 * 新增 surface 后只需：
 *   1. 在 packages/cli-server-core/src/surfaces/ 下按约定新建 surface 文件
 *   2. 导出 XxxInput / XxxOutput 接口
 *   3. 在 package.json exports 加对应子路径条目
 *   4. 跑 pnpm codegen:surface 即自动更新 preload 类型
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const SURFACES_DIR = path.resolve(ROOT, 'packages/cli-server-core/src/surfaces')
const OUTPUT_PATH = path.resolve(
  ROOT,
  'apps/tabtin-electron/src/preload/surface-types.generated.ts',
)

// ─── 命名转换工具 ────────────────────────────────────────────────

/** kebab-case → camelCase：'export-md' → 'exportMd' */
function _kebabToCamel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** module 名作为对象字面量键时的安全包装：合法 identifier 原样输出，否则加单引号 */
function _quotePropertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`
}

// ─── Surface 文件解析 ────────────────────────────────────────────

interface _SurfaceInfo {
  module: string
  verb: string
  /** 文件名（不含 .ts） */
  fileName: string
  /** 导出的 Input 接口名（null 表示未发现） */
  inputType: string | null
  /** 导出的 Output 接口名（null 表示未发现） */
  outputType: string | null
}

/**
 * 从 surface 源文件文本中提取元信息。
 *
 * 依赖约定：
 *   - definePlatformSurface 调用的 module/verb 字面量
 *   - 导出的 XxxInput / XxxOutput 接口
 *
 * 返回 null 表示该文件不是合法 surface 定义。
 */
function _parseSurfaceFile(filePath: string, fileName: string): _SurfaceInfo | null {
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
    fileName,
    inputType: inputMatch?.[1] ?? null,
    outputType: outputMatch?.[1] ?? null,
  }
}

// ─── 主流程 ─────────────────────────────────────────────────────

function main(): void {
  // 1. 扫描 surfaces 目录
  if (!fs.existsSync(SURFACES_DIR)) {
    console.error(`❌ surfaces 目录不存在：${SURFACES_DIR}`)
    process.exit(1)
  }

  const surfaceFiles = fs
    .readdirSync(SURFACES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'))
    .filter((f) => fs.statSync(path.resolve(SURFACES_DIR, f)).isFile())

  const surfaces: _SurfaceInfo[] = []
  for (const file of surfaceFiles) {
    const filePath = path.resolve(SURFACES_DIR, file)
    const fileName = file.replace('.ts', '')
    const info = _parseSurfaceFile(filePath, fileName)
    if (info) {
      surfaces.push(info)
    } else {
      console.warn(`⚠️  跳过 ${file}：无法解析 module/verb（不是 surface 定义文件？）`)
    }
  }

  if (surfaces.length === 0) {
    console.error('❌ 未找到任何 surface 定义文件')
    process.exit(1)
  }

  // 按 module 排序，确保输出稳定
  surfaces.sort((a, b) => {
    if (a.module !== b.module) return a.module.localeCompare(b.module)
    return a.verb.localeCompare(b.verb)
  })

  // 2. 按 module 分组
  const groups = new Map<string, _SurfaceInfo[]>()
  for (const s of surfaces) {
    const existing = groups.get(s.module) ?? []
    existing.push(s)
    groups.set(s.module, existing)
  }

  // 3. 生成代码
  const importLines: string[] = []
  const namespaceBlocks: string[] = []

  for (const [module, moduleSurfaces] of groups) {
    const methodLines: string[] = []

    for (const s of moduleSurfaces) {
      // 收集需要 import 的类型
      const typeNames: string[] = []
      if (s.inputType) typeNames.push(s.inputType)
      if (s.outputType) typeNames.push(s.outputType)

      if (typeNames.length > 0) {
        importLines.push(
          `import type { ${typeNames.join(', ')} } from '@tabtin/cli-server-core/surfaces/${s.fileName}'`,
        )
      }

      // 方法签名
      const methodName = _kebabToCamel(s.verb)
      const inputParam = s.inputType
        ? `input: ${s.inputType}`
        : 'input?: Record<string, unknown>'
      const returnType = s.outputType
        ? `Promise<${s.outputType}>`
        : 'Promise<unknown>'

      methodLines.push(`    /** ${s.module}/${s.verb}（channel: ${s.module}:${s.verb}） */`)
      methodLines.push(`    ${methodName}(${inputParam}): ${returnType}`)
    }

    namespaceBlocks.push(`  ${_quotePropertyKey(module)}: {`)
    namespaceBlocks.push(...methodLines)
    namespaceBlocks.push('  }')
  }

  const output = [
    '// AUTO-GENERATED — DO NOT EDIT, see scripts/electron/codegen-surface-preload.ts',
    '',
    ...importLines,
    '',
    '/**',
    ' * PlatformSurface 自动生成的 preload 类型声明。',
    ' *',
    ' * 每个 module 对应一个 namespace 键，每个 verb 对应一个方法。',
    ' * preload 实现层（index.ts）的 api 对象可用此接口约束 surface',
    ' * 方法的签名，保证 surface 声明 ↔ preload 类型一致。',
    ' *',
    ` * 当前包含 ${surfaces.length} 个 surface，${groups.size} 个 module。`,
    ' */',
    'export interface SurfacePreloadTypes {',
    ...namespaceBlocks,
    '}',
    '',
  ].join('\n')

  // 4. 写文件
  const outputDir = path.dirname(OUTPUT_PATH)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  fs.writeFileSync(OUTPUT_PATH, output, 'utf-8')

  // 5. 自检：跑 tsc --noEmit 验证生成内容能编译。
  //
  // 历史教训：上次 module 名含连字符（agent-engine / agent-security）被
  // 直接当作合法 identifier 写入 interface key，生成的 TS 语法错误把整个
  // electron build 阻塞 25 处 TS1005。codegen 落盘后立即类型检查，把
  // 「写错→污染仓库→build 时才暴露」的反馈链路收敛到 codegen 本步内。
  //
  // 用 isolatedModules 模式让 tsc 只校验当前文件，不把 import type 链路
  // 整个跑一遍——既快又能抓到所有语法/键名/类型签名问题。
  try {
    execSync(
      `npx --yes tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --isolatedModules ${OUTPUT_PATH}`,
      { stdio: 'pipe', encoding: 'utf-8' },
    )
  } catch (err) {
    const stdout = (err as { stdout?: Buffer | string }).stdout?.toString() ?? ''
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString() ?? ''
    console.error('❌ codegen 自检失败：生成的 TS 不能编译')
    console.error(`   产物：${path.relative(ROOT, OUTPUT_PATH)}`)
    if (stdout) console.error(stdout)
    if (stderr) console.error(stderr)
    process.exit(1)
  }

  // 6. 控制台报告
  console.log(`✅ 生成成功（自检通过）：${path.relative(ROOT, OUTPUT_PATH)}`)
  console.log(`   共 ${surfaces.length} 个 surface，${groups.size} 个 module`)
  for (const [module, moduleSurfaces] of groups) {
    for (const s of moduleSurfaces) {
      console.log(`   - ${module}/${s.verb} → ${_kebabToCamel(s.verb)}()`)
    }
  }
}

main()
