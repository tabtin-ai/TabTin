function normalize(input) {
  return String(input || '').replace(/\\/g, '/')
}

function dirname(input) {
  const normalized = normalize(input)
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '.'
  return normalized.slice(0, idx)
}

function join() {
  return normalize(Array.from(arguments).filter(Boolean).join('/')).replace(/\/+/g, '/')
}

module.exports = {
  normalize,
  dirname,
  join,
}
