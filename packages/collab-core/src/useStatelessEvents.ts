/**
 * useStatelessEvents — Stateless 业务事件 Hook
 *
 * 在 Hocuspocus 连接上发送/接收自定义业务消息。
 * 用于字段变更通知、Agent 进度、权限变更等业务事件。
 *
 * 用法:
 * ```tsx
 * const { sendEvent, lastEvent } = useStatelessEvents(provider, {
 *   // 监听特定事件类型
 *   onEvent: {
 *     'field.changed': (event) => handleFieldChanged(event.payload),
 *     'agent.progress': (event) => handleAgentProgress(event.payload),
 *   },
 * })
 *
 * // 发送事件
 * sendEvent({ type: 'field.changed', payload: { fieldId: 'xxx', action: 'create' } })
 * ```
 */

import { useEffect, useCallback, useRef, useState } from "react";
import type { CollabProvider } from "./provider.js";
import { CollabStatus, type StatelessEvent } from "./types.js";

export interface UseStatelessEventsOptions {
  /** 按事件类型注册的回调 */
  onEvent?: Record<string, (event: StatelessEvent) => void>;
  /** 接收所有事件的回调 */
  onAnyEvent?: (event: StatelessEvent) => void;
}

export interface UseStatelessEventsResult {
  /** 发送 Stateless 业务事件 */
  sendEvent: (event: StatelessEvent) => void;
  /** 最近收到的事件 */
  lastEvent: StatelessEvent | null;
}

export function useStatelessEvents(
  provider: CollabProvider | null,
  options: UseStatelessEventsOptions = {}
): UseStatelessEventsResult {
  const [lastEvent, setLastEvent] = useState<StatelessEvent | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // CC-013: 从 onEvent key 列表派生稳定的依赖值，key 变化时重新订阅
  const eventTypeKeys = options.onEvent
    ? Object.keys(options.onEvent).sort().join(",")
    : "";
  const hasAnyHandler = !!options.onAnyEvent;

  useEffect(() => {
    if (!provider) return;

    const unsubscribers: Array<() => void> = [];

    const types = optionsRef.current.onEvent
      ? Object.keys(optionsRef.current.onEvent)
      : [];

    for (const type of types) {
      const unsub = provider.onStatelessEvent(type, (event) => {
        setLastEvent(event);
        // CC-011: 始终从 ref 读取最新 handler，避免闭包捕获过期引用
        optionsRef.current.onEvent?.[type]?.(event);
      });
      unsubscribers.push(unsub);
    }

    if (optionsRef.current.onAnyEvent) {
      const unsub = provider.onAnyStatelessEvent((event) => {
        setLastEvent(event);
        // CC-011: 同上
        optionsRef.current.onAnyEvent?.(event);
      });
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, [provider, eventTypeKeys, hasAnyHandler]);

  const sendEvent = useCallback(
    (event: StatelessEvent) => {
      if (!provider) return;

      // CC-012: 离线时拒绝发送并警告
      const { status } = provider.getState();
      if (status !== CollabStatus.SYNCED && status !== CollabStatus.SYNCING) {
        console.warn(
          `[useStatelessEvents] Cannot send event while offline (status: ${status})`
        );
        return;
      }

      provider.sendStateless({
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
      });
    },
    [provider]
  );

  return { sendEvent, lastEvent };
}
