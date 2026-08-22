import React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

type TranslateFn = (key: string) => string

const defaultT: TranslateFn = (key) => {
  const fallbacks: Record<string, string> = {
    editorCrashTitle: 'Editor encountered an error',
    editorCrashMessage: 'The editor crashed. Please try again.',
    editorCrashRetry: 'Retry',
  }
  return fallbacks[key] ?? key
}

interface Props {
  children: React.ReactNode
  editorKey: number
  t?: TranslateFn
}

interface State {
  hasError: boolean
  error: Error | null
}

export class EditorErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[DocEditor] Editor crashed:', error, info.componentStack)
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.editorKey !== this.props.editorKey && this.state.hasError) {
      this.setState({ hasError: false, error: null })
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const t = this.props.t ?? defaultT
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive opacity-60" />
          <div>
            <h3 className="text-body font-medium text-foreground">
              {t('editorCrashTitle')}
            </h3>
            <p className="mt-1 text-body text-muted-foreground">
              {t('editorCrashMessage')}
            </p>
            {this.state.error && (
              <p className="mt-2 max-w-md truncate text-caption text-muted-foreground/60">
                {this.state.error.message}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-body font-medium text-foreground shadow-sm hover:bg-muted"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('editorCrashRetry')}
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
