import React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

const GridErrorFallback: React.FC<{ error: Error; onRetry: () => void }> = ({ error, onRetry }) => {
  const { t } = useTranslation('table')
  return (
    <div className="flex h-full items-center justify-center p-6 text-destructive">
      <div className="max-w-md text-center">
        <div className="text-title font-bold">{t('pane.gridRenderError')}</div>
        <pre className="mt-2 whitespace-pre-wrap text-body">{error.message}</pre>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-body text-primary-foreground hover:bg-primary/90"
        >
          <RefreshCw className="size-3.5" />
          {t('pane.gridRenderErrorRetry')}
        </button>
      </div>
    </div>
  )
}

export class GridErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('[GridErrorBoundary]', error)
  }
  handleRetry = () => {
    this.setState({ error: null })
  }
  render() {
    if (this.state.error) {
      return <GridErrorFallback error={this.state.error} onRetry={this.handleRetry} />
    }
    return this.props.children
  }
}
