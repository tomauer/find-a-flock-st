import { useState } from 'react';
import { avgScore, buildShareText, loadStats, winRate, type Stats } from '../game/streaks';
import type { Difficulty } from '../types';

interface SpeciesRow {
  code: string;
  name: string;
  bowLink: string;
}

interface Props {
  species: SpeciesRow[];
  difficulty: Difficulty;
  dateKey: string;
  /** S&T week number (1–52) for the abundance-map links. */
  stWeek: number;
  score: number;
  won: boolean;
  inside: boolean;
  distanceKm: number;
  emoji: string;
  onClose: () => void;
}

function ebirdSpecies(code: string) {
  return `https://ebird.org/species/${code}`;
}
function stWeeklyMap(code: string, week: number) {
  return `https://science.ebird.org/en/status-and-trends/species/${code}/abundance-map-weekly?week=${week}`;
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-white/5 px-3 py-2">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-[11px] text-white/60">{label}</span>
    </div>
  );
}

export default function ResultsModal(props: Props) {
  const { species, difficulty, dateKey, stWeek, score, won, inside, distanceKm, emoji, onClose } =
    props;
  const [copied, setCopied] = useState(false);
  const stats: Stats = loadStats();

  const share = () => {
    const text = buildShareText({
      dateKey,
      difficulty,
      score,
      emoji,
      distanceKm: inside ? 0 : distanceKm,
      url: window.location.href,
    });
    if (navigator.share) {
      navigator.share({ text }).catch(() => void 0);
    } else {
      navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      });
    }
  };

  const headline = inside
    ? 'Bullseye — you found the overlap!'
    : won
      ? 'Close! You were in the neighborhood.'
      : 'Off the mark today.';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-slate-900 p-5 shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-sm text-white/60">{headline}</div>
        <h2 className="text-3xl font-bold tabular-nums">
          {score}
          <span className="text-lg font-normal text-white/50">/100</span>
        </h2>
        {!inside && Number.isFinite(distanceKm) && (
          <p className="mt-1 text-sm text-white/60">
            {Math.round(distanceKm).toLocaleString()} km from the overlap
          </p>
        )}

        <div className="my-4 text-center text-3xl">{emoji}</div>

        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
          Today’s flock · <span className="text-white/60">{difficulty}</span>
        </div>
        <ul className="mb-4 space-y-1.5">
          {species.map((s) => (
            <li key={s.code} className="flex items-center gap-2 text-sm">
              <span className="text-white/30">•</span>
              <span className="flex-1 truncate">{s.name}</span>
              <a
                href={ebirdSpecies(s.code)}
                target="_blank"
                rel="noreferrer"
                className="text-white/50 hover:text-white"
              >
                eBird&nbsp;↗
              </a>
              {s.bowLink && (
                <a
                  href={s.bowLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/50 hover:text-white"
                >
                  BOW&nbsp;↗
                </a>
              )}
              <a
                href={stWeeklyMap(s.code, stWeek)}
                target="_blank"
                rel="noreferrer"
                className="text-white/50 hover:text-white"
              >
                S&amp;T&nbsp;↗
              </a>
            </li>
          ))}
        </ul>

        <div className="mb-4 grid grid-cols-4 gap-2">
          <StatChip label="Played" value={stats.played} />
          <StatChip label="Avg" value={avgScore(stats)} />
          <StatChip label="Streak" value={stats.currentStreak} />
          <StatChip label="Best" value={stats.bestScore} />
        </div>

        <div className="flex gap-2">
          <button
            onClick={share}
            className="flex-1 rounded-xl bg-sky-600 px-4 py-2.5 font-semibold hover:bg-sky-500"
          >
            {copied ? 'Copied!' : 'Share'}
          </button>
          <button
            onClick={onClose}
            className="rounded-xl bg-white/10 px-4 py-2.5 hover:bg-white/20"
          >
            Close
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-white/30">
          Win rate {winRate(stats)}% · one puzzle per UTC day
        </p>
      </div>
    </div>
  );
}
