/** Guide content sanity (public/js/guide-data.js): every pipeline is well-formed and
    every step that points at an in-app screen names a real registered route.

    Both files are browser classic scripts with a CommonJS export guard (same trick
    as tests/frontend-nav.test.ts) — load them into a tiny sandbox via `new Function`
    and read the CommonJS export, no transpile needed. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type StepTo = { route?: string; filter?: Record<string, string>; label?: string; external?: string };
type Step = { title: string; role?: string; body: string; tip?: string; to?: StepTo; spot?: string };
type Pipeline = { id: string; title: string; icon: string; tagline: string; steps: Step[]; gotchas: string[] };

function loadClassic<T>(rel: string): T {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports as T;
}

const { GUIDE, GUIDE_PIPELINES, GUIDE_ROUTE_MAP } = loadClassic<{
  GUIDE: { byId: Record<string, Pipeline>; routeMap: Record<string, string>; forRoute(r: string, filter?: Record<string, string>): Pipeline | null };
  GUIDE_PIPELINES: Pipeline[];
  GUIDE_ROUTE_MAP: Record<string, string>;
}>('public/js/guide-data.js');

const { ROUTE_NAMES } = loadClassic<{ ROUTE_NAMES: string[] }>('public/js/nav-config.js');

describe('guide-data: pipelines', () => {
  it('has pipelines with unique ids', () => {
    expect(GUIDE_PIPELINES.length).toBeGreaterThan(3);
    const ids = GUIDE_PIPELINES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every pipeline is well-formed', () => {
    for (const p of GUIDE_PIPELINES) {
      expect(p.id, 'pipeline needs an id').toBeTruthy();
      expect(p.title, `${p.id} needs a title`).toBeTruthy();
      expect(p.icon, `${p.id} needs an icon`).toBeTruthy();
      expect(p.tagline, `${p.id} needs a tagline`).toBeTruthy();
      expect(p.steps.length, `${p.id} needs steps`).toBeGreaterThan(0);
      expect(Array.isArray(p.gotchas), `${p.id}.gotchas must be an array`).toBe(true);
    }
  });

  it('every step is well-formed and screen links resolve to a registered route', () => {
    for (const p of GUIDE_PIPELINES) {
      for (const s of p.steps) {
        expect(s.title, `${p.id}: step needs a title`).toBeTruthy();
        expect(s.body, `${p.id} / "${s.title}": step needs a body`).toBeTruthy();
        if (!s.to) continue;
        if (s.to.route) {
          expect(
            ROUTE_NAMES,
            `${p.id} / "${s.title}" -> unknown route "${s.to.route}"`,
          ).toContain(s.to.route);
          expect(s.to.label, `${p.id} / "${s.title}": a screen link needs a label`).toBeTruthy();
        } else {
          expect(
            typeof s.to.external,
            `${p.id} / "${s.title}": a step's "to" must have a route or an external label`,
          ).toBe('string');
        }
      }
    }
  });
});

describe('guide-data: route map', () => {
  it('maps only real routes to real pipeline ids', () => {
    const pipelineIds = new Set(GUIDE_PIPELINES.map((p) => p.id));
    for (const [route, pid] of Object.entries(GUIDE_ROUTE_MAP)) {
      expect(ROUTE_NAMES, `routeMap key "${route}" is not a registered route`).toContain(route);
      expect(pipelineIds, `routeMap["${route}"] -> unknown pipeline "${pid}"`).toContain(pid);
    }
  });

  it('GUIDE.forRoute resolves a mapped route and shrugs at an unmapped one', () => {
    expect(GUIDE.forRoute('job-orders')?.id).toBe('production');
    expect(GUIDE.forRoute('hr-timekeeping')?.id).toBe('payroll');
    expect(GUIDE.forRoute('production-overview')?.id).toBe('production');
    expect(GUIDE.forRoute('orders', { type: 'purchase' })?.id).toBe('purchasing');
    expect(GUIDE.forRoute('orders', { type: 'job' })).toBeNull();
    expect(GUIDE.forRoute('form-records', { slug: 'hr_payroll' })?.id).toBe('payroll');
    expect(GUIDE.forRoute('definitely-not-a-route')).toBeNull();
  });
});
