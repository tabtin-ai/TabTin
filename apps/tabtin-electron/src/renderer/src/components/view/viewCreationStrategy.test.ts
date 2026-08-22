import { describe, expect, it, vi } from 'vitest'
import { selectViewCreator } from './viewCreationStrategy'

describe('selectViewCreator', () => {
  it('协作创建失败时不自动发起第二次 REST 创建', async () => {
    const runtimeCreator = vi.fn(async () => null)
    const restCreator = vi.fn()

    const result = await selectViewCreator(runtimeCreator, restCreator)({ name: '新视图' })

    expect(result).toBeNull()
    expect(runtimeCreator).toHaveBeenCalledOnce()
    expect(restCreator).not.toHaveBeenCalled()
  })

  it('没有协作运行时时使用普通 REST 创建', async () => {
    const created = { id: 'view-1' }
    const restCreator = vi.fn(async () => created as never)

    const result = await selectViewCreator(null, restCreator)({ name: '新视图' })

    expect(result).toBe(created)
    expect(restCreator).toHaveBeenCalledOnce()
  })
})
