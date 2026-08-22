import { describe, expect, it } from 'vitest'
import {
  computeComposerAcceptTypes,
} from '../modelAttachmentCapabilities'

describe('computeComposerAcceptTypes ', () => {
  it('所有模型都允许选择任意附件类型', () => {
    expect(computeComposerAcceptTypes()).toBe('*/*')
  })
})
