/**
 * Keep a request's async context across a middleware that may lose it.
 *
 * The workspace (tenantStore) and the sync context (syncStore) live in AsyncLocalStorage. multer's
 * memory storage finishes inside the request stream's own events, which run outside the request's
 * async context, so whatever runs after it — the route handler — fell back to the default
 * workspace. Wrapping such a middleware re-enters the request's contexts before continuing.
 */
import type { RequestHandler } from 'express';
import { tenantStore } from './db';
import { syncStore } from './sync-context';

export function keepRequestContext(mw: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const tenant = tenantStore.getStore();
    const sync = syncStore.getStore();
    mw(req, res, (err?: unknown) => {
      const go = () => next(err);
      const withSync = sync ? () => syncStore.run(sync, go) : go;
      if (tenant) tenantStore.run(tenant, withSync);
      else withSync();
    });
  };
}
