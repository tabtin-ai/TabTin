import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pageSource = readFileSync(new URL('./ProvidersPage.tsx', import.meta.url), 'utf8')

describe('模型渠道删除确认', () => {
  it('打开确认弹框前按渠道加载并列出会被一并删除的模型', () => {
    expect(pageSource).toContain("import { modelsApi } from '../api/models'")
    expect(pageSource).toMatch(
      /modelsApi\.listModels\(\{\s*providerId: provider\.id,\s*limit: 500,?\s*\}\)/
    )
    expect(pageSource).toContain('onDelete={openDeleteDialog}')
    expect(pageSource).toContain('deleteModels.map((model)')
    expect(pageSource).toContain('{model.display_name}')
    expect(pageSource).toContain('{model.model_name}')
    expect(pageSource).toContain('const force = deleteModels.length > 0')
  })

  it('在删除确认弹框内展示后端阻断原因', () => {
    expect(pageSource).toContain('deleteError')
    expect(pageSource).toContain('role="alert"')
  })
})
