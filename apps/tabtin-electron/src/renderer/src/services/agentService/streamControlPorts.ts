/** 主进程 stream control 帧的 store 侧执行端口。 */
export interface StreamControlPorts {
  handleSeqGapControl: (sessionId: string) => void
}

class StreamControlPortsRegistry {
  private ports: StreamControlPorts | null = null

  register(ports: StreamControlPorts): void {
    this.ports = ports
  }

  get(): StreamControlPorts | null {
    return this.ports
  }

  resetForTest(): void {
    this.ports = null
  }
}

export const streamControlPorts = new StreamControlPortsRegistry()
