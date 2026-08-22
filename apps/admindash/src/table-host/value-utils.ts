export const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return '发生未知错误'
}

export const isEmptyFieldValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return false
}
