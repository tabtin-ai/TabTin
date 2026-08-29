import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { cn } from '@utils/cn'
/**
 * Orchestration App 的 Home Section —— Agent 的"起始页"
 *
 * 这是 Space 的常驻起始页 Tab（apphome:orchestration），不可关闭、永远在最左、
 * 进入 Space 时默认 active。它的内容由 Agent.working_dir + control_device 共同决定：
 *
 *   遥控器模式（当前 device ≠ control_device）→ RemoteAgentBanner
 *   working_dir 未设       → 引导用户去 Agent 设置面板补
 *   pathExists 探测中      → 骨架占位（避免闪现失效）
 *   pathExists 失败        → 红色失效卡片 + 重试 + 重新选择按钮
 *   已设            → LocalDirAutoPane 按 working_dir_type 决定首屏：
 *                     code → TabCode（IDE）；doc / mixed → 目录浏览。
 *                     未设 type 时仍走 Git 仓库自动判定（兼容旧数据）。
 *
 * 单根契约（docs/single-root-space-prd.md）：本 Tab 是 Agent 目录在当前 Space
 * 内**唯一**的可视化窗口。TabCode / TabFolder 作为内嵌渲染组件出现在这里，
 * 没有"独立 App 主页 / 侧边栏入口 / Quick Action 创建独立标签"等其他形态。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, FolderSearch, RefreshCw } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useDeviceStore } from '@stores/useDeviceStore'
import { isCurrentDeviceControl } from '@/services/deviceControlMatch'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { LocalDirAutoPane } from '../../folder/LocalDirAutoPane'
import { useEnsureAgentReady } from '../../hooks/useEnsureAgentReady'
import { RemoteAgentBanner } from '../../folder/RemoteAgentBanner'
import { RemoteFolderPane } from '../../folder/remote/RemoteFolderPane'
import {
  normalizeWorkingDirType,
  resolveExecutionView,
} from '../../workspaceExecutionRootApp'
import type { HomeSectionHandler, HomeSectionProps } from '../types'

type ProbeState = 'idle' | 'checking' | 'ok' | 'fail'

const OrchestrationSection: React.FC<HomeSectionProps> = ({
  spaceId,
  tabScopeKey,
  contextTabKey,
  isPaneActive,
}) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore((state) => state.spaces.find((p) => p.id === spaceId) ?? null)
  const isWorkspace = space?.type === 'workspace'
  const agent = useSpaceStore((state) => {
    if (!isWorkspace) return null
    const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
    if (!agentId) return null
    return state.agentCache[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null)
  })
  const currentDevice = useDeviceStore((state) => state.currentDevice)
  const currentDeviceId = currentDevice?.id ?? null
  const devices = useDeviceStore((state) => state.devices)
  const openSheet = useAgentSettingsSheetStore((s) => s.open)
  const controlDeviceId =
    space?.control_device_id
    ?? space?.bound_device_id
    ?? agent?.control_device_id
    ?? agent?.bound_device_id
    ?? null
  const controlDevice = controlDeviceId
    ? (devices ?? []).find((device) => device.id === controlDeviceId)
    : null
  const controlDeviceName = controlDevice?.name ?? null
  const isResolving = !currentDeviceId
  const isControl = isCurrentDeviceControl(controlDeviceId, currentDevice, devices ?? [])
  //  开箱即用：进入未初始化的 Agent 时静默绑本机设备 + 补默认 ~/TabTin/<团队>/<名字> 目录。
  // ：绑定丢失但目录已配置 → readyStatus='needs-reclaim'，不静默接管，由下方卡片显式征询。
  const { status: readyStatus, reclaim } = useEnsureAgentReady(spaceId, agent)

  const workingDir = space?.working_dir || agent?.working_dir || ''
  const workingDirType = normalizeWorkingDirType(space?.working_dir_type ?? agent?.working_dir_type)
  const preferredView = workingDirType ? resolveExecutionView(workingDirType) : undefined
  const [probeState, setProbeState] = useState<ProbeState>('idle')
  // 强制重新探测的 nonce（点击"重试"按钮时 ++）—— 不直接依赖 workingDir 是为了能在
  // 同一 path 上手动重试，覆盖 OS 缓存 / 网络挂载短暂掉线场景
  const [probeNonce, setProbeNonce] = useState(0)

  useEffect(() => {
    // 只有当前是 control_device + 有 workingDir 时才做本地 fs 探测
    if (!isControl || !workingDir) {
      setProbeState('idle')
      return
    }
    setProbeState('checking')
    let cancelled = false
    const fs = window.tabtin?.fileSystem
    if (!fs?.pathExists) {
      setProbeState('idle')
      return
    }
    void fs.pathExists(workingDir).then((result) => {
      if (cancelled) return
      setProbeState(result?.exists && result?.isDirectory ? 'ok' : 'fail')
    }).catch(() => {
      if (cancelled) return
      setProbeState('fail')
    })
    return () => {
      cancelled = true
    }
  }, [isControl, workingDir, probeNonce])

  const handleOpenSettings = useCallback(() => {
    openSheet('working-dir', spaceId)
  }, [openSheet, spaceId])

  const handleRelocate = useCallback(() => {
    openSheet('working-dir', spaceId, { relocate: true })
  }, [openSheet, spaceId])

  const handleRetryProbe = useCallback(() => {
    setProbeNonce((n) => n + 1)
  }, [])

  const renderPreparing = (message: string) => (
    <div className="h-full w-full flex items-center justify-center text-body text-muted-foreground/60">
      {message}
    </div>
  )

  // ── State 0: 设备绑定（遥控器模式 /  自愈）──
  if (isResolving) {
    return <RemoteAgentBanner controlDeviceName={null} isResolving={true} />
  }
  if (!isControl) {
    // 真·遥控器：Agent 已绑在「别的」设备上 → 本机只能远程查看。
    if (controlDeviceId) {
      // ：执行设备可用（在线/忙碌）且 working_dir 已设 →
      // 远程只读文件浏览（经 Django 中继 RPC 到执行设备）；否则维持
      // 原 Banner 占位（设备离线时发 RPC 只会得到超时/离线错误）。
      const controlDeviceAvailable =
        controlDevice?.status === 'online' || controlDevice?.status === 'busy'
      if (controlDeviceAvailable && workingDir) {
        return (
          <RemoteFolderPane
            key={`remote-folder:${spaceId}:${workingDir}`}
            spaceId={spaceId}
            rootPath={workingDir}
            deviceName={controlDeviceName}
            contextScopeKey={tabScopeKey}
            contextTabKey={contextTabKey}
          />
        )
      }
      return (
        <RemoteAgentBanner
          controlDeviceName={controlDeviceName}
          workingDir={workingDir || undefined}
        />
      )
    }
    // ：绑定丢失但目录已配置过 → 显式征询是否在本机接管，绝不静默换绑 / 换目录。
    if (readyStatus === 'needs-reclaim') {
      return (
        <div className="h-full w-full flex flex-col items-center justify-center px-8 text-center">
          <AlertTriangle className="h-12 w-12 mb-4 text-amber-500/80" />
          <h3 className="text-h4 text-foreground mb-2">
            {t('agentReady.reclaimTitle', { defaultValue: '此 Space 的执行设备已不可用' })}
          </h3>
          <p className="text-body text-muted-foreground/80 max-w-md mb-2 leading-relaxed">
            {t('agentReady.reclaimDescription', {
              defaultValue:
                '原来绑定的设备被移除了，工作目录还指向那台设备。你可以在本机接管这个 Space，接管后按需重新选择本机目录。',
            })}
          </p>
          {workingDir ? (
            <p className={cn('font-mono', 'max-w-md', 'mb-6', 'truncate', CANVAS_TEXT_META)}>
              {workingDir}
            </p>
          ) : null}
          <Button onClick={() => void reclaim()} className="bg-accent hover:bg-accent/90">
            {t('agentReady.reclaimAction', { defaultValue: '在本机接管' })}
          </Button>
        </div>
      )
    }
    // ：从没绑过设备 → 自愈正在把本机绑为 control_device（成功后 isControl 转 true）。
    // 自愈失败（如本机离线/未注册）才退回遥控器提示，避免无限加载。
    if (readyStatus === 'error') {
      return (
        <RemoteAgentBanner
          controlDeviceName={controlDeviceName}
          workingDir={workingDir || undefined}
        />
      )
    }
    return renderPreparing(t('agentReady.bindingDevice', { defaultValue: '正在本机就绪…' }))
  }

  // ── State 1: working_dir 未设 ──
  if (!workingDir) {
    // ：默认目录自愈进行中 → 加载态；仅在自愈失败时才退回手动「前往设置」墙。
    if (readyStatus !== 'error') {
      return renderPreparing(t('agentReady.preparingDir', { defaultValue: '正在准备工作空间…' }))
    }
    return (
      <div className="h-full w-full flex flex-col items-center justify-center px-8 text-center">
        <FolderSearch className="h-12 w-12 mb-4 text-muted-foreground/40" />
        <h3 className="text-h4 text-foreground mb-2">
          {t('workingDir.emptyTitle', { defaultValue: '还没设置工作空间' })}
        </h3>
        <p className="text-body text-muted-foreground/80 max-w-md mb-6 leading-relaxed">
          {t('workingDir.emptyDescription', {
            defaultValue: '选一个本地文件夹作为工作空间，Agent 就能在这台电脑上跑命令、读写文件、操作浏览器。',
          })}
        </p>
        <Button onClick={handleOpenSettings} className="bg-accent hover:bg-accent/90">
          {t('workingDir.setupAction', { defaultValue: '前往设置' })}
        </Button>
      </div>
    )
  }

  // ── State 2: 探测中 —— 骨架占位避免闪现失效 ──
  if (probeState === 'checking' || probeState === 'idle') {
    return (
      <div className="h-full w-full flex items-center justify-center text-body text-muted-foreground/60">
        {t('label.loading', { ns: 'context', defaultValue: '加载中…' })}
      </div>
    )
  }

  // ── State 3: 失效 ──
  if (probeState === 'fail') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center px-8 text-center">
        <AlertTriangle className="h-12 w-12 mb-4 text-destructive/80" />
        <h3 className="text-h4 text-foreground mb-2">
          {t('workingDir.invalidTitle', { defaultValue: '工作空间无法访问' })}
        </h3>
        <p className="text-body text-muted-foreground/80 max-w-md mb-2 leading-relaxed">
          {t('workingDir.invalidDescription', {
            defaultValue: '当前工作空间在磁盘上找不到——可能被移动、改名或删除了。',
          })}
        </p>
        <p className={cn('font-mono', 'max-w-md', 'mb-6', 'truncate', CANVAS_TEXT_META)}>
          {workingDir}
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={handleRetryProbe} variant="outline" className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('workingDir.retryAction', { defaultValue: '重试' })}
          </Button>
          <Button onClick={handleRelocate} variant="outline">
            {t('workingDir.relocateAction', { defaultValue: '重新选择...' })}
          </Button>
        </div>
      </div>
    )
  }

  // ── State 4: 按 working_dir_type 打开 IDE 或目录浏览；未设 type 时 LocalDirAutoPane 仍走 Git 自动判定 ──
  const folderTitle = workingDir.split(/[\\/]/).filter(Boolean).pop() || workingDir
  return (
    <LocalDirAutoPane
      key={`localdir:${spaceId}:${workingDir}`}
      rootPath={workingDir}
      kind="user"
      title={folderTitle}
      spaceId={spaceId}
      preferredView={preferredView}
      contextScopeKey={tabScopeKey}
      contextTabKey={contextTabKey}
      isPaneActive={isPaneActive}
    />
  )
}

export const orchestrationHomeSection: HomeSectionHandler = {
  appId: 'orchestration',
  labelKey: 'home.assetBrowser.agent',
  Component: OrchestrationSection,
}
