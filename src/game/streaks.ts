// LocalStorage-backed player statistics, streaks, and shareable summaries.

import { todayKey } from './dailySeed';

const KEY = 'fafst:stats:v2';

export interface Stats {
  played: number;
  wins: number;
  currentStreak: number;
  maxStreak: number;
  lastPlayed: string | null; // UTC date key of last completed daily
  totalScore: number; // for average
  bestScore: number;
  lastScore: number | null;
}

function empty(): Stats {
  return {
    played: 0,
    wins: 0,
    currentStreak: 0,
    maxStreak: 0,
    lastPlayed: null,
    totalScore: 0,
    bestScore: 0,
    lastScore: null,
  };
}

export function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    return { ...empty(), ...(JSON.parse(raw) as Partial<Stats>) };
  } catch {
    return empty();
  }
}

function save(stats: Stats): Stats {
  try {
    localStorage.setItem(KEY, JSON.stringify(stats));
  } catch {
    /* storage may be unavailable (private mode) — ignore */
  }
  return stats;
}

/** Was today's daily already completed? Prevents double-counting. */
export function alreadyPlayedToday(stats: Stats, dateKey = todayKey()): boolean {
  return stats.lastPlayed === dateKey;
}

/** Record a completed daily. No-op if this date was already recorded. */
export function recordResult(args: {
  score: number;
  won: boolean;
  dateKey?: string;
}): Stats {
  const stats = loadStats();
  const dateKey = args.dateKey ?? todayKey();
  if (stats.lastPlayed === dateKey) return stats; // idempotent

  stats.played += 1;
  if (args.won) {
    stats.wins += 1;
    stats.currentStreak += 1;
    stats.maxStreak = Math.max(stats.maxStreak, stats.currentStreak);
  } else {
    stats.currentStreak = 0;
  }
  stats.totalScore += args.score;
  stats.bestScore = Math.max(stats.bestScore, args.score);
  stats.lastScore = args.score;
  stats.lastPlayed = dateKey;
  return save(stats);
}

export function winRate(stats: Stats): number {
  return stats.played ? Math.round((stats.wins / stats.played) * 100) : 0;
}

export function avgScore(stats: Stats): number {
  return stats.played ? Math.round(stats.totalScore / stats.played) : 0;
}

/** Shareable text (score + emoji + streak line). */
export function buildShareText(opts: {
  dateKey: string;
  difficulty: string;
  score: number;
  emoji: string;
  distanceKm: number | null;
  url?: string;
}): string {
  const dist =
    opts.distanceKm === null || opts.distanceKm === 0
      ? 'bullseye!'
      : `${Math.round(opts.distanceKm).toLocaleString()} km off`;
  const diff = opts.difficulty.charAt(0).toUpperCase() + opts.difficulty.slice(1);
  return [
    `Find-A-Flock S&T — ${opts.dateKey} · ${diff}`,
    `${opts.emoji} ${opts.score}/100 (${dist})`,
    opts.url ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}
