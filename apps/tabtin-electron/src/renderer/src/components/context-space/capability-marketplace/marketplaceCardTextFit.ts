export function fitMarketplaceTextWithEllipsis(
  fullText: string,
  fits: (candidate: string) => boolean,
): string {
  if (fits(fullText)) return fullText

  const characters = Array.from(fullText)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${characters.slice(0, middle).join('').trimEnd()}...`
    if (fits(candidate)) low = middle
    else high = middle - 1
  }
  return `${characters.slice(0, low).join('').trimEnd()}...`
}
