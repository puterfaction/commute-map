#!/usr/bin/env python3
"""Sanity gate for a freshly fetched listings file. Exits nonzero if it looks
like a blocked or broken fetch, so a bad run fails loudly instead of
publishing zeros (a ban page can be valid JSON with no error in it).

Usage: check_listings.py NEW.json [OLD.json]
"""

import json
import sys

MIN_COUNT = 3000
# rough borough boxes (lat_lo, lat_hi, lon_lo, lon_hi) -> minimum listings
BOROUGHS = {
    "manhattan": ((40.70, 40.88, -74.02, -73.91), 300),
    "brooklyn":  ((40.57, 40.70, -74.04, -73.86), 500),
    "queens":    ((40.70, 40.80, -73.90, -73.75), 200),
    "bronx":     ((40.80, 40.91, -73.90, -73.78), 100),
}
MAX_DROP = 0.5  # fail if count falls by more than half vs the published file


def main():
    new = json.load(open(sys.argv[1]))
    rows = new.get("listings", [])
    errs = []
    if len(rows) < MIN_COUNT:
        errs.append(f"count {len(rows)} < {MIN_COUNT}")
    for name, ((a, b, c, d), need) in BOROUGHS.items():
        n = sum(1 for r in rows if a <= r[0] <= b and c <= r[1] <= d)
        print(f"  {name}: {n}")
        if n < need:
            errs.append(f"{name} {n} < {need}")
    with_br = sum(1 for r in rows if r[3] >= 0)
    if rows and with_br / len(rows) < 0.5:
        errs.append(f"bedroom coverage {with_br}/{len(rows)} < 50%")
    if len(sys.argv) > 2:
        try:
            old = json.load(open(sys.argv[2]))["count"]
            if len(rows) < old * (1 - MAX_DROP):
                errs.append(f"count fell {old} -> {len(rows)}")
        except FileNotFoundError:
            pass
    print(f"count {len(rows)}, bedrooms known {with_br}")
    if errs:
        print("SANITY FAIL: " + "; ".join(errs))
        sys.exit(1)
    print("sanity ok")


if __name__ == "__main__":
    main()
