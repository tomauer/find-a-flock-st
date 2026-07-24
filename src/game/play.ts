// Persist today's completed puzzle so a page refresh restores the finished state
// (pin + overlap + score) instead of re-opening the puzzle. Keyed per UTC day and
// per difficulty, since each difficulty is a distinct daily puzzle.

import type { LocationResult } from './scoring';
import type { Difficulty, LngLat } from '../types';

const KEY = 'fafst:play:v1';

export interface SavedPlay {
  puzzleId: string;
  guess: LngLat;
  result: LocationResult;
}

interface DayPlays {
  dateKey: string;
  plays: Partial<Record<Difficulty, SavedPlay>>;
}

function read(dateKey: string): DayPlays {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DayPlays;
      // A stored record from a previous day is stale — start today fresh.
      if (parsed && parsed.dateKey === dateKey && parsed.plays) return parsed;
    }
  } catch {
    /* corrupt/unavailable storage — treat as empty */
  }
  return { dateKey, plays: {} };
}

/** The saved play for today's puzzle at this difficulty, or null. */
export function loadPlay(dateKey: string, difficulty: Difficulty): SavedPlay | null {
  return read(dateKey).plays[difficulty] ?? null;
}

/** Record today's completed puzzle for this difficulty. */
export function savePlay(dateKey: string, difficulty: Difficulty, play: SavedPlay): void {
  const day = read(dateKey);
  day.plays[difficulty] = play;
  try {
    localStorage.setItem(KEY, JSON.stringify(day));
  } catch {
    /* storage may be unavailable (private mode) — ignore */
  }
}
