import React from 'react'
import i18n from '@/i18n'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { reportError } from '@/services/errorReporter'

type DebugErrorBoundaryProps = {
  children: React.ReactNode
  enabled?: boolean
  fallback?: React.ReactNode
}

type DebugErrorBoundaryState = {
  hasError: boolean
  error?: Error | null
  componentStack?: string
}

export class DebugErrorBoundary extends React.Component<DebugErrorBoundaryProps, DebugErrorBoundaryState> {
  private hasLogged = false

  state: DebugErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: ''
  }

  static getDerivedStateFromError(error: Error): DebugErrorBoundaryState {
    return { hasError: true, error, componentStack: '' }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (this.hasLogged) return
    this.hasLogged = true
    const componentStack = info?.componentStack || ''
    this.setState({ componentStack })
    console.error('[DebugErrorBoundary] 捕获到渲染错误:', error)
    if (componentStack) {
      console.error('[DebugErrorBoundary] 组件栈:', componentStack)
    }
    globalThis.__TABTIN_LAST_REACT_ERROR__ = {
      message: error.message,
      stack: error.stack,
      componentStack
    }
    reportError(error, { componentStack }, 'fatal')
  }

  render() {
    const { enabled = true, fallback } = this.props
    if (!enabled) {
      return this.props.children
    }
    if (!this.state.hasError) {
      return this.props.children
    }
    if (fallback) {
      return fallback
    }
    return (
      <div className="flex h-full w-full flex-col items-start justify-center gap-3 p-6 text-body text-muted-foreground">
        <div className="text-subtitle text-foreground">{i18n.t('debug:errorBoundary.title')}</div>
        <div>{this.state.error?.message || i18n.t('debug:errorBoundary.unknown')}</div>
        <ScrollArea className="max-h-48 w-full rounded-md border border-border/60 bg-background/80 p-3 text-body">
          <pre className="whitespace-pre-wrap">{this.state.componentStack || i18n.t('debug:errorBoundary.emptyStack')}</pre>
        </ScrollArea>
      </div>
    )
  }
}
