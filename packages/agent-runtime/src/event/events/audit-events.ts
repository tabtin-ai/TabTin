/** Capability 治理审计流事件。 */

import { AgentEvent } from '../agent-event.js';

export const AUDIT_CAP_EVENT_TYPE = 'agent.stream.audit_cap' as const;

export class RuntimeAuditEvent extends AgentEvent {
  readonly type = AUDIT_CAP_EVENT_TYPE;
  constructor(private readonly payload: Record<string, unknown>) { super(); }
  protected data(): Record<string, unknown> { return { ...this.payload }; }
}
