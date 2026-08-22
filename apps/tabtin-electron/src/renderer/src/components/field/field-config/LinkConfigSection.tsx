/**
 * LinkConfigSection — Electron 适配层
 *
 * 包装 smartsheet-ui 的平台无关版本，注入 Electron 的 store/API 作为回调。
 */

import React, { useCallback } from 'react'
import {
  LinkConfigSection as SharedLinkConfigSection,
  type LinkConfigSectionProps as SharedProps,
  type LinkTableOption,
  type LinkForeignMeta,
  type LinkableFieldItem,
} from '@tabtin/smartsheet-ui'
import { FieldApiService, TableApiService, ViewApiService } from '@tabtin/table-core'
import { useSpaceStore } from '@/stores/useSpaceStore'

type ElectronLinkProps = Omit<SharedProps, 'tables' | 'onLoadTables' | 'onLoadForeignMeta'>

export const LinkConfigSection: React.FC<ElectronLinkProps> = (props) => {
  const selectedSpace = useSpaceStore((s) => s.selectedSpace)

  const onLoadTables = useCallback(async (): Promise<LinkTableOption[]> => {
    if (!selectedSpace?.id) return []
    const res = await TableApiService.getTablesBySpace(selectedSpace.organization_id, selectedSpace.id)
    const tableList = (res?.tables || res || []) as Array<{ id: string; name: string }>
    return tableList.map((t) => ({ id: t.id, name: t.name }))
  }, [selectedSpace?.id, selectedSpace?.organization_id])

  const onLoadForeignMeta = useCallback(
    async (tableId: string): Promise<LinkForeignMeta> => {
      const [fieldsResp, viewsResp] = await Promise.all([
        FieldApiService.getFields(tableId),
        ViewApiService.getViewsByTable(tableId),
      ])
      const fieldList = (fieldsResp as { fields?: unknown })?.fields ?? fieldsResp
      const fields: LinkableFieldItem[] = (Array.isArray(fieldList) ? fieldList : []).map((f: any) => ({
        id: String(f.id),
        name: f.name || '',
        field_type: f.field_type || 'text',
        is_primary: Boolean(f.is_primary),
      }))
      const viewList = (viewsResp as { views?: unknown })?.views ?? viewsResp
      const views = (Array.isArray(viewList) ? viewList : []).map((v: any) => ({
        id: String(v.id),
        name: v.name || '',
      }))
      return { fields, views }
    },
    [],
  )

  return (
    <SharedLinkConfigSection
      {...props}
      onLoadTables={onLoadTables}
      onLoadForeignMeta={onLoadForeignMeta}
    />
  )
}

export type { SharedProps as LinkConfigSectionProps }
