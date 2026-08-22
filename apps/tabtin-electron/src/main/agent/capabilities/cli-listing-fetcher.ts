/**
 * CliCap 的宿主 fetcher。
 *
 * 命令树物化统一走 `cli-commands-materializer`。Host 初始化 / Space 预热负责
 * 一次 `--include-hidden` spawn；发送热路径只读可见子集快照。
 */

import type { CliListing } from '@tabtin/agent-host/capabilities'
import {
  getCliCommandsMaterializedSnapshot,
  warmCliCommandsMaterialized,
} from './cli-commands-materializer.js'

export function createCliListingFetcher(): (
  context: { query?: string },
) => Promise<CliListing | null> {
  return async () => {
    const materialized = getCliCommandsMaterializedSnapshot()
    if (!materialized) {
      void warmCliCommandsMaterialized('cli-listing-fetcher-miss')
    }
    return materialized?.listing ?? null
  }
}
