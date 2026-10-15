/** Optional path tenancy on one explicit host. Subdomain/self-hosted routing is unchanged. */
import { isValidSlug } from './platform';

const SHARED_PATHS = new Set(['api', 'ws', 'm', 'mobile', 'js', 'css', 'images', 'icons', 'fonts', 'vendor', 'policies', '_platform']);

export function tenantPath(host: string | undefined, url: string): { slug: string; base: string; url: string } | null {
  const configured = (process.env.TENANT_PATH_HOST || '').toLowerCase().trim();
  if (!configured || String(host || '').toLowerCase().split(':')[0] !== configured) return null;
  const first = url.split('?')[0]!.split('/')[1] || '';
  if (!first || SHARED_PATHS.has(first) || first.includes('.')) return null;
  if (!isValidSlug(first)) return null;
  const base = `/${first}`;
  const rest = url.slice(base.length);
  return { slug: first, base, url: !rest ? '/' : rest.startsWith('?') ? `/${rest}` : rest };
}

export function onTenantPathHost(host: string | undefined): boolean {
  const configured = (process.env.TENANT_PATH_HOST || '').toLowerCase().trim();
  return !!configured && String(host || '').toLowerCase().split(':')[0] === configured;
}
