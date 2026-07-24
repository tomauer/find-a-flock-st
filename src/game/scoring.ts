// Scoring for the location-guessing game: the player clicks where they think the
// 5 species' ranges overlap. A click inside the true overlap region scores 100;
// otherwise the score decays with distance to the NEAREST point of the overlap,
// normalized by the overlap's size — so a fixed miss costs more against a tiny
// overlap than a continent-wide one.

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

const DEG2KM_LAT = 110.574; // km per degree latitude
function deg2kmLng(lat: number) {
  return 111.32 * Math.cos((lat * Math.PI) / 180); // km per degree longitude at lat
}

/**
 * Distance (km) from point `p` to segment `a`–`b`, in a local equirectangular
 * plane centered at `p`. Accurate at the ~10²–10³ km scale of these overlaps and
 * cheap for the handful of vertices in a simplified answer polygon.
 */
function pointSegKm(p: LngLat, a: number[], b: number[]): number {
  const kx = deg2kmLng(p[1]);
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * DEG2KM_LAT;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * DEG2KM_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

function ringMinKm(p: LngLat, ring: number[][]): number {
  let min = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = pointSegKm(p, ring[j], ring[i]);
    if (d < min) min = d;
  }
  return min;
}

/** Great-circle distance (km) from a point to the nearest point of a geometry's boundary. */
function distanceToBoundaryKm(pt: LngLat, geom: Geometry): number {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let min = Infinity;
  for (const poly of polys) {
    for (const ring of poly) {
      const d = ringMinKm(pt, ring);
      if (d < min) min = d;
    }
  }
  return min;
}

/** How far the overlap reaches: max distance (km) from its center to any vertex. */
function extentRadiusKm(center: LngLat, geom: Geometry): number {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let max = 0;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const v of ring) {
        const d = haversineKm(center, v as LngLat);
        if (d > max) max = d;
      }
    }
  }
  return max;
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
  distanceKm: number; // to the nearest point of the overlap (0 when inside)
  score: number; // 0..100
  tier: 0 | 1 | 2 | 3 | 4; // for the share grid / feedback color
}

// Equal-area radius of one H3 res-4 cell (√(area/π), area ≈ 1770 km²). The union
// of n cells has area ≈ n·cell-area, so its compact "range radius" ≈ √n · this.
const CELL_RADIUS_KM = 23.74;

// Score falloff in normalized (range-radius) units: score = 100·exp(−norm/SCALE),
// where norm = distanceToOverlap / rangeRadius. So ~100 at the edge, ~61 half a
// range-radius out, ~37 one range-radius out, ~14 two out — the SAME curve in km
// stretches with the overlap, so bigger overlaps forgive bigger misses.
const NORM_SCALE = 1;

export function scoreLocation(guess: LngLat, answer: PuzzleAnswer): LocationResult {
  const inside = pointInPolygon(guess, answer.poly);
  const distanceKm = inside ? 0 : distanceToBoundaryKm(guess, answer.poly);
  // Yardstick = the overlap's own size. Use the LARGER of its compact-area radius
  // (√cells·cell-radius) and its actual reach (center→farthest vertex), so a long
  // thin overlap — a coastal strip, say — isn't scored as if it were a tiny disc.
  const rangeRadiusKm = Math.max(
    1,
    Math.sqrt(answer.cells) * CELL_RADIUS_KM,
    extentRadiusKm(answer.center, answer.poly),
  );
  const norm = distanceKm / rangeRadiusKm;
  const score = inside ? 100 : Math.round(100 * Math.exp(-norm / NORM_SCALE));

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
