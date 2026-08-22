import { useEffect, useMemo, useRef, useState } from 'react'
import { useFolderContextStore } from '../folder/useFolderStore'
import { isLegacyOk } from '@/services/legacy-result'

/**
 * 异步校验文件夹路径是否仍然有效（目录存在且可读）。
 * 返回 `invalidFolderIds: Set<string>`，包含所有路径已失效的文件夹 ID。
 */
export function useFolderPathValidation(spaceId: string) {
  const folders = useFolderContextStore(s => s.folders)
  const getSpaceFolderIds = useFolderContextStore(s => s.getSpaceFolderIds)

  const folderEntries = useMemo(() => {
    return getSpaceFolderIds(spaceId)
      .map(id => ({ id, path: folders[id]?.rootPath }))
      .filter((f): f is { id: string; path: string } => !!f.path)
  }, [getSpaceFolderIds, spaceId, folders])

  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set())
  const checkVersionRef = useRef(0)

  useEffect(() => {
    const version = ++checkVersionRef.current
    if (folderEntries.length === 0) {
      setInvalidIds(new Set())
      return
    }

    let cancelled = false
    const check = async () => {
      const nextInvalid = new Set<string>()
      for (const entry of folderEntries) {
        if (cancelled) return
        try {
          // contract W2-β: fs:readDir (LEGACY_HANDLERS) — readDir 失败 = 路径
          // 已删除 / 权限丢失，标记 invalid 是正确语义；W2-α envelope ok:false
          // 短路也会落 catch 同样处理。用 isLegacyOk 收口字面 success。
          const dirRes = await window.tabtin.fileSystem.readDir(entry.path)
          if (!isLegacyOk(dirRes)) nextInvalid.add(entry.id)
        } catch {
          nextInvalid.add(entry.id)
        }
      }
      if (!cancelled && checkVersionRef.current === version) {
        setInvalidIds(nextInvalid)
      }
    }
    check()
    return () => { cancelled = true }
  }, [folderEntries])

  return invalidIds
}
