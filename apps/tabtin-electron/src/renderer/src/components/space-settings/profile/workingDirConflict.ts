/**
 * workingDirConflict — 工作目录唯一性冲突的处理
 *
 * 创建 / 变更 working_dir 时，后端按 Team + control_device + normalized path
 * 拒绝重复绑定。前端收到 WORKING_DIR_CONFLICT 后查找已有 Space 并引导打开。
 */
import { toast } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'
import type { Space } from '@tabtin/app-shell'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'

export function normalizeWorkingDirForCompare(path: string | null | undefined): string {
  const trimmed = (path ?? '').trim()
  // Windows 路径大小写不敏感；统一小写后再比，避免 C:\A 与 c:\a 漏检。
  const stripped = trimmed.replace(/[\\/]+$/, '')
  if (/^[a-zA-Z]:[\\/]/.test(stripped) || stripped.startsWith('\\\\')) {
    return stripped.toLowerCase()
  }
  return stripped
}

export function isWorkingDirConflictError(error: string | null | undefined): boolean {
  const message = error ?? ''
  // 后端 / i18n 可能返回中文或英文文案；子串须覆盖双语，勿把英文 Workspace 改成中文。
  return (
    message.includes('WORKING_DIR_CONFLICT') ||
    message.includes('工作目录已绑定') ||
    message.includes('already bound to another Workspace') ||
    message.includes('already bound to another Space')
  )
}

export function findSpaceByWorkingDirConflict(options: {
  organizationId: string
  targetWorkingDir: string
  currentDeviceId: string | null
  excludeSpaceId?: string
}): Space | undefined {
  const normalizedTarget = normalizeWorkingDirForCompare(options.targetWorkingDir)
  if (!normalizedTarget) return undefined
  return useSpaceStore.getState().spaces.find((space) => {
    if (options.excludeSpaceId && space.id === options.excludeSpaceId) return false
    if (space.organization_id !== options.organizationId) return false
    if (options.currentDeviceId && space.control_device_id !== options.currentDeviceId) return false
    const candidate = normalizeWorkingDirForCompare(
      space.normalized_working_dir || space.working_dir,
    )
    return candidate === normalizedTarget
  })
}

export type WorkingDirConflictHandleResult = 'opened' | 'conflict_unresolved' | 'not_conflict'

export async function handleWorkingDirConflictResponse(options: {
  spaceId?: string
  organizationId: string
  targetWorkingDir: string
  storeError: string | null | undefined
  t: TFunction
}): Promise<WorkingDirConflictHandleResult> {
  if (!isWorkingDirConflictError(options.storeError)) {
    return 'not_conflict'
  }

  const currentDeviceId = useDeviceStore.getState().currentDevice?.id ?? null
  const existingSpace = findSpaceByWorkingDirConflict({
    organizationId: options.organizationId,
    targetWorkingDir: options.targetWorkingDir,
    currentDeviceId,
    excludeSpaceId: options.spaceId,
  })

  if (!existingSpace) {
    return 'conflict_unresolved'
  }

  const opened = await ensureSpaceSelectedWithFeedback(existingSpace.id, {
    organizationId: options.organizationId,
    failureToast: {
      title: options.t('create.existingSpaceOpenFailed', {
        ns: 'space',
        defaultValue: '目录已绑定，但未能自动打开已有工作空间',
      }),
      variant: 'destructive',
    },
  })

  if (opened) {
    toast({
      title: options.t('create.existingSpaceOpened', {
        ns: 'space',
        defaultValue: '已打开使用该目录的工作空间「{{space}}」',
        space: existingSpace.name,
      }),
    })
    return 'opened'
  }

  return 'conflict_unresolved'
}

/** 选目录时本地预检：同设备同路径已有 Workspace 则直接提示，不必等提交。 */
export function findLocalWorkingDirConflict(options: {
  organizationId: string | null | undefined
  targetWorkingDir: string
  excludeSpaceId?: string
}): Space | undefined {
  if (!options.organizationId) return undefined
  const currentDeviceId = useDeviceStore.getState().currentDevice?.id ?? null
  return findSpaceByWorkingDirConflict({
    organizationId: options.organizationId,
    targetWorkingDir: options.targetWorkingDir,
    currentDeviceId,
    excludeSpaceId: options.excludeSpaceId,
  })
}

/**
 * 创建提交前：已选手动目录则必须通过本地冲突预检。
 *
 * 空目录表示「未选手动目录」，调用方可走默认目录兜底；
 * 已选且冲突时必须拦截——禁止清空后回落到 ensureDefaultAgentDir。
 */
export function getSelectedWorkingDirCreateBlocker(options: {
  organizationId: string | null | undefined
  selectedWorkingDir: string
  excludeSpaceId?: string
}): { blocked: false } | { blocked: true; existing: Space } {
  const selected = options.selectedWorkingDir.trim()
  if (!selected) return { blocked: false }
  const existing = findLocalWorkingDirConflict({
    organizationId: options.organizationId,
    targetWorkingDir: selected,
    excludeSpaceId: options.excludeSpaceId,
  })
  if (!existing) return { blocked: false }
  return { blocked: true, existing }
}
