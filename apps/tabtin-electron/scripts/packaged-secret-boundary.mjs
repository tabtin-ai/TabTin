export function resolveSourcemapUploadConfig({ profile, processEnv = {} }) {
  if (profile === 'community' && processEnv.SOURCEMAP_UPLOAD_ENABLED !== '1') {
    return { enabled: false }
  }
  if (processEnv.SOURCEMAP_UPLOAD_SKIP === '1') {
    return { enabled: false }
  }

  const hasKey = Boolean(processEnv.SOURCEMAP_UPLOAD_KEY)
  const hasApiUrl = Boolean(processEnv.SOURCEMAP_API_URL)
  if (!hasKey || !hasApiUrl) {
    const missing = []
    if (!hasKey) missing.push('SOURCEMAP_UPLOAD_KEY')
    if (!hasApiUrl) missing.push('SOURCEMAP_API_URL')
    return { enabled: false, missing }
  }

  return {
    enabled: true,
    keySource: 'process'
  }
}
