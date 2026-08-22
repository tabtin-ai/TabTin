/**
 * ：packaged 下包根 toast 与 /toast shim 必须是同一函数引用，
 * 否则业务 `toast()` 写入的 store 与 `<Toaster />` 订阅的 store 分裂。
 */
import { describe, expect, it } from 'vitest'

import { toast as rootToast, useToast as rootUseToast } from '@tabtin/smartsheet-ui'
import { toast as shimToast, useToast as shimUseToast } from '@tabtin/smartsheet-ui/toast'
import { toast as uiToast } from '@components/ui'

describe('smartsheet-ui toast singleton ', () => {
  it('package root, /toast shim, and @components/ui share the same toast fn', () => {
    expect(rootToast).toBe(shimToast)
    expect(uiToast).toBe(shimToast)
  })

  it('package root and /toast shim share the same useToast hook', () => {
    expect(rootUseToast).toBe(shimUseToast)
  })
})
