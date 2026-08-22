import React from 'react'
import i18n from '@/i18n'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundaryInner extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} />
    }
    return this.props.children
  }
}

function safeT(key: string, fallback: string, ns = 'common'): string {
  try {
    const result = i18n.t(key, { ns, defaultValue: fallback })
    return typeof result === 'string' && result !== key ? result : fallback
  } catch {
    return fallback
  }
}

function ErrorFallback({ error }: { error: Error | null }) {
  const title = safeT('errorBoundary.title', 'Something went wrong')
  const description = safeT('errorBoundary.description', 'The application encountered an unexpected error. Please try reloading.')
  const reloadLabel = safeT('reload', 'Reload')
  const showDebugDetails = import.meta.env.DEV && error

  return (
    <div className="h-screen flex items-center justify-center" style={{ background: 'hsl(var(--canvas))' }}>
      <div className="text-center space-y-4 max-w-md px-6">
        <div className="text-display text-muted-foreground/30">!</div>
        <h1 className="text-title font-semibold text-foreground">{title}</h1>
        <p className="text-body text-muted-foreground">{description}</p>
        {showDebugDetails ? (
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-left text-caption text-muted-foreground">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </pre>
        ) : null}
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center justify-center rounded-md text-body font-medium h-9 px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {reloadLabel}
        </button>
      </div>
    </div>
  )
}

export function ErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundaryInner>
      {children}
    </ErrorBoundaryInner>
  )
}
