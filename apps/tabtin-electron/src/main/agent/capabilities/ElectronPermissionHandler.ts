import { LocalPermissionHandler } from '@tabtin/agent-runtime'
import type { LocalPermissionHandlerOptions } from '@tabtin/agent-runtime'
import { createLogger } from '../../logger.js'

const log = createLogger('PermissionHandler')

export type ElectronPermissionHandlerOptions = Omit<LocalPermissionHandlerOptions, 'onLog'>

export class ElectronPermissionHandler extends LocalPermissionHandler {
  constructor(options: ElectronPermissionHandlerOptions = {}) {
    super({
      ...options,
      onLog: (level, message) => {
        if (level === 'warn') log.warn(message)
        else log.info(message)
      },
    })
  }
}
