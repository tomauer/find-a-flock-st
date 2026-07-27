import { useCallback, useEffect, useMemo, useState } from 'react';
import MapView from './components/MapView';
import ResultsModal from './components/ResultsModal';
import { loadManifest, loadWeek } from './data';
import { currentWeekIndex, pickPuzzle, shortDate, utcDateKey } from './game/dailySeed';
import { scoreLocation, scoreEmoji, type LocationResult } from './game/scoring';
import { loadPlay, savePlay } from './game/play';
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

// The default framing: all of the US & Canada (incl. Alaska → Newfoundland). The
// map resets to this on load and whenever the difficulty is switched, so it never
// pre-zooms to the overlap's neighborhood (which would give the answer away).
const US_CANADA: BBox = [-168, 23, -53, 71];

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
  const [fitBBox, setFitBBox] = useState<BBox | null>(null);

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

  // Restore today's completed puzzle after a refresh (or when switching back to a
  // difficulty already played today); otherwise reset to a fresh, unplayed board.
  // Either way, frame the whole US & Canada — never the overlap's neighborhood.
  useEffect(() => {
    const saved = puzzle ? loadPlay(dateKey, difficulty) : null;
    if (saved && saved.puzzleId === puzzle!.id) {
      setGuess(saved.guess);
      setResult(saved.result);
    } else {
      setGuess(null);
      setResult(null);
    }
    setShowResults(false);
    setFitBBox([...US_CANADA] as BBox); // fresh array => MapView re-fits on every toggle
  }, [puzzle, dateKey, difficulty]);

  const finished = result !== null;

  const chooseDifficulty = useCallback(
    (d: Difficulty) => {
      if (d === difficulty) return;
      localStorage.setItem(DIFF_KEY, d);
      setDifficulty(d); // the rehydrate effect resets/restores the board and view for `d`
    },
    [difficulty],
  );

  const submit = useCallback(() => {
    if (!puzzle || !guess || finished) return;
    const res = scoreLocation(guess, puzzle.answer);
    setResult(res);
    savePlay(dateKey, difficulty, { puzzleId: puzzle.id, guess, result: res });
    recordResult({ score: res.score, won: res.score >= WIN_SCORE, dateKey });
    // Reveal: zoom to the overlap + the guess pin.
    const acc: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    extendBBox(puzzle.answer.poly, acc);
    acc[0] = Math.min(acc[0], guess[0]);
    acc[1] = Math.min(acc[1], guess[1]);
    acc[2] = Math.max(acc[2], guess[0]);
    acc[3] = Math.max(acc[3], guess[1]);
    setFitBBox(acc);
    setTimeout(() => setShowResults(true), 500);
  }, [puzzle, guess, finished, dateKey, difficulty]);

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
        fitBBox={fitBBox}
        onMapClick={finished ? undefined : setGuess}
      />

      {/* Top HUD — header + controls in one compact card so nothing overlaps or
          clips on small screens; capped to the viewport and scrollable if needed. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-2 sm:p-3">
        <div className="pointer-events-auto flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-xl bg-black/60 backdrop-blur-md">
          {/* Header */}
          <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5 sm:px-4">
            <div className="text-sm font-bold leading-tight">Find-A-Flock S&amp;T</div>
            <div className="whitespace-nowrap text-[10px] text-white/50">
              {dateKey} · wk of {shortDate(weekData.date)}
            </div>
          </div>
          <div className="px-3 pb-2 pt-0.5 text-[10px] leading-tight text-white/40 sm:px-4">
            {weekData.speciesAvailable.toLocaleString()} well-modeled species this
            week · US &amp; Canada
          </div>

          <div className="px-3 pb-3 sm:px-4">
            {/* Difficulty selector */}
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/5 p-1">
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
                <div className="mt-2 text-center text-[13px] leading-snug text-white/80">
                  {finished
                    ? 'The overlap — where all five could be seen this week — is highlighted.'
                    : 'Where do all five overlap this week? Tap the map.'}
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {species.map((s) => (
                    <li key={s.code} className="flex items-center gap-2 text-[13px]">
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
                    className="mt-2.5 w-full rounded-xl bg-sky-600 px-4 py-2 font-semibold enabled:hover:bg-sky-500 disabled:opacity-40"
                  >
                    {guess ? 'Submit guess' : 'Tap the map'}
                  </button>
                ) : (
                  <div className="mt-2.5 flex items-center justify-between gap-3">
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
      </div>

      {showResults && result && puzzle && (
        <ResultsModal
          species={species}
          difficulty={difficulty}
          dateKey={dateKey}
          stWeek={weekData.week + 1}
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
