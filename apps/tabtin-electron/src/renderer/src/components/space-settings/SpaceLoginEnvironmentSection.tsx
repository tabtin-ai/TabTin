/**
 * Space 设置面板"登录环境"区块。
 *
 * Phase 0（移除独立浏览器 cookie）后本组件退役为「历史兼容出口」：
 * 仅对仍绑定非默认 env 的历史 Space 渲染（见下方 return null 守卫），
 * 只提供「切回共享环境 / 在已有环境间切换」，不再提供「新建独立环境」入口。
 *
 * 数据流：
 *   - useBrowserEnvListQuery: 一次拉所有 environments + 当前 space binding
 *   - useBindSpaceMutation: 切换绑定后 invalidate query + 弹"刷新 TabWeb 标签"toast
 *
 * 注意：不挂 navKey，作为 GeneralSection 内的 sub-section。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
  cn,
} from '@tabtin/smartsheet-ui'
import { ChevronDown, Globe, Loader2, Lock } from 'lucide-react'
import {
  SETTINGS_HINT,
  SETTINGS_SECTION_TITLE,
} from '../settings/settingsUi'
import type {
  BrowserEnvBindResult,
  BrowserEnvBootstrap,
  BrowserEnvironment,
  BrowserEnvWriteResult,
} from '@shared/types/browser-env'
import { useAuthStore } from '@stores/useAuthStore'
import { ensureLegacyOk } from '@/services/legacy-result'

interface BrowserEnvAPI {
  /**
   * 本地化退役 Wave 1 后:list 一次返回 environments + bindings(纯本地读)。
   * 无 HTTP / pending 概念,失败仅在 IPC 不可用时发生。
   */
  list: () => Promise<
    | { success: true; environments: BrowserEnvironment[]; bindings: BrowserEnvBootstrap['bindings'] }
    | { success: false; code?: string; error?: string }
  >
  create: (payload: { name: string }) => Promise<BrowserEnvWriteResult>
  bindSpace: (payload: { spaceId: string; environmentId: string }) => Promise<BrowserEnvBindResult>
  onChanged: (
    cb: (payload: { reason: string; spaceId?: string; environmentId?: string }) => void,
  ) => () => void
}

function readBrowserEnvAPI(): BrowserEnvAPI | null {
  if (typeof window === 'undefined') return null
  const tabtin = (window as any).tabtin
  return tabtin?.browserEnv ?? null
}

const browserEnvKeys = {
  all: ['browser-env'] as const,
  list: () => [...browserEnvKeys.all, 'list'] as const,
}

/**
 * 拉 environments + bindings —— 本地优先,纯同步读 IPC。
 *
 * contract W2-β: channel `browser-env:list` 在 LEGACY_HANDLERS 内（preload 透传
 * raw `{success, ...}`）。queryFn 内部主动 ensureLegacyOk 转 throw，
 * react-query 的 isError state 自动接管失败。main 端将来迁 envelope 后 helper 退化。
 */
function useBrowserEnvListQuery() {
  return useQuery({
    queryKey: browserEnvKeys.list(),
    queryFn: async (): Promise<BrowserEnvBootstrap> => {
      const api = readBrowserEnvAPI()
      if (!api) throw new Error('browserEnv API 不可用(preload 未就绪)')
      const listRes = await api.list()
      ensureLegacyOk(listRes, 'browserEnv list')
      return { environments: listRes.environments, bindings: listRes.bindings }
    },
    staleTime: 30_000,
  })
}

function useBindSpaceMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: { spaceId: string; environmentId: string }) => {
      const api = readBrowserEnvAPI()
      if (!api) throw new Error('browserEnv API 不可用')
      const bindRes = await api.bindSpace(payload)
      ensureLegacyOk(bindRes, 'browserEnv bindSpace')
      if (!bindRes.environment) {
        throw new Error('browserEnv bindSpace 返回 environment 为空')
      }
      return bindRes.environment
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: browserEnvKeys.all })
    },
  })
}

/**
 * Wave 5b 视角 3#7 自修：原"已读"标记是裸 key（`tabtin:space:env-switch-explained`），
 * 多账号设备共用 → A 用户已读 → B 用户登录后第一次切环境**也不弹**说明对话框，
 * 丢掉了 PD-2 "用户级登录环境" 的关键 onboarding 节点。改成 user.id 前缀隔离。
 *
 * 兼容性：旧 key 不再读，新 key 重新走"未读"路径——上线后老用户会被多弹一次
 * 说明对话框，可接受。
 */
const FIRST_TIME_SWITCH_KEY_PREFIX = 'tabtin:space:env-switch-explained:'

function hasSeenSwitchExplanation(userId: string | null | undefined): boolean {
  if (!userId) return false // 匿名 / 未登录态保守每次都弹
  try {
    return window.localStorage.getItem(`${FIRST_TIME_SWITCH_KEY_PREFIX}${userId}`) === '1'
  } catch {
    return false
  }
}

function markSwitchExplanationSeen(userId: string | null | undefined): void {
  if (!userId) return
  try {
    window.localStorage.setItem(`${FIRST_TIME_SWITCH_KEY_PREFIX}${userId}`, '1')
  } catch {
    // localStorage 不可用（隐私模式）→ 每次都弹一遍说明，不影响功能
  }
}

export interface SpaceLoginEnvironmentSectionProps {
  spaceId: string
  /** 是否允许编辑（admin+，与 GeneralSection 危险区一致）。 */
  canManage: boolean
}

export const SpaceLoginEnvironmentSection: React.FC<SpaceLoginEnvironmentSectionProps> = ({
  spaceId,
  canManage,
}) => {
  const { t } = useTranslation('space')
  const { data, isLoading, error } = useBrowserEnvListQuery()
  const bindMutation = useBindSpaceMutation()
  // Wave 5b 视角 3#7：localStorage 已读标记按 user.id 隔离，避免多账号设备误吞 onboarding。
  const currentUserId = useAuthStore((state) => state.user?.id ?? null)

  // 订阅 browserEnv 变更事件，主进程缓存改变后自动 invalidate
  const queryClient = useQueryClient()
  useEffect(() => {
    const api = readBrowserEnvAPI()
    if (!api?.onChanged) return undefined
    const unsub = api.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: browserEnvKeys.all })
    })
    return () => {
      try {
        unsub()
      } catch {
        // ignore
      }
    }
  }, [queryClient])

  const environments = data?.environments ?? []
  const bindings = data?.bindings ?? []

  const currentEnv = useMemo(() => {
    const binding = bindings.find((b) => b.space_id === spaceId)
    if (binding) {
      return environments.find((e) => e.id === binding.environment_id) ?? null
    }
    // 无显式绑定 = fallback 到默认环境
    return environments.find((e) => e.is_default) ?? null
  }, [environments, bindings, spaceId])

  const [switchOpen, setSwitchOpen] = useState(false)
  const [explanationOpen, setExplanationOpen] = useState(false)
  const [pendingEnvId, setPendingEnvId] = useState<string | null>(null)

  const performSwitch = async (environmentId: string) => {
    try {
      await bindMutation.mutateAsync({ spaceId, environmentId })
      // 本地化退役 Wave 3 收尾：BES 写盘后 broadcast `browser-env:changed` →
      // renderer mirror 升级 → tabsSlice listener 改 `crawlspaceConfigById` →
      // EmbeddedCrawlView 监测 partition 变化 → 主动调 `crawl-view:show` →
      // 主进程 `ipc-handlers.ts` 检测 partition mismatch → destroy + 重建 +
      // 广播 `crawl-view:partition-rebuilt` → `usePartitionRebuildToast` 弹
      // 一条"已切换到新登录环境"友好 toast（**仅在真正完成重建时**才弹）。
      //
      // Agent run 期间的 deferred 路径（B1）：主进程检测到 view 绑定了 active
      // run，拒绝重建（toast 不弹），等 run 结束后用户切 tab / resize / 刷新触发
      // useViewDisplay 主 effect 重新调 show，主进程守卫此时已放行 → 完成重建。
      //
      // 因此设置页 toast 只描述"操作结果"，不再硬性承诺"自动重载"——partition-rebuilt
      // toast 才是"实际重建完成"的真正信号；deferred 路径下用户感知 = 设置页 toast
      // 出现 + tab 暂未变化 + 任务结束后下次操作时 partition-rebuilt toast 弹出。
      toast({
        title: t('loginEnv.switchSuccess', {
          defaultValue: '已切换到「{{name}}」',
          name:
            environments.find((e) => e.id === environmentId)?.name ?? environmentId.slice(0, 8),
        }),
        description: t('loginEnv.switchHintAuto', {
          defaultValue:
            '已打开的 TabWeb 标签会自动加载到新环境；Agent 正在执行的任务会继续用旧环境跑完，任务结束后请切到对应标签或刷新让新环境生效。',
        }),
      })
    } catch (err: any) {
      toast({
        title: t('loginEnv.switchFailed', { defaultValue: '切换登录环境失败' }),
        description: err?.message,
        variant: 'destructive',
      })
    }
  }

  const handleSelect = async (environmentId: string) => {
    setSwitchOpen(false)
    if (!environmentId || environmentId === currentEnv?.id) return
    if (hasSeenSwitchExplanation(currentUserId)) {
      await performSwitch(environmentId)
    } else {
      setPendingEnvId(environmentId)
      setExplanationOpen(true)
    }
  }

  const handleConfirmExplanation = async () => {
    markSwitchExplanationSeen(currentUserId)
    setExplanationOpen(false)
    if (pendingEnvId) {
      await performSwitch(pendingEnvId)
      setPendingEnvId(null)
    }
  }

  // Phase 0（移除独立浏览器 cookie）后本组件不再是常规入口：仅为「历史上仍绑定
  // 独立 env」的 Space 保留一个「切回共享环境」的出口。共享环境 / 新用户 / 加载中 /
  // 出错一律 return null —— 新用户无感，老用户能切回。
  if (isLoading || error) return null
  if (!currentEnv || currentEnv.is_default) return null

  const sharedSpaceCount = currentEnv.using_space_count ?? 0
  const otherSharedCount = Math.max(0, sharedSpaceCount - 1)
  const isShared = Boolean(currentEnv.is_default)

  return (
    <div className="border-t border-border/30 pt-4 space-y-2">
      <h4 className={cn(SETTINGS_SECTION_TITLE, 'flex items-center gap-1.5')}>
        <Globe className="h-3 w-3" />
        {t('loginEnv.title', { defaultValue: '登录环境' })}
      </h4>

      <div className="rounded-lg bg-muted/10 px-3 py-2.5 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isShared ? (
                <Globe className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
              ) : (
                <Lock className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
              )}
              <span className="truncate text-body font-medium text-foreground">
                {currentEnv?.name ??
                  t('loginEnv.unknown', { defaultValue: '未绑定（默认环境）' })}
              </span>
            </div>
            <div className={SETTINGS_HINT}>
              {isShared
                ? t('loginEnv.sharedDescription', {
                    defaultValue: '与其他 {{count}} 个 Agent 共享登录状态',
                    count: otherSharedCount,
                  })
                : t('loginEnv.independentDescription', {
                    defaultValue: '独立环境，与其他 Agent 完全隔离',
                  })}
            </div>
          </div>
          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSwitchOpen(true)}
              disabled={bindMutation.isPending}
              className="shrink-0 gap-1"
            >
              {bindMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {t('loginEnv.switchAction', { defaultValue: '切换' })}
            </Button>
          )}
        </div>
      </div>

      {/* 切换下拉对话框 */}
      <Dialog open={switchOpen} onOpenChange={setSwitchOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('loginEnv.switchDialogTitle', { defaultValue: '选择登录环境' })}
            </DialogTitle>
            <DialogDescription>
              {t('loginEnv.switchDialogDesc', {
                defaultValue: '选择要切换到的登录环境（切到共享环境会与其他 Agent 共用登录态）。',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-2 max-h-72 overflow-y-auto">
            {environments.map((env) => {
              const isCurrent = env.id === currentEnv?.id
              return (
                <button
                  key={env.id}
                  type="button"
                  disabled={isCurrent}
                  onClick={() => void handleSelect(env.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-body transition-colors',
                    isCurrent
                      ? 'bg-accent/10 text-accent cursor-default'
                      : 'hover:bg-muted/30',
                  )}
                >
                  {env.is_default ? (
                    <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  ) : (
                    <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  )}
                  <span className="flex-1 truncate font-medium">{env.name}</span>
                  <span className="text-caption text-muted-foreground/60">
                    {t('loginEnv.usingSpaces', {
                      defaultValue: '{{count}} 个 Agent',
                      count: env.using_space_count,
                    })}
                  </span>
                  {isCurrent && (
                    <span className="text-caption text-accent">
                      {t('loginEnv.current', { defaultValue: '当前' })}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSwitchOpen(false)}>
              {t('actions.cancel', { defaultValue: '取消' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 首次切换说明对话框（Story 3 关键信息） */}
      <Dialog open={explanationOpen} onOpenChange={setExplanationOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('loginEnv.explanationTitle', { defaultValue: '关于登录环境' })}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2 text-body text-foreground/80">
            <p>
              {t('loginEnv.explanationShared', {
                defaultValue:
                  '共享环境下：一个 Agent 退出某个网站登录，其他共享同一环境的 Agent 也会退出。',
              })}
            </p>
            <p>
              {t('loginEnv.explanationIndependent', {
                defaultValue: '独立环境完全隔离：登录与其他 Agent 互不影响。',
              })}
            </p>
            {/* Wave 5b 视角 2#4 P1 自修：把 PRD Story 4 附录的 run 原子性
                放进首次切换 onboarding——用户最该问的"我那个正跑的任务会乱吗"
                必须在切换前回答清楚。一次性教育时刻信息密度容许更高。 */}
            <p>
              {t('loginEnv.explanationRunAtomicity', {
                defaultValue:
                  '正在执行中的 Agent 任务会继续用旧环境跑完，下次启动新任务时才切到新环境，避免中途打断。',
              })}
            </p>
            <p className={SETTINGS_HINT}>
              {t('loginEnv.explanationAutoSwitch', {
                defaultValue:
                  '切换后，已打开的 TabWeb 标签会自动重新加载到新环境；如有正在填的表单未提交请记得保存。',
              })}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setExplanationOpen(false)
                setPendingEnvId(null)
              }}
            >
              {t('actions.cancel', { defaultValue: '取消' })}
            </Button>
            <Button onClick={handleConfirmExplanation}>
              {t('loginEnv.explanationConfirm', { defaultValue: '我已了解，继续' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}
