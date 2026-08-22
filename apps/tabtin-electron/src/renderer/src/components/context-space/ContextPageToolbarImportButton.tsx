import React from 'react'
import { Loader2, Upload, type LucideIcon } from 'lucide-react'
import { ContextPageToolbarIconButton } from './ContextPageToolbarIconButton'

interface ContextPageToolbarImportButtonProps {
  label: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  className?: string
  /** 默认 Upload；云盘单文件导入可覆写为 FileInput 等更贴切语义的图标 */
  icon?: LucideIcon
}

/** 应用主列表工具行「导入」。 */
export const ContextPageToolbarImportButton: React.FC<ContextPageToolbarImportButtonProps> = ({
  label,
  onClick,
  disabled = false,
  loading = false,
  className,
  icon: Icon = Upload,
}) => (
  <ContextPageToolbarIconButton
    label={label}
    onClick={onClick}
    disabled={disabled || loading}
    className={className}
  >
    {loading
      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
      : <Icon className="h-3.5 w-3.5" />}
  </ContextPageToolbarIconButton>
)
