import { describe, expect, it } from 'vitest';
import { effectiveClientIp, isLocalPeer, LOOPBACK_ADDRESSES } from '../src/server/clientAddress.js';

describe('isLocalPeer', () => {
  it('accepts loopback addresses in every form', () => {
    expect(isLocalPeer('127.0.0.1')).toBe(true);
    expect(isLocalPeer('::1')).toBe(true);
    expect(isLocalPeer('::ffff:127.0.0.1')).toBe(true);
  });

  it('accepts private-network peers where a reverse proxy can sit', () => {
    expect(isLocalPeer('10.20.30.40')).toBe(true);
    expect(isLocalPeer('172.16.0.1')).toBe(true);
    expect(isLocalPeer('172.31.255.255')).toBe(true);
    expect(isLocalPeer('192.168.1.1')).toBe(true);
    expect(isLocalPeer('169.254.10.10')).toBe(true);
    expect(isLocalPeer('fd00::1')).toBe(true);
    expect(isLocalPeer('fe80::1')).toBe(true);
    expect(isLocalPeer('::ffff:10.0.0.1')).toBe(true);
  });

  it('rejects remote peers', () => {
    expect(isLocalPeer('8.8.8.8')).toBe(false);
    expect(isLocalPeer('203.0.113.7')).toBe(false);
    expect(isLocalPeer('172.32.0.1')).toBe(false); // Just outside 172.16/12.
    expect(isLocalPeer('11.0.0.1')).toBe(false); // Just outside 10/8.
    expect(isLocalPeer('2001:db8::1')).toBe(false);
    expect(isLocalPeer(undefined)).toBe(false);
  });
});

describe('effectiveClientIp', () => {
  it('keys on the socket address when no proxy is trusted', () => {
    expect(effectiveClientIp(0, '8.8.8.8', '1.2.3.4')).toBe('8.8.8.8');
  });

  it('uses the proxied address only when the trusted proxy is the direct peer', () => {
    expect(effectiveClientIp(1, '127.0.0.1', '1.2.3.4')).toBe('1.2.3.4');
    expect(effectiveClientIp(1, '10.0.0.5', '1.2.3.4')).toBe('1.2.3.4');
  });

  it('ignores a forged X-Forwarded-For from a remote client that connects directly', () => {
    // The direct peer is a public address: no trusted proxy can be in front of it.
    expect(effectiveClientIp(1, '203.0.113.7', '1.2.3.4')).toBe('203.0.113.7');
  });

  it('falls back to unknown when nothing is known', () => {
    expect(effectiveClientIp(0, undefined, undefined)).toBe('unknown');
    expect(effectiveClientIp(1, '8.8.8.8', '1.2.3.4')).toBe('8.8.8.8');
  });
});

describe('LOOPBACK_ADDRESSES', () => {
  it('contains the addresses the admin routes test against', () => {
    expect(LOOPBACK_ADDRESSES.has('127.0.0.1')).toBe(true);
    expect(LOOPBACK_ADDRESSES.has('::1')).toBe(true);
    expect(LOOPBACK_ADDRESSES.has('::ffff:127.0.0.1')).toBe(true);
  });
});
