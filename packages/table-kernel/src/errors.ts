export const ErrorCodes = {
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  DB_ERROR: 'DB_ERROR',
  WRITE_ERROR: 'WRITE_ERROR',
  API_ERROR: 'API_ERROR',
  VALIDATION_REQUIRED: 'REQUIRED',
  VALIDATION_INVALID_TYPE: 'INVALID_TYPE',
  EMPTY_INPUT: 'EMPTY_INPUT',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]
