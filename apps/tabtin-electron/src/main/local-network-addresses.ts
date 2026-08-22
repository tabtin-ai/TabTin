// 本模块依赖 node:os / node:net，只能由 main 进程加载。
// 不要从 sandbox preload（src/preload/index.ts）导入：主窗口
// webPreferences.sandbox=true，preload 加载这些 Node 内建模块会直接失败。
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { LocalNetworkAddress } from '../shared/types/local-network'

type NetworkInterfaces = ReturnType<typeof networkInterfaces>

const VIRTUAL_INTERFACE_PATTERN =
  /(?:docker|veth|bridge|vmnet|virtualbox|hyper-v)/i
const PHYSICAL_INTERFACE_PATTERN = /(?:^en\d+$|ethernet|wi-?fi|wlan|^eth\d+$)/i

function isUsableIPv4(address: string): boolean {
  if (!isIPv4(address)) return false
  if (address.startsWith('127.') || address.startsWith('169.254.')) return false
  const firstOctet = Number(address.split('.')[0])
  return firstOctet > 0 && firstOctet < 224
}

function interfacePriority(interfaceName: string): number {
  if (PHYSICAL_INTERFACE_PATTERN.test(interfaceName)) return 0
  if (VIRTUAL_INTERFACE_PATTERN.test(interfaceName)) return 2
  return 1
}

function compareNetworkAddresses(
  left: LocalNetworkAddress,
  right: LocalNetworkAddress,
): number {
  return (
    interfacePriority(left.interfaceName) -
      interfacePriority(right.interfaceName) ||
    left.interfaceName.localeCompare(right.interfaceName) ||
    left.address.localeCompare(right.address)
  )
}

export function collectLocalNetworkAddresses(
  interfaces: NetworkInterfaces = networkInterfaces(),
): LocalNetworkAddress[] {
  const addresses = Object.entries(interfaces).flatMap(
    ([interfaceName, entries]) =>
      (entries ?? [])
        .filter(
          (entry) =>
            !entry.internal &&
            entry.family === 'IPv4' &&
            isUsableIPv4(entry.address),
        )
        .map((entry) => ({ interfaceName, address: entry.address })),
  )

  const seen = new Set<string>()
  return addresses.sort(compareNetworkAddresses).filter((entry) => {
    if (seen.has(entry.address)) return false
    seen.add(entry.address)
    return true
  })
}
