#!/usr/bin/env python3
"""
Find-A-Flock S&T — Stage 2b: build overlap puzzles + per-week web files.

Consumes build/cells/<code>.json (from build_ranges.py). For each of the 52
weeks it generates puzzles at three difficulty tiers. In every puzzle the app
shows you WHICH five species were chosen (names visible); the map is blank and
you click where all five overlap this week. We ship only the small answer
region (for scoring + reveal) — the individual species ranges are NOT drawn, so
they aren't shipped at all.

Difficulty (species breadth + intersection size):
  easy   — broadly distributed species, LARGE overlap (pick the 5 whose common
           area stays biggest); a big, forgiving target.
  medium — moderate-range species, medium overlap.
  hard   — small-range species, tiny overlap (pick the 5 whose common area is
           smallest); a pinpoint target.

Outputs (served statically):
  public/data/manifest.json    -- {game, h3res, weeks, weekDates, species index}
  public/data/weeks/<NN>.json  -- {week, date, species:{code:{name,...}}, puzzles[]}

Usage:
  python scripts/build_puzzles.py                 # all 52 weeks
  python scripts/build_puzzles.py --weeks 10,11   # just those weeks
"""
from __future__ import annotations

import argparse
import csv
import datetime
import glob
import json
import math
import os
import random
import sys

import h3
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

DEFAULT_CELLS = "build/cells"
DEFAULT_OUT = "public/data"
DEFAULT_SEASONS = "st2025_seasons - DATES-6.csv"
N_WEEKS = 52
H3_RES = 5

SPECIES_PER = 5

# Exclude any species whose S&T model quality for the week's season is below this.
# Quality is 0–3; the low tiers are the poorly-modeled ranges that produce the
# scattered, wonky overlaps.
MIN_QUALITY = 2

# Keep puzzles in North America (the US/CA species set's home). S&T models full
# global ranges, so without this a flock of Holarctic birds can overlap in Europe
# or Asia. Bounds span Bering Sea → Newfoundland, arctic Canada → southern Mexico.
NA_LNG = (-180.0, -50.0)
NA_LAT = (14.0, 78.0)

EARTH_KM = 6371.0

# Difficulty tiers. Each defines the eligible species range band (sp_min..sp_max
# cells this week), the accepted overlap-region size band (ans_min..ans_max
# cells), a compactness cap (radius km — the overlap must be one place), how many
# co-occurring species a target needs (here_min), a per-target candidate cap for
# speed (here_cap), and the flock-selection mode:
#   "max" — greedily keep the intersection as LARGE as possible (easy: broad
#           species, big forgiving target).
#   "min" — greedily shrink the intersection (medium/hard: pinpoint target).
# Cell-count bands below are for H3 res-5 (~252.9 km²/cell). They were derived
# from the res-4 bands by the measured res-4->res-5 scaling: per-species ranges
# grew ~9.5x (median) at the finer read, while compact overlaps track the ~7x
# area ratio. So species-breadth bands (sp_*) are scaled ~9x and overlap bands
# (ans_*) ~7x, with generous upper bounds. `radius` stays in km (resolution-free).
TIERS = [
    ("easy",   dict(sp_min=3400, sp_max=48000, ans_min=250, ans_max=6600,
                    radius=1400, here_min=6, here_cap=28, mode="max")),
    ("medium", dict(sp_min=1250, sp_max=8000,  ans_min=70,  ans_max=560,
                    radius=500, here_min=6, here_cap=30, mode="min")),
    ("hard",   dict(sp_min=110,  sp_max=1800,  ans_min=4,   ans_max=60,
                    radius=110, here_min=5, here_cap=24, mode="min")),
]

# Bound the search per tier: after this many target-cell attempts, take whatever
# puzzles were found (keeps broad-species weeks from churning indefinitely).
MAX_ATTEMPTS = 600

# Display-geometry cleanup for the answer region (h3 hex unions are jagged &
# speckled). This affects ONLY the rendered outline — all overlap math runs on
# the exact H3 cell sets. Tuned for H3 res-5 cells (~17 km across): a gentle close
# just merges 1-cell specks and rounds corners, without inflating the outline past
# the true overlap (the res-4 values were ~3x larger and over-generous).
CLOSE_DEG = 0.22   # morphological close: merge cells within ~1 gap into one blob
SIMP_DEG = 0.03    # Douglas–Peucker tolerance (~3 km): keep the rounded curve


def load_cells(cells_dir: str):
    recs = {}
    for fp in glob.glob(os.path.join(cells_dir, "*.json")):
        r = json.load(open(fp))
        recs[r["code"]] = r
    if not recs:
        sys.exit(f"No range files in {cells_dir} — run build_ranges.py first.")
    return recs


def load_seasons(path):
    """Map species code -> its season rows from the S&T seasons CSV."""
    rows = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            rows[r["SPECIES_CODE"]] = r
    return rows


def _mmdd_to_doy(s):
    s = (s or "").strip()
    if not s:
        return None
    m, d = s.split("-")
    return datetime.date(2001, int(m), int(d)).timetuple().tm_yday  # 2001 = non-leap


def _iso_to_doy(iso):
    y, m, d = iso.split("-")
    return datetime.date(2001, int(m), int(d)).timetuple().tm_yday


def _in_season(doy, start, end):
    if start is None or end is None:
        return False
    if start <= end:
        return start <= doy <= end
    return doy >= start or doy <= end  # wraps the year (e.g. Nov→Feb nonbreeding)


def _q(v):
    v = (v or "").strip()
    return int(v) if v.isdigit() else None


# Migratory-season columns, in calendar order, paired with their quality field.
_SEASONS = [
    ("NONBREEDING_START", "NONBREEDING_END", "NONBREEDING_QUALITY"),
    ("PREBREEDING_MIGRATION_START", "PREBREEDING_MIGRATION_END", "PREBREEDING_MIGRATION_QUALITY"),
    ("BREEDING_START", "BREEDING_END", "BREEDING_QUALITY"),
    ("POSTBREEDING_MIGRATION_START", "POSTBREEDING_MIGRATION_END", "POSTBREEDING_MIGRATION_QUALITY"),
]


def quality_for_week(row, week_doy):
    """S&T model quality (0–3) for this species during the week's season.

    Residents use the full-year rating. Migrants use the season whose date range
    contains the week. If the week falls in NO defined season (a gap between a
    species' seasons — i.e. it isn't modeled to be present then), it is excluded:
    we return None so the quality gate drops it for that week. Returns None when
    unknown.
    """
    if row is None:
        return None
    if (row.get("RESIDENT_START") or "").strip():
        return _q(row["FULL_YEAR_QUALITY"])
    for start_c, end_c, q_c in _SEASONS:
        if _in_season(week_doy, _mmdd_to_doy(row[start_c]), _mmdd_to_doy(row[end_c])):
            return _q(row[q_c])
    return None  # week is outside every defined season -> exclude this species


def round_geo(geo, ndp=3):
    """Round every coordinate in a GeoJSON geometry dict in place."""
    def rc(x):
        if isinstance(x, (int, float)):
            return round(x, ndp)
        return [rc(v) for v in x]
    return {"type": geo["type"], "coordinates": rc(geo["coordinates"])}


def cells_to_display_geo(cells):
    """H3 cell set -> clean, lightweight GeoJSON outline for rendering.

    Morphological close merges the trace-occurrence speckle into coherent blobs;
    simplify trims the jagged hex boundary. Presentation only — overlap math and
    scoring use the raw cells / spherical centroid.
    """
    geom = shape(h3.cells_to_geo(sorted(cells)))
    geom = geom.buffer(CLOSE_DEG).buffer(-CLOSE_DEG).simplify(
        SIMP_DEG, preserve_topology=True)
    return round_geo(mapping(geom))


def _haversine_km(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    dp = math.radians(la2 - la1)
    dl = math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


def answer_geometry(cells):
    """Dateline-safe spherical centroid + radius (km) of an H3 cell set.

    The centroid averages 3D unit vectors so it stays correct across the ±180°
    meridian; radius is the farthest cell center from that centroid.
    """
    pts = [h3.cell_to_latlng(c) for c in cells]  # (lat, lng)
    x = y = z = 0.0
    for la, lo in pts:
        rla, rlo = math.radians(la), math.radians(lo)
        x += math.cos(rla) * math.cos(rlo)
        y += math.cos(rla) * math.sin(rlo)
        z += math.sin(rla)
    n = len(pts)
    x, y, z = x / n, y / n, z / n
    clat = math.degrees(math.atan2(z, math.hypot(x, y)))
    clng = math.degrees(math.atan2(y, x))
    radius = max((_haversine_km((clat, clng), p) for p in pts), default=0.0)
    return [round(clng, 4), round(clat, 4)], radius


def largest_component(cells):
    """Largest H3-adjacency-connected component of a cell set.

    Greedy "min" intersections often land in several disjoint patches (the cells
    common to all five ranges can sit in separate coastal/montane pockets). Showing
    the full scattered set either looks broken (many specks) or, if bridged by a
    big display buffer, paints gaps where the species do NOT co-occur. Instead we
    keep the single biggest contiguous patch: one clean, honest target to click.
    """
    remaining = set(cells)
    best = set()
    while remaining:
        seed = next(iter(remaining))
        comp, stack = set(), [seed]
        remaining.discard(seed)
        while stack:
            c = stack.pop()
            comp.add(c)
            for nb in h3.grid_disk(c, 1):
                if nb in remaining:
                    remaining.discard(nb)
                    stack.append(nb)
        if len(comp) > len(best):
            best = comp
    return best


def greedy_flock(here, sets, mode):
    """Pick SPECIES_PER species from `here` (all cover the target cell).

    mode="min": each step choose the species that SHRINKS the running
    intersection most (smallest resulting overlap) — a pinpoint answer.
    mode="max": each step choose the species that RETAINS the most overlap
    (largest resulting intersection) — a broad, forgiving answer.

    Every species in `here` contains the target cell, so the intersection always
    contains it and can never be empty. Returns (chosen_codes, answer_cellset)
    or (None, None) if fewer than SPECIES_PER are available.
    """
    pool = list(here)
    chosen, inter = [], None
    want_max = mode == "max"
    while len(chosen) < SPECIES_PER and pool:
        best, best_inter, best_size = None, None, None
        for code in pool:
            s = sets[code]
            ni = s if inter is None else (inter & s)
            size = len(ni)
            if best_size is None or (size > best_size if want_max else size < best_size):
                best, best_inter, best_size = code, ni, size
        chosen.append(best)
        pool.remove(best)
        inter = best_inter
    if len(chosen) < SPECIES_PER:
        return None, None
    return chosen, inter


def build_tier(name, cfg, wk, recs, rng, pool_size, quality_ok):
    """Generate one tier's puzzle pool for a week."""
    sp_min, sp_max = cfg["sp_min"], cfg["sp_max"]
    # Restrict to this tier's species-breadth band AND the quality gate, then
    # rebuild the inverted index over just those species.
    eligible = {
        code
        for code, r in recs.items()
        if code in quality_ok and sp_min <= len(r["weeks"][wk]) <= sp_max
    }
    if not eligible:
        return []
    sets = {code: set(recs[code]["weeks"][wk]) for code in eligible}

    inverted: dict[str, list[str]] = {}
    for code in eligible:
        for cell in sets[code]:
            inverted.setdefault(cell, []).append(code)

    def in_na(cell):
        lat, lng = h3.cell_to_latlng(cell)
        return NA_LAT[0] <= lat <= NA_LAT[1] and NA_LNG[0] <= lng <= NA_LNG[1]

    candidates = [
        c for c, codes in inverted.items()
        if len(codes) >= cfg["here_min"] and in_na(c)
    ]
    rng.shuffle(candidates)

    puzzles = []
    seen_sets = set()
    for attempt, t in enumerate(candidates):
        if len(puzzles) >= pool_size or attempt >= MAX_ATTEMPTS:
            break
        here = inverted[t]
        if len(here) < SPECIES_PER:
            continue
        if len(here) > cfg["here_cap"]:
            here = rng.sample(here, cfg["here_cap"])
        chosen, answer = greedy_flock(here, sets, cfg["mode"])
        if not chosen or not answer:
            continue
        # Keep only the biggest contiguous patch, so the revealed target is one
        # coherent place to click rather than scattered specks across the region.
        answer = largest_component(answer)
        if not (cfg["ans_min"] <= len(answer) <= cfg["ans_max"]):
            continue
        center, radius = answer_geometry(answer)
        if radius > cfg["radius"]:  # patch itself is still too sprawling
            continue
        key = frozenset(chosen)
        if key in seen_sets:
            continue
        seen_sets.add(key)
        puzzles.append({
            "id": f"w{wk:02d}-{name[0]}{len(puzzles):02d}",
            "difficulty": name,
            "species": sorted(chosen, key=lambda c: recs[c]["taxonOrder"]),
            "answer": {
                "poly": cells_to_display_geo(answer),
                "center": center,
                "cells": len(answer),
            },
        })
    return puzzles


def build_week(wk, recs, pool_size, seed, quality_ok):
    rng = random.Random(seed * 1000 + wk)
    puzzles = []
    per_tier = {}
    for name, cfg in TIERS:
        tier_puzzles = build_tier(name, cfg, wk, recs, rng, pool_size, quality_ok)
        per_tier[name] = len(tier_puzzles)
        puzzles.extend(tier_puzzles)

    # Species the player is "working with" this week: modeled in US/CA, present
    # this week, and passing the quality gate.
    species_available = sum(
        1 for code in quality_ok if recs[code]["weeks"][wk]
    )

    if not puzzles:
        return None, per_tier, species_available

    # Species metadata for the species referenced by this week's puzzles.
    # No range polygon — the map is blank during play and the reveal shows only
    # the overlap region.
    used = sorted({c for p in puzzles for c in p["species"]})
    species = {}
    for code in used:
        r = recs[code]
        species[code] = {
            "name": r["name"],
            "taxonOrder": r["taxonOrder"],
            "bowLink": r["bowLink"],
        }

    return {
        "week": wk,
        "date": recs[used[0]]["dates"][wk] if used else None,
        "h3res": H3_RES,
        "speciesAvailable": species_available,
        "species": species,
        "puzzles": puzzles,
    }, per_tier, species_available


def main(argv=None):
    p = argparse.ArgumentParser(description="Build overlap puzzles + week files.")
    p.add_argument("--cells", default=DEFAULT_CELLS)
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--seasons", default=DEFAULT_SEASONS,
                   help="S&T seasons CSV (per-species season quality + dates)")
    p.add_argument("--pool", type=int, default=8, help="puzzles per tier per week")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--weeks", default="", help="comma-separated week indices only")
    args = p.parse_args(argv)

    recs = load_cells(args.cells)
    seasons = load_seasons(args.seasons)
    dates = recs[next(iter(recs))]["dates"]

    # Per-week quality gate: codes whose season quality this week is >= MIN_QUALITY.
    quality_ok_by_week = []
    for wk in range(N_WEEKS):
        doy = _iso_to_doy(dates[wk])
        ok = {
            code for code in recs
            if (q := quality_for_week(seasons.get(code), doy)) is not None
            and q >= MIN_QUALITY
        }
        quality_ok_by_week.append(ok)
    weeks = (
        [int(x) for x in args.weeks.split(",") if x.strip() != ""]
        if args.weeks else list(range(N_WEEKS))
    )

    weeks_dir = os.path.join(args.out, "weeks")
    os.makedirs(weeks_dir, exist_ok=True)
    print(f"Building puzzles from {len(recs)} species. "
          f"pool={args.pool}/tier tiers={[t[0] for t in TIERS]}")

    totals = {name: 0 for name, _ in TIERS}
    ok = 0
    for wk in weeks:
        data, per_tier, avail = build_week(
            wk, recs, args.pool, args.seed, quality_ok_by_week[wk])
        n = len(data["puzzles"]) if data else 0
        for name in totals:
            totals[name] += per_tier.get(name, 0)
        if data:
            ok += 1
            with open(os.path.join(weeks_dir, f"{wk:02d}.json"), "w") as f:
                json.dump(data, f, separators=(",", ":"))
        tier_str = " ".join(f"{k}={per_tier.get(k, 0)}" for k, _ in TIERS)
        print(f"  week {wk:2d} ({dates[wk]}): {n:3d} puzzles  "
              f"[{tier_str}]  ({avail} species q>={MIN_QUALITY})")

    # Species index for the manifest (metadata only; no ranges anywhere now).
    species_index = sorted(
        ({
            "code": r["code"],
            "commonName": r["name"],
            "taxonOrder": r["taxonOrder"],
            "bowLink": r["bowLink"],
        } for r in recs.values()),
        key=lambda e: e["taxonOrder"],
    )
    manifest = {
        "game": "locate",
        "generated": None,
        "h3res": H3_RES,
        "weeks": N_WEEKS,
        "weekDates": dates,
        "difficulties": [name for name, _ in TIERS],
        "minQuality": MIN_QUALITY,
        "count": len(species_index),
        "species": species_index,
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    print("\n" + "=" * 60)
    print(f"Wrote {ok}/{len(weeks)} week files + manifest.json")
    for name, _ in TIERS:
        print(f"  {name:6s}: {totals[name]} puzzles "
              f"(avg {totals[name]/max(1,len(weeks)):.1f}/wk)")
    print("=" * 60)


if __name__ == "__main__":
    main()
