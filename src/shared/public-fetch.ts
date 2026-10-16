/** Fetch untrusted public URLs without permitting DNS rebinding or internal-network access.
 * Resolve once per hop and pin the validated address into the connection's lookup.
 * TLS still verifies the original hostname. Redirects are handled by the caller.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';

const blocked = new net.BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2001::', 23], ['2002::', 16], ['64:ff9b::', 96], ['64:ff9b:1::', 48]] as const) {
  blocked.addSubnet(ip, prefix, 'ipv6');
}
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (!family) return false;
  // IPv6 global unicast only; exclude transition/translation ranges and mapped literals.
  if (family === 6 && !/^[23][0-9a-f]{3}:/i.test(ip)) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export async function fetchPublicResource(url: URL, maxBytes: number, timeoutMs: number, init: RequestInit = {}, contentType = 'text/html'): Promise<Response | null> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let dispatcher: Agent | undefined;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]);
  try {
    const family = net.isIP(host);
    const addresses = family ? [{ address: host, family }] : await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ]);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return null;
    const chosen = addresses[0]!;
    dispatcher = new Agent({ connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: chosen.address, family: chosen.family }]);
        else callback(null, chosen.address, chosen.family);
      },
    } });
    const response = await fetch(url, {
      ...init, dispatcher, redirect: 'manual', signal,
      headers: init.headers || { 'User-Agent': 'VerdesakayLinkPreview/1.0' },
    } as RequestInit & { dispatcher: Agent });
    if (!response.ok || !(response.headers.get('content-type') || '').includes(contentType)) {
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    // Headers describe a fetched/decompressed body: do not forward wire framing.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding'); headers.delete('content-length');
    return new Response(Buffer.concat(chunks), { status: response.status, headers });
  } catch { return null; }
  finally { if (dispatcher) await dispatcher.close().catch(() => {}); }
}

export function fetchPublicPage(url: URL, maxBytes: number, timeoutMs: number): Promise<Response | null> {
  return fetchPublicResource(url, maxBytes, timeoutMs);
}
