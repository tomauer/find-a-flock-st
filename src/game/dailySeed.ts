// Deterministic daily puzzle selection. Every player on a given UTC date gets the
// same species, and no species repeats until the whole pool has been used.

/** cyrb53 string hash (public-domain, fast, well-distributed) -> 53-bit int. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Mulberry32 PRNG seeded from a 32-bit int -> deterministic float stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UTC date string "YYYY-MM-DD" for a given Date (defaults to now). */
export function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days since the Unix epoch in UTC — used as the permutation cycle index. */
export function epochDay(dateKey: string): number {
  return Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000);
}

/**
 * Fisher–Yates shuffle of [0..n) driven by a seeded PRNG. A fixed `epoch` seed
 * yields one canonical ordering; the day index then walks that ordering so the
 * sequence only repeats after all n species have appeared.
 */
export function seededPermutation(n: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pick the daily species index into a pool of size `poolSize`.
 * The pool is shuffled once per cycle; a new cycle reshuffles with a fresh seed
 * so ordering differs across cycles but stays deterministic per date.
 */
export function dailyIndex(poolSize: number, dateKey: string = utcDateKey()): number {
  if (poolSize <= 0) return 0;
  const day = epochDay(dateKey);
  const cycle = Math.floor(day / poolSize);
  const offset = ((day % poolSize) + poolSize) % poolSize;
  const perm = seededPermutation(poolSize, cyrb53('fafst-cycle', cycle));
  return perm[offset];
}

/** Day-of-year [0,365] in UTC for an ISO "YYYY-MM-DD" date. */
function dayOfYear(iso: string): number {
  const d = new Date(iso + 'T00:00:00Z');
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000);
}

/**
 * Index of the S&T week whose date is seasonally closest to `dateKey`, so the
 * puzzle uses the current calendar week's ranges regardless of the data year.
 * Comparison is circular on day-of-year (Dec 31 is adjacent to Jan 1).
 */
export function currentWeekIndex(dateKey: string, weekDates: string[]): number {
  if (weekDates.length === 0) return 0;
  const today = dayOfYear(dateKey);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < weekDates.length; i++) {
    const diff = Math.abs(dayOfYear(weekDates[i]) - today);
    const dist = Math.min(diff, 366 - diff); // wrap around the year
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Deterministic daily puzzle pick from a week's pool. */
export function pickPuzzle<T>(pool: T[], dateKey: string = utcDateKey()): T | null {
  if (pool.length === 0) return null;
  return pool[dailyIndex(pool.length, dateKey)];
}

/** "Jan 4" style label from an ISO date string (UTC). */
export function shortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
