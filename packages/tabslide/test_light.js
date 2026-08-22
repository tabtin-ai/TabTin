function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

function isLightColor(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{3,8})$/)
  if (!m) return true
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length < 6) return true
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return relativeLuminance(r, g, b) > 0.5
}

console.log('ffffff', isLightColor('#ffffff'))
console.log('000000', isLightColor('#000000'))
console.log('f0f0f0', isLightColor('#f0f0f0'))
