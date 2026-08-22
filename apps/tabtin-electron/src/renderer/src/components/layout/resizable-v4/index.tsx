import React from 'react'
import * as ResizablePrimitive from 'react-resizable-panels'
import { GripVertical } from 'lucide-react'
import { cn } from '@utils/cn'

export type LayoutOrientation = 'horizontal' | 'vertical'

const GroupPrimitive: React.ComponentType<any> =
  (ResizablePrimitive as any).Group

const PanelPrimitive: React.ComponentType<any> =
  (ResizablePrimitive as any).Panel

const SeparatorPrimitive: React.ComponentType<any> =
  (ResizablePrimitive as any).Separator

export interface LayoutGroupProps {
  id?: string
  className?: string
  children: React.ReactNode
  orientation?: LayoutOrientation
  defaultLayout?: number[]
  disabled?: boolean
  onLayoutChange?: (layout: unknown) => void
  onLayoutChanged?: (layout: unknown) => void
  /** 传给 react-resizable-panels Group，扩大分隔条/边缘的可点击命中区 */
  resizeTargetMinimumSize?: { coarse: number; fine: number }
}

export const LayoutGroup: React.FC<LayoutGroupProps> = ({
  className,
  children,
  orientation = 'horizontal',
  ...rest
}) => {
  return (
    <GroupPrimitive
      className={cn(
        'flex h-full w-full overflow-hidden',
        orientation === 'vertical' ? 'flex-col' : 'flex-row',
        className,
      )}
      orientation={orientation}
      {...rest}
    >
      {children}
    </GroupPrimitive>
  )
}

export type LayoutPanelProps = React.ComponentProps<typeof PanelPrimitive>

export const LayoutPanel: React.FC<LayoutPanelProps> = ({
  className,
  ...rest
}) => {
  return (
    <PanelPrimitive
      className={cn('min-w-0 min-h-0 overflow-hidden', className)}
      {...rest}
    />
  )
}

export interface LayoutSeparatorProps extends React.ComponentProps<typeof SeparatorPrimitive> {
  withHandle?: boolean
  /** 分隔线常驻可见（默认仅 hover / 拖拽时显色） */
  persistentLine?: boolean
}

export const LayoutSeparator: React.FC<LayoutSeparatorProps> = ({
  className,
  withHandle = false,
  persistentLine = false,
  ...rest
}) => {
  return (
    <SeparatorPrimitive
      className={cn(
        'group relative flex-shrink-0 bg-transparent outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0',
        '[&[aria-orientation=vertical]]:w-2',
        '[&[aria-orientation=horizontal]]:h-2',
        className,
      )}
      {...rest}
    >
          <div
            className={cn(
              'pointer-events-none absolute transition-colors',
              // 浅色主题 --border 本身接近背景；常驻线用 muted-foreground。
              // 竖线贴左/右边缘，避免 left-1/2 + translate 在非整数 DPR 下抗锯齿变粗。
              persistentLine
                ? 'bg-muted-foreground/35'
                : 'bg-border/0 group-hover:bg-muted-foreground/50 group-active:bg-muted-foreground/70 group-data-[separator=drag]:bg-muted-foreground/80',
              'left-0 top-0 bottom-0 w-0.5',
              'group-[&[aria-orientation=horizontal]]:left-0 group-[&[aria-orientation=horizontal]]:right-0',
              'group-[&[aria-orientation=horizontal]]:top-0 group-[&[aria-orientation=horizontal]]:bottom-auto',
              'group-[&[aria-orientation=horizontal]]:h-0.5 group-[&[aria-orientation=horizontal]]:w-auto',
            )}
          />

      {withHandle && (
        <div
          className={cn(
            'pointer-events-none absolute left-1/2 top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2',
            'items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground',
            'opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100 group-data-[separator=drag]:opacity-100',
            'data-[panel-group-direction=vertical]:rotate-90',
          )}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </div>
      )}
    </SeparatorPrimitive>
  )
}
