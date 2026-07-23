#!/usr/bin/env python3
"""
Find-A-Flock S&T — Stage 2a: occurrence presence -> H3 range cells.

Reads the already-built per-species density assets (public/data/species/<code>.png
+ <code>.json) and converts each species' weekly range into a set of H3 cells.
A pixel counts as "present" when its quantized index > 0, i.e. occurrence > 0 —
which for eBird S&T is exactly the modeled range (non-range areas are zeroed).

This reuses the expensive raster read that already happened; it does NOT touch the
111 GB Box rasters. Output is an intermediate consumed by build_puzzles.py:

  build/cells/<code>.json  -- {code, name, taxonOrder, bowLink, dates[52],
                               weeks: [[h3cell, ...] x 52]}   (gitignored)

Usage:
  python scripts/build_ranges.py               # all species in manifest
  python scripts/build_ranges.py --limit 20    # smoke test
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np

DEFAULT_DATA = "public/data"
DEFAULT_OUT = "build/cells"
DEFAULT_RES = 4
N_WEEKS = 52


def species_meta(data_dir: str) -> dict[str, dict]:
    """code -> {commonName, taxonOrder, bowLink} from the (old) manifest."""
    mpath = os.path.join(data_dir, "manifest.json")
    manifest = json.load(open(mpath))
    return {
        s["code"]: {
            "commonName": s.get("commonName", s["code"]),
            "taxonOrder": s.get("taxonOrder", 0),
            "bowLink": s.get("bowLink", ""),
        }
        for s in manifest["species"]
    }


def process_species(code: str, meta: dict, data_dir: str, out_dir: str, res: int):
    import h3
    from PIL import Image

    sdir = os.path.join(data_dir, "species")
    detail = json.load(open(os.path.join(sdir, f"{code}.json")))
    w, h, frames = detail["w"], detail["h"], detail["frames"]
    west, south, east, north = detail["bbox"]

    img = np.asarray(Image.open(os.path.join(sdir, f"{code}.png")).convert("L"))
    if img.shape != (h * frames, w):
        raise RuntimeError(f"png {img.shape} != {(h * frames, w)}")
    stack = img.reshape(frames, h, w)

    # Cell-center lon/lat for every grid cell.
    lons = west + (np.arange(w) + 0.5) * (east - west) / w
    lats = north - (np.arange(h) + 0.5) * (north - south) / h

    # Compute the H3 cell for each pixel present in ANY week, once.
    union = np.any(stack > 0, axis=0)
    rc = np.argwhere(union)  # (k, 2) of (row, col)
    cell_of = {}
    for r, c in rc:
        cell_of[(int(r), int(c))] = h3.latlng_to_cell(
            float(lats[r]), float(lons[c]), res
        )

    weeks_cells = []
    for wk in range(frames):
        present = np.argwhere(stack[wk] > 0)
        cells = {cell_of[(int(r), int(c))] for r, c in present}
        weeks_cells.append(sorted(cells))

    rec = {
        "code": code,
        "name": meta["commonName"],
        "taxonOrder": meta["taxonOrder"],
        "bowLink": meta["bowLink"],
        "dates": [wi["date"] for wi in detail["weeks"]],
        "res": res,
        "weeks": weeks_cells,
    }
    with open(os.path.join(out_dir, f"{code}.json"), "w") as f:
        json.dump(rec, f, separators=(",", ":"))
    total = sum(len(c) for c in weeks_cells)
    peak = max((len(c) for c in weeks_cells), default=0)
    return {"code": code, "peakCells": peak, "totalCells": total}


def _worker(args):
    code, meta, data_dir, out_dir, res = args
    try:
        return {"ok": True, **process_species(code, meta, data_dir, out_dir, res)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": code, "error": str(exc)}


def main(argv=None):
    p = argparse.ArgumentParser(description="Occurrence PNGs -> H3 range cells.")
    p.add_argument("--data", default=DEFAULT_DATA)
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--res", type=int, default=DEFAULT_RES)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--codes", default="")
    p.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = p.parse_args(argv)

    meta = species_meta(args.data)
    codes = list(meta)
    if args.codes:
        want = {c.strip() for c in args.codes.split(",") if c.strip()}
        codes = [c for c in codes if c in want]
    if args.limit:
        codes = codes[: args.limit]
    if not codes:
        sys.exit("No species selected.")

    os.makedirs(args.out, exist_ok=True)
    print(f"Extracting H3 res-{args.res} ranges for {len(codes)} species. "
          f"jobs={args.jobs}")

    tasks = [(c, meta[c], args.data, args.out, args.res) for c in codes]
    ok, fail, done = 0, [], 0
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(_worker, t): t[0] for t in tasks}
        for fut in as_completed(futs):
            r = fut.result()
            done += 1
            if r["ok"]:
                ok += 1
                if done % 50 == 0 or done == len(codes):
                    print(f"[{done}/{len(codes)}] {r['code']:10s} "
                          f"peak {r['peakCells']} cells/wk")
            else:
                fail.append(r)
                print(f"[{done}/{len(codes)}] ERR {r['code']}: {r['error']}")

    print("\n" + "=" * 60)
    print(f"Wrote {ok} range files to {args.out}/")
    if fail:
        print(f"{len(fail)} failures: " + ", ".join(f['code'] for f in fail[:20]))
    print("=" * 60)


if __name__ == "__main__":
    main()
