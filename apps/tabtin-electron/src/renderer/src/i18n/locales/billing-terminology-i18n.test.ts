import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const zhLocaleDir = join(dirname(fileURLToPath(import.meta.url)), 'zh-CN')

describe('中文计费单位术语', () => {
  it('统一使用小写 credits，并与相邻中文留空格', () => {
    const localeFiles = readdirSync(zhLocaleDir).filter(file => file.endsWith('.json'))

    for (const file of localeFiles) {
      const content = readFileSync(join(zhLocaleDir, file), 'utf8')
      expect(content, `${file} 不应再使用废词“点券”`).not.toContain('点券')
      expect(content, `${file} 应使用小写 credits`).not.toMatch(/\bCredits\b/)
      expect(content, `${file} 的 credits 与中文之间应保留空格`).not.toMatch(
        /credits[\u3400-\u9fff]|[\u3400-\u9fff]credits/,
      )
    }
  })

  it('LLM 计量统一使用 1K tokens，小写复数且价格分隔清晰', () => {
    const settings = JSON.parse(
      readFileSync(join(zhLocaleDir, 'settings.json'), 'utf8'),
    ) as {
      organizationServices: {
        catalog: Record<string, { description: string; unit: string }>
        creditsPerUnit: string
      }
    }

    expect(settings.organizationServices.catalog['llm.tokens']).toMatchObject({
      description: 'LLM tokens 消耗，按模型动态定价',
      unit: '1K tokens',
    })
    expect(settings.organizationServices.catalog['rag.embedding']).toMatchObject({
      unit: '1K tokens',
    })
    expect(settings.organizationServices.creditsPerUnit).toBe('{{price}} credits / {{unit}}')
  })
})
