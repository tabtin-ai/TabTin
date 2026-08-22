export interface AgentGatewayPort {
  subscribeTopics(topics: string[]): Promise<void>
  unsubscribeTopics(topics: string[]): Promise<void>
  relayEvents(
    sessionId: string,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ): Promise<void>
  sendAgentEvent(
    threadId: string,
    messageType: string,
    payload: Record<string, any>,
  ): Promise<void>
  acknowledgeApplicationEvent?(eventId: string, topic: string): void
  onReconnect(callback: () => void | Promise<void>): void
}
