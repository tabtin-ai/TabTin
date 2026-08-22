import { cn } from '@/utils/cn'

/** Input 与「发送验证码」等并排：行容器 */
export const formInputActionRowClassName = 'flex gap-2 items-stretch'

/**
 * 与 smartsheet-ui Input 同列伸缩单元（Input 外层包一层，避免 flex-1 与组件自带 w-full 冲突）
 */
export const formInputGrowCellClassName = 'min-w-0 flex-1'

/** 带图标 Input 的伸缩列（内层 relative 由调用方保留） */
export const formInputGrowCellRelativeClassName = 'relative min-w-0 flex-1'

/** 配合 Button `size="form"` 的全宽主按钮 */
export const formPrimaryFullWidthClassName = 'w-full'

/** 配合 Button `size="form"` 的全宽次要（ghost/outline） */
export const formGhostFullWidthClassName = 'w-full'

/** 配合 Button `size="form"` 的并排右列（发送验证码等） */
export const formOutlineCompanionClassName = 'shrink-0 whitespace-nowrap'

/** 登录 / 注册等方式分段，高度与 Input 一致 */
export function formMethodSegmentClassName(active: boolean): string {
  return cn(
    'flex h-10 flex-1 items-center justify-center rounded-interactive px-4 text-body font-medium transition-colors',
    active
      ? 'bg-background text-foreground'
      : 'text-muted-foreground hover:text-foreground',
  )
}
