/**
 * 通用头像裁剪上传组件
 *
 * 纯 UI + OSS 上传逻辑，不含任何业务持久化。
 * 调用方通过 onUploadComplete / onRemove 回调处理持久化。
 *
 * 适用场景：Agent 头像、群头像、频道头像、用户头像等。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Cropper from 'react-easy-crop'
import type { Area, Point } from 'react-easy-crop'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '@components/ui'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUpload, type UseUploadOptions } from '@/hooks/useUpload'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import { beginNativeFilePickerInteraction } from '@/utils/nativeFilePickerGuard'

const log = createLogger('AvatarCropUploader')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AvatarCropUploaderProps {
  currentAvatar?: string
  disabled?: boolean
  /** 上传中 / 外部正在保存 */
  saving?: boolean

  /** OSS 上传选项 */
  uploadOptions: Pick<UseUploadOptions, 'module' | 'folder' | 'contextType' | 'contextId' | 'isPublic'> & {
    /** 文件名前缀，最终文件名为 `${prefix}-${Date.now()}.png` */
    fileNamePrefix?: string
  }

  /** 裁剪完成、OSS 上传成功后回调（CDN URL + file_id） */
  onUploadComplete: (url: string, fileId: string) => void | Promise<void>
  /** 点击移除头像时回调 */
  onRemove: () => void | Promise<void>

  /** 自定义 label，默认 "头像" */
  label?: string
  /** 自定义提示文案 */
  hint?: string
  /** 自定义裁剪对话框标题 */
  cropTitle?: string

  /** 预览区尺寸 class，默认 "h-16 w-16" */
  previewSize?: string
  /** 预览区圆角 class，默认 "rounded-xl" */
  previewRounded?: string
  /** 紧凑模式：仅展示可点击预览区，隐藏 label / 操作按钮 / hint */
  compact?: boolean
  /** 无头像或头像加载失败时的自定义预览；默认显示上传图片图标 */
  emptyPreview?: React.ReactNode
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/gif,image/webp'
const VALID_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_FILE_SIZE = 5 * 1024 * 1024
const OUTPUT_SIZE = 512
/** 进入裁剪前的最长边上限，避免大图在 react-easy-crop 拖拽时卡顿 */
const CROP_PREVIEW_MAX_EDGE = 1600

// ---------------------------------------------------------------------------
// Crop utility
// ---------------------------------------------------------------------------

/** 将过大图片缩到预览上限，降低拖拽时 GPU/合成压力 */
async function downscaleImageForCrop(dataUrl: string, maxEdge = CROP_PREVIEW_MAX_EDGE): Promise<string> {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Image decode failed'))
    image.src = dataUrl
  })

  const longest = Math.max(image.naturalWidth, image.naturalHeight)
  if (!longest || longest <= maxEdge) return dataUrl

  const scale = maxEdge / longest
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', 0.92)
}

async function getCroppedBlob(imageSrc: string, cropPixels: Area): Promise<Blob> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Image decode failed'))
    image.src = imageSrc
  })

  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const ctx = canvas.getContext('2d')!

  ctx.drawImage(
    image,
    cropPixels.x,
    cropPixels.y,
    cropPixels.width,
    cropPixels.height,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE,
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
      'image/png',
      0.92,
    )
  })
}

function resolveAvatarUploadErrorMessage(err: unknown, t: ReturnType<typeof useTranslation>['t']): string {
  if (err instanceof Error) {
    const message = err.message || ''
    if (
      message.includes('OSS 配置')
      || message.includes('Bucket 配置')
      || message.includes('Endpoint')
    ) {
      return t('avatarUploader.errors.ossConfigUnavailable', {
        defaultValue: '头像上传失败：上传服务配置不可用，请稍后重试或联系管理员',
      })
    }
    if (
      message.includes('AccessDenied')
      || message.includes('HTTP 403')
      || message.includes('bucket acl')
      || message.includes('OSS 权限不足')
    ) {
      return t('avatarUploader.errors.ossPermissionDenied', {
        defaultValue: '头像上传失败：上传服务没有写入权限，请联系管理员',
      })
    }
    if (message.includes('PRESIGN_FAILED') || message.includes('生成签名失败')) {
      return t('avatarUploader.errors.presignFailed', {
        defaultValue: '头像上传失败：上传签名生成失败，请稍后重试',
      })
    }
  }
  return t('avatarUploader.errors.uploadFailed', { defaultValue: '头像上传失败' })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AvatarCropUploader: React.FC<AvatarCropUploaderProps> = ({
  currentAvatar,
  disabled = false,
  saving = false,
  uploadOptions,
  onUploadComplete,
  onRemove,
  label,
  hint,
  cropTitle,
  previewSize = 'h-16 w-16',
  previewRounded = 'rounded-xl',
  compact = false,
  emptyPreview,
}) => {
  const { t } = useTranslation('common')
  const resolvedLabel = label ?? t('avatarUploader.label', { defaultValue: '头像' })
  const resolvedHint = hint ?? t('avatarUploader.hint', { defaultValue: '支持 JPG、PNG、GIF、WebP，最大 5MB。GIF 将转为静态图。' })
  const resolvedCropTitle = cropTitle ?? t('avatarUploader.cropTitle', { defaultValue: '裁剪头像' })
  const inputRef = useRef<HTMLInputElement>(null)
  const finishNativePickerRef = useRef<(() => void) | null>(null)

  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  /** 拖拽过程用 ref，避免每帧 setState 触发整树重绘 */
  const croppedAreaPixelsRef = useRef<Area | null>(null)
  const [hasCropArea, setHasCropArea] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [failedCurrentAvatar, setFailedCurrentAvatar] = useState<string | null>(null)

  const { upload, isUploading, progress, cancel } = useUpload({
    module: uploadOptions.module,
    folder: uploadOptions.folder,
    contextType: uploadOptions.contextType,
    contextId: uploadOptions.contextId,
    isPublic: uploadOptions.isPublic,
    preset: 'IMAGE' as const,
    trackInQueue: false,
  })

  useEffect(() => {
    return () => {
      finishNativePickerRef.current?.()
      finishNativePickerRef.current = null
      cancel()
    }
  }, [cancel])

  const busy = isUploading || isSaving || saving
  const previewActionLabel = currentAvatar
    ? t('avatarUploader.replace', { defaultValue: '更换' })
    : t('avatarUploader.upload', { defaultValue: '上传头像' })

  const resetCropSession = useCallback(() => {
    croppedAreaPixelsRef.current = null
    setHasCropArea(false)
    setImageSrc(null)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setDialogOpen(false)
  }, [])

  const finishNativePicker = useCallback(() => {
    finishNativePickerRef.current?.()
    finishNativePickerRef.current = null
  }, [])

  const handleOpenNativePicker = useCallback(() => {
    if (disabled || busy) return
    finishNativePicker()
    finishNativePickerRef.current = beginNativeFilePickerInteraction()
    inputRef.current?.click()
  }, [busy, disabled, finishNativePicker])

  // ── File selection ──

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    finishNativePicker()
    const file = e.target.files?.[0]
    if (!file) return

    if (!VALID_MIME_TYPES.has(file.type)) {
      toast.error(t('avatarUploader.errors.unsupportedFormat', { defaultValue: '不支持的图片格式' }))
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    if (file.size > MAX_FILE_SIZE) {
      toast.error(t('avatarUploader.errors.fileTooLarge', { defaultValue: '图片不能超过 5MB' }))
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const raw = reader.result as string
      void (async () => {
        try {
          const preview = await downscaleImageForCrop(raw)
          croppedAreaPixelsRef.current = null
          setHasCropArea(false)
          setImageSrc(preview)
          setCrop({ x: 0, y: 0 })
          setZoom(1)
          setDialogOpen(true)
        } catch {
          toast.error(t('avatarUploader.errors.decodeFailed', { defaultValue: '图片解析失败，请换一张图片' }))
        }
      })()
    }
    reader.readAsDataURL(file)
    if (inputRef.current) inputRef.current.value = ''
  }, [finishNativePicker, t])

  // ── Crop + upload ──

  const onCropComplete = useCallback((_: Area, pixelCrop: Area) => {
    croppedAreaPixelsRef.current = pixelCrop
    setHasCropArea((prev) => prev || true)
  }, [])

  const handleConfirmCrop = useCallback(async () => {
    const croppedAreaPixels = croppedAreaPixelsRef.current
    if (!imageSrc || !croppedAreaPixels) return

    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels)
      const prefix = uploadOptions.fileNamePrefix ?? 'avatar'
      const result = await upload(blob, `${prefix}-${Date.now()}.png`)

      setIsSaving(true)
      try {
        await onUploadComplete(result.accessUrl, result.fileId)
      } finally {
        setIsSaving(false)
      }

      resetCropSession()
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'UploadAbortedError')) return
      console.error('[AvatarCropUploader] Upload failed:', err)
      const isDecodeError = err instanceof Error && err.message === 'Image decode failed'
      toast.error(
        isDecodeError
          ? t('avatarUploader.errors.decodeFailed', { defaultValue: '图片解析失败，请换一张图片' })
          : resolveAvatarUploadErrorMessage(err, t)
      )
    }
  }, [imageSrc, upload, uploadOptions.fileNamePrefix, onUploadComplete, resetCropSession, t])

  // ── Remove ──

  const handleRemove = useCallback(async () => {
    setIsSaving(true)
    try {
      await onRemove()
    } finally {
      setIsSaving(false)
    }
  }, [onRemove])

  // ── Dialog ──

  const handleDialogClose = useCallback((open: boolean) => {
    if (!open) resetCropSession()
  }, [resetCropSession])

  const handleCropDialogInteractOutside = useCallback((event: Event) => {
    // 原生文件选择器关闭时，Electron 会恢复窗口焦点和鼠标事件。若裁剪框恰好在
    // 这个阶段打开，Radix 可能把残留事件识别为 outside interaction，并立即丢弃
    // 刚生成的裁剪草稿。裁剪是有输入草稿的阻塞阶段，只允许显式取消或关闭。
    if (!event.defaultPrevented) {
      log.debug('Prevented outside dismissal while crop draft is open')
      event.preventDefault()
    }
  }, [])

  // ── Render ──

  return (
    <div className={cn(!compact && 'space-y-1.5')}>
      {!compact && (
        <label className="text-body font-medium text-muted-foreground">{resolvedLabel}</label>
      )}

      <div className={cn('flex items-center', compact ? '' : 'gap-3')}>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={handleOpenNativePicker}
          aria-label={previewActionLabel}
          aria-busy={busy}
          className={cn(
            'relative shrink-0 overflow-hidden transition-all',
            'flex items-center justify-center',
            !compact && 'hover:border-accent/60 hover:bg-accent/5',
            previewSize,
            previewRounded,
            currentAvatar && currentAvatar !== failedCurrentAvatar
              ? compact ? '' : 'border border-border/40'
              : compact ? 'bg-muted/40' : 'border-2 border-dashed border-border/30',
            disabled && 'opacity-50 cursor-not-allowed',
            compact && !disabled && !busy && 'hover:opacity-80 cursor-pointer',
          )}
        >
          {busy ? (
            <div className="flex flex-col items-center gap-0.5" role="status" aria-live="polite">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              {isUploading && (
                <span className="text-caption text-muted-foreground">
                  {Math.round(progress * 100)}%
                </span>
              )}
            </div>
          ) : currentAvatar && currentAvatar !== failedCurrentAvatar ? (
            <img
              src={currentAvatar}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setFailedCurrentAvatar(currentAvatar)}
            />
          ) : (
            emptyPreview ?? <ImagePlus className="h-5 w-5 text-muted-foreground/60" />
          )}
        </button>

        {!compact && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || busy}
                onClick={handleOpenNativePicker}
                className="h-7 text-body"
              >
                {currentAvatar
                  ? t('avatarUploader.replace', { defaultValue: '更换' })
                  : t('avatarUploader.upload', { defaultValue: '上传头像' })}
              </Button>
              {currentAvatar && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || busy}
                  onClick={handleRemove}
                  className="h-7 text-body text-muted-foreground/60 hover:text-destructive"
                  title={t('avatarUploader.remove', { defaultValue: '移除' })}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
            <p className="text-caption text-muted-foreground/60">{resolvedHint}</p>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={handleFileSelect}
      />

      <Dialog open={dialogOpen} onOpenChange={handleDialogClose}>
        <DialogContent
          // 嵌在创建组织等弹层内时需抬到 z-global；遮罩关 blur，避免拖拽卡顿
          className="sm:max-w-md !z-global"
          overlayClassName="!z-global ![backdrop-filter:none] ![-webkit-backdrop-filter:none]"
          onPointerDownOutside={handleCropDialogInteractOutside}
          onInteractOutside={handleCropDialogInteractOutside}
        >
          <DialogHeader>
            <DialogTitle>{resolvedCropTitle}</DialogTitle>
          </DialogHeader>

          <div
            className="relative h-72 w-full bg-black/90 rounded-lg overflow-hidden"
            style={{ contain: 'strict' }}
          >
            {imageSrc && (
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="rect"
                showGrid={false}
                objectFit="contain"
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            )}
          </div>

          <div className="flex items-center gap-3 px-1">
            <span className="text-caption text-muted-foreground shrink-0">
              {t('avatarUploader.zoom', { defaultValue: '缩放' })}
            </span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="flex-1 accent-accent h-1"
            />
            <span className="text-caption text-muted-foreground/60 w-8 text-right tabular-nums">
              {zoom.toFixed(1)}×
            </span>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDialogClose(false)}
              disabled={busy}
              className="text-body"
            >
              {t('cancel', { defaultValue: '取消' })}
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmCrop}
              disabled={busy || !hasCropArea}
              className="text-body"
            >
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  {isSaving
                    ? t('avatarUploader.saving', { defaultValue: '保存中...' })
                    : t('avatarUploader.uploading', { defaultValue: '上传中...' })}
                </>
              ) : (
                t('avatarUploader.confirmCrop', { defaultValue: '确认裁剪' })
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
