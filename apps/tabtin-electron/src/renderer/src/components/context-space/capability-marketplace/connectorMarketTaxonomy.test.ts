import { describe, expect, it } from 'vitest'

import { resolveConnectorMarketCategory } from './connectorMarketTaxonomy'

describe('resolveConnectorMarketCategory', () => {
  it.each([
    ['PostgreSQL', 'storage'],
    ['Google Drive', 'storage'],
    ['Slack', 'collab'],
    ['飞书 Lark', 'collab'],
    ['GitHub', 'dev'],
    ['Playwright', 'dev'],
    ['Filesystem', 'system'],
    ['Shell', 'system'],
  ] as const)('把 %s 映射到 %s', (name, category) => {
    expect(resolveConnectorMarketCategory(name)).toBe(category)
  })

  it('未知连接器归入系统与终端，避免从全部结果中消失', () => {
    expect(resolveConnectorMarketCategory('Custom MCP')).toBe('system')
  })
})
