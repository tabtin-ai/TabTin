type ActionPayload = Record<string, unknown>
type ActionEnvelope = Record<string, unknown> | undefined
type ActionHandler = (
  payload: ActionPayload,
  envelope?: Record<string, unknown>,
) => Promise<boolean>

export interface DeviceActionRequestHandlers {
  handleRollback: ActionHandler
  handleLoginRelayImport: ActionHandler
  handleMcp: ActionHandler
  handleFile: ActionHandler
}

export async function dispatchDeviceActionRequest(
  payload: ActionPayload,
  envelope: ActionEnvelope,
  handlers: DeviceActionRequestHandlers,
): Promise<void> {
  if (await handlers.handleRollback(payload, envelope)) return
  if (await handlers.handleLoginRelayImport(payload, envelope)) return
  if (await handlers.handleMcp(payload, envelope)) return
  await handlers.handleFile(payload, envelope)
}
