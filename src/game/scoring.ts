// Scoring for the location-guessing game: the player clicks where they think the
// 5 species' ranges overlap. A click inside the true overlap region scores 100;
// otherwise the score decays with great-circle distance to the overlap center.

import type { Geometry, LngLat, PuzzleAnswer } from '../types';

const EARTH_KM = 6371;

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray-cast test: is [lng,lat] inside a single ring (array of [lng,lat])? */
function inRing(pt: LngLat, ring: number[][]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Inside a Polygon = inside its outer ring and outside every hole. */
function inPolygon(pt: LngLat, rings: number[][][]): boolean {
  if (rings.length === 0 || !inRing(pt, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (inRing(pt, rings[h])) return false; // in a hole
  }
  return true;
}

/** Point-in-(Multi)Polygon for a GeoJSON geometry. */
export function pointInPolygon(pt: LngLat, geom: Geometry): boolean {
  if (geom.type === 'Polygon') {
    return inPolygon(pt, geom.coordinates);
  }
  return geom.coordinates.some((poly) => inPolygon(pt, poly));
}

export interface LocationResult {
  inside: boolean;
  distanceKm: number; // to the overlap center (0 when inside)
  score: number; // 0..100
  tier: 0 | 1 | 2 | 3 | 4; // for the share grid / feedback color
}

// Distance→score falloff. ~26 km hexes, so credit stays generous for near misses:
// 100 inside, ~78 at 100 km, ~61 at 200 km, ~37 at 400 km, ~14 at 800 km.
const SCALE_KM = 400;

export function scoreLocation(guess: LngLat, answer: PuzzleAnswer): LocationResult {
  const inside = pointInPolygon(guess, answer.poly);
  const distanceKm = inside ? 0 : haversineKm(guess, answer.center);
  const score = inside ? 100 : Math.round(100 * Math.exp(-distanceKm / SCALE_KM));

  let tier: LocationResult['tier'];
  if (score >= 90) tier = 4;
  else if (score >= 65) tier = 3;
  else if (score >= 40) tier = 2;
  else if (score >= 15) tier = 1;
  else tier = 0;

  return { inside, distanceKm, score, tier };
}

const TIER_EMOJI = ['⬛', '🟥', '🟧', '🟨', '🟩'] as const;

export function scoreEmoji(tier: LocationResult['tier']): string {
  return TIER_EMOJI[tier];
}
