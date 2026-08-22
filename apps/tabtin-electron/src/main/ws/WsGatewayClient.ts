// Backward-compatible re-export — all callers using '../ws/WsGatewayClient'
// now get the unified implementation backed by @tabtin/ws-gateway-client.
export { ElectronWsGateway as WsGatewayClient, electronWsGateway } from './ElectronWsGateway.js'
export type {
  GatewayAuthContext,
  GatewayResponse,
  GatewayRequestOptions,
  GatewayClientStatus,
  EventHandler
} from './ElectronWsGateway.js'
