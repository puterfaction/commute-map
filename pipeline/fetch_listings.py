#!/usr/bin/env python3
"""Fetch NYC apartment listings from Craigslist's search API and tag them
with bedrooms/amenities via filtered segment queries.

Output: ../web/data/listings-craigslist.json
  {asOf, count, listings: [[lat, lon, price, br, flagsBitmask], ...]}

flags bits: 1 w/d in unit, 2 balcony/terrace, 4 A/C, 8 dishwasher,
            16 doorman, 32 gym, 64 cats ok, 128 dogs ok, 256 no broker fee

br: 0 studio, 1-2 exact, 3 = 3+, -1 unknown

Craigslist's sapi returns a positional encoding; we use:
  item[0] = posting id offset (add decode.minPostingId)
  item[3] = price (int)
  item[4] = "locIdx:descIdx~lat~lon" (lat/lon may be absent -> skip)

Run from anywhere craigslist doesn't block (cloud OK as of 2026-07).
Canonical copy lives here; the public repo (puterfaction/commute-map) carries
an identical copy at pipeline/fetch_listings.py, run monthly by a GitHub
Action (.github/workflows/refresh-craigslist.yml). Keep them in sync.
Usage: fetch_listings.py [OUT_PATH]   (default: ../web/data/listings-craigslist.json)
Be polite: ~0.6 s between requests, ~60-90 s total.
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

BASE = "https://sapi.craigslist.org/web/v8/postings/search/full"
AREA = 3          # newyork
BATCH_SIZE = 360
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
DELAY_S = 0.6
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "web", "data", "listings-craigslist.json")

# NYC-ish bounding box (drops NJ/Westchester/LI listings in the feed)
BBOX = (40.49, 40.94, -74.27, -73.68)
PRICE_MIN, PRICE_MAX = 700, 25000

SEGMENTS = [
    # (flag bit, params) — each crawl collects posting ids
    (1,   {"laundry": "1"}),
    (2,   {"query": "balcony|terrace"}),
    (4,   {"airconditioning": "1"}),
    (8,   {"query": "dishwasher"}),
    (16,  {"query": "doorman"}),
    (32,  {"query": "gym|fitness"}),
    (64,  {"pets_cat": "1"}),
    (128, {"pets_dog": "1"}),
    (256, {"broker_fee": "1"}),
]
BEDROOM_SEGMENTS = [
    (0, {"min_bedrooms": "0", "max_bedrooms": "0"}),
    (1, {"min_bedrooms": "1", "max_bedrooms": "1"}),
    (2, {"min_bedrooms": "2", "max_bedrooms": "2"}),
    (3, {"min_bedrooms": "3"}),
]

LOC_RE = re.compile(r"^\d+:\d+~(-?[\d.]+)~(-?[\d.]+)")


def api(params, offset):
    q = {
        "batch": f"{AREA}-{offset}-{BATCH_SIZE}-0-0",
        "cc": "US",
        "lang": "en",
        "searchPath": "apa",
        "sort": "dateoldest",
    }
    q.update(params)
    url = BASE + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://newyork.craigslist.org/"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_page(params):
    """One API call -> (parsed {pid: (price, lat, lon)}, totalResultCount)."""
    for attempt in range(4):
        try:
            d = api(params, 0)
            if not isinstance(d.get("data", {}).get("decode"), dict):
                # zero-result queries come back without a decode table
                if not d.get("data", {}).get("items") and attempt >= 1:
                    time.sleep(DELAY_S)
                    return {}, 0
                raise ValueError("decode not a dict (retrying to rule out a transient)")
            break
        except Exception as e:
            if attempt == 3:
                raise
            print(f"  retry {json.dumps(params)}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    data = d["data"]
    min_id = data["decode"].get("minPostingId", 0)
    out = {}
    for it in data.get("items", []):
        if not isinstance(it, list) or len(it) < 5 or not isinstance(it[0], int):
            continue
        pid = it[0] + min_id
        price = it[3] if isinstance(it[3], int) else None
        lat = lon = None
        if isinstance(it[4], str):
            m = LOC_RE.match(it[4])
            if m:
                lat, lon = float(m.group(1)), float(m.group(2))
        out[pid] = (price, lat, lon)
    time.sleep(DELAY_S)
    return out, data.get("totalResultCount", 0)


def crawl(params, label=""):
    """All results for a query, sidestepping pagination by recursively
    splitting the price range until each slice fits in one page."""
    out = {}

    def slice_(lo, hi):
        p = dict(params)
        p["min_price"], p["max_price"] = str(lo), str(hi)
        page, total = fetch_page(p)
        if total <= BATCH_SIZE or hi - lo <= 1:
            out.update(page)
            return
        mid = (lo + hi) // 2
        slice_(lo, mid)
        slice_(mid + 1, hi)

    slice_(PRICE_MIN, PRICE_MAX)
    # sub-$PRICE_MIN and unpriced listings are dropped by design
    print(f"  {label or json.dumps(params)}: {len(out)} listings")
    return out


def main():
    print("master crawl…")
    master = crawl({}, label="all")

    br_of = {}
    for br, params in BEDROOM_SEGMENTS:
        print(f"bedrooms={br} crawl…")
        for pid in crawl(params, label=f"br{br}"):
            br_of[pid] = br
        time.sleep(DELAY_S)

    flags_of = {}
    for bit, params in SEGMENTS:
        print(f"segment {bit} crawl…")
        for pid in crawl(params, label=f"flag{bit}"):
            flags_of[pid] = flags_of.get(pid, 0) | bit
        time.sleep(DELAY_S)

    rows = []
    dropped = 0
    for pid, (price, lat, lon) in master.items():
        if price is None or lat is None:
            dropped += 1
            continue
        if not (BBOX[0] <= lat <= BBOX[1] and BBOX[2] <= lon <= BBOX[3]):
            dropped += 1
            continue
        if not (PRICE_MIN <= price <= PRICE_MAX):
            dropped += 1
            continue
        rows.append([round(lat, 5), round(lon, 5), price, br_of.get(pid, -1), flags_of.get(pid, 0)])

    out = {
        "asOf": date.today().isoformat(),
        "source": "craigslist apa (newyork)",
        "count": len(rows),
        "flagBits": {"wd": 1, "balcony": 2, "ac": 4, "dishwasher": 8, "doorman": 16, "gym": 32, "cats": 64, "dogs": 128, "nofee": 256},
        "listings": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {len(rows)} listings ({dropped} dropped) -> {OUT}")
    with_br = sum(1 for r in rows if r[3] >= 0)
    print(f"bedroom coverage: {with_br}/{len(rows)}")


if __name__ == "__main__":
    main()
