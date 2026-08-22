import { describe, expect, it, vi } from 'vitest'
import {
  fetchHostTrackerSnapshot,
  fireHostTracker,
  prepareHostTrackerRun,
} from '../src/application/agent/host-tracker-cloud.js'

const AUTH = {
  token: 'test-token',
  apiBaseUrl: 'https://api.test.local',
  fingerprint: 'daemon-fp-1',
}

describe('host-tracker-cloud', () => {
  it('parses schedule items and pending work', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('/tracker/host-schedule')
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
        'X-Device-Fingerprint': 'daemon-fp-1',
      })
      return new Response(JSON.stringify({
        success: true,
        data: {
          items: [
            {
              id: 'tr-1',
              trigger_type: 'cron',
              trigger_config: { cron_expression: '0 9 * * *' },
              last_run_at: null,
              created_at: '2026-08-19T00:00:00Z',
            },
            { id: '', trigger_type: 'cron' },
          ],
          work: [{ run_id: 'run-1' }, { run_id: '' }],
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(fetchHostTrackerSnapshot(AUTH, fetchFn)).resolves.toEqual({
      items: [{
        trackerId: 'tr-1',
        triggerType: 'cron',
        triggerConfig: { cron_expression: '0 9 * * *' },
        lastRunAt: null,
        createdAt: '2026-08-19T00:00:00Z',
      }],
      work: [{ runId: 'run-1' }],
    })
  })

  it('fires a due tracker on the bound device', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('/tracker/host-schedule/tr-1/fire')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch

    await fireHostTracker(AUTH, 'tr-1', fetchFn)
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('prepares a pending run for local execution', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        session_id: 'sess-1',
        prompt: '提醒开会',
        workspace_id: 'ws-1',
        agent_id: 'ag-1',
      },
    }), { status: 200 })) as unknown as typeof fetch

    await expect(prepareHostTrackerRun(AUTH, 'run-1', fetchFn)).resolves.toEqual({
      sessionId: 'sess-1',
      agentId: 'ag-1',
      workspaceId: 'ws-1',
      prompt: '提醒开会',
      modelId: undefined,
      taskId: undefined,
      appContext: undefined,
    })
  })
})
