/**
 * useEnsureAgentReady — Space「开箱即用」自愈
 *
 * 产品语义：打开就能用，不让用户显式配置「执行设备」和「工作目录」。
 * 本 hook 在进入一个 workspace 时，对**尚未初始化**的 Space 执行配置静默补齐两件事：
 *
 *   1. 执行设备：Space 暂无 control_device 且本机已是注册的 control 设备
 *      → 自动把本机绑为 control_device（修好"刚建却显示在别处工作"的突兀感，
 *        也顺带自愈本功能上线前创建的历史 Space）。
 *   2. 工作目录：Space 没设 working_dir 且本机就是 control_device
 *      → 自动在本机创建 ~/TabTin/<团队名>/<Space名> 作为默认目录（用户可见）。
 *
 * 护栏：
 *   - 只在本机就是（或刚绑成）control_device 时才动 working_dir，绝不替远端 Space 落本机路径。
 *   - 已绑到**另一台安装身份**的不改绑——尊重用户/历史选择；只有 id 不同但
 *     fingerprint 相同的重复记录才自动换绑。machine_key 不能作为客户端接管凭据。
 *   - 已设过 working_dir 的不覆盖。
 *   - 模块级 guard 保证每个 Space 进程内最多自愈一次成功，避免与用户后续手动操作打架。
 *   - 失败不标记完成（下次进入可重试），但 inflight 去重避免并发风暴。
 *
 *  根因 2 修正：区分「从未绑定过」和「绑定丢失」。
 *   - 从未绑定过（control_device 与 working_dir **都为空**）→ 视为全新 Space，
 *     可静默绑本机 + 落默认目录（开箱即用）。
 *   - 绑定丢失（control_device 为空但 **working_dir 非空**）→ 这个 Space 曾在某台
 *     设备上配置过目录，绑定被清空（设备被删 / 指纹漂移等）。**绝不静默接管**，
 *     否则本机会把别的设备的目录路径抢成自己的。改为 `needs-reclaim` 状态，交给
 *     UI 显式征询用户是否在本机接管（`reclaim()`）。
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'
import type { Agent } from '@tabtin/app-shell'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { DeviceApiService } from '@/services/deviceApi'
import { isSamePhysicalDevice } from '@/services/deviceControlMatch'
import { buildWorkingDirUpdatePayload } from '@components/space-settings/profile/workingDirPayload'
import { notifyWorkspacePathsForSpace } from '@components/workspace/notifyWorkspacePaths'
import { logger } from '@/utils/logger'

export type AgentReadyStatus = 'idle' | 'preparing' | 'ready' | 'error' | 'needs-reclaim'

/** 已成功自愈过的 agentId（进程内一次性，避免反复触发）。 */
const _bootstrappedAgents = new Set<string>()
/** 正在自愈中的 agentId（并发去重）。 */
const _inflightAgents = new Set<string>()

/** 测试 / 登出重置。 */
export function _resetAgentReadyGuardsForTests(): void {
  _bootstrappedAgents.clear()
  _inflightAgents.clear()
}

export function useEnsureAgentReady(
  spaceId: string,
  agent: Agent | null,
): { status: AgentReadyStatus; reclaim: () => Promise<void> } {
  const currentDevice = useDeviceStore((s) => s.currentDevice)
  const devices = useDeviceStore((s) => s.devices)
  const [status, setStatus] = useState<AgentReadyStatus>('idle')

  const agentId = agent?.id ?? null
  const currentDeviceId = currentDevice?.id ?? null
  const currentDeviceFingerprint = currentDevice?.fingerprint ?? null

  // 绑定与目录既可能落在 agent 也可能落在 space（迁移期兼容）——任一有值即算「已配置」。
  const spaceControlDeviceId = useSpaceStore((s) => {
    const sp = s.spaces.find((item) => item.id === spaceId)
    return sp?.control_device_id ?? sp?.bound_device_id ?? null
  })
  const spaceWorkingDir = useSpaceStore(
    (s) => s.spaces.find((item) => item.id === spaceId)?.working_dir ?? '',
  )
  const boundDeviceId = (agent?.control_device_id ?? null) ?? spaceControlDeviceId
  const effectiveWorkingDir = agent?.working_dir || spaceWorkingDir

  // 显式接管：绑定丢失（needs-reclaim）时由 UI 触发，把本机绑为 control_device。
  // 不自动落目录——保留原 working_dir，让用户走「重新选择」显式挑本机路径，
  // 避免把别的设备的路径当成本机路径直接沿用。
  const reclaim = useCallback(async () => {
    if (!agentId || !currentDeviceId) return
    if (_inflightAgents.has(agentId)) return
    _inflightAgents.add(agentId)
    setStatus('preparing')
    try {
      await DeviceApiService.bindSpaceDevice(spaceId, currentDeviceId)
      await useSpaceStore.getState().loadAgent(agentId, { force: true })
      _bootstrappedAgents.add(agentId)
      setStatus('ready')
      toast({
        title: i18n.t('space:agentReady.reclaimToastTitle', {
          defaultValue: '已在本机接管',
        }),
        description: i18n.t('space:agentReady.reclaimToastDesc', {
          defaultValue: '此 Space 已绑定到本机。如原工作目录不在本机，请重新选择目录。',
        }),
        variant: 'success',
      })
    } catch (err) {
      logger.warn(
        '[useEnsureAgentReady] reclaim failed:',
        err instanceof Error ? err.message : String(err),
      )
      setStatus('error')
    } finally {
      _inflightAgents.delete(agentId)
    }
  }, [agentId, spaceId, currentDeviceId])

  useEffect(() => {
    if (!agentId || !agent) return

    const needBind = !boundDeviceId
    const needDir = !effectiveWorkingDir

    // 同机 stale 必须在「已完整配置」早退之前算好，否则有 control+dir 时永远换不了绑。
    const boundDevice = boundDeviceId
      ? (devices ?? []).find((device) => device.id === boundDeviceId) ?? null
      : null
    const staleSameMachine = Boolean(
      boundDeviceId
      && currentDeviceId
      && boundDeviceId !== currentDeviceId
      && currentDevice
      && isSamePhysicalDevice(boundDevice, currentDevice),
    )

    if (!needBind && !needDir && !staleSameMachine) {
      setStatus('ready')
      return
    }

    //  根因 2：绑定丢失但目录已配置 → 不静默接管，交给 UI 显式确认（reclaim）。
    // 这是「设备被删 / 指纹漂移」后目录被跨设备抢走的分叉点：原代码在这里会静默把
    // 本机绑成 control_device，随后本机探测别设备的路径必然失败、诱导用户「重新选择」
    // 把目录也换成本机路径。改为停在 needs-reclaim，等用户主动决定。
    if (needBind && !needDir) {
      setStatus('needs-reclaim')
      return
    }

    // 已自愈过：不再重复（store 里的 agent 还没刷新时也别二次触发）。
    if (_bootstrappedAgents.has(agentId)) return
    if (_inflightAgents.has(agentId)) return

    // 绑定 / 落目录都需要本机是已注册的设备；设备 store 还没就绪时先等。
    if (!currentDeviceId) return

    // 已绑到「别的」设备（真正的遥控器场景）→ 不属于本机自愈范畴，交给 RemoteAgentBanner。
    if (boundDeviceId && boundDeviceId !== currentDeviceId && !staleSameMachine) {
      setStatus('idle')
      return
    }

    let cancelled = false
    _inflightAgents.add(agentId)
    setStatus('preparing')

    void (async () => {
      const store = useSpaceStore.getState()
      let didSomething = false
      let didSetDir = false
      try {
        let justBoundThisDevice = false

        // 1) 设备自动绑定 / fingerprint 漂移后 stale 记录换绑
        if (needBind || staleSameMachine) {
          await DeviceApiService.bindSpaceDevice(spaceId, currentDeviceId)
          // ：control_device 在 Space；refresh 后再读，勿只信 Agent.control_device_id。
          await store.refreshSpace(spaceId)
          await store.loadAgent(agentId, { force: true })
          justBoundThisDevice = true
          didSomething = true
        }

        const space = store.spaces.find((item) => item.id === spaceId)
        const spaceControlId =
          space?.control_device_id ?? space?.bound_device_id ?? null
        // 刚 bind 成功即可落目录；否则以 Space（优先）/ Agent 兼容字段判定本机 control。
        const boundToThisDevice =
          justBoundThisDevice
          || spaceControlId === currentDeviceId
          || (agent?.control_device_id ?? null) === currentDeviceId

        // 2) 默认目录自动落地——写 Space.working_dir（；AgentUpdate 已忽略该字段）
        if (needDir && boundToThisDevice) {
          const spaceName = space?.name ?? agent.name ?? 'Space'
          const organizationState = useOrganizationStore.getState()
          const organizationName = space
            ? organizationState.organizations.find((item) => item.id === space.organization_id)?.name
              ?? (organizationState.selectedOrganization?.id === space.organization_id
                ? organizationState.selectedOrganization.name
                : '')
            : (organizationState.selectedOrganization?.name ?? '')
          const res = await window.tabtin?.fileSystem?.ensureDefaultAgentDir({
            organizationName,
            spaceName,
          })
          if (res?.success && res.path) {
            const ok = await store.updateSpace(spaceId, {
              ...buildWorkingDirUpdatePayload(res.path, 'mixed'),
              device_fingerprint: currentDeviceFingerprint ?? undefined,
            })
            if (!ok) {
              throw new Error(store.error || 'updateSpace working_dir failed')
            }
            await notifyWorkspacePathsForSpace(spaceId)
            didSetDir = true
            didSomething = true
          } else if (res && !res.success) {
            throw new Error(res.error || 'ensureDefaultAgentDir failed')
          }
        }

        _bootstrappedAgents.add(agentId)
        if (cancelled) return
        setStatus('ready')

        if (didSomething) {
          toast({
            title: i18n.t('space:agentReady.toastTitle', {
              defaultValue: '已在本机就绪',
            }),
            description: didSetDir
              ? i18n.t('space:agentReady.toastDesc', {
                  defaultValue: '已自动绑定本机并准备好工作目录，可以直接开始。',
                })
              : i18n.t('space:agentReady.toastDescRebind', {
                  defaultValue: '已将执行设备更新为本机当前会话，可以直接开始。',
                }),
            variant: 'success',
          })
        }
      } catch (err) {
        logger.warn(
          '[useEnsureAgentReady] bootstrap failed:',
          err instanceof Error ? err.message : String(err),
        )
        if (!cancelled) setStatus('error')
      } finally {
        _inflightAgents.delete(agentId)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    spaceId,
    agentId,
    agent,
    boundDeviceId,
    effectiveWorkingDir,
    currentDeviceId,
    currentDeviceFingerprint,
    currentDevice,
    devices,
  ])

  return { status, reclaim }
}
