import { AgentActionEvents, LocalRuntimeEvents } from '@tabtin/ws-gateway-client';
import type { AgentTransportEnvelope } from '@tabtin/agent-host/realtime';

export interface PromptForwardControllerPorts {
  acceptsNewTasks(): boolean;
  lifecycleState(): string;
  hasAgentHost(): boolean;
  feed(envelope: AgentTransportEnvelope): void;
  reportFailure(envelope: Record<string, unknown>, payload: Record<string, unknown>, message: string): Promise<void>;
  handleUnavailableUserResponse(envelope: Record<string, unknown>): Promise<void>;
  warn(message: string): void;
  debug(message: string): void;
}

/** Owns work/control ingress routing for gateway agent envelopes. */
export class PromptForwardController {
  constructor(private readonly ports: PromptForwardControllerPorts) {}

  async handle(envelope: unknown): Promise<void> {
    if (!envelope || typeof envelope !== 'object') {
      this.ports.warn('[Daemon] Received invalid agent bridge envelope (not an object)');
      return;
    }
    const env = envelope as Record<string, unknown>;
    if (env.type === 'agent.prompt.forward') {
      await this.handlePrompt(env);
      return;
    }
    if (CONTROL_ENVELOPES.has(String(env.type))) {
      if (this.ports.hasAgentHost()) {
        this.ports.feed(env as AgentTransportEnvelope);
      } else {
        await this.handleWithoutHost(env);
      }
      return;
    }
    this.ports.debug(`[Daemon] Unhandled agent envelope type (no-op): ${String(env.type)}`);
  }

  private async handlePrompt(env: Record<string, unknown>): Promise<void> {
    const payload = objectPayload(env.payload);
    if (!this.ports.acceptsNewTasks()) {
      const state = this.ports.lifecycleState();
      this.ports.warn(`[Daemon] Rejecting prompt.forward — daemon is ${state}`);
      await this.ports.reportFailure(env, payload, `Local runtime is unavailable: daemon is ${state}`);
      return;
    }
    if (!this.ports.hasAgentHost()) {
      this.ports.warn('[Daemon] prompt.forward received but localAgentHost not initialised');
      await this.ports.reportFailure(env, payload, 'Local runtime is unavailable: DaemonAgentHost is not initialised');
      return;
    }
    this.ports.feed(env as AgentTransportEnvelope);
  }

  private async handleWithoutHost(env: Record<string, unknown>): Promise<void> {
    if (env.type === LocalRuntimeEvents.USER_RESPONSE) {
      await this.ports.handleUnavailableUserResponse(env);
      return;
    }
    if (env.type === 'agent.subagent.cancel') {
      const childId = String(objectPayload(env.payload).child_id ?? '?');
      this.ports.warn(`[Daemon] subagent.cancel received but localAgentHost not initialised: child=${childId.slice(0, 8)}`);
      return;
    }
    if (env.type === 'agent.prompt.cancel') {
      this.ports.warn('[Daemon] prompt.cancel received but localAgentHost not initialised');
      return;
    }
    this.ports.warn(`[Daemon] ${String(env.type)} received but localAgentHost not initialised`);
  }
}

const CONTROL_ENVELOPES = new Set<string>([
  'agent.prompt.pause',
  'agent.prompt.resume',
  'agent.prompt.cancel',
  'agent.subagent.cancel',
  LocalRuntimeEvents.USER_RESPONSE,
  AgentActionEvents.APPROVAL_MEMO_UPDATED,
  'agent.permission.reset_session',
  'agent.permission.response',
  'agent.permission.mode_update',
]);

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
