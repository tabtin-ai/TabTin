export interface ProcessUsageEntry {
  pid: number
  ppid: number
  cpu: number
  memory: number
  command: string
}

export function collectProcessSubtreeUsage(
  rootPid: number,
  processMap: Map<number, ProcessUsageEntry>,
): {
  cpu: number
  memory: number
  pids: number[]
} {
  if (!Number.isFinite(rootPid) || rootPid <= 0 || processMap.size === 0) {
    return { cpu: 0, memory: 0, pids: [] }
  }

  const childrenByParent = new Map<number, number[]>()
  processMap.forEach((entry) => {
    const siblings = childrenByParent.get(entry.ppid) ?? []
    siblings.push(entry.pid)
    childrenByParent.set(entry.ppid, siblings)
  })

  const cpuByPid = new Map<number, number>()
  const memoryByPid = new Map<number, number>()
  processMap.forEach((entry) => {
    cpuByPid.set(entry.pid, entry.cpu)
    memoryByPid.set(entry.pid, entry.memory)
  })

  const visited = new Set<number>()
  const queue = [rootPid]
  let cpu = 0
  let memory = 0
  const pids: number[] = []

  const normalizeFinite = (v: number): number =>
    Number.isFinite(v) ? Math.max(0, v) : 0

  while (queue.length > 0) {
    const pid = queue.shift()
    if (!pid || visited.has(pid)) continue
    visited.add(pid)
    pids.push(pid)
    cpu += cpuByPid.get(pid) ?? 0
    memory += memoryByPid.get(pid) ?? 0

    const children = childrenByParent.get(pid)
    if (children) {
      children.forEach((childPid) => {
        if (!visited.has(childPid)) queue.push(childPid)
      })
    }
  }

  return {
    cpu: normalizeFinite(cpu),
    memory: normalizeFinite(memory),
    pids,
  }
}
