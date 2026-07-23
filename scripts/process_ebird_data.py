#!/usr/bin/env python3
"""
Find-A-Flock S&T — Data Engineering & Pipeline Agent (agent-data)

Converts eBird Status & Trends 3km weekly occurrence rasters into web-optimized
static assets for a zero-backend GitHub Pages game.

For each playable species it produces:
  public/data/species/<code>.png   -- 8-bit grayscale frame stack, w x (h*52),
                                       occurrence quantized with a shared curve.
  public/data/species/<code>.json  -- per-week dates, occ-weighted centroid,
                                       argmax peak (lat/lng), grid dims, bbox.
And a single:
  public/data/manifest.json         -- light index (autocomplete + daily pick):
                                       code, name, taxonOrder, bowLink, quality,
                                       bbox, season week-ranges + global config.

Input rasters: EPSG:8857 (Equal Earth), 52 bands (weekly), Float32, NoData=nan,
occurrence in [0,1]. Playable set = CSV REASON == "US/CA" that also has a matching
TIF, minus SENSITIVE species.

Usage:
  python scripts/process_ebird_data.py --limit 5          # smoke test
  python scripts/process_ebird_data.py --jobs 6           # full run
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.vrt import WarpedVRT

# ---------------------------------------------------------------------------
# Configuration / constants
# ---------------------------------------------------------------------------
DEFAULT_SRC = (
    "/Users/mta45/Library/CloudStorage/Box-Box/Projects/2024_status/"
    "status_results/occurrence_3km"
)
DEFAULT_CSV = "st2025_seasons - DATES-6.csv"
DEFAULT_OUT = "public/data"
TIF_SUFFIX = "_occurrence_median_3km_2023.tif"
N_WEEKS = 52

# Shared quantization curve: idx = round(255 * occ**QUANT_EXP). Perceptual (sqrt)
# so low-but-present occurrence stays visible. The client inverts this to recover
# an approximate occurrence value for Pin-the-Flock scoring. 0 == nodata / zero.
QUANT_EXP = 0.5

# Resolution of the single full-extent warp read (longest side, px). These source
# rasters have NO overviews and are 52-band PIXEL-interleaved DEFLATE, so ANY read
# decompresses the whole ~13 GB surface once (~60 s). We therefore read exactly
# ONCE per species at this resolution and derive bbox + crop + per-week stats from
# that in-memory array. ~1200 px over 360deg lon is ~0.3deg (~33 km) per pixel,
# ample for a density-pattern guessing game.
FULL_DIM = 1200

# Season fields in the CSV -> manifest key. Each is a (START, END) MM-DD pair.
SEASON_FIELDS = {
    "nonbreeding": ("NONBREEDING_START", "NONBREEDING_END"),
    "prebreedingMig": ("PREBREEDING_MIGRATION_START", "PREBREEDING_MIGRATION_END"),
    "breeding": ("BREEDING_START", "BREEDING_END"),
    "postbreedingMig": ("POSTBREEDING_MIGRATION_START", "POSTBREEDING_MIGRATION_END"),
    "resident": ("RESIDENT_START", "RESIDENT_END"),
}


# ---------------------------------------------------------------------------
# CSV / selection helpers
# ---------------------------------------------------------------------------
def tif_path(src_dir: str, code: str) -> str:
    return os.path.join(src_dir, f"{code}{TIF_SUFFIX}")


def load_selection(csv_path: str, src_dir: str, reason: str):
    """Return the list of playable CSV rows: REASON match, has TIF, not sensitive."""
    rows = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if row["REASON"].strip() != reason:
                continue
            if row["SENSITIVE"].strip().upper() == "TRUE":
                continue
            code = row["SPECIES_CODE"].strip()
            if not os.path.exists(tif_path(src_dir, code)):
                continue
            rows.append(row)
    # Deterministic order by taxonomy for reproducible manifests.
    rows.sort(key=lambda r: int(r["TAXON_ORDER"]))
    return rows


def _mmdd_to_doy(mmdd: str) -> int | None:
    mmdd = (mmdd or "").strip()
    if not mmdd or "-" not in mmdd:
        return None
    try:
        mm, dd = mmdd.split("-")
        return datetime(2023, int(mm), int(dd)).timetuple().tm_yday
    except (ValueError, TypeError):
        return None


def mmdd_to_week(mmdd: str, week_doys: list[int]) -> int | None:
    """Map an MM-DD string to the closest weekly band index (0-based, circular)."""
    doy = _mmdd_to_doy(mmdd)
    if doy is None:
        return None
    best_i, best_d = 0, 10**9
    for i, wd in enumerate(week_doys):
        d = abs(wd - doy)
        d = min(d, 365 - d)  # wrap around year end
        if d < best_d:
            best_i, best_d = i, d
    return best_i


def season_ranges(row: dict, week_doys: list[int]) -> dict:
    out = {}
    for key, (sf, ef) in SEASON_FIELDS.items():
        s = mmdd_to_week(row.get(sf, ""), week_doys)
        e = mmdd_to_week(row.get(ef, ""), week_doys)
        if s is not None and e is not None:
            out[key] = [s, e]
    return out


# ---------------------------------------------------------------------------
# Raster processing (per species, runs in a worker process)
# ---------------------------------------------------------------------------
def _pool_factor(h: int, w: int, max_dim: int) -> int:
    longest = max(h, w)
    return 1 if longest <= max_dim else int(np.ceil(longest / max_dim))


def _block_downsample(stack: np.ndarray, factor: int) -> np.ndarray:
    """Mean-pool a (bands, h, w) float stack by an integer factor. Caller has
    already trimmed h, w to exact multiples of `factor`."""
    if factor <= 1:
        return stack
    b, h, w = stack.shape
    s = stack.reshape(b, h // factor, factor, w // factor, factor)
    return s.mean(axis=(2, 4))


def process_species(row: dict, src_dir: str, out_dir: str, max_dim: int,
                    pad: float, full_dim: int):
    """Process one species with a SINGLE full-extent warp read. Returns
    (manifest_entry, week_doys) or raises."""
    code = row["SPECIES_CODE"].strip()
    path = tif_path(src_dir, code)
    species_dir = os.path.join(out_dir, "species")

    with rasterio.open(path) as src:
        descriptions = list(src.descriptions)
        with WarpedVRT(src, crs="EPSG:4326", resampling=Resampling.average) as vrt:
            if vrt.width >= vrt.height:
                gw = full_dim
                gh = max(1, round(full_dim * vrt.height / vrt.width))
            else:
                gh = full_dim
                gw = max(1, round(full_dim * vrt.width / vrt.height))
            left, bottom, right, top = vrt.bounds
            # THE one expensive read: whole reprojected surface, all 52 bands.
            full = vrt.read(out_shape=(vrt.count, gh, gw),
                            resampling=Resampling.average)

    full = np.nan_to_num(full, nan=0.0).astype(np.float32)
    full = np.clip(full, 0.0, 1.0)  # (52, gh, gw) global 4326

    mask = np.any(full > 0, axis=0)
    if not mask.any():
        raise RuntimeError("empty occurrence surface")
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    r0, r1, c0, c1 = int(rows[0]), int(rows[-1]), int(cols[0]), int(cols[-1])

    gpx_w = (right - left) / gw
    gpx_h = (top - bottom) / gh
    # Pad the bbox by `pad` fraction of the detected span, then clamp.
    pad_c = max(1, round((c1 - c0 + 1) * pad))
    pad_r = max(1, round((r1 - r0 + 1) * pad))
    c0 = max(0, c0 - pad_c); c1 = min(gw - 1, c1 + pad_c)
    r0 = max(0, r0 - pad_r); r1 = min(gh - 1, r1 + pad_r)

    crop = full[:, r0:r1 + 1, c0:c1 + 1]
    ch, cw = crop.shape[1], crop.shape[2]
    factor = _pool_factor(ch, cw, max_dim)
    # Trim to exact multiples of factor so pooling is clean, and keep the bbox
    # aligned to exactly the retained native cells.
    nh = (ch // factor) * factor
    nw = (cw // factor) * factor
    crop = crop[:, :nh, :nw]

    w = left + c0 * gpx_w
    e = left + (c0 + nw) * gpx_w
    n = top - r0 * gpx_h
    s = top - (r0 + nh) * gpx_h

    stack = _block_downsample(crop, factor)
    stack = np.clip(stack, 0.0, 1.0).astype(np.float32)
    dst_h, dst_w = stack.shape[1], stack.shape[2]

    # Quantize to uint8 with the shared perceptual curve.
    q = np.round(255.0 * np.power(stack, QUANT_EXP)).astype(np.uint8)  # (52,h,w)

    # Frame stack image: vertically stacked weeks -> (h*52, w) grayscale.
    img = q.reshape(N_WEEKS * dst_h, dst_w)
    _save_png(img, os.path.join(species_dir, f"{code}.png"))

    # Cell-center lon/lat grids for centroid / peak computation.
    lons = w + (np.arange(dst_w) + 0.5) * (e - w) / dst_w
    lats = n - (np.arange(dst_h) + 0.5) * (n - s) / dst_h
    lon_g, lat_g = np.meshgrid(lons, lats)

    weeks = []
    for wk in range(N_WEEKS):
        occ = stack[wk]
        total = float(occ.sum())
        if total > 0:
            centroid = [
                round(float((occ * lon_g).sum() / total), 4),
                round(float((occ * lat_g).sum() / total), 4),
            ]
            idx = int(np.argmax(occ))
            pr, pc = divmod(idx, dst_w)
            peak = [round(float(lons[pc]), 4), round(float(lats[pr]), 4)]
            max_occ = round(float(occ.max()), 5)
        else:
            centroid = peak = None
            max_occ = 0.0
        weeks.append({
            "week": wk,
            "date": descriptions[wk],
            "centroid": centroid,
            "peak": peak,
            "maxOcc": max_occ,
        })

    detail = {
        "code": code,
        "w": dst_w,
        "h": dst_h,
        "frames": N_WEEKS,
        "bbox": [round(w, 5), round(s, 5), round(e, 5), round(n, 5)],
        "quantExp": QUANT_EXP,
        "weeks": weeks,
    }
    with open(os.path.join(species_dir, f"{code}.json"), "w") as f:
        json.dump(detail, f, separators=(",", ":"))

    week_doys = [datetime.strptime(d, "%Y-%m-%d").timetuple().tm_yday
                 for d in descriptions]

    manifest_entry = {
        "code": code,
        "commonName": row["COMMON_NAME"].strip(),
        "taxonOrder": int(row["TAXON_ORDER"]),
        "bowLink": row.get("BOW_LINK", "").strip(),
        "animationQuality": _int_or_none(row.get("ANIMATION_QUALITY", "")),
        "bbox": detail["bbox"],
        "seasons": season_ranges(row, week_doys),
    }
    return manifest_entry, week_doys


def _int_or_none(v: str):
    v = (v or "").strip()
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def _save_png(arr: np.ndarray, path: str):
    from PIL import Image
    Image.fromarray(arr, mode="L").save(path, format="PNG", optimize=True)


# Top-level worker wrapper so it is picklable for ProcessPoolExecutor.
def _worker(args):
    row, src_dir, out_dir, max_dim, pad, full_dim = args
    code = row["SPECIES_CODE"].strip()
    try:
        entry, week_doys = process_species(
            row, src_dir, out_dir, max_dim, pad, full_dim
        )
        size = os.path.getsize(os.path.join(out_dir, "species", f"{code}.png"))
        return {"ok": True, "code": code, "entry": entry, "png": size,
                "week_doys": week_doys}
    except Exception as exc:  # noqa: BLE001 - report and continue
        return {"ok": False, "code": code, "error": f"{exc}",
                "trace": traceback.format_exc()}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(argv=None):
    p = argparse.ArgumentParser(description="Process eBird S&T occurrence rasters.")
    p.add_argument("--src", default=DEFAULT_SRC)
    p.add_argument("--csv", default=DEFAULT_CSV)
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--reason", default="US/CA")
    p.add_argument("--limit", type=int, default=0, help="process first N species")
    p.add_argument("--codes", default="", help="comma-separated species codes only")
    p.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    p.add_argument("--max-dim", type=int, default=256,
                   help="longest side of the per-species output grid (px)")
    p.add_argument("--full-dim", type=int, default=FULL_DIM,
                   help="longest side of the single full-extent warp read (px)")
    p.add_argument("--pad", type=float, default=0.08, help="bbox padding fraction")
    args = p.parse_args(argv)

    if not os.path.isdir(args.src):
        sys.exit(f"Source dir not found: {args.src}")
    if not os.path.exists(args.csv):
        sys.exit(f"CSV not found: {args.csv}")

    rows = load_selection(args.csv, args.src, args.reason)
    if args.codes:
        want = {c.strip() for c in args.codes.split(",") if c.strip()}
        rows = [r for r in rows if r["SPECIES_CODE"].strip() in want]
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        sys.exit("No species selected.")

    species_dir = os.path.join(args.out, "species")
    os.makedirs(species_dir, exist_ok=True)

    print(f"Selected {len(rows)} species (REASON={args.reason!r}). "
          f"jobs={args.jobs} max_dim={args.max_dim}")

    tasks = [(r, args.src, args.out, args.max_dim, args.pad, args.full_dim)
             for r in rows]

    entries, failures, week_doys = [], [], None
    total_png = 0
    done = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(_worker, t): t[0]["SPECIES_CODE"].strip() for t in tasks}
        for fut in as_completed(futs):
            res = fut.result()
            done += 1
            if res["ok"]:
                entries.append(res["entry"])
                total_png += res["png"]
                week_doys = week_doys or res["week_doys"]
                print(f"[{done}/{len(rows)}] OK  {res['code']:10s} "
                      f"{res['png']/1024:6.1f} KB")
            else:
                failures.append(res)
                print(f"[{done}/{len(rows)}] ERR {res['code']:10s} {res['error']}")

    entries.sort(key=lambda e: e["taxonOrder"])
    manifest = {
        "generated": None,  # stamped by CI/commit, kept deterministic here
        "weeks": N_WEEKS,
        "quantExp": QUANT_EXP,
        "reason": args.reason,
        "count": len(entries),
        "species": entries,
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    print("\n" + "=" * 60)
    print(f"Wrote {len(entries)} species, manifest.json, "
          f"total PNG {total_png/1024/1024:.1f} MB "
          f"(avg {total_png/max(1,len(entries))/1024:.1f} KB)")
    if failures:
        print(f"{len(failures)} FAILURES:")
        for frec in failures[:20]:
            print(f"  {frec['code']}: {frec['error']}")
    print("=" * 60)


if __name__ == "__main__":
    main()
