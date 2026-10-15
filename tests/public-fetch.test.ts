import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'node:dns/promises';
import { isPublicAddress, fetchPublicPage } from '../src/shared/public-fetch';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('public URL fetch boundary', () => {
  it('blocks IPv4, IPv6, mapped IPv6, metadata, and reserved ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.31.0.1', '192.168.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1']) expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects mixed public/private DNS answers without a connection', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    expect(await fetchPublicPage(new URL('https://mixed.example'), 1024, 1000)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('resolves once and supplies a pinned dispatcher with manual redirects', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    const request = vi.fn().mockResolvedValue(new Response('<title>ok</title>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', request);
    const response = await fetchPublicPage(new URL('https://public.example'), 1024, 1000);
    expect(await response?.text()).toContain('ok');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ dispatcher: expect.anything(), redirect: 'manual', signal: expect.any(AbortSignal) });
  });
  it('rejects oversized response bodies and URL credentials', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    const request = vi.fn().mockResolvedValue(new Response('x'.repeat(2048), { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', request);
    expect(await fetchPublicPage(new URL('https://public.example'), 1024, 1000)).toBeNull();
    expect(await fetchPublicPage(new URL('https://user:pass@public.example'), 1024, 1000)).toBeNull();
  });
});
