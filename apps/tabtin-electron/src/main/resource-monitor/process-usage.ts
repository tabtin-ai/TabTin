import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '../logger'

const log = createLogger('ProcessUsage')
const execFileAsync = promisify(execFile)
const PROCESS_LIST_TIMEOUT_MS = 5000

export interface ProcessUsageEntry {
  pid: number
  ppid: number
  cpu: number
  memory: number
  command: string
}

const normalizeFiniteNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function parsePsLine(line: string): ProcessUsageEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const parts = trimmed.split(/\s+/, 5)
  if (parts.length < 5) return null

  const pid = Number.parseInt(parts[0] ?? '', 10)
  const ppid = Number.parseInt(parts[1] ?? '', 10)
  const cpu = Number.parseFloat(parts[2] ?? '')
  const rssKb = Number.parseInt(parts[3] ?? '', 10)
  const command = parts[4] ?? ''

  if (!Number.isFinite(pid) || pid <= 0) return null
  if (!Number.isFinite(ppid) || ppid < 0) return null

  return {
    pid,
    ppid,
    cpu: normalizeFiniteNumber(cpu),
    memory: normalizeFiniteNumber(rssKb) * 1024,
    command,
  }
}

async function collectUnixProcessTable(): Promise<Map<number, ProcessUsageEntry>> {
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,%cpu=,rss=,comm='],
    { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  )

  const processMap = new Map<number, ProcessUsageEntry>()
  stdout
    .split('\n')
    .map(parsePsLine)
    .forEach((entry) => {
      if (!entry) return
      processMap.set(entry.pid, entry)
    })
  return processMap
}

function parsePowerShellCsvLine(line: string): ProcessUsageEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // CSV format: "ProcessId","ParentProcessId","WorkingSetSize","Name"
  const fields = trimmed.split(',').map(f => f.replace(/^"|"$/g, '').trim())
  if (fields.length < 4) return null

  const pid = Number.parseInt(fields[0] ?? '', 10)
  const ppid = Number.parseInt(fields[1] ?? '', 10)
  const workingSetBytes = Number.parseInt(fields[2] ?? '', 10)
  const command = fields[3] ?? ''

  if (!Number.isFinite(pid) || pid <= 0) return null
  if (!Number.isFinite(ppid) || ppid < 0) return null

  return {
    pid,
    ppid,
    // Win32_Process 无法直接提供 CPU%，需要两次采样求差值，暂置 0。
    // 后续可通过 Win32_PerfFormattedData_PerfProc_Process 的
    // PercentProcessorTime 实现精确采集。
    cpu: 0,
    memory: normalizeFiniteNumber(workingSetBytes),
    command,
  }
}

function parseWmicCsvLine(line: string): ProcessUsageEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // wmic CSV format: Node,Name,ParentProcessId,PercentProcessorTime,ProcessId,WorkingSetSize
  const fields = trimmed.split(',')
  if (fields.length < 6) return null

  const name = fields[1] ?? ''
  const ppid = Number.parseInt(fields[2] ?? '', 10)
  const cpu = Number.parseFloat(fields[3] ?? '')
  const pid = Number.parseInt(fields[4] ?? '', 10)
  const workingSetBytes = Number.parseInt(fields[5] ?? '', 10)

  if (!Number.isFinite(pid) || pid <= 0) return null
  if (!Number.isFinite(ppid) || ppid < 0) return null

  return {
    pid,
    ppid,
    // wmic PercentProcessorTime 是进程生命周期内的累计值，并非瞬时 CPU%，
    // 仅作参考。精确值需两次采样求差值。
    cpu: normalizeFiniteNumber(cpu),
    memory: normalizeFiniteNumber(workingSetBytes),
    command: name,
  }
}

async function collectWindowsProcessTable(): Promise<Map<number, ProcessUsageEntry>> {
  // windowsHide: GUI 进程 spawn 控制台程序会新建可见控制台窗口
  const execOpts = { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }

  // 优先 PowerShell (Get-CimInstance)，wmic 在较新 Windows 版本已弃用
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NoLogo',
        '-OutputFormat',
        'Text',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Csv -NoTypeInformation',
      ],
      execOpts,
    )

    const processMap = new Map<number, ProcessUsageEntry>()
    const lines = stdout.split(/\r?\n/)
    // 第一行是 CSV header，跳过
    for (let i = 1; i < lines.length; i++) {
      const entry = parsePowerShellCsvLine(lines[i]!)
      if (entry) processMap.set(entry.pid, entry)
    }
    if (processMap.size > 0) return processMap
  } catch (err: any) {
    // PowerShell 不可用，回退到 wmic（属预期降级，debug 记一条便于排查“进程占用为 0”）
    log.debug('PowerShell 进程表采集失败，回退 wmic', { name: err?.name })
  }

  // 回退方案：wmic（Windows 10 较旧版本仍可用）
  const { stdout } = await execFileAsync(
    'wmic',
    ['process', 'get', 'Name,ParentProcessId,PercentProcessorTime,ProcessId,WorkingSetSize', '/format:csv'],
    execOpts,
  )

  const processMap = new Map<number, ProcessUsageEntry>()
  const lines = stdout.split(/\r?\n/)
  // wmic CSV 第一行/第二行可能是空行或 header
  for (const line of lines) {
    if (/^Node,/i.test(line.trim()) || !line.trim()) continue
    const entry = parseWmicCsvLine(line)
    if (entry) processMap.set(entry.pid, entry)
  }
  return processMap
}

export async function collectProcessUsageTable(): Promise<Map<number, ProcessUsageEntry>> {
  const platform = os.platform()

  if (platform === 'win32') {
    try {
      return await collectWindowsProcessTable()
    } catch (err: any) {
      // 采集彻底失败 → 返回空表（调用方按“无数据”降级）。周期轮询，debug 即可。
      log.debug('Windows 进程表采集失败', { name: err?.name })
      return new Map()
    }
  }

  if (platform !== 'darwin' && platform !== 'linux') {
    return new Map()
  }

  try {
    return await collectUnixProcessTable()
  } catch (err: any) {
    log.debug('Unix 进程表采集失败', { name: err?.name })
    return new Map()
  }
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

  while (queue.length > 0) {
    const pid = queue.shift()
    if (!pid || visited.has(pid)) continue
    visited.add(pid)
    pids.push(pid)
    cpu += cpuByPid.get(pid) ?? 0
    memory += memoryByPid.get(pid) ?? 0

    const children = childrenByParent.get(pid)
    if (children) {
      children.forEach(childPid => {
        if (!visited.has(childPid)) queue.push(childPid)
      })
    }
  }

  return {
    cpu: normalizeFiniteNumber(cpu),
    memory: normalizeFiniteNumber(memory),
    pids,
  }
}

