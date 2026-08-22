import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { collectLocalNetworkAddresses } from '../local-network-addresses'

function address(
  value: string,
  options: { internal?: boolean } = {},
): NetworkInterfaceInfo {
  return {
    address: value,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${value}/24`,
    ...options,
  }
}

describe('collectLocalNetworkAddresses', () => {
  it('returns reachable IPv4 candidates with physical interfaces first', () => {
    expect(
      collectLocalNetworkAddresses({
        lo0: [address('127.0.0.1', { internal: true })],
        docker0: [address('172.17.0.1')],
        en0: [address('192.168.1.20')],
        utun5: [address('10.8.0.2')],
      }),
    ).toEqual([
      { interfaceName: 'en0', address: '192.168.1.20' },
      { interfaceName: 'utun5', address: '10.8.0.2' },
      { interfaceName: 'docker0', address: '172.17.0.1' },
    ])
  })

  it('filters loopback, link-local, multicast, and IPv6 addresses', () => {
    expect(
      collectLocalNetworkAddresses({
        en0: [
          address('169.254.1.2'),
          address('224.0.0.1'),
          {
            address: 'fe80::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
        ],
      }),
    ).toEqual([])
  })

  it('deduplicates the same address reported by multiple interfaces', () => {
    expect(
      collectLocalNetworkAddresses({
        en0: [address('192.168.1.20')],
        bridge0: [address('192.168.1.20')],
      }),
    ).toEqual([{ interfaceName: 'en0', address: '192.168.1.20' }])
  })
})
