import { describe, expect, it } from 'vitest'
import { OrganizationBillingApiService } from '../billingApi'

describe('OrganizationBillingApiService.buildExportUrl ', () => {
  it('includes meter_key when exporting LLM usage', () => {
    const url = OrganizationBillingApiService.buildExportUrl('org-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-21',
      meterKey: 'llm.tokens',
      format: 'csv',
      mode: 'detail',
    })
    const query = new URL(url, 'http://localhost').searchParams
    expect(query.get('meter_key')).toBe('llm.tokens')
    expect(query.get('start_date')).toBe('2026-07-01')
    expect(query.get('end_date')).toBe('2026-07-21')
  })

  it('omits meter_key when not provided', () => {
    const url = OrganizationBillingApiService.buildExportUrl('org-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-21',
    })
    const query = new URL(url, 'http://localhost').searchParams
    expect(query.has('meter_key')).toBe(false)
  })

  it('passes expanded model-call biz_type alias through to export URL', () => {
    const url = OrganizationBillingApiService.buildExportUrl('org-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-21',
      meterKey: 'llm.tokens',
      bizType: 'llm_call,llm',
      format: 'csv',
      mode: 'detail',
    })
    const query = new URL(url, 'http://localhost').searchParams
    expect(query.get('meter_key')).toBe('llm.tokens')
    expect(query.get('biz_type')).toBe('llm_call,llm')
  })

  it('passes scene_key when exporting the LLM chat subset', () => {
    const url = OrganizationBillingApiService.buildExportUrl('org-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-21',
      meterKey: 'llm.tokens',
      bizType: 'llm_call,llm',
      sceneKey: '_main_chat',
    })
    const query = new URL(url, 'http://localhost').searchParams
    expect(query.get('scene_key')).toBe('_main_chat')
  })

  it('passes schema=ledger for LLM usage ledger export without forcing member audit schema', () => {
    const ledgerUrl = OrganizationBillingApiService.buildExportUrl('org-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-21',
      meterKey: 'llm.tokens',
      format: 'csv',
      mode: 'detail',
      schema: 'ledger',
      timezone: 'America/Los_Angeles',
    })
    const ledgerQuery = new URL(ledgerUrl, 'http://localhost').searchParams
    expect(ledgerQuery.get('schema')).toBe('ledger')
    expect(ledgerQuery.get('meter_key')).toBe('llm.tokens')
    expect(ledgerQuery.get('timezone')).toBe('America/Los_Angeles')

    const memberUrl = OrganizationBillingApiService.buildExportUrl('org-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-21',
    })
    const memberQuery = new URL(memberUrl, 'http://localhost').searchParams
    expect(memberQuery.has('schema')).toBe(false)
    expect(memberQuery.has('timezone')).toBe(false)
  })

  it('passes schema=llm_usage for the current LLM scene list export', () => {
    const usageUrl = OrganizationBillingApiService.buildExportUrl('org-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-21',
      meterKey: 'llm.tokens',
      schema: 'llm_usage',
    })

    const usageQuery = new URL(usageUrl, 'http://localhost').searchParams
    expect(usageQuery.get('schema')).toBe('llm_usage')
    expect(usageQuery.get('meter_key')).toBe('llm.tokens')
  })
})
