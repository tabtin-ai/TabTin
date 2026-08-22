import type { IMProviderId } from './contracts'

export class IMProviderUnavailableError extends Error {
  readonly providerId: IMProviderId
  readonly operation: string

  constructor(providerId: IMProviderId, operation: string) {
    super(`IM provider "${providerId}" does not support ${operation} yet`)
    this.name = 'IMProviderUnavailableError'
    this.providerId = providerId
    this.operation = operation
  }
}
