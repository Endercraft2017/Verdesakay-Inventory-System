import { it, expect } from 'vitest';
import { requireProductionTransport } from '../src/shared/hosting';
it('refuses an unencrypted production fallback and allows TLS proxy or local HTTPS', () => {
  expect(() => requireProductionTransport(false, false, 'production')).toThrow('Production requires HTTPS');
  expect(() => requireProductionTransport(false, true, 'production')).not.toThrow();
  expect(() => requireProductionTransport(true, false, 'production')).not.toThrow();
  expect(() => requireProductionTransport(false, false, 'development')).not.toThrow();
});
