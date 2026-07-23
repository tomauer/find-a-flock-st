import { useCallback, useEffect, useMemo, useState } from 'react';
import MapView from './components/MapView';
import ResultsModal from './components/ResultsModal';
import { loadManifest, loadWeek } from './data';
import { currentWeekIndex, pickPuzzle, shortDate, utcDateKey } from './game/dailySeed';
import { scoreLocation, scoreEmoji, type LocationResult } from './game/scoring';
import { recordResult } from './game/streaks';
import {
  DIFFICULTIES,
  type BBox,
  type Difficulty,
  type Geometry,
  type LngLat,
  type Manifest,
  type WeekData,
} from './types';

const WIN_SCORE = 50;
const DIFF_KEY = 'fafst:difficulty';

const DIFF_LABEL: Record<Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};
const DIFF_BLURB: Record<Difficulty, string> = {
  easy: 'Widespread species · a big, forgiving overlap.',
  medium: 'Moderate ranges · a medium overlap.',
  hard: 'Narrow-range species · a pinpoint overlap.',
};

function loadDifficulty(): Difficulty {
  const v = localStorage.getItem(DIFF_KEY);
  return v === 'easy' || v === 'medium' || v === 'hard' ? v : 'medium';
}

/** Bounding box that encloses every coordinate in a geometry (extends `acc`). */
function extendBBox(geom: Geometry, acc: BBox): BBox {
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      if (typeof x[0] === 'number' && typeof x[1] === 'number') {
        const [lng, lat] = x as number[];
        if (lng < acc[0]) acc[0] = lng;
        if (lat < acc[1]) acc[1] = lat;
        if (lng > acc[2]) acc[2] = lng;
        if (lat > acc[3]) acc[3] = lat;
      } else {
        for (const v of x) walk(v);
      }
    }
  };
  walk(geom.coordinates);
  return acc;
}

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [weekData, setWeekData] = useState<WeekData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [difficulty, setDifficulty] = useState<Difficulty>(loadDifficulty);
  const [guess, setGuess] = useState<LngLat | null>(null);
  const [result, setResult] = useState<LocationResult | null>(null);
  const [showResults, setShowResults] = useState(false);

  const dateKey = utcDateKey();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await loadManifest();
        if (cancelled) return;
        setManifest(m);
        const weekIdx = currentWeekIndex(dateKey, m.weekDates);
        const wd = await loadWeek(weekIdx);
        if (cancelled) return;
        setWeekData(wd);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dateKey]);

  // The daily puzzle for the chosen difficulty.
  const puzzle = useMemo(() => {
    if (!weekData) return null;
    const pool = weekData.puzzles.filter((p) => p.difficulty === difficulty);
    return pickPuzzle(pool, dateKey);
  }, [weekData, difficulty, dateKey]);

  const finished = result !== null;

  // Only frame the map AFTER guessing (pre-guess framing would reveal the spot).
  const fitBBox: BBox | null = useMemo(() => {
    if (!finished || !puzzle) return null;
    const acc: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    extendBBox(puzzle.answer.poly, acc);
    if (guess) {
      acc[0] = Math.min(acc[0], guess[0]);
      acc[1] = Math.min(acc[1], guess[1]);
      acc[2] = Math.max(acc[2], guess[0]);
      acc[3] = Math.max(acc[3], guess[1]);
    }
    return acc;
  }, [finished, puzzle, guess]);

  const chooseDifficulty = useCallback(
    (d: Difficulty) => {
      if (d === difficulty) return;
      localStorage.setItem(DIFF_KEY, d);
      setDifficulty(d);
      setGuess(null);
      setResult(null);
      setShowResults(false);
    },
    [difficulty],
  );

  const submit = useCallback(() => {
    if (!puzzle || !guess || finished) return;
    const res = scoreLocation(guess, puzzle.answer);
    setResult(res);
    recordResult({ score: res.score, won: res.score >= WIN_SCORE, dateKey });
    setTimeout(() => setShowResults(true), 500);
  }, [puzzle, guess, finished, dateKey]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-white/70">
        Failed to load game data.
        <br />
        <span className="text-sm text-white/40">{error}</span>
      </div>
    );
  }
  if (!manifest || !weekData) {
    return (
      <div className="flex h-full items-center justify-center text-white/60">
        Loading today’s flock…
      </div>
    );
  }

  const species = puzzle
    ? puzzle.species.map((code) => ({ code, ...weekData.species[code] }))
    : [];

  return (
    <div className="relative h-full w-full overflow-hidden">
      <MapView
        answer={finished && puzzle ? puzzle.answer.poly : null}
        guess={guess}
        revealCenter={finished && puzzle ? puzzle.answer.center : null}
        fitBBox={fitBBox}
        onMapClick={finished ? undefined : setGuess}
      />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-3">
        <div className="pointer-events-auto rounded-xl bg-black/55 px-3 py-2 backdrop-blur-md">
          <div className="text-sm font-bold leading-tight">Find-A-Flock S&amp;T</div>
          <div className="text-[11px] text-white/60">
            {dateKey} · week of {shortDate(weekData.date)}
          </div>
          <div className="text-[11px] text-white/50">
            Drawing from {weekData.speciesAvailable.toLocaleString()} well-modeled
            species this week · US &amp; Canada primarily
          </div>
        </div>
      </div>

      {/* Prompt + difficulty + species list */}
      <div className="pointer-events-none absolute inset-x-0 top-16 z-20 flex justify-center px-3">
        <div className="pointer-events-auto w-full max-w-md rounded-xl bg-black/55 px-4 py-3 backdrop-blur-md">
          {/* Difficulty selector */}
          <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-white/5 p-1">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                onClick={() => chooseDifficulty(d)}
                className={
                  'rounded-md px-2 py-1 text-sm font-medium transition ' +
                  (d === difficulty
                    ? 'bg-sky-600 text-white'
                    : 'text-white/60 hover:text-white')
                }
              >
                {DIFF_LABEL[d]}
              </button>
            ))}
          </div>

          {!puzzle ? (
            <div className="py-2 text-center text-sm text-white/70">
              No {DIFF_LABEL[difficulty].toLowerCase()} puzzle this week — try
              another difficulty.
            </div>
          ) : (
            <>
              <div className="mb-2 text-center text-sm text-white/80">
                {finished
                  ? 'The overlap — where all five could be seen this week — is highlighted.'
                  : 'Where do all five overlap this week? Click the map.'}
              </div>
              <ul className="space-y-1">
                {species.map((s) => (
                  <li key={s.code} className="flex items-center gap-2 text-sm">
                    <span className="text-white/30">•</span>
                    <span className="flex-1 truncate">{s.name}</span>
                  </li>
                ))}
              </ul>
              {!finished && (
                <p className="mt-1 text-center text-[11px] text-white/40">
                  {DIFF_BLURB[difficulty]}
                </p>
              )}

              {!finished ? (
                <button
                  onClick={submit}
                  disabled={!guess}
                  className="mt-3 w-full rounded-xl bg-sky-600 px-4 py-2 font-semibold enabled:hover:bg-sky-500 disabled:opacity-40"
                >
                  {guess ? 'Submit guess' : 'Click the map'}
                </button>
              ) : (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="text-sm">
                    <span className="text-xl font-bold tabular-nums">{result!.score}</span>
                    <span className="text-white/50">/100</span>
                    {!result!.inside && (
                      <span className="ml-2 text-white/60">
                        {Math.round(result!.distanceKm).toLocaleString()} km off
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setShowResults(true)}
                    className="rounded-xl bg-white/10 px-4 py-2 hover:bg-white/20"
                  >
                    View result
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showResults && result && puzzle && (
        <ResultsModal
          species={species}
          difficulty={difficulty}
          dateKey={dateKey}
          score={result.score}
          won={result.score >= WIN_SCORE}
          inside={result.inside}
          distanceKm={result.distanceKm}
          emoji={scoreEmoji(result.tier)}
          onClose={() => setShowResults(false)}
        />
      )}
    </div>
  );
}
