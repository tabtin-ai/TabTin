import { LanguageToggle, ThemeToggle } from './ToolbarWidgets'

interface AuthPageShellProps {
  children: React.ReactNode
  className?: string
}

export function AuthPageShell({ children, className = '' }: AuthPageShellProps) {
  return (
    <div
      className={`min-h-screen flex flex-col ${className}`}
      style={{ background: 'hsl(var(--canvas))' }}
    >
      <div className="flex justify-end items-center gap-1 p-4">
        <LanguageToggle />
        <ThemeToggle />
      </div>

      <div className="flex-1 flex items-center justify-center px-4 pb-8">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mx-auto mb-4">
              <span className="text-primary-foreground font-bold text-title">T</span>
            </div>
          </div>
          <div className="bg-background rounded-2xl border border-border/50 p-8 shadow-sm">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
