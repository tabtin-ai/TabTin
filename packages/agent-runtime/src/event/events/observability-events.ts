/** Run lifecycle / step 观测事件的唯一 typed 构造入口。 */

import { StreamEvents } from '../../engine/contracts/stream-events.js';
import type {
  LifecycleEvent,
  StepEvent,
  SystemNoticeEvent,
} from '../../engine/contracts/wire-protocol.js';
import { TypedAgentEvent } from '../agent-event.js';

export class RuntimeLifecycleEvent extends TypedAgentEvent<LifecycleEvent> {
  constructor(payload: LifecycleEvent['payload']) {
    super(StreamEvents.LIFECYCLE, payload);
  }
}

export class RuntimeStepEvent extends TypedAgentEvent<StepEvent> {
  constructor(payload: StepEvent['payload']) {
    super(StreamEvents.STEP, payload);
  }
}

export class RuntimeSystemNoticeEvent extends TypedAgentEvent<SystemNoticeEvent> {
  constructor(payload: SystemNoticeEvent['payload']) {
    super(StreamEvents.SYSTEM_NOTICE, payload);
  }
}
