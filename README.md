# Find-A-Flock S&T 🦅

A daily map-guessing game inspired by [Find-A-Flock](https://find-a-flock.com), powered by
[eBird Status & Trends](https://science.ebird.org/en/status-and-trends) **3 km weekly occurrence**
data. Each day you're shown **five bird species** and a **blank map** (coastlines + borders, no place
labels). Their ranges overlap somewhere this week — click **where all five could be seen at once**,
from your own knowledge of the birds. Score by how close you land to the true overlap region.

- **Pick your difficulty** — Easy (widespread species, a big forgiving overlap), Medium, or Hard
  (narrow-range species pinned to a tiny overlap).
- **Quality-gated** — only species whose S&T model quality for the week's season is ≥ 2 are used, so
  the ranges are trustworthy. The UI shows how many such species the week draws from (US & Canada only).
- **100% static** — no backend. Just JSON assets served from GitHub Pages.
- **Deterministic daily puzzle** — everyone gets the same flock per difficulty each UTC day.
- **Seasonally live** — the puzzle uses the current calendar week's S&T ranges.

---

## How it works

```
Raw eBird S&T rasters          scripts/process_ebird_data.py       scripts/build_ranges.py        scripts/build_puzzles.py
(Box, EPSG:8857, 52-band  ───▶ warp→4326, crop, quantize,   ───▶  presence (idx>0) → H3 res-4 ───▶ overlap puzzles + clean
 Float32, ~111 GB)             encode PNG stack (one time)         cells per species/week          GeoJSON outlines per week
                                                                                                          │
                                                                                                          ▼
                                                                                          React + deck.gl app ──▶ GitHub Pages
```

The heavy raster read happens once (`process_ebird_data.py`, already done — its PNG stacks live in
`build/`, gitignored). From there the pipeline is pure geometry and runs in seconds:

| Stage | Script | Output |
| --- | --- | --- |
| 1. Ranges | `build_ranges.py` | `build/cells/<code>.json` — each species' weekly range as a set of **H3 resolution-4** (~26 km) cells. A pixel counts as present when occurrence > 0, which for S&T is exactly the modeled range. |
| 2. Puzzles | `build_puzzles.py` | `public/data/weeks/<NN>.json` — for each week: species metadata + a pool of puzzles per difficulty, each with its small overlap region. |
| Index | `build_puzzles.py` | `public/data/manifest.json` — species metadata + `{h3res, weeks, weekDates, difficulties}`. |

**Puzzle generation.** For each week and each **difficulty tier** we build an inverted index
`cell → species present` (restricted to that tier's species-breadth band), pick target cells, and
**greedily choose 5 species** covering the target:

| Tier | Species range | Flock selection | Overlap |
| --- | --- | --- | --- |
| Easy | broad (≥ ~450 hexes) | keep the intersection **largest** | big, forgiving target |
| Medium | moderate | shrink the intersection | medium |
| Hard | narrow | shrink the intersection | pinpoint (≤ 8 hexes) |

**Quality gate.** Each species carries an S&T model-quality rating (0–3) per season in
`st2025_seasons - DATES-6.csv`. For each week we resolve the season (resident species use the
full-year rating; migrants use whichever season's date range contains the week, falling back to the
full-year rating in the short gaps between seasons) and **exclude any species below quality 2**, so
puzzles never lean on a poorly-modeled range. Each week file records `speciesAvailable` — the count of
US/CA species present that week and passing the gate — which the UI surfaces.

Overlap math runs on the exact H3 cell sets; only the small answer region ships (morphologically
closed + simplified for rendering) plus a dateline-safe spherical centroid + radius. The map is blank
during play and the reveal shows only the overlap, so **individual species ranges are never shipped.**

The browser loads the current week's file, filters to the chosen difficulty, picks the daily puzzle,
shows the five species names, and scores your click with a hand-rolled point-in-polygon test (100
inside the overlap, decaying with distance otherwise).

---

## Local setup

### 1. Process the data (local, one time)

The raw rasters (~111 GB) are **not** in this repo — they live on Box and are read locally. A full run
is a multi-hour batch; see `scripts/process_ebird_data.py`. It produces the per-species PNG stacks that
the range builder consumes.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
```

> **Note:** use `.venv/bin/python` explicitly if `python` isn't on your PATH.

### 2. Build ranges + puzzles (seconds, no raster access)

```bash
python scripts/build_ranges.py               # PNG presence → H3 res-4 cells  (build/cells/)
python scripts/build_ranges.py --limit 20     # smoke test

python scripts/build_puzzles.py               # overlap puzzles → public/data/weeks/*.json
python scripts/build_puzzles.py --weeks 0,25   # just those weeks

python scripts/validate_data.py               # check the bundle
```

Key `build_puzzles.py` flags: `--pool` (puzzles per tier per week), `--seed` (deterministic RNG),
`--seasons` (path to the S&T seasons CSV, for the quality gate). The per-tier species/overlap bands
live in the `TIERS` table at the top of the script; the quality threshold is `MIN_QUALITY`.

### 3. Run the app

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc + vite → dist/  (VITE_BASE controls the Pages subpath)
npm run preview
```

---

## Deploy to GitHub Pages (free)

1. Create a **public** repo and push this project (including the processed `public/data/`).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds with
   `VITE_BASE=/<repo-name>/` and deploys via `actions/deploy-pages`.
4. Your game is live at `https://<user>.github.io/<repo-name>/`.

[`.github/workflows/data-pipeline.yml`](.github/workflows/data-pipeline.yml) validates the committed
data bundle on push. Raster aggregation runs locally (the 111 GB source isn't in CI); CI only builds
and deploys the small pre-processed assets.

---

## Game design notes

- **Current week** (`src/game/dailySeed.ts`): `currentWeekIndex` maps today to the seasonally-closest
  S&T week (circular on day-of-year), so the puzzle tracks the real calendar.
- **Difficulty**: each week ships an Easy/Medium/Hard pool; the client filters to the chosen tier
  (persisted in localStorage) and picks that tier's daily puzzle.
- **Daily pick**: a seeded permutation walks the tier's puzzle pool by UTC epoch-day.
- **Scoring** (`src/game/scoring.ts`): inside the overlap polygon = 100; otherwise
  `round(100·exp(−distanceKm / 400))` from the overlap center.
- **Stats** (`src/game/streaks.ts`): localStorage streaks, win rate, average/best score, shareable line.

## Data & attribution

- Occurrence data: eBird Status & Trends (Fink et al., Cornell Lab of Ornithology). Cite per their
  [data-use terms](https://science.ebird.org/en/status-and-trends/data-access).
- Basemap: © [CARTO](https://carto.com/attributions), © OpenStreetMap contributors.

## Known limitations

- Ranges are aggregated at H3 resolution 4 (~26 km); tiny-range species are coarse at this grid.
- "Presence = any nonzero occurrence" includes trace values; the display geometry is morphologically
  closed to merge the resulting speckle into coherent range blobs.
- Species whose range crosses the ±180° antimeridian may frame loosely.
