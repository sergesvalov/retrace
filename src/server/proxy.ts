/**
 * Working behind haproxy on 192.168.0.230: the site is open to the internet at
 * http://31.216.75.169:8252/retrace/ and to the home network directly at :8089.
 */

/**
 * Fastify's trustProxy from TRUST_PROXY: empty / `0` — no proxy, `1` — trust every hop,
 * otherwise the proxy's addresses or networks, comma-separated (`192.168.0.230`). With the
 * addresses, X-Forwarded-For is read right to left up to the first untrusted hop, so the address
 * haproxy appended wins over whatever the client sent itself.
 */
export function trustProxyFromEnv(value: string | undefined): boolean | string {
  const v = value?.trim() ?? '';
  if (v === '' || v === '0') return false;
  if (v === '1') return true;
  return v;
}

/**
 * Path of the session cookie. Behind haproxy the site sits under a prefix (haproxy sends
 * X-Forwarded-Prefix: /retrace): the cookie stays there and does not go to the other sites on the
 * same external address. A malformed prefix is ignored (it goes into the Set-Cookie header).
 */
export function cookiePath(prefix: string | string[] | undefined): string {
  return typeof prefix === 'string' && /^(\/[\w-]+)+$/.test(prefix) ? `${prefix}/` : '/';
}
