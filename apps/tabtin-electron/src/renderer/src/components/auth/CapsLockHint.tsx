import { ArrowBigUp } from 'lucide-react'
import { cn } from '@/utils/cn'

interface CapsLockHintProps {
  show: boolean
  label: string
  className?: string
}

/**
 * 叠在密码框下方的字段缝隙里（绝对定位），不占文档流高度。
 * 父级需 `relative`（通常是输入框外包一层）。
 */
export function CapsLockHint({ show, label, className }: CapsLockHintProps) {
  return (
    <p
      className={cn(
        'pointer-events-none absolute inset-x-0 top-full flex h-3 items-center gap-0.5 text-caption leading-none text-warning',
        !show && 'invisible',
        className,
      )}
      aria-hidden={!show}
      aria-live="polite"
    >
      {show ? (
        <>
          <ArrowBigUp className="h-3 w-3 flex-shrink-0" aria-hidden />
          {label}
        </>
      ) : null}
    </p>
  )
}
