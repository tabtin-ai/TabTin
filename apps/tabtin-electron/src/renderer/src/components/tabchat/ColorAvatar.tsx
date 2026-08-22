import React from 'react'
import { Users } from 'lucide-react'
import { identityAvatarColor, identityAvatarInitial } from '@tabtin/shared'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'

const log = createLogger('ColorAvatar')

function avatarFailureContext(imageUrl: string): { avatarHost: string; avatarPath: string } {
  try {
    const url = new URL(imageUrl)
    return { avatarHost: url.host, avatarPath: url.pathname }
  } catch {
    // 兼容后端意外返回 object key / 相对路径；query 可能带签名，不能写入诊断包。
    return { avatarHost: '', avatarPath: imageUrl.split(/[?#]/, 1)[0] }
  }
}

interface ColorAvatarProps {
  name: string
  seed?: string
  imageUrl?: string
  group?: boolean
  fallbackIcon?: React.ReactNode
  /** Agent 保持专属语义色，不与用户默认头像混用。 */
  isAgent?: boolean
  className?: string
  fallbackClassName?: string
}

/**
 * IM 默认头像：真实头像优先；否则按稳定身份 ID 生成平台统一的彩色首字头像。
 */
export const ColorAvatar: React.FC<ColorAvatarProps> = ({
  name,
  seed,
  imageUrl,
  group = false,
  fallbackIcon,
  isAgent = false,
  className,
  fallbackClassName,
}) => {
  const identity = seed || name || '?'
  const backgroundColor = isAgent ? 'hsl(var(--type-agent))' : identityAvatarColor(identity)
  const initial = identityAvatarInitial(name)
  const [imageFailed, setImageFailed] = React.useState(false)
  const failedImageUrlRef = React.useRef<string | null>(null)
  const showImage = Boolean(imageUrl && !imageFailed)

  React.useEffect(() => {
    failedImageUrlRef.current = null
    setImageFailed(false)
  }, [imageUrl])

  const handleImageError = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const failedUrl = event.currentTarget.currentSrc || imageUrl || ''
    if (!failedUrl || failedImageUrlRef.current === failedUrl) return
    failedImageUrlRef.current = failedUrl
    log.warn('IM avatar image failed to load', {
      ...avatarFailureContext(failedUrl),
      avatarSubject: seed || 'unknown',
    })
    setImageFailed(true)
  }

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white shadow-sm ring-1 ring-black/[0.04] dark:ring-white/10',
        className,
      )}
      style={{ backgroundColor }}
      aria-hidden={!showImage}
    >
      {showImage ? (
        <img src={imageUrl} alt="" className="h-full w-full rounded-full object-cover" onError={handleImageError} />
      ) : fallbackIcon ? (
        fallbackIcon
      ) : group ? (
        <Users className={cn('h-[45%] w-[45%]', fallbackClassName)} strokeWidth={2.2} />
      ) : (
        <span className={cn('text-body font-semibold leading-none text-white', fallbackClassName)}>
          {initial}
        </span>
      )}
    </div>
  )
}

ColorAvatar.displayName = 'ColorAvatar'
