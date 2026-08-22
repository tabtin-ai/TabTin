import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LanguageToggle, ThemeToggle } from '@/components/layout/ToolbarWidgets'

export function NotFoundPage() {
  const { t } = useTranslation('common')

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'hsl(var(--canvas))' }}>
      <div className="flex justify-end items-center gap-1 p-4">
        <LanguageToggle />
        <ThemeToggle />
      </div>

      <div className="flex-1 flex items-center justify-center pb-16">
        <div className="text-center space-y-4 max-w-md">
          <div className="text-6xl font-bold text-muted-foreground/30">404</div>
          <h1 className="text-title font-semibold text-foreground">{t('notFound.title')}</h1>
          <Link
            to="/"
            className="inline-block text-body text-primary hover:text-primary/80 underline underline-offset-4 transition-colors"
          >
            {t('notFound.back')}
          </Link>
        </div>
      </div>
    </div>
  )
}
