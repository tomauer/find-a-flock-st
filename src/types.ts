// Shared types mirroring the pipeline output (scripts/build_puzzles.py).

export type LngLat = [lng: number, lat: number];
export type BBox = [west: number, south: number, east: number, north: number];

// Minimal GeoJSON geometry (only what the pipeline emits: Polygon / MultiPolygon).
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: number[][][]; // rings -> points -> [lng, lat]
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: number[][][][]; // polygons -> rings -> points -> [lng, lat]
}
export type Geometry = PolygonGeometry | MultiPolygonGeometry;

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** Species index entry in manifest.json (metadata only). */
export interface SpeciesEntry {
  code: string;
  commonName: string;
  taxonOrder: number;
  bowLink: string;
}

export interface Manifest {
  game: 'locate';
  generated: string | null;
  h3res: number;
  weeks: number;
  /** ISO date of each S&T week (length = weeks); drives current-week selection. */
  weekDates: string[];
  difficulties: Difficulty[];
  /** Minimum S&T model quality (0–3) a species needs to appear in a puzzle. */
  minQuality: number;
  count: number;
  species: SpeciesEntry[];
}

/** A species referenced by a week's puzzles (public/data/weeks/<NN>.json). */
export interface WeekSpecies {
  name: string;
  taxonOrder: number;
  bowLink: string;
}

/** The true overlap region a puzzle's 5 ranges pin down. */
export interface PuzzleAnswer {
  poly: Geometry;
  center: LngLat;
  cells: number;
}

export interface PuzzleDef {
  id: string;
  difficulty: Difficulty;
  species: string[]; // 5 species codes, keys into WeekData.species
  answer: PuzzleAnswer;
}

export interface WeekData {
  week: number;
  date: string;
  h3res: number;
  /** Species modeled in US/CA, present this week, passing the quality gate. */
  speciesAvailable: number;
  species: Record<string, WeekSpecies>;
  puzzles: PuzzleDef[];
}
