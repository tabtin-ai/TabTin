/**
 * useSkillSync — 本地 Skill 文件同步（Wave 1 重构，PRD V3.3 §11.5）。
 *
 * Wave 1 起草稿不上云：
 * - 不再调 ``syncAgentSkills`` 把本地 SKILL.md 推送到云端
 * - 主进程 LocalSkillRegistry 直接扫描 sandbox + ``~/.agents/skills/`` 索引
 * - 文件变更触发 ``skills:dir-changed`` IPC，由 react-query 失效本地缓存
 *
 * 本 hook 仅负责：
 * 1. mount 时确保 Space sandbox 存在
 * 2. 监听 ``skills:dir-changed`` IPC 事件
 * 3. unmount 自动清理
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { skillKeys } from '@/hooks/queries/skills'
import { useSpaceStore } from '@/stores/useSpaceStore'

interface UseSkillSyncOptions {
  enabled?: boolean
}

export function useSkillSync(spaceId: string | null | undefined, options?: UseSkillSyncOptions) {
  const { enabled = true } = options ?? {}
  const sandboxPathRef = useRef<string | null>(null)
  const queryClient = useQueryClient()
  // ：invalidate 走 organizationId 前缀，与 skills query key 一致；
  // spaceId 仅用于 ensureSpaceSandbox 本地 IPC。
  const organizationId = useSpaceStore(state =>
    spaceId ? state.spaces.find(s => s.id === spaceId)?.organization_id ?? null : null,
  )

  useEffect(() => {
    if (!spaceId || !enabled) return
    let cancelled = false

    const ensureSpaceSandbox = window.tabtin?.fileSystem?.ensureSpaceSandbox
    if (!ensureSpaceSandbox) return

    ensureSpaceSandbox(spaceId)
      .then((result: { success: boolean; path?: string }) => {
        if (cancelled || !result?.success || !result.path) return
        sandboxPathRef.current = result.path
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn('[useSkillSync] ensureSpaceSandbox failed:', err)
        }
      })

    // Wave 1：监听主进程 watcher 广播的变更事件，触发 react-query 缓存失效
    const ipcRenderer = window.electron?.ipcRenderer
    const handleDirChanged = () => {
      if (cancelled) return
      if (organizationId) {
        void queryClient.invalidateQueries({ queryKey: skillKeys.list(organizationId) })
        void queryClient.invalidateQueries({ queryKey: skillKeys.configs(organizationId) })
      }
      // 任意 skill 文件变更（编辑器保存 / Agent skill_create / watcher 自动）
      // 都需要让 SkillMdEditor 重新读 read-content；不缩 key 到具体 skillKey
      // 是因为 watcher 事件不带 skillKey，统一全失效。
      void queryClient.invalidateQueries({ queryKey: [...skillKeys.all, 'content'] })
    }
    const removeListener = ipcRenderer?.on?.('skills:dir-changed', handleDirChanged)

    return () => {
      cancelled = true
      if (typeof removeListener === 'function') {
        removeListener()
      } else {
        ipcRenderer?.removeListener?.('skills:dir-changed', handleDirChanged)
      }
    }
  }, [spaceId, organizationId, enabled, queryClient])

  return { sandboxPath: sandboxPathRef }
}
