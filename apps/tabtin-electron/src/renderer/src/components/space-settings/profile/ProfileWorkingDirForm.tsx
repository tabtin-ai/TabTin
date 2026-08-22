/**
 * ProfileWorkingDirForm — Space 工作目录 + 类型表单（执行根 SSOT = Space.working_dir）
 *
 * 状态：
 *   - 遥控器模式（当前 device ≠ control_device）：表单只读 + 提示去 control_device 操作
 *   - 未设置：path 为空，引导选择 + 可选导入旧 sandbox
 *   - 失效：path 非空但 OS 检测不存在，红色警告 + 重新选择（选完自动 updateSpace）
 *   - 正常：显示当前 path（只读）+ 类型可改；不提供「更换目录」（创建时绑定，避免改绑丢现场）
 *
 * 设计原则（PRD §2.4）："TabTin 挂载物理实在，但不创造物理实在"——只支持选已存在
 * 的目录，不建目录。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { AlertTriangle, Code2, FileText, Folder, FolderSearch, MonitorOff } from 'lucide-react'
import { Button, toast } from '@tabtin/smartsheet-ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { SETTINGS_HINT, SETTINGS_LABEL } from '@components/settings/settingsUi'
import { notifyWorkspacePathsForSpace } from '@components/workspace/notifyWorkspacePaths'
import { cn } from '@utils/cn'
import { resolveRealPath } from '@utils/canonicalPath'
import { createLogger } from '@/utils/logger'
import { useIsAgentControlDevice } from '../../../components/context-space/hooks/useIsAgentControlDevice'
import { useIsRemoteViewer } from '../../../components/context-space/hooks/useIsRemoteViewer'
import { useWorkspaceRootHealth } from '../../../components/context-space/hooks/useWorkspaceRootHealth'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { useSpaceExecutionAgent } from '../hooks/useSpaceExecutionAgent'
import { DevicePanel } from '../DevicePanel'
import { ProfileFormShell } from './ProfileFormShell'
import { buildWorkingDirUpdatePayload } from './workingDirPayload'
import {
  findLocalWorkingDirConflict,
  getSelectedWorkingDirCreateBlocker,
  handleWorkingDirConflictResponse,
  isWorkingDirConflictError,
} from './workingDirConflict'

const log = createLogger('WorkingDirForm')

type WorkingDirType = 'code' | 'mixed' | 'doc'

interface ProfileWorkingDirFormProps {
  spaceId: string
  canManage: boolean
  /** 角色是否允许 editor+；传给嵌入的 DevicePanel 做权限提示 */
  roleCanEdit?: boolean
}

interface TypeOption {
  value: WorkingDirType
  labelKey: string
  fallback: string
  Icon: React.FC<{ className?: string }>
}

const TYPE_OPTIONS: TypeOption[] = [
  { value: 'code', labelKey: 'workingDir.types.code', fallback: '代码', Icon: Code2 },
  { value: 'mixed', labelKey: 'workingDir.types.mixed', fallback: '混合', Icon: Folder },
  { value: 'doc', labelKey: 'workingDir.types.doc', fallback: '文档', Icon: FileText },
]

export const ProfileWorkingDirForm: React.FC<ProfileWorkingDirFormProps> = ({
  spaceId,
  canManage,
  roleCanEdit,
}) => {
  const { t } = useTranslation('space')
  // 按 spaceId 解析该 Space 的执行 Agent（缓存未命中会主动拉取），
  // 不再读全局 selectedAgent——否则从 Space 管理页打开非当前选中 Space 时，
  // selectedAgent 可能属于别的 Space 或为 null，导致弹窗整页空白。
  const { space, agent, ensureAgent, isLoading: agentLoading } =
    useSpaceExecutionAgent(spaceId)
  // ：执行根写 Space/Workspace，不再 updateAgent（AgentUpdate 已忽略 working_dir）。
  const { updateSpace, isLoading } = useSpaceStore(
    useShallow((s) => ({
      updateSpace: s.updateSpace,
      isLoading: s.isLoading,
    })),
  )
  const remoteViewer = useIsRemoteViewer(spaceId)
  const currentDeviceFingerprint = useDeviceStore((s) => s.currentDevice?.fingerprint ?? null)
  const currentDeviceId = useDeviceStore((s) => s.currentDevice?.id ?? null)
  const { isControl: rawIsControl, controlDeviceName: agentDeviceName, isResolving: agentResolving } =
    useIsAgentControlDevice(agent)
  // 与 WorkspaceRootBanner / useWorkspaceRootHealth 对齐：Space 级 control_device 才是
  // 本机能否改绑工作目录的 SSOT（无执行 Agent 的 workspace 也走这条）。
  const spaceControlDeviceId =
    space?.control_device_id ?? space?.bound_device_id ?? null
  const isSpaceLocalControl =
    !!spaceControlDeviceId &&
    !!currentDeviceId &&
    spaceControlDeviceId === currentDeviceId
  // 横幅 unreachable 仅用于失效展示；不反推 isControl（health 探针本身已要求本机 control）。
  const { status: rootHealthStatus } = useWorkspaceRootHealth(spaceId)
  const rootUnreachable = rootHealthStatus === 'unreachable'
  const relocateNonce = useAgentSettingsSheetStore((s) => s.relocateNonce)
  //  /  根因 4：区分「这个 Space 没有执行 Agent」和「有执行 Agent 但还没加载出来」。
  // 前者（无 agentId）在 workspace 场景下执行根落 Space 级；后者必须按「解析中」处理。
  const spaceExecutionAgentId = space?.execution_agent_id ?? space?.agent_id ?? null
  const agentPending = !!spaceExecutionAgentId && !agent
  // 远程查看优先；本机 control（含尚未绑定 control_device 的首次设置）可编辑。
  const isControl =
    !remoteViewer.isRemoteViewer &&
    !agentPending &&
    (isSpaceLocalControl ||
      (!remoteViewer.isResolving &&
        !spaceControlDeviceId &&
        (agent ? rawIsControl : true)))
  const isResolving =
    remoteViewer.isResolving || agentPending || (agent ? agentResolving : false)
  const controlDeviceName = remoteViewer.controlDeviceName ?? agentDeviceName

  //  / ：执行根只认 Space.working_dir。Agent 纯化后常带空串，
  // 用 || 而非 ??，避免空串盖住 Space 真值（否则横幅报失效、表单却像「未设置」）。
  const savedWorkingDir = space?.working_dir || agent?.working_dir || ''
  const savedType: WorkingDirType | '' = (space?.working_dir_type ||
    agent?.working_dir_type ||
    '') as WorkingDirType | ''

  const [workingDir, setWorkingDir] = useState(savedWorkingDir)
  const [workingDirType, setWorkingDirType] = useState<WorkingDirType | ''>(savedType)
  /** 已落库路径是否仍可访问；失效重选时以此为准，避免新路径探测结果误拦改绑。 */
  const [savedPathExists, setSavedPathExists] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [legacySandbox, setLegacySandbox] = useState<{ path: string; hasContent: boolean } | null>(null)
  const [isImporting, setIsImporting] = useState(false)

  useEffect(() => {
    setWorkingDir(savedWorkingDir)
    setWorkingDirType(savedType)
    setError(null)
    setSuccess(null)
    setSavedPathExists(null)
  }, [agent?.id, savedWorkingDir, savedType])

  // 失效检测：仅 control_device 上、且针对已落库路径做（其他客户端路径形态不一定相同）。
  useEffect(() => {
    if (!isControl || !savedWorkingDir) {
      return
    }
    let cancelled = false
    const fs = window.tabtin?.fileSystem
    if (!fs?.pathExists) {
      return
    }
    void fs.pathExists(savedWorkingDir).then((result) => {
      if (cancelled) return
      setSavedPathExists(!!(result?.exists && result?.isDirectory))
    }).catch(() => {
      if (cancelled) return
      setSavedPathExists(null)
    })
    return () => {
      cancelled = true
    }
  }, [isControl, savedWorkingDir])

  // 旧 sandbox 探测：未设 working_dir 且当前是 control_device 时才探测
  useEffect(() => {
    if (savedWorkingDir || !isControl) {
      setLegacySandbox(null)
      return
    }
    if (!space) return
    let cancelled = false
    const lookup = window.tabtin?.fileSystem?.lookupSpaceSandbox
    if (!lookup) {
      setLegacySandbox(null)
      return
    }
    void lookup(spaceId, space.organization_id).then((result) => {
      if (cancelled) return
      if (result?.exists && result?.path) {
        setLegacySandbox({ path: result.path, hasContent: !!result.hasContent })
      } else {
        setLegacySandbox(null)
      }
    }).catch(() => {
      if (cancelled) return
      setLegacySandbox(null)
    })
    return () => {
      cancelled = true
    }
  }, [savedWorkingDir, isControl, space, spaceId])

  const persistWorkingDir = useCallback(
    async (
      nextDir: string,
      nextType: WorkingDirType | '',
      options?: { successMessage?: string },
    ): Promise<boolean> => {
      if (!space) {
        log.warn('persist skipped: space missing', { spaceId })
        return false
      }
      // 已绑定且仍可访问的目录不允许改绑；仅允许首次设置、失效重选、改类型。
      // rootUnreachable：与顶部横幅同源，避免 pathExists 尚未回写时误拦重选。
      if (
        savedWorkingDir &&
        nextDir &&
        nextDir !== savedWorkingDir &&
        savedPathExists !== false &&
        !rootUnreachable
      ) {
        setWorkingDir(savedWorkingDir)
        setError(
          t('workingDir.changeDisabled', {
            defaultValue: '工作目录创建后不可更换。目录无法访问时可重新选择。',
          }),
        )
        return false
      }
      const occupied = findLocalWorkingDirConflict({
        organizationId: space.organization_id,
        targetWorkingDir: nextDir,
        excludeSpaceId: spaceId,
      })
      if (occupied) {
        const message = t('create.workingDirConflictNamed', {
          space: occupied.name,
          defaultValue:
            '该目录已被工作空间「{{space}}」占用，请换一个目录或打开已有工作空间',
        })
        setError(message)
        toast({ title: message, variant: 'destructive' })
        return false
      }
      setError(null)
      setSuccess(null)
      try {
        log.info('persist working_dir via updateSpace', {
          spaceId,
          hasDir: Boolean(nextDir),
          type: nextType || null,
        })
        const ok = await updateSpace(spaceId, {
          ...buildWorkingDirUpdatePayload(nextDir, nextType),
          device_fingerprint: currentDeviceFingerprint ?? undefined,
        })
        if (!ok) {
          const conflict = await handleWorkingDirConflictResponse({
            spaceId,
            organizationId: space.organization_id,
            targetWorkingDir: nextDir,
            storeError: useSpaceStore.getState().error,
            t,
          })
          if (conflict === 'opened') return false
          setError(
            isWorkingDirConflictError(useSpaceStore.getState().error)
              ? t('workingDir.conflict', {
                  defaultValue: '这个工作目录已绑定到当前设备上的其他 Space',
                })
              : t('errors.updateFailed', { defaultValue: '更新失败' }),
          )
          return false
        }
        // ：updateSpace 同步写 spaces[]；立即推 main 端执行根，避免切 Space 才收敛。
        void notifyWorkspacePathsForSpace(spaceId)
        setSuccess(
          options?.successMessage ??
            t('workingDir.saved', { defaultValue: '工作目录已保存' }),
        )
        setTimeout(() => setSuccess(null), 2000)
        return true
      } catch (err) {
        log.error('persist working_dir failed', {
          spaceId,
          errorType: err instanceof Error ? err.name : typeof err,
        })
        setError(
          err instanceof Error
            ? err.message
            : t('errors.updateFailed', { defaultValue: '更新失败' }),
        )
        return false
      }
    },
    [
      space,
      spaceId,
      savedWorkingDir,
      savedPathExists,
      rootUnreachable,
      updateSpace,
      currentDeviceFingerprint,
      t,
    ],
  )

  const handlePickDir = useCallback(
    async (options?: { autoSave?: boolean }) => {
      const tabtin = window.tabtin
      if (!tabtin?.showOpenDialog) {
        toast({
          title: t('workingDir.pickUnavailable', {
            defaultValue: '文件夹选择器不可用，请稍后重试',
          }),
          variant: 'destructive',
        })
        return
      }
      try {
        const picked = await tabtin.showOpenDialog({
          properties: ['openDirectory'],
          // 失效重选时定位到原先绑定路径（或其父级，由系统对话框处理）。
          ...(savedWorkingDir ? { defaultPath: savedWorkingDir } : {}),
        })
        if (!picked || picked.length === 0) return
        // 收敛到物理真实路径再绑定：symlink / junction / 大小写不同写法归一到同一目录，
        // 让后端唯一性约束（Team + control_device + normalized path）能正确拦截重复绑定。
        const next = await resolveRealPath(picked[0])
        // 首次设置 / 失效重选：同组织同设备路径已被其他工作空间占用则提示，
        // 仍写入已选路径并由 occupiedBySpace 禁用保存（与创建侧  一致）。
        const existing = findLocalWorkingDirConflict({
          organizationId: space?.organization_id,
          targetWorkingDir: next,
          excludeSpaceId: spaceId,
        })
        let nextType: WorkingDirType | '' = workingDirType
        // 选了新目录且当前还没设过类型 → 按 .git 推断默认类型（跟创建流程一致）
        if (!nextType) {
          try {
            const result = await tabtin?.git?.isGitRepo?.(next)
            nextType = result?.success && result?.isRepo ? 'code' : 'mixed'
          } catch {
            nextType = 'mixed'
          }
        }
        setWorkingDir(next)
        setWorkingDirType(nextType)
        setSuccess(null)
        if (existing) {
          const message = t('create.workingDirConflictNamed', {
            space: existing.name,
            defaultValue:
              '该目录已被工作空间「{{space}}」占用，请换一个目录或打开已有工作空间',
          })
          setError(message)
          toast({ title: message, variant: 'destructive' })
          return
        }
        setError(null)
        // 失效重选：选完即落库，避免用户以为「重新选择」没反应。
        if (options?.autoSave) {
          await persistWorkingDir(next, nextType)
        }
      } catch (err) {
        log.error('pick directory failed', {
          errorType: err instanceof Error ? err.name : typeof err,
        })
        toast({
          title: t('workingDir.pickFailed', { defaultValue: '选择目录失败，请重试' }),
          variant: 'destructive',
        })
      }
    },
    [
      space?.organization_id,
      spaceId,
      t,
      workingDirType,
      savedWorkingDir,
      persistWorkingDir,
    ],
  )

  const handleOpenInFinder = useCallback(() => {
    const tabtin = window.tabtin
    if (!tabtin?.openPath || !workingDir) return
    void tabtin.openPath(workingDir)
  }, [workingDir])

  // 旧 sandbox 一键导入：直接 updateSpace 落库，type 按 .git 智能推断
  const handleImportLegacy = useCallback(async () => {
    if (!legacySandbox) return
    // 无 Agent 也可导入——执行根在 Space；ensureAgent 仅作兼容预热。
    void ensureAgent()
    const existing = findLocalWorkingDirConflict({
      organizationId: space?.organization_id,
      targetWorkingDir: legacySandbox.path,
      excludeSpaceId: spaceId,
    })
    if (existing) {
      const message = t('create.workingDirConflictNamed', {
        space: existing.name,
        defaultValue:
          '该目录已被工作空间「{{space}}」占用，请换一个目录或打开已有工作空间',
      })
      setError(message)
      toast({ title: message, variant: 'destructive' })
      return
    }
    setIsImporting(true)
    setError(null)
    try {
      let inferredType: WorkingDirType = 'mixed'
      try {
        const result = await window.tabtin?.git?.isGitRepo?.(legacySandbox.path)
        if (result?.success && result?.isRepo) inferredType = 'code'
      } catch {
        // ignore；保持 mixed
      }
      setWorkingDir(legacySandbox.path)
      setWorkingDirType(inferredType)
      await persistWorkingDir(legacySandbox.path, inferredType, {
        successMessage: t('workingDir.legacyImported', {
          defaultValue: '已导入旧目录为工作空间',
        }),
      })
    } finally {
      setIsImporting(false)
    }
  }, [legacySandbox, ensureAgent, persistWorkingDir, space?.organization_id, spaceId, t])

  const dirty = useMemo(
    () => workingDir !== savedWorkingDir || workingDirType !== savedType,
    [workingDir, savedWorkingDir, workingDirType, savedType],
  )

  // 硬规则：本机路径已被当前组织其他工作空间占用 → 不允许保存改绑。
  const createBlocker = useMemo(
    () =>
      getSelectedWorkingDirCreateBlocker({
        organizationId: space?.organization_id,
        selectedWorkingDir: workingDir,
        excludeSpaceId: spaceId,
      }),
    [workingDir, space?.organization_id, spaceId],
  )
  const occupiedBySpace = createBlocker.blocked ? createBlocker.existing : undefined

  const pathOccupiedMessage = occupiedBySpace
    ? t('create.workingDirConflictNamed', {
        space: occupiedBySpace.name,
        defaultValue:
          '该目录已被工作空间「{{space}}」占用，请换一个目录或打开已有工作空间',
      })
    : null

  // 校验：path 非空时必须配 type；type 非空时必须配 path；占用路径不可保存
  const canSave = useMemo(() => {
    if (occupiedBySpace) return false
    if (!workingDir && !workingDirType) return true
    return !!workingDir && !!workingDirType
  }, [workingDir, workingDirType, occupiedBySpace])

  const handleSubmit = async () => {
    if (occupiedBySpace) {
      const message =
        pathOccupiedMessage ??
        t('workingDir.conflict', {
          defaultValue: '这个工作目录已绑定到当前设备上的其他 Space',
        })
      setError(message)
      toast({ title: message, variant: 'destructive' })
      return
    }
    await persistWorkingDir(workingDir, workingDirType)
  }

  // 遥控器模式：表单整体只读，提示去 control_device 操作
  // device 还在加载时也禁用编辑，避免短暂闪现"可编辑"。
  // 无 Agent 的 workspace Space 没有设备关系，不用等 device 解析（否则本机无 currentDevice
  // 时会永久禁用，用户无法首次设置目录）——保存时 ensureAgent 由后端权威绑定设备。
  const resolvingGate = agent ? isResolving : false
  const editingDisabled = !canManage || !isControl || resolvingGate
  // 失效警告：本表单 pathExists 或与横幅同源的 root health（避免探测窗口期漏显「重新选择」）。
  const showInvalidWarning =
    isControl &&
    !!savedWorkingDir &&
    workingDir === savedWorkingDir &&
    (savedPathExists === false || rootUnreachable)

  // 横幅 / 起始页「重新选择…」带 relocate 意图打开时，直接弹系统选目录器并自动落库。
  // 用 ref 记已消费的 nonce：面板打开瞬间若仍 editingDisabled，等解锁后再弹一次。
  const consumedRelocateNonceRef = useRef(0)
  useEffect(() => {
    if (!relocateNonce || relocateNonce === consumedRelocateNonceRef.current) return
    if (editingDisabled) return
    consumedRelocateNonceRef.current = relocateNonce
    void handlePickDir({ autoSave: true })
  }, [relocateNonce, editingDisabled, handlePickDir])

  // 仅在「确实无执行 Agent、已加载完、且当前用户无管理权限」时才显示占位提示。
  // 有管理权限时即便 agent 尚未解析出来也渲染表单——保存时 ensureAgent() 兜底补建，
  // 避免像  那样对可编辑用户误显示"暂无可编辑的执行配置"。
  if (!agent && !agentLoading && !canManage) {
    return (
      <p className="text-body text-muted-foreground/60 py-8 text-center">
        {t('profileSheet.noAgent', { defaultValue: '当前工作空间暂无可编辑的执行配置' })}
      </p>
    )
  }

  return (
    <>
    <ProfileFormShell
      dirty={dirty && isControl}
      saving={isLoading || isImporting || agentLoading}
      saveDisabled={editingDisabled || !canSave}
      error={pathOccupiedMessage || error}
      success={success}
      onSubmit={handleSubmit}
    >
      <div className="space-y-4">
        {/* 执行设备与工作目录同屏：绑定 / 恢复仍走 DevicePanel，不再单独占档案行 */}
        <div className="pb-4 border-b border-border/40">
          <DevicePanel
            spaceId={spaceId}
            canManage={canManage}
            roleCanEdit={roleCanEdit ?? canManage}
            embedded
          />
        </div>
        {/* 遥控器模式横幅：Sheet / 主面板已有 RemoteSettingsReadonlyNotice 时不重复 */}
        {!isControl && !isResolving && !remoteViewer.isRemoteViewer && (
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 flex items-start gap-2">
            <MonitorOff className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/80" />
            <div className="space-y-1 text-caption">
              <p className="text-foreground/90">
                {controlDeviceName
                  ? t('workingDir.remoteEditDisabledWithDevice', {
                      device: controlDeviceName,
                      defaultValue: 'Agent 在「{{device}}」上工作。切换到该设备才能修改工作目录。',
                    })
                  : t('workingDir.remoteEditDisabledNoDevice', {
                      defaultValue: 'Agent 还没绑定执行设备。请先在上方选择执行设备。',
                    })}
              </p>
            </div>
          </div>
        )}

        {/* path 区块 */}
        <div className="space-y-2">
          <label className={SETTINGS_LABEL}>
            {t('workingDir.pathLabel', { defaultValue: '工作目录' })}
          </label>

          {!workingDir ? (
            <div className="space-y-2">
              <div className="rounded-md border border-dashed border-border/60 bg-muted/10 px-3 py-4 text-center space-y-2">
                <FolderSearch className="h-5 w-5 mx-auto text-muted-foreground/60" />
                <p className="text-caption text-muted-foreground/80">
                  {t('workingDir.emptyHint', { defaultValue: '尚未设置工作目录，Agent 无法在你的电脑上跑命令、读文件' })}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePickDir()}
                  disabled={editingDisabled}
                >
                  {t('workingDir.pickAction', { defaultValue: '选择文件夹...' })}
                </Button>
              </div>
              {legacySandbox && legacySandbox.hasContent && (
                <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2.5 space-y-2">
                  <p className="text-caption text-foreground/90">
                    {t('workingDir.legacyDetected', {
                      defaultValue: '检测到旧的 Agent 文件夹（早期版本自动创建），点击直接导入',
                    })}
                  </p>
                  <div className="flex items-center gap-2 text-caption text-muted-foreground/80">
                    <Folder className="h-3 w-3 shrink-0" />
                    <span className="font-mono truncate" title={legacySandbox.path}>
                      {legacySandbox.path}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleImportLegacy}
                    disabled={editingDisabled || isImporting}
                  >
                    {isImporting
                      ? t('workingDir.legacyImporting', { defaultValue: '导入中...' })
                      : t('workingDir.legacyImportAction', { defaultValue: '导入为工作空间' })}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div
              className={cn(
                'rounded-md border px-3 py-2.5 space-y-2',
                showInvalidWarning
                  ? 'border-destructive/40 bg-destructive/5'
                  : 'border-border/40 bg-muted/10',
              )}
            >
              <div className="flex items-center gap-2 text-caption">
                {showInvalidWarning ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
                )}
                <span
                  className={cn(
                    'font-mono truncate',
                    showInvalidWarning ? 'text-destructive' : 'text-foreground',
                  )}
                  title={workingDir}
                >
                  {workingDir}
                </span>
              </div>
              {showInvalidWarning && (
                <p className="text-caption text-destructive/90">
                  {t('workingDir.invalidWarning', {
                    defaultValue: '目录无法访问。可能被移动、改名或删除了，请重新选择。',
                  })}
                </p>
              )}
              <div className="flex items-center gap-2 pt-1">
                {showInvalidWarning || occupiedBySpace ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handlePickDir({ autoSave: showInvalidWarning })}
                    disabled={editingDisabled}
                  >
                    {t('workingDir.relocateAction', { defaultValue: '重新选择...' })}
                  </Button>
                ) : null}
                {!showInvalidWarning && !occupiedBySpace && isControl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenInFinder}
                  >
                    {t('workingDir.openInFinder', { defaultValue: '在文件管理器中打开' })}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 类型选择 */}
        <div className="space-y-2">
          <label className={SETTINGS_LABEL}>
            {t('workingDir.typeLabel', { defaultValue: '目录类型' })}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {TYPE_OPTIONS.map(({ value, labelKey, fallback, Icon }) => {
              const active = workingDirType === value
              const disabled = editingDisabled || !workingDir
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setWorkingDirType(value)}
                  disabled={disabled}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md border px-3 py-2 transition-colors',
                    active
                      ? 'border-accent bg-accent/10 text-foreground'
                      : 'border-border/40 bg-muted/10 text-muted-foreground hover:border-accent/40 hover:bg-accent/5',
                    disabled && 'opacity-60 cursor-not-allowed',
                  )}
                >
                  <Icon className={cn('h-3.5 w-3.5', active && 'text-accent')} />
                  <span className="text-caption">{t(labelKey, { defaultValue: fallback })}</span>
                </button>
              )
            })}
          </div>
          <p className={SETTINGS_HINT}>
            {t('workingDir.typeHint', {
              defaultValue:
                '目录类型决定 Agent 默认怎么做事、也决定起始页默认视图：代码偏稳妥、文档偏表达、混合两者兼顾。想特别强调可在「角色设定」里补充；它不会改变「授权策略」里的权限。',
            })}
          </p>
        </div>
      </div>
    </ProfileFormShell>
    </>
  )
}
