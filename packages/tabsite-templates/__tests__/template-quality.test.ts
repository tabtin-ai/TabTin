/**
 * 模板工程质量回归测试
 *
 * 验证目标：DU-012, DU-013, DU-026, DU-027, DU-028, DU-029
 * 运行方式：npx vitest run packages/tabsite-templates/__tests__/
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_ROOT = resolve(__dirname, '..')

function readJSON(relPath: string) {
  return JSON.parse(readFileSync(resolve(TEMPLATES_ROOT, relPath), 'utf-8'))
}
function readText(relPath: string) {
  return readFileSync(resolve(TEMPLATES_ROOT, relPath), 'utf-8')
}

describe('DU-012: dashboard @tabtin/sdk 不使用 workspace:* 协议', () => {
  it('依赖版本不包含 workspace: 前缀', () => {
    const pkg = readJSON('dashboard/package.json')
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const [name, version] of Object.entries(allDeps)) {
      expect(version, `${name} 不应使用 workspace: 协议`).not.toMatch(/^workspace:/)
    }
  })
})

describe('DU-013: tailwind.config.js 包含语义字号和 z-index', () => {
  const requiredFontSizes = ['caption', 'body', 'subtitle', 'title', 'heading', 'display']
  const requiredZIndex = ['sticky', 'floating', 'overlay', 'modal', 'dropdown', 'toast']

  for (const template of ['dashboard', 'blank']) {
    it(`${template}/tailwind.config.js 定义了所有语义字号`, () => {
      const content = readText(`${template}/tailwind.config.js`)
      for (const size of requiredFontSizes) {
        expect(content, `缺少字号定义: ${size}`).toContain(size)
      }
    })

    it(`${template}/tailwind.config.js 定义了所有语义 z-index`, () => {
      const content = readText(`${template}/tailwind.config.js`)
      for (const z of requiredZIndex) {
        expect(content, `缺少 z-index 定义: ${z}`).toContain(z)
      }
    })
  }
})

describe('DU-026: 依赖版本使用 ~ 而非 ^', () => {
  for (const template of ['dashboard', 'blank']) {
    it(`${template}/package.json 核心依赖不使用 ^ 前缀`, () => {
      const pkg = readJSON(`${template}/package.json`)
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      for (const [name, version] of Object.entries(allDeps)) {
        expect(version, `${name} 不应使用 ^ 前缀`).not.toMatch(/^\^/)
      }
    })
  }
})

describe('DU-027: blank .env.example 不含 dashboard 专属变量', () => {
  it('不包含 VITE_TABTIN_TOKEN', () => {
    const content = readText('blank/.env.example')
    expect(content).not.toContain('VITE_TABTIN_TOKEN')
  })
  it('不包含 VITE_TABTIN_TABLE_ID', () => {
    const content = readText('blank/.env.example')
    expect(content).not.toContain('VITE_TABTIN_TABLE_ID')
  })
  it('不包含 VITE_TABTIN_SPACE_ID', () => {
    const content = readText('blank/.env.example')
    expect(content).not.toContain('VITE_TABTIN_SPACE_ID')
  })
})

describe('DU-028: README 环境变量引用正确', () => {
  it('不引用不存在的 VITE_TABLE_NAME', () => {
    const content = readText('README.md')
    expect(content).not.toContain('VITE_TABLE_NAME')
  })
  it('包含正确的 VITE_TABTIN_TABLE_ID', () => {
    const content = readText('README.md')
    expect(content).toContain('VITE_TABTIN_TABLE_ID')
  })
  it('包含正确的 VITE_TABTIN_SPACE_ID', () => {
    const content = readText('README.md')
    expect(content).toContain('VITE_TABTIN_SPACE_ID')
  })
})

describe('DU-029: debounceRef 类型声明正确', () => {
  it('类型包含 undefined 联合', () => {
    const content = readText('dashboard/src/App.tsx')
    expect(content).toContain('useRef<ReturnType<typeof setTimeout> | undefined>')
  })
})
