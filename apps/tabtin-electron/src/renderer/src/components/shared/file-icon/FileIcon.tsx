import { useState, useCallback, useSyncExternalStore } from 'react'
import { File, Folder } from 'lucide-react'
import { getFileIcon, subscribeManifest, getManifestVersion } from './file-icons'

export interface FileIconProps {
  fileName: string
  isDirectory?: boolean
  isOpen?: boolean
  className?: string
}

export function FileIcon({
  fileName,
  isDirectory = false,
  isOpen = false,
  className,
}: FileIconProps) {
  useSyncExternalStore(subscribeManifest, getManifestVersion)
  const [hasError, setHasError] = useState(false)
  const handleError = useCallback(() => setHasError(true), [])

  if (hasError) {
    const FallbackIcon = isDirectory ? Folder : File
    return <FallbackIcon className={className} />
  }

  const { src } = getFileIcon(fileName, isDirectory, isOpen)
  return <img src={src} alt="" draggable={false} className={className} onError={handleError} />
}
