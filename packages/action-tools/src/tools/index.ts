import type { AgentTool, ActionTool } from '../types'
import type { ToolDomain } from '../types/manifest'

import { domain as tabweb } from './tabweb/_meta'
import { domain as tabwebHeadless } from './tabweb-headless/_meta'
import { domain as tabcodeReadonly } from './tabcode/_meta'
import { domain as coreHeadless } from './core-headless/_meta'

/**
 * Manifest domains — only tools that REQUIRE FC exposure to LLM.
 *
 * - tabcode: read-only subset (read_file, glob_search/grep_search)
 *   for explore/plan subagents that cannot use terminal. Write tools excluded;
 *   main Agent uses CLI.
 *
 * Backend/Python ToolHub may expose overlapping surfaces (CLI, Hub domains);
 * TabCode write tools are not in the tabcode domain; use CLI + full `tabcodeTools` on adapters.
 *
 * Adapter registration (Daemon / Electron): terminal and skills groups
 * live under `core-headless` (appId `core`); tabcode full set is still
 * registered manually beside the read-only tabcode domain. The legacy
 * `tabslide` adapter group was retired in W6 (2026-05-04) — slide ops
 * go through `tabtin slide *` CLI / Django HTTP API directly.
 *
 * Wave 4a (2026-05-01): tabdata 域已从 `core-headless` 删除，相关 7+5 个 FC
 * 全部下架；Agent 走 `tabtin table *` CLI 操作多维表格。
 */
export const allDomains: ToolDomain<AgentTool | ActionTool>[] = [
  tabweb,
  tabwebHeadless,
  tabcodeReadonly,
  coreHeadless,
]

/** Domains suitable for headless (non-Electron) environments. */
export const getHeadlessDomains = (): ToolDomain<AgentTool>[] =>
  allDomains.filter((d): d is ToolDomain<AgentTool> => d.meta.headless !== false)
