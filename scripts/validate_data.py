#!/usr/bin/env python3
"""Validate the committed public/data bundle for the location-guessing game.

Checks the manifest is consistent and every weeks/<NN>.json is well-formed:
each puzzle carries a known difficulty and exactly 5 known species, plus a
non-empty answer region with a valid center. The map is blank during play and
the reveal shows only the overlap, so species no longer ship range polygons.
Run locally or in CI (data-pipeline.yml). Exits non-zero on hard errors.
"""
from __future__ import annotations

import json
import os
import sys

OUT = os.environ.get("DATA_DIR", "public/data")
WEEK_WARN_BYTES = 3 * 1024 * 1024  # per-week file size budget
SPECIES_PER = 5
DIFFICULTIES = ("easy", "medium", "hard")


def geo_points(geom: dict) -> int:
    """Count coordinate pairs in a GeoJSON Polygon/MultiPolygon."""
    n = 0

    def walk(x):
        nonlocal n
        if isinstance(x, list) and x and isinstance(x[0], (int, float)):
            n += 1
            return
        if isinstance(x, list):
            for v in x:
                walk(v)

    walk(geom.get("coordinates", []))
    return n


def main() -> int:
    manifest_path = os.path.join(OUT, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"ERROR: {manifest_path} missing")
        return 1
    manifest = json.load(open(manifest_path))
    errors, warnings = [], []

    species_index = manifest.get("species", [])
    known_codes = {s["code"] for s in species_index}
    if manifest.get("game") != "locate":
        errors.append(f"manifest.game is {manifest.get('game')!r}, expected 'locate'")
    if manifest.get("count") != len(species_index):
        errors.append(
            f"count {manifest.get('count')} != species array {len(species_index)}"
        )
    week_dates = manifest.get("weekDates", [])
    n_weeks = manifest.get("weeks", 0)
    if len(week_dates) != n_weeks:
        errors.append(f"weekDates {len(week_dates)} != weeks {n_weeks}")

    weeks_dir = os.path.join(OUT, "weeks")
    if not os.path.isdir(weeks_dir):
        print(f"ERROR: {weeks_dir} missing")
        return 1

    week_files = sorted(f for f in os.listdir(weeks_dir) if f.endswith(".json"))
    total_puzzles = 0
    for fn in week_files:
        path = os.path.join(weeks_dir, fn)
        wd = json.load(open(path))
        species = wd.get("species", {})
        puzzles = wd.get("puzzles", [])
        total_puzzles += len(puzzles)

        for code in species:
            if code not in known_codes:
                errors.append(f"{fn}: species {code} not in manifest index")

        tier_counts = {d: 0 for d in DIFFICULTIES}
        for p in puzzles:
            pid = p.get("id", "?")
            diff = p.get("difficulty")
            if diff not in DIFFICULTIES:
                errors.append(f"{fn}:{pid} has bad difficulty {diff!r}")
            else:
                tier_counts[diff] += 1
            codes = p.get("species", [])
            if len(codes) != SPECIES_PER:
                errors.append(f"{fn}:{pid} has {len(codes)} species, expected {SPECIES_PER}")
            for code in codes:
                if code not in species:
                    errors.append(f"{fn}:{pid} references missing species {code}")
            ans = p.get("answer", {})
            if geo_points(ans.get("poly", {})) == 0:
                errors.append(f"{fn}:{pid} has empty answer polygon")
            if not ans.get("cells"):
                errors.append(f"{fn}:{pid} has zero answer cells")
            center = ans.get("center")
            if not (isinstance(center, list) and len(center) == 2):
                errors.append(f"{fn}:{pid} has malformed answer center")

        for d in DIFFICULTIES:
            if tier_counts[d] == 0:
                warnings.append(f"{fn}: no {d} puzzles")

        size = os.path.getsize(path)
        if size > WEEK_WARN_BYTES:
            warnings.append(f"{fn}: {size/1024/1024:.1f} MB > {WEEK_WARN_BYTES//1024//1024} MB budget")

    if len(week_files) != n_weeks:
        warnings.append(f"{len(week_files)} week files present, manifest says {n_weeks}")

    print(f"Validated {len(week_files)} week files, {total_puzzles} puzzles, "
          f"{len(species_index)} species.")
    for w in warnings:
        print(f"  WARN {w}")
    for e in errors:
        print(f"  ERR  {e}")
    if errors:
        print(f"\n{len(errors)} error(s).")
        return 1
    print(f"OK ({len(warnings)} warning(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
