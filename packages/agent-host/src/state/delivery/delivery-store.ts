import type { DeliveryBatchBuffer } from '../../delivery/delivery-batch-buffer.js'

/**
 * Delivery 侧 session 缓冲登记（ Phase 3）。
 *
 * Per-turn buffer 目前由 DeliveryCoordinator 局部持有；本 store 提供
 * `trackBuffer` 登记面。未登记前 `cancelSessionDelivery` 为 no-op（与迁移前
 * AgentHost.deliveryBuffers 行为一致），取消在途 relay 仍依赖 query abort。
 */
export class DeliveryStore {
  private readonly deliveryBuffers = new Map<string, Set<DeliveryBatchBuffer>>()

  trackBuffer(sessionId: string, buffer: DeliveryBatchBuffer): void {
    const id = sessionId.trim()
    if (!id) return
    let set = this.deliveryBuffers.get(id)
    if (!set) {
      set = new Set()
      this.deliveryBuffers.set(id, set)
    }
    set.add(buffer)
  }

  getBuffers(sessionId: string): Set<DeliveryBatchBuffer> | undefined {
    return this.deliveryBuffers.get(sessionId)
  }

  deleteBuffers(sessionId: string): boolean {
    return this.deliveryBuffers.delete(sessionId)
  }

  cancelSessionDelivery(sessionId: string): void {
    const buffers = this.deliveryBuffers.get(sessionId)
    if (!buffers) return
    this.deliveryBuffers.delete(sessionId)
    for (const buffer of buffers) buffer.cancel()
  }

  clearAll(): void {
    for (const buffers of this.deliveryBuffers.values()) {
      for (const buffer of buffers) buffer.cancel()
    }
    this.deliveryBuffers.clear()
  }
}
