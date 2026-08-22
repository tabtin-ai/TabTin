import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { reportError } from '@/services/errorReporter'
import { captureRendererFatal } from '@/services/sentry'
import i18n from '@/i18n'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  resetKeys?: unknown[]
  /**
   * `region`：填满父容器，用于 shell 分区隔离（标签工作台 / 对话栏），
   * 避免一侧崩溃时整页被 App 级 ErrorBoundary 吃掉。
   */
  variant?: 'inline' | 'region'
}

interface ErrorBoundaryState {
  hasError: boolean
  prevResetKeys?: unknown[]
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true }
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (state.hasError && state.prevResetKeys !== undefined) {
      const keysChanged = props.resetKeys?.some(
        (key, i) => key !== state.prevResetKeys?.[i],
      ) ?? false
      if (keysChanged) {
        return { hasError: false, prevResetKeys: props.resetKeys ? [...props.resetKeys] : undefined }
      }
    }
    return { prevResetKeys: props.resetKeys ? [...props.resetKeys] : undefined }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Render error:', error)
    // 用 'fatal' 级别让 errorReporter 立即上报，不等 30s batch flush——
    // 渲染崩溃天然是 fatal：用户已经看到"出了点问题"兜底页，事件再不上报
    // 等于当场作废（用户大概率会立刻刷新或关 App）。
    reportError(error, { componentStack: errorInfo.componentStack || '' }, 'fatal')
    captureRendererFatal(error, 'react_error_boundary')
    this.props.onError?.(error, errorInfo)
  }

  private handleRetry = () => {
    this.setState({ hasError: false })
  }

  private handleRefresh = () => {
    window.location.reload()
  }

  // 崩溃兜底页导出诊断包：崩溃时用户最需要报 bug，此处 JS runtime 仍存活。
  // 动态 import 避免把 jszip 拉进首屏加载的 ErrorBoundary chunk。
  private handleExportLogs = () => {
    void import('@/services/diagnostics/exportDiagnostics').then((m) =>
      m.exportDiagnostics({ reason: 'crash' }),
    )
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback
      }
      const isRegion = this.props.variant === 'region'
      return (
        <div
          className={
            isRegion
              ? 'flex h-full w-full min-h-0 flex-col items-center justify-center gap-2.5 px-4'
              : 'flex flex-col items-center justify-center gap-2.5 py-8 px-4'
          }
        >
          <AlertTriangle className="h-5 w-5 text-muted-foreground/60" />
          <p className="text-body text-muted-foreground">{i18n.t('common:errorBoundary.message')}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={this.handleRetry}
              className="flex items-center gap-1.5 text-body font-medium text-accent hover:text-accent/80 transition-colors duration-150"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {i18n.t('common:retry')}
            </button>
            <button
              type="button"
              onClick={this.handleRefresh}
              className="text-body text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-150"
            >
              {i18n.t('common:errorBoundary.refresh')}
            </button>
            <button
              type="button"
              onClick={this.handleExportLogs}
              className="text-body text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-150"
            >
              {i18n.t('common:errorBoundary.exportLogs', { defaultValue: '导出诊断日志' })}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
