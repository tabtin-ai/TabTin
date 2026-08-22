import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mocks.toast,
  ToastAction: () => null,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}))

import {
  extractBillingErrorCode,
  getResourceQuotaDescriptionKey,
  resolveResourceQuotaErrorCode,
  showBillingErrorToast,
} from '../billingErrorHandler'

describe('extractBillingErrorCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads entitlement codes from Error.code', () => {
    const error = new Error('当前套餐文档额度已用完')
    ;(error as Error & { code?: string }).code = 'ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED'

    expect(extractBillingErrorCode(error)).toBe('ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED')
  })

  it('reads entitlement codes from Error.message', () => {
    expect(
      extractBillingErrorCode(new Error('request failed: ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED')),
    ).toBe('ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED')
  })

  it('reads entitlement codes from plain object message', () => {
    expect(
      extractBillingErrorCode({ message: 'ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED: 当前套餐文档额度已用完' }),
    ).toBe('ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED')
  })

  it('reads entitlement codes from nested API error payloads', () => {
    expect(
      extractBillingErrorCode({
        data: {
          code: 403,
          data: { error_code: 'ENTITLEMENT_GROUP_LIMIT_EXCEEDED' },
        },
      }),
    ).toBe('ENTITLEMENT_GROUP_LIMIT_EXCEEDED')
  })

  it('renders balance-insufficient prompts as short warning notices', () => {
    showBillingErrorToast('ORGANIZATION_INSUFFICIENT_CREDITS')
    showBillingErrorToast('INSUFFICIENT_CREDITS')
    showBillingErrorToast('INSUFFICIENT_BALANCE')

    expect(mocks.toast).toHaveBeenNthCalledWith(1, expect.objectContaining({
      variant: 'warning',
      duration: 5000,
    }))
    expect(mocks.toast).toHaveBeenNthCalledWith(2, expect.objectContaining({
      variant: 'warning',
      duration: 5000,
    }))
    expect(mocks.toast).toHaveBeenNthCalledWith(3, expect.objectContaining({
      variant: 'warning',
      duration: 5000,
    }))
  })
})

describe('resolveResourceQuotaErrorCode', () => {
  it.each([
    ['tabdata', 'ENTITLEMENT_TABLE_LIMIT_EXCEEDED'],
    ['tabdoc', 'ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED'],
  ] as const)('maps a generic quota error to the %s resource entitlement', (resourceType, expected) => {
    expect(resolveResourceQuotaErrorCode('QUOTA_EXCEEDED', resourceType)).toBe(expected)
  })

  it('preserves an already-specific entitlement error code', () => {
    expect(
      resolveResourceQuotaErrorCode('ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED', 'tabdata'),
    ).toBe('ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED')
  })

  it.each([
    ['ENTITLEMENT_TABLE_LIMIT_EXCEEDED', 'common:billing.tableQuotaExceededDesc'],
    ['ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED', 'common:billing.documentQuotaExceededDesc'],
  ] as const)('uses count-free copy for %s', (code, expected) => {
    expect(getResourceQuotaDescriptionKey(code)).toBe(expected)
  })
})
