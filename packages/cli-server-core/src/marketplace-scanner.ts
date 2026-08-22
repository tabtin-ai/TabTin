/**
 * Marketplace App manifest 扫描器（Wave 7）。
 *
 * 扫描 packages/apps/ 下所有 distribution=marketplace 的 App manifest，
 * 提取 cliGrammar.rules 转为 ExtensionCliCommand 数组，供 /extensions/cli-commands
 * endpoint 合并返回。
 *
 * 不 import 主仓内部包——只读 JSON 文件、提取声明元信息。
 * 不进 PlatformSurface registry（D-8）。
 *
 * 调用方：Electron / Daemon CLI Server 在启动时调一次缓存结果，
 * 或在 /extensions/cli-commands 请求时实时扫描。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 从 marketplace manifest 提取的单条 CLI 命令描述。
 * 字段命名与 Go ExtensionCommand struct 对齐，便于合并到
 * /extensions/cli-commands JSON 响应中。
 */
export interface MarketplaceCliCommand {
  /** App ID（如 tabtin-demo-app） */
  extension_id: string
  /** 命令动作名（grammar pattern 的 verb 段） */
  name: string
  /** 命令描述（来自 cliGrammar.rules[].reason） */
  description: string
  /** marketplace binary 不走 API endpoint，留空 */
  api_endpoint: string
  /** binary 执行方式：fork 子进程 */
  method: string
  options: unknown[]
  /** 命令来源标识——Agent 按此字段区分平台/扩展/marketplace */
  source: string
  /** grammar domain 段 */
  domain: string
  /** grammar verb 段 */
  verb: string
  /** 风险等级（safe / review / strict） */
  risk_level: string
}

/** manifest 中 cliGrammar.rules 单条的形状 */
interface GrammarRule {
  pattern: string
  risk_level: string
  reason: string
}

/** manifest 最小必需字段子集 */
interface AppManifestSubset {
  id: string
  name?: string
  distribution?: string
  cli?: { binary?: string; version?: string }
  cliGrammar?: { rules?: GrammarRule[] }
  agentIntegration?: { hasPromptSection?: boolean }
}

/**
 * 扫描指定目录下的 marketplace App manifest，返回所有 CLI 命令。
 *
 * @param appsDir - packages/apps/ 的绝对路径
 * @returns MarketplaceCliCommand[]（空数组 = 没找到 marketplace App）
 */
export function scanMarketplaceManifests(appsDir: string): MarketplaceCliCommand[] {
  if (!fs.existsSync(appsDir)) return []

  const commands: MarketplaceCliCommand[] = []

  let entries: string[]
  try {
    entries = fs.readdirSync(appsDir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const manifestPath = path.join(appsDir, entry, 'app.json')
    if (!fs.existsSync(manifestPath)) continue

    let manifest: AppManifestSubset
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8')
      manifest = JSON.parse(raw) as AppManifestSubset
    } catch {
      continue
    }

    if (manifest.distribution !== 'marketplace') continue
    if (!manifest.cliGrammar?.rules?.length) continue
    if (!manifest.cli?.binary) continue
    // ：显式关闭 Agent 提示词的 marketplace 样板（如 tabtin-demo-app）
    // 也不应进入 `tabtin commands` / CliCap `<cli_commands>` 发现面。
    if (manifest.agentIntegration?.hasPromptSection === false) continue

    const appId = manifest.id
    const source = `marketplace:${appId}`

    for (const rule of manifest.cliGrammar.rules) {
      const parts = rule.pattern.split('.')
      if (parts.length < 2) continue
      const domain = parts.slice(0, -1).join('.')
      const verb = parts[parts.length - 1]

      commands.push({
        extension_id: appId,
        name: verb,
        description: rule.reason || `${domain}.${verb}`,
        api_endpoint: '',
        method: 'CLI_BINARY',
        options: [],
        source,
        domain,
        verb,
        risk_level: rule.risk_level || 'review',
      })
    }
  }

  return commands
}
