import type { CommandResult, DomainEventLike, IEventBus } from '../../ports/index.js'
import { ErrorCodes } from '../../errors.js'

export class FlowAbort extends Error {
  constructor(readonly result: CommandResult<unknown>) {
    super('write-flow-abort')
  }
}

export function ensureSuccess<T>(result: CommandResult<T>): asserts result is CommandResult<T> & { success: true } {
  if (!result.success) {
    throw new FlowAbort(result)
  }
}

export interface WriteFlowOutputBase<T = unknown> {
  result: CommandResult<T>
  events: DomainEventLike[]
}

export async function runWriteOp<TOutput extends WriteFlowOutputBase>(
  op: () => Promise<TOutput>,
  eventBus: IEventBus | undefined,
  emptyOutput: (result: CommandResult) => TOutput,
): Promise<TOutput> {
  try {
    const output = await op()
    if (output.events.length > 0 && eventBus) {
      try {
        await eventBus.publish(output.events)
      } catch { /* best-effort: data already persisted */ }
    }
    return output
  } catch (err) {
    if (err instanceof FlowAbort) {
      return emptyOutput(err.result)
    }
    return emptyOutput({ success: false, errors: [{ code: ErrorCodes.WRITE_ERROR, message: String(err) }] })
  }
}
