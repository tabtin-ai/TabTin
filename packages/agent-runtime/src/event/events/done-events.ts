/** Agent run 终态事件的唯一 typed 构造入口。 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import type { DoneEvent } from '../../engine/contracts/wire-protocol.js';
import { TypedAgentEvent } from '../agent-event.js';

export class RuntimeDoneEvent extends TypedAgentEvent<DoneEvent> {
  constructor(payload: DoneEvent['payload']) {
    super(StreamEvents.DONE, payload);
  }
}
