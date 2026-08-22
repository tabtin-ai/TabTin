export const CONNECTOR_MARKET_CATEGORY_ORDER = [
  'storage',
  'collab',
  'dev',
  'system',
] as const

export type ConnectorMarketCategory = (typeof CONNECTOR_MARKET_CATEGORY_ORDER)[number]

const CATEGORY_PATTERNS: Array<{
  category: Exclude<ConnectorMarketCategory, 'system'>
  pattern: RegExp
}> = [
  {
    category: 'storage',
    pattern:
      /(postgres|mysql|sqlite|redis|database|drive|s3|oss|storage|warehouse|mongo|supabase|neon|百度网盘|baidu|同花顺|hithink|fuyao)/i,
  },
  {
    category: 'collab',
    pattern:
      /(slack|lark|feishu|飞书|notion|linear|teams|discord|mail|calendar|jira|dingtalk|钉钉|canva)/i,
  },
  {
    category: 'dev',
    pattern: /(github|gitlab|sentry|playwright|puppeteer|docker|browser|vercel|cloudflare)/i,
  },
]

export function resolveConnectorMarketCategory(name: string): ConnectorMarketCategory {
  return CATEGORY_PATTERNS.find(item => item.pattern.test(name))?.category ?? 'system'
}
