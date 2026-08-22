/**
 * TinSandboxView - Tin 面板的沙箱化 WebView 容器
 *
 * 使用 Electron 的 <webview> tag 渲染 Tin 的 HTML 面板，
 * 提供安全隔离和 window.tin API。
 */

import React, { useRef, useEffect, useCallback } from 'react'
import { cn } from '../../utils/cn'

interface TinSandboxViewProps {
  instanceId: string
  panelHtml: string
  preloadPath?: string
  htmlPath?: string
  width?: number | string
  height?: number | string
  className?: string
  onLoad?: () => void
  onError?: (error: string) => void
}

export const TinSandboxView: React.FC<TinSandboxViewProps> = ({
  instanceId,
  panelHtml,
  preloadPath,
  htmlPath,
  width = 360,
  height = '100%',
  className,
  onLoad,
  onError,
}) => {
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const instanceIdRef = useRef(instanceId)
  instanceIdRef.current = instanceId
  const cleanupRef = useRef<(() => void) | null>(null)

  const webviewCallbackRef = useCallback((node: HTMLElement | null) => {
    // 清理旧 webview 的监听
    cleanupRef.current?.()
    cleanupRef.current = null

    if (!node) return

    const webview = node as any
    const currentInstanceId = instanceIdRef.current

    const handleDidFinishLoad = () => {
      try {
        const contentsId = webview.getWebContentsId?.()
        if (typeof contentsId === 'number') {
          window.tabtin?.tins?.registerWebview(currentInstanceId, contentsId)
        }
      } catch { /* webview may not support getWebContentsId */ }
      onLoadRef.current?.()
    }
    const handleDidFailLoad = () => {
      onErrorRef.current?.('WEBVIEW_LOAD_FAILED')
    }

    webview.addEventListener('did-finish-load', handleDidFinishLoad)
    webview.addEventListener('did-fail-load', handleDidFailLoad)

    cleanupRef.current = () => {
      webview.removeEventListener('did-finish-load', handleDidFinishLoad)
      webview.removeEventListener('did-fail-load', handleDidFailLoad)
      window.tabtin?.tins?.unregisterWebview(currentInstanceId)
    }
  }, [])

  // unmount 时确保清理
  useEffect(() => {
    return () => { cleanupRef.current?.() }
  }, [])

  const src = htmlPath
    ? `file://${htmlPath}`
    : `data:text/html;charset=utf-8,${encodeURIComponent(panelHtml)}`

  return (
    <div
      className={cn('tin-sandbox-container overflow-hidden', className)}
      style={{ width, height }}
    >
      {/*
        安全属性不在元素上声明：allowpopups / nodeintegration 等是 HTML 布尔属性，
        「存在即开启」——写 'false' 反而等于开启（曾导致 will-attach 白名单按
        「tin guest 不允许 allowpopups」拒绝 attach，面板白屏）。sandbox /
        contextIsolation / nodeIntegration=false 由主进程 will-attach-webview
        统一强制（attach-policy ENFORCED_WEB_PREFERENCES），元素侧不重复声明。
      */}
      <webview
        ref={webviewCallbackRef as any}
        src={src}
        preload={preloadPath ? `file://${preloadPath}` : undefined}
        partition={`persist:tin-${instanceId}`}
        style={{ width: '100%', height: '100%', border: 'none' }}
        data-instance-id={instanceId}
      />
    </div>
  )
}
