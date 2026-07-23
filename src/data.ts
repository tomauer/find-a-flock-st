// Static data loading: the manifest index and per-week puzzle files.
// All paths are BASE_URL-relative so it works under a GitHub Pages subpath.

import type { Manifest, WeekData } from './types';

const BASE = import.meta.env.BASE_URL;

export function dataUrl(path: string): string {
  return `${BASE}data/${path}`;
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(dataUrl('manifest.json'));
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  return res.json();
}

/** Load one week's species ranges + puzzle pool (weeks/<NN>.json). */
export async function loadWeek(weekIdx: number): Promise<WeekData> {
  const nn = String(weekIdx).padStart(2, '0');
  const res = await fetch(dataUrl(`weeks/${nn}.json`));
  if (!res.ok) throw new Error(`week ${nn} ${res.status}`);
  return res.json();
}
