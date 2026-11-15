/** Loopback addresses as reported by `socket.remoteAddress` (the IPv4-mapped form included). */
export const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True when `address` is this machine or a private network: the only peers a *trusted* reverse
 * proxy can connect from. A remote client that connects directly (no proxy in between) must never
 * be mistaken for that proxy, or `X-Forwarded-For` and `X-Forwarded-Proto` could be forged —
 * rotating rate-limit buckets and, worse, sending the admin key in cleartext past the HTTPS guard.
 */
export function isLocalPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (LOOPBACK_ADDRESSES.has(address)) return true;
  const normalized = address.replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
    const [a, b] = normalized.split('.').map(Number);
    return (
      a === 10 || // 10.0.0.0/8
      a === 127 || // 127.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) // 169.254.0.0/16 link-local
    );
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd]/.test(normalized) || normalized.startsWith('fe80');
}

/**
 * The client address a request is attributed to. `proxiedIp` (Express' `req.ip`) is only
 * trustworthy when the operator declared a known number of trusted proxy hops *and* the direct
 * peer of the socket really is local — otherwise a client could forge `X-Forwarded-For` and
 * rotate its rate-limit key at will. Falls back to the socket address.
 */
export function effectiveClientIp(
  trustProxyHops: number,
  socketAddress: string | undefined,
  proxiedIp: string | undefined
): string {
  return trustProxyHops > 0 && isLocalPeer(socketAddress) ? (proxiedIp ?? 'unknown') : (socketAddress ?? 'unknown');
}
