import { useMemo } from 'react'
import { useSpaceAppEnabled } from '@stores/useSpaceApps'
import { useFolderContextStore } from '../folder/useFolderStore'
import { useFolderPathValidation } from './useFolderPathValidation'
import { useTinsStore } from '@/stores/useTinsStore'
import { useTrackerListState } from '@/stores/useTrackerStore'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { TINS_UI_ENABLED } from '@/utils/featureFlags'
import type { SpaceContextItem as SearchResultItem } from '@/services/spaceApi'

/**
 * 聚合本地/独立 API 来源的资源，生成标准 SearchResultItem 列表。
 * 从 ContextHome 中提取以降低单文件复杂度并方便测试。
 */
export function useLocalContextItems(spaceId: string): SearchResultItem[] {
  const organizationId = useResolvedOrganizationId()
  const folderMap = useFolderContextStore(s => s.folders)
  const getFolderIds = useFolderContextStore(s => s.getSpaceFolderIds)
  const isFolderEnabled = useSpaceAppEnabled(spaceId, 'tabfolder')
  const invalidFolderIds = useFolderPathValidation(spaceId)

  const tinInstances = useTinsStore(s => s.instances)
  const isTinsEnabled = useSpaceAppEnabled(spaceId, 'tins')

  const { tasks: trackers } = useTrackerListState(organizationId, spaceId)
  const isTrackerEnabled = useSpaceAppEnabled(spaceId, 'tabtracker')

  return useMemo<SearchResultItem[]>(() => {
    const items: SearchResultItem[] = []

    if (isFolderEnabled) {
      const folderIds = getFolderIds(spaceId)
      for (const fid of folderIds) {
        const state = folderMap[fid]
        if (!state) continue
        const isInvalid = invalidFolderIds.has(fid)
        items.push({
          id: `local:tabfolder:${fid}`,
          item_type: 'tabfolder',
          title: state.title || state.rootPath,
          preview: isInvalid ? '' : state.rootPath,
          resource_id: fid,
          space_id: spaceId,
          metadata: { path: state.rootPath, kind: state.kind, pathInvalid: isInvalid },
          is_archived: false,
          is_pinned: false,
          updated_at: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
          created_at: null,
        })
      }
    }

    if (isTrackerEnabled) {
      for (const tk of trackers) {
        if (tk.space_id && tk.space_id !== spaceId) continue
        items.push({
          id: `local:tabtracker:${tk.id}`,
          item_type: 'tabtracker',
          title: tk.name,
          preview: tk.description || '',
          resource_id: tk.id,
          space_id: spaceId,
          metadata: { spaceId, taskId: tk.id, status: tk.status, trigger_type: tk.trigger_type },
          is_archived: false,
          is_pinned: false,
          updated_at: tk.updated_at,
          created_at: tk.created_at,
        })
      }
    }

    if (TINS_UI_ENABLED && isTinsEnabled) {
      for (const inst of tinInstances) {
        items.push({
          id: `local:tins:${inst.id}`,
          item_type: 'tins',
          title: inst.tin.name,
          preview: '',
          resource_id: `tins-${spaceId}`,
          space_id: spaceId,
          metadata: { spaceId, tinInstanceId: inst.id, icon_url: inst.tin.icon_url, is_enabled: inst.is_enabled },
          is_archived: false,
          is_pinned: false,
          updated_at: inst.updated_at,
          created_at: inst.created_at,
        })
      }
    }

    return items
  }, [
    spaceId, isFolderEnabled, getFolderIds, folderMap, invalidFolderIds,
    isTrackerEnabled, trackers,
    isTinsEnabled, tinInstances,
  ])
}

/** 暴露 invalidFolderIds 供 ContextHome 传递给 sectionProps */
export function useInvalidFolderIds(spaceId: string): Set<string> {
  return useFolderPathValidation(spaceId)
}
