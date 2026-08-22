export interface CLIInstancePolicy {
  socketName: string
  publishGlobalDiscovery: boolean
}

export function resolveCLIInstancePolicy(options: {
  isDev: boolean
  instanceId?: string
}): CLIInstancePolicy {
  if (!options.isDev) {
    return {
      socketName: 'electron-cli.sock',
      publishGlobalDiscovery: true,
    }
  }

  if (options.instanceId) {
    return {
      socketName: `cli-${options.instanceId}.sock`,
      publishGlobalDiscovery: false,
    }
  }

  return {
    socketName: 'cli.sock',
    publishGlobalDiscovery: true,
  }
}
