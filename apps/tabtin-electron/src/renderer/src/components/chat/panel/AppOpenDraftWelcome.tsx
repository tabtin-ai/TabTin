import React from 'react'
import { cn } from '@utils/cn'

interface AppOpenDraftWelcomeProps {
  title: string
  hint: string
}

/** 已打开 App 的新任务空白态：保留上下文说明，把任务交给输入框表达。 */
export const AppOpenDraftWelcome: React.FC<AppOpenDraftWelcomeProps> = ({ title, hint }) => (
  <div className={cn(
    'pointer-events-none absolute inset-0 px-4',
  )}>
    <div className={cn(
      'text-center',
      'w-full max-w-2xl',
      'absolute left-1/2 top-[calc(50%-10rem)] -translate-x-1/2',
    )}>
      <h1 className="font-semibold tracking-tight text-heading text-foreground text-balance">
        {title}
      </h1>
      <p className="mt-2 text-body leading-6 text-muted-foreground/60">
        {hint}
      </p>
    </div>
  </div>
)
