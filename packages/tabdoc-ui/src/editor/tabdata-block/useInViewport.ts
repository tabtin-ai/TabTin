import { useEffect, useState, type RefObject } from 'react'

/**
 * Bidirectional IntersectionObserver viewport detection.
 * Returns true when element is within the buffered viewport area,
 * false when scrolled far away. Uses a generous rootMargin to
 * avoid unmount/remount churn during normal scrolling.
 */
export function useInViewport(
  ref: RefObject<HTMLElement | null>,
  options?: { rootMargin?: string; threshold?: number },
): boolean {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      {
        rootMargin: options?.rootMargin ?? '500px',
        threshold: options?.threshold ?? 0,
      },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, options?.rootMargin, options?.threshold])

  return isVisible
}
