/**
 * MCP 配置解析 SSoT —— main（自动发现）与 renderer（手动粘贴）共用一份。
 *
 * 背景：main 侧 `LocalMcpService.discoveryCandidates` 与 renderer 侧
 * `McpPanel.buildManualConnectionInput` 曾各写一份「JSON → transport」归一化逻辑，
 * 导致 discover 能读标准 `{ mcpServers: {...} }`、手动粘贴却只认「裸单 server 对象」
 * 的格式漂移。这里抽成单源，两端复用，避免再漂。
 *
 * 支持的格式（两种都吃）：
 *   ① 标准 mcpServers 文档：`{ "mcpServers": { "<名字>": <serverConfig> } }`
 *      —— Cursor / Claude Desktop / Windsurf 通用；VS Code 用 `servers` 键。
 *   ② 裸单 server 对象：`{ "url": ... }` 或 `{ "command": ... }`（TabTin 手动添加历史格式）。
 *
 * server config 字段（与 discover 侧一致）：
 *   - http：`url`（必填）+ `headers`（string map）
 *   - stdio：`command`（必填）+ `args`（string[]）+ `cwd` + `env`（string map）
 *   - `type` 字段忽略（靠 url/command 推断）；SSE 独立端点不支持。
 */

import type { LocalMcpTransportConfig } from '../types/mcp'

/** 标准 mcpServers 文档的包装键（VS Code 用 `servers`，其余用 `mcpServers`）。 */
const WRAPPER_KEYS = ['mcpServers', 'servers'] as const

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

export function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

/**
 * 单个 server config（url/command 二选一）→ 内部 transport 形态。无法识别返回 null。
 */
export function normalizeTransportConfig(value: unknown): LocalMcpTransportConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  if (typeof raw.url === 'string' && raw.url.trim()) {
    return {
      kind: 'http',
      url: raw.url.trim(),
      headers: normalizeStringMap(raw.headers),
    }
  }

  if (typeof raw.command === 'string' && raw.command.trim()) {
    return {
      kind: 'stdio',
      command: raw.command.trim(),
      args: normalizeStringArray(raw.args),
      cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : undefined,
      env: normalizeStringMap(raw.env),
    }
  }

  return null
}

/** 解析出的单条 server：`name` 来自 mcpServers 的 key（裸对象为 null，由调用方兜底）。 */
export interface ParsedMcpEntry {
  name: string | null
  transport: LocalMcpTransportConfig
}

function readWrapper(parsed: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of WRAPPER_KEYS) {
    const value = parsed[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return null
}

/**
 * 把一份 MCP 配置 JSON 解析成 server 条目数组。
 *
 * - 标准包装（`mcpServers` / `servers`）：每个 key → 一条，`name` = key；忽略无效条目。
 * - 裸单 server 对象：返回单条，`name = null`（调用方用表单名兜底）。
 * - 无法识别任何 server：返回空数组（调用方据此报错）。
 *
 * **纯函数、不抛错**：调用方按返回长度决定「无 server / 单个 / 多个」的处理与文案。
 */
export function parseMcpConfigEntries(parsed: unknown): ParsedMcpEntry[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const obj = parsed as Record<string, unknown>

  const wrapper = readWrapper(obj)
  if (wrapper) {
    const entries: ParsedMcpEntry[] = []
    for (const [name, config] of Object.entries(wrapper)) {
      const transport = normalizeTransportConfig(config)
      if (transport) entries.push({ name, transport })
    }
    return entries
  }

  const transport = normalizeTransportConfig(obj)
  return transport ? [{ name: null, transport }] : []
}
