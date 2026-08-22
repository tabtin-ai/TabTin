import { describe, it, expect } from 'vitest';
import {
  isPrivateIPv4,
  parseAlternativeIPv4,
  isPrivateHost,
} from '../private-host';

// ---------------------------------------------------------------------------
// isPrivateIPv4
// ---------------------------------------------------------------------------
describe('isPrivateIPv4', () => {
  describe('private ranges → true', () => {
    it.each([
      ['0.0.0.0', '0.0.0.0/8 (current network)'],
      ['0.255.255.255', '0.0.0.0/8 upper bound'],
      ['127.0.0.1', '127.0.0.0/8 loopback'],
      ['127.255.255.255', '127.0.0.0/8 upper bound'],
      ['10.0.0.1', '10.0.0.0/8 class A'],
      ['10.255.255.255', '10.0.0.0/8 upper bound'],
      ['172.16.0.1', '172.16.0.0/12 lower bound'],
      ['172.31.255.255', '172.16.0.0/12 upper bound'],
      ['192.168.0.1', '192.168.0.0/16'],
      ['192.168.255.255', '192.168.0.0/16 upper bound'],
      ['169.254.0.1', '169.254.0.0/16 link-local'],
      ['169.254.255.255', '169.254.0.0/16 upper bound'],
      ['100.64.0.1', '100.64.0.0/10 CGNAT lower'],
      ['100.127.255.255', '100.64.0.0/10 CGNAT upper'],
      ['198.18.0.1', '198.18.0.0/15 benchmarking'],
      ['198.19.255.255', '198.18.0.0/15 upper bound'],
    ])('%s (%s)', (ip) => {
      expect(isPrivateIPv4(ip)).toBe(true);
    });
  });

  describe('public IPs → false', () => {
    it.each(['8.8.8.8', '1.1.1.1', '198.20.0.1', '100.63.0.1', '172.32.0.1'])(
      '%s',
      (ip) => {
        expect(isPrivateIPv4(ip)).toBe(false);
      },
    );
  });

  describe('non-IP strings → false', () => {
    it.each(['localhost', 'abc', ''])('%j', (input) => {
      expect(isPrivateIPv4(input)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// parseAlternativeIPv4
// ---------------------------------------------------------------------------
describe('parseAlternativeIPv4', () => {
  describe('valid alternative representations', () => {
    it('hex integer 0x7f000001 → 127.0.0.1', () => {
      expect(parseAlternativeIPv4('0x7f000001')).toBe('127.0.0.1');
    });

    it('decimal integer 2130706433 → 127.0.0.1', () => {
      expect(parseAlternativeIPv4('2130706433')).toBe('127.0.0.1');
    });

    it('octal segments 0177.0.0.1 → 127.0.0.1', () => {
      expect(parseAlternativeIPv4('0177.0.0.1')).toBe('127.0.0.1');
    });

    it('mixed hex segment 0x7f.0.0.1 → 127.0.0.1', () => {
      expect(parseAlternativeIPv4('0x7f.0.0.1')).toBe('127.0.0.1');
    });

    it('hex integer boundary 0xffffffff → 255.255.255.255', () => {
      expect(parseAlternativeIPv4('0xffffffff')).toBe('255.255.255.255');
    });

    it('decimal integer 0 → 0.0.0.0', () => {
      expect(parseAlternativeIPv4('0')).toBe('0.0.0.0');
    });
  });

  describe('unrecognised inputs → null', () => {
    it('non-numeric string', () => {
      expect(parseAlternativeIPv4('abc')).toBeNull();
    });

    it('hex integer too large (9 hex digits)', () => {
      expect(parseAlternativeIPv4('0x1ffffffff')).toBeNull();
    });

    it('decimal integer exceeding 2^32-1', () => {
      expect(parseAlternativeIPv4('4294967296')).toBeNull();
    });

    it('five-segment dotted notation', () => {
      expect(parseAlternativeIPv4('1.2.3.4.5')).toBeNull();
    });

    it('empty string', () => {
      expect(parseAlternativeIPv4('')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// isPrivateHost
// ---------------------------------------------------------------------------
describe('isPrivateHost', () => {
  describe('localhost variants', () => {
    it.each(['localhost', 'localhost.localdomain'])('%s → true', (h) => {
      expect(isPrivateHost(h)).toBe(true);
    });
  });

  describe('cloud metadata domains', () => {
    it.each(['metadata.google.internal', 'metadata.internal'])(
      '%s → true',
      (h) => {
        expect(isPrivateHost(h)).toBe(true);
      },
    );
  });

  describe('standard private IPv4', () => {
    it.each(['127.0.0.1', '10.0.0.1', '192.168.1.1'])('%s → true', (h) => {
      expect(isPrivateHost(h)).toBe(true);
    });
  });

  describe('alternative IPv4 representations', () => {
    it.each([
      ['0x7f000001', 'hex integer'],
      ['2130706433', 'decimal integer'],
      ['0177.0.0.1', 'octal segments'],
    ])('%s (%s) → true', (h) => {
      expect(isPrivateHost(h)).toBe(true);
    });
  });

  describe('IPv6 loopback', () => {
    it.each(['::1', '0:0:0:0:0:0:0:1'])('%s → true', (h) => {
      expect(isPrivateHost(h)).toBe(true);
    });
  });

  describe('IPv6 unspecified', () => {
    it.each(['::', '0:0:0:0:0:0:0:0'])('%s → true', (h) => {
      expect(isPrivateHost(h)).toBe(true);
    });
  });

  describe('IPv6 ULA (fc00::/7)', () => {
    it.each(['fc00::1', 'fd12::1'])('%s → true', (h) => {
      expect(isPrivateHost(h)).toBe(true);
    });
  });

  describe('IPv6 link-local (fe80::/10)', () => {
    it('fe80::1 → true', () => {
      expect(isPrivateHost('fe80::1')).toBe(true);
    });
  });

  describe('IPv4-mapped IPv6', () => {
    it('::ffff:127.0.0.1 (dotted) → true', () => {
      expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    });

    it('::ffff:7f00:1 (hex) → true', () => {
      expect(isPrivateHost('::ffff:7f00:1')).toBe(true);
    });
  });

  describe('bracket-wrapped addresses', () => {
    it('[::1] → true', () => {
      expect(isPrivateHost('[::1]')).toBe(true);
    });

    it('[127.0.0.1] → true', () => {
      expect(isPrivateHost('[127.0.0.1]')).toBe(true);
    });
  });

  describe('URL-encoded zone suffix', () => {
    it('127.0.0.1%eth0 → true', () => {
      expect(isPrivateHost('127.0.0.1%eth0')).toBe(true);
    });
  });

  describe('public hosts → false', () => {
    it.each(['google.com', 'example.com', '8.8.8.8'])('%s → false', (h) => {
      expect(isPrivateHost(h)).toBe(false);
    });
  });
});
