#!/usr/bin/env python3
"""
Fetch the raw OpenStreetMap context for one curated example via the Overpass API.

    python3 scripts/fetch_osm.py <example-id> <camera-lat> <camera-lon> <heading-deg>

One query per example: buildings (ways + multipolygon relations, full member geometry), natural=tree nodes,
natural=tree_row ways and highway ways around a point 35 m ahead of the camera. The raw JSON response is
written to data/raw/<example-id>/osm.json together with the query text, endpoint and UTC retrieval time
(`_sunvision` key) so the scene build is reproducible offline.

Etiquette: a single request (retried with back-off only on 429/5xx/timeouts), a generic User-Agent, and
public mirrors only as a fallback. Data © OpenStreetMap contributors, ODbL 1.0.
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

UA = "Sunvision/0.1 (open-source research prototype)"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    eid, lat, lon, hdg = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    d = 35.0  # query centre 35 m ahead of the camera along the heading
    clat = lat + d * math.cos(math.radians(hdg)) / 111320
    clon = lon + d * math.sin(math.radians(hdg)) / (111320 * math.cos(math.radians(lat)))
    q = f"""[out:json][timeout:60];
( way["building"](around:220,{clat:.7f},{clon:.7f});
  relation["building"]["type"="multipolygon"](around:220,{clat:.7f},{clon:.7f});
  node["natural"="tree"](around:200,{clat:.7f},{clon:.7f});
  way["natural"="tree_row"](around:200,{clat:.7f},{clon:.7f});
  way["highway"](around:200,{clat:.7f},{clon:.7f}); );
out body geom;"""
    out = ROOT / "data" / "raw" / eid / "osm.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    for url in ENDPOINTS:
        for attempt in range(8 if url == ENDPOINTS[0] else 2):
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
                js = json.loads(urllib.request.urlopen(req, timeout=120).read())
                js["_sunvision"] = dict(query=q, endpoint=url, retrieved=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                        centre=[clat, clon])
                out.write_text(json.dumps(js))
                c = Counter((e["type"], "building" if "building" in e.get("tags", {}) else e.get("tags", {}).get("natural")
                             or ("highway" if "highway" in e.get("tags", {}) else "?")) for e in js["elements"])
                print(eid, url, dict(c), flush=True)
                return
            except Exception as e:  # 429 / 502 / 504 / timeouts on busy public instances
                print("retry", url, e, flush=True)
                time.sleep(min(60, 8 * (attempt + 1)))
    sys.exit(f"{eid}: all Overpass endpoints failed")


if __name__ == "__main__":
    main()
