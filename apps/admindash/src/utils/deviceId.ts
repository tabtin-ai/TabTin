const STORAGE_KEY = 'tabtin.device_id'

const createDeviceId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `admin-${crypto.randomUUID()}`
  }
  return `admin-${Date.now()}_${Math.floor(Math.random() * 100000)}`
}

export const getOrCreateDeviceId = (): string => {
  if (typeof window === 'undefined') {
    return createDeviceId()
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && stored.trim().length > 0) {
      return stored
    }
    const created = createDeviceId()
    window.localStorage.setItem(STORAGE_KEY, created)
    return created
  } catch {
    return createDeviceId()
  }
}
