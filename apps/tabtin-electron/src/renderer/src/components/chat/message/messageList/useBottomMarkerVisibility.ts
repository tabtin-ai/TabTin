import { useState } from 'react'
import { useScopedEffect } from '@hooks/spaceActivity'

export function useBottomMarkerVisibility(
  scrollElement: HTMLDivElement | null,
  bottomMarkerElement: HTMLDivElement | null,
): boolean {
  const [isBottomMarkerVisible, setIsBottomMarkerVisible] = useState(true)

  useScopedEffect(() => {
    if (!scrollElement || !bottomMarkerElement) {
      setIsBottomMarkerVisible(true)
      return
    }

    setIsBottomMarkerVisible(true)
    const observer = new IntersectionObserver(
      ([entry]) => setIsBottomMarkerVisible(entry?.isIntersecting ?? true),
      { root: scrollElement },
    )
    observer.observe(bottomMarkerElement)
    return () => observer.disconnect()
  }, [bottomMarkerElement, scrollElement])

  return isBottomMarkerVisible
}
