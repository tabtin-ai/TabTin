/**
 * 会话级 Agent 回合脉冲是否可见（原 streaming tail 口径）。
 *
 * 显示：session streaming 且非 HITL（审批 / askUser / WS suspended）。
 * 用于驱动 AgentAwaitingThought，并 suppress 块内重复 Loader2。
 */
export { useAgentStreamingTailVisible as useAgentTurnPulseVisible } from './useAgentStreamingTailVisible'
export { useAgentStreamingTailVisible } from './useAgentStreamingTailVisible'
