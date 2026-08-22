/**
 * Stable portal host utilities — 在不同布局分支间移动同一 DOM 子树，
 * 避免 React 卸载/重装。
 *
 * 使用场景：
 * - AppLayout: ContentArea 跨布局分支保活
 * - SpaceWorkbenchHost: workspace layer 跨 Space 实例共享
 *
 * 所有权模型：同一 host 可被多个槽位短暂争抢（任务三态 ↔ 一级域）。
 * 用 claim 栈保证「后挂载者优先」，释放时把 host 交回仍存活的上一个槽位，
 * 避免临时槽位 cleanup 把 host 移出 document 后可见槽位不再跑 effect 造成整页白屏。
 */

import React, { useRef, useLayoutEffect } from 'react'
import { createLogger } from '@/utils/logger'

const log = createLogger('PortalHost')

export function useStablePortalHost(): HTMLDivElement {
  const ref = useRef<HTMLDivElement | null>(null)
  if (!ref.current) {
    ref.current = document.createElement('div')
    ref.current.style.display = 'contents'
    ref.current.dataset.stablePortalHost = 'true'
  }
  return ref.current
}

type HostClaim = {
  id: string
  container: HTMLElement
  owner: string
}

const claimsByHost = new WeakMap<HTMLElement, HostClaim[]>()
let claimSeq = 0

function getClaims(host: HTMLElement): HostClaim[] {
  let claims = claimsByHost.get(host)
  if (!claims) {
    claims = []
    claimsByHost.set(host, claims)
  }
  return claims
}

function describeHost(host: HTMLElement, container: HTMLElement) {
  return {
    owner: host.dataset.portalOwner || '',
    hostConnected: host.isConnected,
    hostInDocument: document.contains(host),
    containerConnected: container.isConnected,
    containerWidth: Math.round(container.getBoundingClientRect().width),
    containerHeight: Math.round(container.getBoundingClientRect().height),
    claimants: getClaims(host).length,
  }
}

function attachToClaim(host: HTMLElement, claim: HostClaim): void {
  if (host.parentNode !== claim.container) {
    claim.container.appendChild(host)
  }
  host.dataset.portalOwner = claim.owner

  if (!document.contains(host)) {
    log.warn('portal host attached but not in document', describeHost(host, claim.container))
    // 槽位本身若已连上 document，再试一次；否则留给后续 claimant。
    if (claim.container.isConnected && host.parentNode !== claim.container) {
      claim.container.appendChild(host)
    }
  }
}

function releaseClaim(host: HTMLElement, claim: HostClaim): void {
  const claims = getClaims(host)
  const idx = claims.indexOf(claim)
  if (idx >= 0) {
    claims.splice(idx, 1)
  }

  const wasAttachedHere = host.parentNode === claim.container
  if (wasAttachedHere) {
    claim.container.removeChild(host)
  }

  const next = claims[claims.length - 1]
  if (next) {
    attachToClaim(host, next)
    if (!document.contains(host) && next.container.isConnected) {
      log.warn('portal host reclaim self-healed after detach', describeHost(host, next.container))
      attachToClaim(host, next)
    }
    return
  }

  if (wasAttachedHere || !document.contains(host)) {
    delete host.dataset.portalOwner
  }
}

/**
 * 声明对 host 的挂载所有权。后声明者优先；释放时自动交回上一任。
 */
export function claimPortalHost(
  host: HTMLElement,
  container: HTMLElement,
  owner = 'anonymous',
): () => void {
  const claim: HostClaim = {
    id: `c${++claimSeq}`,
    container,
    owner,
  }
  getClaims(host).push(claim)
  attachToClaim(host, claim)
  log.debug('portal host claimed', describeHost(host, container))

  return () => {
    releaseClaim(host, claim)
    log.debug('portal host released', {
      owner,
      remaining: getClaims(host).length,
      hostInDocument: document.contains(host),
    })
  }
}

export function StableSlot({
  host,
  className,
  owner = 'stable-slot',
}: {
  host: HTMLElement
  className?: string
  /** 诊断用所有者标签（不含业务数据） */
  owner?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = ref.current
    if (!container) return
    return claimPortalHost(host, container, owner)
  }, [host, owner])
  return (
    <div
      ref={ref}
      className={className}
      data-portal-slot={owner}
    />
  )
}

StableSlot.displayName = 'StableSlot'

/**
 * 把一个稳定宿主节点（host）**命令式**挂到外部目标节点（target）上，挂载与否由 `active`
 * 同步门控。与 {@link StableSlot} 的区别：StableSlot 把 host 收进自己渲染的 div；本组件
 * 把 host 追加进「组件树之外」的既有 target 节点。
 *
 * 用途：让「是否向某个共享槽位投递内容」的决策脱离 React 19.2 `<Activity mode="hidden">`
 * 的延迟渲染。把本组件渲染在 Activity **之外**、用外层同步已知的 `active` 门控，切前后台时
 * 追加/移除立即生效——避免 createPortal 的 DOM 逃出 Activity 的 display:none 后，因 hidden
 * 子树重渲染被降优先级而滞留，造成同一槽位出现两份内容。
 */
export function PortalHostBridge({
  host,
  target,
  active,
  owner = 'portal-bridge',
}: {
  host: HTMLElement
  target: HTMLElement | null
  active: boolean
  /** 诊断用所有者标签（不含业务数据） */
  owner?: string
}) {
  useLayoutEffect(() => {
    if (!active || !target) return
    return claimPortalHost(host, target, owner)
  }, [host, target, active, owner])
  return null
}

PortalHostBridge.displayName = 'PortalHostBridge'
