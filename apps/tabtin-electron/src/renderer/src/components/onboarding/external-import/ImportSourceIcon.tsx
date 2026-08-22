import React from 'react'
import type { ImportSourceId } from '@tabtin/cli-server-core'
import { cn } from '@utils/cn'
import { IMPORT_SOURCE_ICON_URLS } from './importSourceIcons'

interface ImportSourceIconProps {
  source: ImportSourceId
  /** Lucide 占位（静态资源缺失时的兜底，正常打包路径不应走到） */
  FallbackIcon: React.ComponentType<{ className?: string }>
  fallbackTint?: string
  fallbackChip?: string
  className?: string
  imageClassName?: string
  iconClassName?: string
}

export const ImportSourceIcon: React.FC<ImportSourceIconProps> = ({
  source,
  FallbackIcon,
  fallbackTint,
  fallbackChip,
  className,
  imageClassName,
  iconClassName,
}) => {
  const src = IMPORT_SOURCE_ICON_URLS[source]
  if (src) {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden bg-background/80',
          className,
        )}
      >
        <img
          src={src}
          alt=""
          aria-hidden
          className={cn('h-full w-full object-contain', imageClassName)}
          draggable={false}
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center',
        fallbackChip,
        className,
      )}
    >
      <FallbackIcon className={cn(fallbackTint, iconClassName ?? 'h-5 w-5')} aria-hidden />
    </div>
  )
}
