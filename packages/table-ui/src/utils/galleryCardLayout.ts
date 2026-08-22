/** Gallery card size stored in view.config.card_size */
export type GalleryCardSize = 'small' | 'medium' | 'large'

const GALLERY_CARD_SIZES = new Set<GalleryCardSize>(['small', 'medium', 'large'])

export const GALLERY_BREAKPOINTS = [
  { width: 1536, columns: 6 },
  { width: 1280, columns: 5 },
  { width: 1024, columns: 4 },
  { width: 768, columns: 3 },
  { width: 640, columns: 2 },
] as const

/** small → more columns (smaller cards); large → fewer columns (larger cards). */
const CARD_SIZE_COLUMN_OFFSET: Record<GalleryCardSize, number> = {
  small: 1,
  medium: 0,
  large: -1,
}

export function resolveGalleryCardSize(value: unknown): GalleryCardSize {
  if (typeof value === 'string' && GALLERY_CARD_SIZES.has(value as GalleryCardSize)) {
    return value as GalleryCardSize
  }
  return 'medium'
}

export function calcGalleryColumns(containerWidth: number, cardSize: GalleryCardSize = 'medium'): number {
  let columns = 1
  for (const bp of GALLERY_BREAKPOINTS) {
    if (containerWidth >= bp.width) {
      columns = bp.columns
      break
    }
  }
  return Math.max(1, columns + CARD_SIZE_COLUMN_OFFSET[cardSize])
}
