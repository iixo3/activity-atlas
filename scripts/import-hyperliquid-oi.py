"""Extract closed UTC months from Ironflow's hourly open interest archive.

Requires DuckDB. Pass YYYY-MM.parquet files and Hyperliquid's
perpConciseAnnotations response. The output retains the source's two-sided values.
"""

import argparse
import calendar
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import duckdb


def extract_month(db, path):
    start = datetime.strptime(path.stem, "%Y-%m").replace(tzinfo=timezone.utc)
    year, month = start.year, start.month
    days = calendar.monthrange(year, month)[1]
    first = int(start.timestamp())
    last = first + (days * 24 - 1) * 3600
    db.read_parquet(str(path)).create_view("hourly", replace=True)
    hours = [row[0] for row in db.execute("SELECT DISTINCT epoch(timestamp) FROM hourly ORDER BY 1").fetchall()]
    if hours != list(range(first, last + 1, 3600)):
        raise ValueError(f"{path.stem} has missing or off-grid UTC hours")
    rows = db.execute(
        "SELECT coin, coalesce(dex, ''), open_interest_usd FROM hourly WHERE epoch(timestamp) = ? ORDER BY 1, 2",
        [last],
    ).fetchall()
    if (not rows or len({(coin, dex) for coin, dex, _ in rows}) != len(rows)
            or any(not coin or value is None or not math.isfinite(value) or value < 0 for coin, _, value in rows)
            or not any(not dex and value > 0 for _, dex, value in rows)
            or not any(dex and value > 0 for _, dex, value in rows)):
        raise ValueError(f"{path.stem} has an invalid or incomplete month-end cohort")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    return {
        "date": start.date().isoformat(),
        "asOfDate": start.replace(day=days).date().isoformat(),
        "sha256": digest,
        "markets": [row for row in rows if row[2] > 0],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--annotations", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("files", type=Path, nargs="+")
    args = parser.parse_args()
    with duckdb.connect() as db:
        months = [extract_month(db, path) for path in sorted(args.files)]
    if len({month["date"] for month in months}) != len(months):
        raise ValueError("Each month must appear once")
    coins = {coin for month in months for coin, dex, _ in month["markets"] if dex}
    annotations = dict(json.loads(args.annotations.read_text()))
    archive = {
        "retrievedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "annotations": {coin: annotations[coin].get("category") for coin in sorted(coins & annotations.keys())},
        "months": months,
    }
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(archive, separators=(",", ":"), allow_nan=False) + "\n")
    temporary.replace(args.output)


if __name__ == "__main__":
    main()
