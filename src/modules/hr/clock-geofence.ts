/**
 * Office location lock for phone time-in. The rotating kiosk QR (clock.ts) proves someone saw the
 * office screen within the last ~2 minutes, but on a cloud deployment a photo of it forwarded in a
 * chat works from anywhere. With the lock on, a phone punch must ALSO come from within one of the
 * company's office sites (the phone's GPS position vs a radius).
 *
 * Per company = per tenant DB: the policy lives in the `clock_geofence` setting. Per employee,
 * `employees.clock_anywhere` exempts field staff: they may punch from anywhere WITHOUT the QR
 * (they can't see it), but must still send their location, which is stored on the punch.
 *
 * This raises the bar, it isn't proof: a browser can't detect a spoofed (mock) GPS location.
 * Every phone punch keeps its position, accuracy and distance so HR can review odd ones.
 */
import { getSetting, setSetting } from '../../shared/db';

export interface GeofenceSite { name: string; lat: number; lng: number; radius_m: number }

export interface GeofencePolicy {
  /** Off ⇒ phone punches work as before (QR only). */
  enabled: boolean;
  sites: GeofenceSite[];
  /** A position less precise than this (±metres) is refused rather than trusted. */
  max_accuracy_m: number;
}

export interface PunchLocation { lat: number; lng: number; accuracy_m: number }

/** What gets stored on the punch (time_punches.lat/lng/accuracy_m/distance_m/geo_site). */
export interface PunchGeo extends PunchLocation { distance_m: number | null; site: string | null }

export const DEFAULT_GEOFENCE: GeofencePolicy = { enabled: false, sites: [], max_accuracy_m: 100 };

export function getGeofence(): GeofencePolicy {
  return { ...DEFAULT_GEOFENCE, ...(getSetting<Partial<GeofencePolicy>>('clock_geofence') || {}) };
}

export function setGeofence(p: GeofencePolicy): GeofencePolicy {
  setSetting('clock_geofence', p);
  return getGeofence();
}

/** True when phone punches must come from an office site. An enabled policy with no sites is
 *  treated as off (nothing to check against) — the settings screen refuses to save that. */
export function geofenceActive(p: GeofencePolicy = getGeofence()): boolean {
  return p.enabled && p.sites.length > 0;
}

/** Great-circle distance in metres (haversine). */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest site to a position, or null when there are none. */
export function nearestSite(loc: { lat: number; lng: number }, sites: GeofenceSite[]): { site: GeofenceSite; distance_m: number } | null {
  let best: { site: GeofenceSite; distance_m: number } | null = null;
  for (const s of sites) {
    const d = distanceM(loc.lat, loc.lng, s.lat, s.lng);
    if (!best || d < best.distance_m) best = { site: s, distance_m: d };
  }
  return best;
}

export class GeofenceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GeofenceError';
  }
}

/**
 * Decide a phone punch. `exempt` = employees.clock_anywhere. `hasCode` = a valid kiosk QR was sent.
 * Returns what to store on the punch, or throws GeofenceError with a message for the employee.
 *  - exempt, no code: location required (any place) — the remote punch's only evidence.
 *  - QR punch, lock active and not exempt: location required, must be inside a site's radius.
 *  - otherwise: location optional, stored when sent.
 */
export function checkPunchLocation(opts: { exempt: boolean; hasCode: boolean; location: PunchLocation | null }): PunchGeo | null {
  const policy = getGeofence();
  const mustBeOnSite = opts.hasCode && !opts.exempt && geofenceActive(policy);
  const needLocation = mustBeOnSite || (opts.exempt && !opts.hasCode);
  const loc = opts.location;

  if (!loc) {
    if (!needLocation) return null;
    throw new GeofenceError(
      mustBeOnSite
        ? 'Turn on location for this app — time-in is only allowed at the office.'
        : 'Turn on location for this app — a time-in outside the office records where you are.',
      400
    );
  }
  if (needLocation && loc.accuracy_m > policy.max_accuracy_m) {
    throw new GeofenceError(
      `Your location is too imprecise (±${Math.round(loc.accuracy_m)} m). Turn on precise location, step near a window or outside, and try again.`,
      400
    );
  }
  const near = policy.sites.length ? nearestSite(loc, policy.sites) : null;
  const geo: PunchGeo = {
    ...loc,
    distance_m: near ? Math.round(near.distance_m) : null,
    site: near && near.distance_m <= near.site.radius_m ? near.site.name : null,
  };
  if (mustBeOnSite && !geo.site) {
    throw new GeofenceError(
      `You're about ${formatDistance(near!.distance_m)} from ${near!.site.name}. Time-in is only allowed at the office.`,
      403
    );
  }
  return geo;
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
