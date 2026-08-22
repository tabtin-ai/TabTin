import { afterEach, describe, expect, it } from 'vitest'
import { setResourceDetectionAPI } from '../../runtime/public'
import { listResourcesTool } from '../resource-detection'

afterEach(() => {
  setResourceDetectionAPI(null)
})

describe('list_resources defaults', () => {
  it('hides stream segments by default', async () => {
    let capturedInput: any
    setResourceDetectionAPI({
      async listResources(input: any) {
        capturedInput = input
        return { success: true, data: { resources: [], summary: { total: 0, byCategory: {}, byCaptureStatus: {} }, viewId: input.viewId } }
      },
    } as any)

    const result = await listResourcesTool.execute({ viewId: 'view-1' } as any)

    expect(result.success).toBe(true)
    expect(capturedInput.hideSegments).toBe(true)
  })
})
