/**
 * useSubagentTemplateMeta — 按 spaceId 解析「templateId → { name, color }」。
 *
 * 冷源重载时 `deriveSubagentRunsFromMessages` 只能从父消息里恢复 `templateId`
 * （模板名 / 颜色不在 tool_use.input 里，也不落 run），聚合视图要展示模板名 badge
 * 并按模板的 `display_color` 染色，就需要用 templateId 反查当前 Space 的模板列表。
 * live 与冷源都带 templateId，故统一走这条反查。
 *
 * 每个 space 只拉一次（模块级缓存 + inflight 去重），仅在确有带 templateId 的 run
 * 时才触发（`enabled`）。
 */
import { useEffect, useState } from 'react'
import { SubAgentTemplateApi } from '@/services/subagentTemplateApi'

export interface SubagentTemplateMeta {
  name: string
  /** 模板配置的显示颜色（hex，可能为空串）。 */
  color: string
}

const metaCache = new Map<string, Map<string, SubagentTemplateMeta>>()
const inflight = new Map<string, Promise<Map<string, SubagentTemplateMeta>>>()

async function fetchMeta(spaceId: string): Promise<Map<string, SubagentTemplateMeta>> {
  const items = await SubAgentTemplateApi.list(spaceId)
  const map = new Map<string, SubagentTemplateMeta>()
  for (const it of items) {
    if (!it.id) continue
    map.set(it.id, {
      name: it.name?.trim() ?? '',
      color: it.display_color?.trim() ?? '',
    })
  }
  metaCache.set(spaceId, map)
  return map
}

export function useSubagentTemplateMeta(
  spaceId: string | undefined,
  enabled: boolean,
): Map<string, SubagentTemplateMeta> {
  const [map, setMap] = useState<Map<string, SubagentTemplateMeta>>(
    () => (spaceId ? metaCache.get(spaceId) : undefined) ?? new Map(),
  )

  useEffect(() => {
    if (!enabled || !spaceId) return
    const cached = metaCache.get(spaceId)
    if (cached) {
      setMap(cached)
      return
    }
    let alive = true
    let p = inflight.get(spaceId)
    if (!p) {
      p = fetchMeta(spaceId).finally(() => inflight.delete(spaceId))
      inflight.set(spaceId, p)
    }
    p.then((m) => {
      if (alive) setMap(m)
    }).catch(() => {
      /* 拉取失败：保持空 map，badge 走「无名不显 / 不染色」，不报错打断阅读流 */
    })
    return () => {
      alive = false
    }
  }, [spaceId, enabled])

  return map
}
