#!/usr/bin/env python3
"""Extra photographs of the SURROUNDINGS of each curated example (multi-view obstacles).

A curated example has one primary photo of the target facade. The buildings that shade that facade
(across the street / canal, and the immediate neighbours) are otherwise only known from map tags.
This script adds openly licensed Wikimedia Commons photographs of those obstacle buildings as
`PhotoView`s (web/src/schema/scene.ts) in the example's `scene.base.json` -> "extraViews".

Sub-commands (run from repo root or anywhere; paths are resolved from this file):

    # 1. network: Commons API metadata + original download (SHA-1 verified) -> resized photo.jpg
    cd api && uv run python ../scripts/add_views.py fetch [exampleId ...]
    # 2. Roboflow + depth for each view (see scripts/analyze_view.py)
    cd api && uv run --extra depth python ../scripts/analyze_view.py <exampleId> <viewId>
    # 3. offline: camera + footprint ray casts -> patch "extraViews" into scene.base.json
    cd api && uv run python ../scripts/add_views.py build [exampleId ...]
    # 4. offline: plan plot of every view's camera and FOV over the footprints (also before step 2)
    cd api && uv run python ../scripts/add_views.py plot [exampleId ...] [--out <dir>]

Only the "extraViews" key of scene.base.json is written; every other field is preserved exactly
(the NYC camera there is hand-resected, see scripts/solve_camera.py). scripts/build_scene.py is imported for its exact WGS84 ENU
transform and 2D helpers, never run.

Files
    data/raw/<id>/views/manifest.json                provenance per view (original URL, SHA-1s, license, ...)
    data/raw/<id>/views/<viewId>/commons_api.json    raw Commons API response (imageinfo + wikitext)
    web/public/examples/<id>/views/<viewId>/photo.jpg  <= 2000 px long side, JPEG q88, no EXIF/XMP/ICC
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_scene import (  # noqa: E402  (exact WGS84 ENU + 2D helpers; main() is not run)
    ENU,
    bearing_of,
    bearing_vec,
    first_hit,
    outward_normal,
    point_in_ring,
    ring_distance,
    signed_area,
)

EXAMPLES_DIR = ROOT / "web" / "public" / "examples"
RAW_DIR = ROOT / "data" / "raw"
UA = "Sunvision/0.1 (open-source research prototype)"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
MAX_SIDE = 2000
JPEG_QUALITY = 88
FULL_FRAME_DIAGONAL_MM = math.hypot(36.0, 24.0)  # 43.27 mm: 35 mm-equivalent focal lengths use the diagonal

# --------------------------------------------------------------------------------------
# Curated view list. Every value is copied from the Commons file page / EXIF or marked as an
# assumption. Selection rationale and rejected candidates: docs/research/views.md.
# --------------------------------------------------------------------------------------
VIEWS: dict[str, list[dict]] = {
    "amsterdam-herengracht": [
        dict(
            id="across-canal-261",
            title="File:Herengracht 261.JPG",
            label="Across the canal: Herengracht 259–263 (east quay)",
            camera=dict(
                mode="subject-geotag",  # {{location dec}} marks the photographed house, not the photographer
                facadeBearing=270.0,  # the east-quay houses face west onto the Herengracht
                # Inferred from the photo: the 3-bay facade of no. 261 spans ~0.34 of the frame width (by eye on the
                # 960-px Commons thumbnail) and its OSM edge is 5.24 m, so at hfov 26.1° the distance is
                # 5.24 / (0.34 * 2 tan 13.05°) = 33 m, i.e. the camera stood at the west quay wall (tree line).
                standoff=33.0,
                standoffNote="5.24 m facade spanning ~0.34 of the frame at hfov 26.1° -> 33 m",
                sensorPx=[4000, 3000],  # Nikon COOLPIX L110 native 12 MP frame (published 3000x4000 = rotated, uncropped)
            ),
            notes=[
                "Same photographer, camera and series as the primary photo (Evert100, COOLPIX L110, January 2011); "
                "the Commons {{location dec}} geotag (heading 'N') is the address point of the photographed house, "
                "so the camera is placed on the opposite (west) quay, i.e. on the target's side of the canal.",
            ],
        ),
        dict(
            id="across-canal-263",
            title="File:Herengracht 263.JPG",
            label="Across the canal: Herengracht 261–265 (east quay)",
            # No. 263 (OSM edge 6.11 m) spans ~0.48 of the frame at hfov 21.9° -> 6.11 / (0.48 * 2 tan 10.97°) = 33 m:
            # the same spot on the west quay wall as across-canal-261.
            camera=dict(mode="subject-geotag", facadeBearing=270.0, standoff=33.0,
                        standoffNote="6.11 m facade spanning ~0.48 of the frame at hfov 21.9° -> 33 m", sensorPx=[4000, 3000]),
            notes=[
                "Same series as across-canal-261, taken 16 s later one house further south; together the two views "
                "cover the four houses directly opposite Herengracht 256.",
            ],
        ),
    ],
    "paris-boulevard-diderot": [
        dict(
            id="gare-de-lyon-south",
            title="File:Vue de la gare de Lyon (Paris) sous la pluie en juin 2023.JPG",
            label="Across the boulevard: Gare de Lyon and its clock tower (south)",
            camera=dict(
                mode="geotag",
                sensorPx=[4032, 3024],  # iPhone 13 main camera native 12 MP frame
                croppedFromSensor=True,  # 3690x2898 published, EXIF Software 'GIMP 2.10.34'
            ),
            notes=[
                "Camera geotag + compass heading from the Commons {{Location dec}} template (phone GPS/compass, "
                "accuracy unknown). The camera stands on Boulevard Diderot ~25 m in front of the target facade, "
                "looking away from it towards the obstacles that face it.",
            ],
        ),
        dict(
            id="rue-de-lyon-southwest",
            title="File:Place Combattants Afrique Nord - Paris XII (FR75) - 2021-05-23 - 1.jpg",
            label="South-west across Rue de Lyon: Gare de Lyon west wing and towers",
            camera=dict(mode="geotag", sensorPx=[4032, 3024]),  # iPhone XS, uncropped
            notes=[
                "Camera geotag + compass heading from the Commons {{Location}} template (phone GPS/compass, "
                "accuracy unknown). Same photographer (Chabe01) as the primary photo. Covers the afternoon-sun "
                "sector (south-west) of the target facade.",
            ],
        ),
    ],
    "nyc-ridge-street": [
        dict(
            id="ps140-across-ridge",
            title="File:Straus School PS 140 jeh.jpg",
            label="Across Ridge Street: Nathan Straus School (PS 140)",
            camera=dict(
                mode="geotag",
                sensorPx=[4608, 3456],  # Nikon COOLPIX P610 native 16 MP frame
                croppedFromSensor=None,  # unknown: 3561x2671 = 0.773 x native on both axes, edited in Windows Photo Editor
            ),
            notes=[
                "Camera geotag from the Commons {{Location}} template; heading 'NbW' (north by west, 348.75°) is a "
                "32-point compass label, i.e. ±5.6° at best.",
            ],
        ),
    ],
}

COMPASS_32 = [
    "N", "NbE", "NNE", "NEbN", "NE", "NEbE", "ENE", "EbN", "E", "EbS", "ESE", "SEbE", "SE", "SEbS", "SSE", "SbE",
    "S", "SbW", "SSW", "SWbS", "SW", "SWbW", "WSW", "WbS", "W", "WbN", "WNW", "NWbW", "NW", "NWbN", "NNW", "NbW",
]


# --------------------------------------------------------------------------------------
# Commons helpers
# --------------------------------------------------------------------------------------
def http_get(url: str, data: dict | None = None, timeout: int = 120, tries: int = 4) -> bytes:
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as exc:  # 429 / transient proxy errors: back off politely
            if k == tries - 1:
                raise
            wait = 15 * (k + 1)
            print(f"  {type(exc).__name__}: {exc}; retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError("unreachable")


def commons_query(title: str) -> dict:
    params = dict(
        action="query", format="json", formatversion=2, maxlag=5, titles=title,
        prop="imageinfo|revisions", iiprop="url|size|sha1|mime|extmetadata|commonmetadata",
        rvprop="content|ids|timestamp", rvslots="main",
    )
    d = json.loads(http_get(COMMONS_API, params))
    if "error" in d:
        raise RuntimeError(f"Commons API error for {title}: {d['error']}")
    return d


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def parse_heading(token: str | None) -> float | None:
    if token is None:
        return None
    token = token.strip()
    try:
        return float(token) % 360.0
    except ValueError:
        pass
    if token in COMPASS_32:
        return COMPASS_32.index(token) * 11.25
    return None


def parse_location(wikitext: str) -> dict | None:
    """Camera {{Location}} / {{Location dec}} template (not {{Object location}}) -> lat, lon, heading."""
    for m in re.finditer(r"\{\{\s*([Ll]ocation(?: dec)?|[Cc]amera location(?: dec)?)\s*\|([^}]*)\}\}", wikitext):
        parts = [p.strip() for p in m.group(2).split("|")]
        named = {}
        pos = []
        for p in parts:
            if "=" in p:
                k, v = p.split("=", 1)
                named[k.strip()] = v.strip()
            else:
                pos.append(p)
        params = "_".join([x for x in pos if ":" in x] + [named.get("attributes", "")])
        nums = [x for x in pos if ":" not in x]
        heading_tok = None
        hm = re.search(r"heading:([^_|]+)", params)
        if hm:
            heading_tok = hm.group(1)
        if len(nums) >= 8 and nums[3] in "NS" and nums[7] in "EW":  # d|m|s|N|d|m|s|E
            lat = float(nums[0]) + float(nums[1]) / 60 + float(nums[2]) / 3600
            lon = float(nums[4]) + float(nums[5]) / 60 + float(nums[6]) / 3600
            lat, lon = (lat if nums[3] == "N" else -lat), (lon if nums[7] == "E" else -lon)
        elif len(nums) >= 6 and nums[2] in "NS" and nums[5] in "EW":  # d|m|N|d|m|E
            lat = float(nums[0]) + float(nums[1]) / 60
            lon = float(nums[3]) + float(nums[4]) / 60
            lat, lon = (lat if nums[2] == "N" else -lat), (lon if nums[5] == "E" else -lon)
        elif len(nums) >= 4 and nums[1] in "NS" and nums[3] in "EW":  # dec|N|dec|E
            lat = float(nums[0]) * (1 if nums[1] == "N" else -1)
            lon = float(nums[2]) * (1 if nums[3] == "E" else -1)
        else:
            lat, lon = float(nums[0]), float(nums[1])
        return dict(template=m.group(0), lat=lat, lon=lon, headingRaw=heading_tok, heading=parse_heading(heading_tok))
    return None


def exif_subset(ii: dict) -> dict:
    keep = ("Make", "Model", "DateTimeOriginal", "FocalLength", "FocalLengthIn35mmFilm", "Software", "Orientation",
            "GPSImgDirection", "DigitalZoomRatio")
    out = {}
    for m in ii.get("commonmetadata", []):
        if m["name"] in keep and not isinstance(m["value"], (list, dict)):
            v = m["value"]
            out[m["name"]] = v.strip() if isinstance(v, str) else v
    return out


def rational(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if "/" in str(v):
        a, b = str(v).split("/", 1)
        return float(a) / float(b) if float(b) else None
    try:
        return float(v)
    except ValueError:
        return None


# --------------------------------------------------------------------------------------
# fetch: metadata + original -> resized, EXIF-free photo.jpg + manifest
# --------------------------------------------------------------------------------------
def fetch(eid: str, cache: Path) -> None:
    from PIL import Image, ImageOps
    import numpy as np

    views = VIEWS.get(eid, [])
    manifest_path = RAW_DIR / eid / "views" / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else dict(views=[])
    by_id = {v["viewId"]: v for v in manifest["views"]}
    for v in views:
        vid = v["id"]
        raw_dir = RAW_DIR / eid / "views" / vid
        out_dir = EXAMPLES_DIR / eid / "views" / vid
        raw_dir.mkdir(parents=True, exist_ok=True)
        out_dir.mkdir(parents=True, exist_ok=True)
        api_path = raw_dir / "commons_api.json"
        if api_path.exists():
            d = json.loads(api_path.read_text())
        else:
            d = commons_query(v["title"])
            d["_sunvision"] = dict(retrieved=date.today().isoformat(), endpoint=COMMONS_API)
            api_path.write_text(json.dumps(d, ensure_ascii=False, indent=1))
            time.sleep(2)
        page = d["query"]["pages"][0]
        ii = page["imageinfo"][0]
        em = {k: (x.get("value") if isinstance(x, dict) else x) for k, x in ii.get("extmetadata", {}).items()}
        original_url = ii["url"].split("?")[0]
        cached = cache / f"{ii['sha1']}{Path(urllib.parse.urlparse(original_url).path).suffix.lower()}"
        if not cached.exists():
            print(f"{eid}/{vid}: downloading {original_url} ({ii['size'] / 1e6:.1f} MB)")
            data = http_get(original_url)
            cached.write_bytes(data)
            time.sleep(3)
        data = cached.read_bytes()
        sha1 = hashlib.sha1(data).hexdigest()
        if sha1 != ii["sha1"]:
            raise SystemExit(f"{eid}/{vid}: SHA-1 mismatch {sha1} != Commons {ii['sha1']}")

        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            ow, oh = im.size
            rgb = np.asarray(im.convert("RGB"), dtype=np.uint8)
        scale = min(1.0, MAX_SIDE / max(ow, oh))
        clean = Image.fromarray(rgb)  # a fresh image: no EXIF / XMP / ICC carried over
        if scale < 1.0:
            clean = clean.resize((round(ow * scale), round(oh * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        clean.save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
        (out_dir / "photo.jpg").write_bytes(buf.getvalue())
        w, h = clean.size
        transformations = ([f"downscaled from {ow}x{oh} to {w}x{h} (Lanczos)"] if scale < 1.0 else []) + [
            f"re-encoded JPEG q{JPEG_QUALITY}", "all EXIF/XMP/ICC metadata stripped"]
        loc = parse_location(page["revisions"][0]["slots"]["main"]["content"])
        lic = em.get("LicenseShortName", "")
        by_id[vid] = dict(
            viewId=vid,
            commonsTitle=page["title"],
            filePage=ii["descriptionurl"],
            originalUrl=original_url,
            originalSize=[ii["width"], ii["height"]],
            originalBytes=ii["size"],
            originalSha1=ii["sha1"],
            creator=strip_html(em.get("Artist", "")),
            license=lic,
            licenseUrl=(em.get("LicenseUrl") or "").replace("http://", "https://"),
            credit=strip_html(em.get("Credit", "")),
            dateTimeOriginal=em.get("DateTimeOriginal"),
            commonsLocationTemplate=loc["template"] if loc else None,
            exif=exif_subset(ii),
            shippedFile=f"web/public/examples/{eid}/views/{vid}/photo.jpg",
            shippedSize=[w, h],
            shippedSha1=hashlib.sha1(buf.getvalue()).hexdigest(),
            transformations=transformations,
            retrieved=d.get("_sunvision", {}).get("retrieved"),
            commonsApiFile=f"data/raw/{eid}/views/{vid}/commons_api.json",
        )
        print(f"{eid}/{vid}: {page['title']} [{lic}] {ow}x{oh} -> {w}x{h}, sha1 ok")
    manifest = dict(
        generatedBy="scripts/add_views.py fetch",
        note="Extra views of the surroundings (multi-view obstacles). Originals are not stored; re-download from originalUrl and verify originalSha1.",
        views=[by_id[v["id"]] for v in views if v["id"] in by_id],
    )
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


# --------------------------------------------------------------------------------------
# build: PhotoView per photo -> scene.base.json "extraViews"
# --------------------------------------------------------------------------------------
def hfov_from_focal35(f35: float, w: int, h: int) -> float:
    """Horizontal FOV from a 35 mm-equivalent focal length (diagonal convention, 43.27 mm).
    For a 3:2 landscape frame the horizontal side is exactly 36 mm, i.e. 2·atan(36 / 2f)."""
    side = FULL_FRAME_DIAGONAL_MM * w / math.hypot(w, h)
    return math.degrees(2 * math.atan(side / (2 * f35)))


def subject_footprint(enu_pt, footprints):
    inside = [f for f in footprints if point_in_ring(enu_pt, f["ring"])]
    if inside:
        return min(inside, key=lambda f: abs(signed_area(f["ring"])))
    d, fid = min((ring_distance(enu_pt, f["ring"]), f["id"]) for f in footprints)
    if d > 6.0:
        raise SystemExit(f"subject geotag is {d:.1f} m from the nearest footprint")
    return next(f for f in footprints if f["id"] == fid)


def facing_edge(ring, bearing):
    ang = lambda i: abs(((bearing_of(outward_normal(ring, i)) - bearing) + 180) % 360 - 180)
    return min(range(len(ring)), key=lambda i: (round(ang(i) / 10), -math.dist(ring[i], ring[(i + 1) % len(ring)])))


def view_camera(eid: str, v: dict, scene: dict, entry: dict, photo_wh: tuple[int, int]) -> tuple[dict, dict]:
    """Returns (CameraParams, extra info for exif/notes)."""
    enu = ENU(scene["origin"]["lat"], scene["origin"]["lon"])
    api = json.loads((ROOT / entry["commonsApiFile"]).read_text())
    page = api["query"]["pages"][0]
    loc = parse_location(page["revisions"][0]["slots"]["main"]["content"])
    if not loc:
        raise SystemExit(f"{eid}/{v['id']}: no {{{{Location}}}} template on the file page")
    cc = v["camera"]
    notes = list(v.get("notes", []))
    geo_pt = enu.xy(loc["lat"], loc["lon"])
    info = dict(loc=loc)
    if cc["mode"] == "geotag":
        pos = geo_pt
        pos_prov = "observed"
        if loc["heading"] is None:
            raise SystemExit(f"{eid}/{v['id']}: geotag has no heading")
        heading = round(loc["heading"], 2)
        head_prov = "observed"
        info["gps"] = dict(lat=loc["lat"], lon=loc["lon"])
        notes.append(f"Commons geotag {loc['template']} -> ENU ({pos[0]:.1f}, {pos[1]:.1f}) m in the scene frame.")
    else:
        subj = subject_footprint(geo_pt, scene["footprints"])
        ring = subj["ring"]
        e = facing_edge(ring, cc["facadeBearing"])
        nrm = outward_normal(ring, e)
        a, b = ring[e], ring[(e + 1) % len(ring)]
        mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        d = cc["standoff"]
        pos = [round(mid[0] + nrm[0] * d, 3), round(mid[1] + nrm[1] * d, 3)]
        heading = round(bearing_of((-nrm[0], -nrm[1])), 2)
        pos_prov = head_prov = "inferred"
        info["subject"] = dict(id=subj["id"], edge=e, width=math.dist(a, b), mid=mid)
        notes.append(
            f"Commons geotag {loc['template']} marks the subject ({subj['id']}, {math.dist(geo_pt, mid):.1f} m from the "
            f"midpoint of its edge {e}), not the photographer. Camera placed {d:.0f} m in front of that "
            f"{math.dist(a, b):.1f} m facade along its normal (bearing {bearing_of(nrm):.1f}°), heading = reverse "
            f"normal ({heading:.1f}°): the photo is near-frontal."
            + (f" Distance from the facade's apparent width: {cc['standoffNote']} (by eye)." if cc.get("standoffNote") else "")
        )
    ex = entry["exif"]
    f35 = ex.get("FocalLengthIn35mmFilm")
    w, h = photo_wh
    ow, oh = entry["originalSize"]
    if f35:
        sensor = cc.get("sensorPx")
        portrait = h > w
        sw, sh = (sensor if sensor else [ow, oh])
        if sensor and portrait != (sh > sw):
            sw, sh = sh, sw
        full = hfov_from_focal35(float(f35), sw, sh)
        crop = cc.get("croppedFromSensor")
        if (ow, oh) == (sw, sh) or crop is False or not sensor:
            hfov, hfov_prov = full, "inferred"
            notes.append(f"hfov {full:.1f}° from EXIF 35 mm-equivalent focal length {f35} mm on the uncropped "
                         f"{sw}x{sh} frame (diagonal convention, 43.27 mm).")
        elif crop:
            frac = ow / sw
            hfov = math.degrees(2 * math.atan(frac * math.tan(math.radians(full / 2))))
            hfov_prov = "inferred"
            notes.append(f"Published file {ow}x{oh} is a crop of the {sw}x{sh} sensor frame (EXIF Software "
                         f"'{ex.get('Software', '?')}'). hfov {hfov:.1f}° assumes the crop kept the original pixel scale "
                         f"(full frame at {f35} mm eq. would be {full:.1f}°). Calibrate.")
        else:
            hfov, hfov_prov = full, "assumed"
            fr = ow / sw
            alt = math.degrees(2 * math.atan(fr * math.tan(math.radians(full / 2))))
            notes.append(f"Published file {ow}x{oh} is {fr:.3f}x the {sw}x{sh} native frame on both axes (EXIF Software "
                         f"'{ex.get('Software', '?')}'): either downscaled (hfov {full:.1f}° from {f35} mm eq.) or a "
                         f"same-aspect crop (hfov {alt:.1f}°). {full:.1f}° assumed. Calibrate.")
    else:
        hfov, hfov_prov = 60.0, "assumed"
        notes.append("No 35 mm-equivalent focal length in EXIF: hfov 60° assumed.")
    notes.append("Pitch 8° and lens height 1.6 m are assumptions (not measured); solve pitch from the ground line.")
    cam = dict(
        position=pos,
        height=1.6,
        heading=heading,
        pitch=8,
        roll=0.0,
        hfov=round(hfov, 2),
        provenance=dict(position=pos_prov, heading=head_prov, pitch="assumed", hfov=hfov_prov, height="assumed"),
        notes=notes,
    )
    return cam, info


def ray_cast_view(cam: dict, footprints: list[dict], max_dist: float = 120.0):
    o = cam["position"]
    axis = first_hit(o, bearing_vec(cam["heading"]), footprints, max_dist=max_dist)
    visible = []
    for k in range(121):
        ang = cam["heading"] - cam["hfov"] / 2 + cam["hfov"] * k / 120
        hit = first_hit(o, bearing_vec(ang), footprints, max_dist=max_dist)
        if hit and (axis is None or hit[1] != axis[1]) and hit[1] not in visible:
            visible.append(hit[1])
    return axis, visible


def photo_view(eid: str, v: dict, scene: dict, entry: dict, require_analysis: bool = True) -> dict:
    from PIL import Image

    vdir = EXAMPLES_DIR / eid / "views" / v["id"]
    with Image.open(vdir / "photo.jpg") as im:
        w, h = im.size
    cam, info = view_camera(eid, v, scene, entry, (w, h))
    axis, visible = ray_cast_view(cam, scene["footprints"])
    if axis is None:
        raise SystemExit(f"{eid}/{v['id']}: optical axis hits no footprint within 120 m")
    analysis_path = vdir / "analysis.json"
    if not analysis_path.exists():
        if require_analysis:
            raise SystemExit(f"{eid}/{v['id']}: run scripts/analyze_view.py {eid} {v['id']} first")
        analysis = dict(imageWidth=w, imageHeight=h, detections=[], classCounts={})
    else:
        analysis = json.loads(analysis_path.read_text())
    if (analysis["imageWidth"], analysis["imageHeight"]) != (w, h):
        raise SystemExit(f"{eid}/{v['id']}: analysis is {analysis['imageWidth']}x{analysis['imageHeight']}, photo {w}x{h}")
    ex = entry["exif"]
    dto = ex.get("DateTimeOriginal")
    capture = None
    if dto and re.match(r"\d{4}:\d\d:\d\d \d\d:\d\d:\d\d", dto):
        capture = dto[:10].replace(":", "-") + "T" + dto[11:19]
    exif = dict(
        gps=info.get("gps"),
        focalLength35mm=ex.get("FocalLengthIn35mmFilm"),
        focalLengthMm=round(rational(ex.get("FocalLength")), 3) if ex.get("FocalLength") else None,
        # A subject geotag's heading describes nothing about this camera (e.g. Evert100's 'N'): kept only in notes.
        heading=round(info["loc"]["heading"], 2) if info["loc"]["heading"] is not None and "gps" in info else None,
        captureTime=capture,
        make=ex.get("Make"),
        model=ex.get("Model"),
    )
    return dict(
        id=v["id"],
        label=v["label"],
        purpose="surroundings",
        image=dict(
            url=f"views/{v['id']}/photo.jpg",
            width=w,
            height=h,
            attribution=dict(
                title=entry["commonsTitle"],
                creator=entry["creator"],
                license=entry["license"],
                licenseUrl=entry["licenseUrl"],
                sourceUrl=entry["filePage"],
                originalUrl=entry["originalUrl"],
                captureDate=capture,
                transformations=entry["transformations"],
            ),
            exif={k: x for k, x in exif.items() if x is not None},
        ),
        camera=cam,
        analysis=analysis,
        targetBuildingId=axis[1],
        facadeEdgeIndex=axis[2],
        visibleBuildingIds=visible,
    )


def build(eid: str) -> None:
    path = EXAMPLES_DIR / eid / "scene.base.json"
    text = path.read_text()
    scene = json.loads(text)
    views = computed_views(eid, scene, require_analysis=True)
    before = {k: x for k, x in scene.items() if k != "extraViews"}
    if views:
        scene["extraViews"] = views
    else:
        scene.pop("extraViews", None)
    out = json.dumps(scene, ensure_ascii=False, separators=(",", ":"))
    # Guard: every pre-existing field must survive byte-for-byte.
    if {k: x for k, x in json.loads(out).items() if k != "extraViews"} != before:
        raise SystemExit(f"{eid}: refusing to write, a field other than extraViews would change")
    path.write_text(out)
    for pv in views:
        c = pv["camera"]
        print(f"{eid}/{pv['id']}: cam ({c['position'][0]:.1f}, {c['position'][1]:.1f}) heading {c['heading']} "
              f"hfov {c['hfov']} -> target {pv['targetBuildingId']} edge {pv['facadeEdgeIndex']}, "
              f"visible {pv['visibleBuildingIds']}, classes {pv['analysis'].get('classCounts')}")


# --------------------------------------------------------------------------------------
# plot: plan view of each view's camera + FOV over the footprints
# --------------------------------------------------------------------------------------
def computed_views(eid: str, scene: dict, require_analysis: bool) -> list[dict]:
    manifest = json.loads((RAW_DIR / eid / "views" / "manifest.json").read_text())
    entries = {m["viewId"]: m for m in manifest["views"]}
    return [photo_view(eid, v, scene, entries[v["id"]], require_analysis) for v in VIEWS.get(eid, []) if v["id"] in entries]


def plot(eid: str, out_dir: Path) -> None:
    """Plots the views recomputed from VIEWS + manifest (works before analysis/build too)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon

    scene = json.loads((EXAMPLES_DIR / eid / "scene.base.json").read_text())
    views = computed_views(eid, scene, require_analysis=False)
    for pv in views:
        c = pv["camera"]
        print(f"{eid}/{pv['id']}: cam ({c['position'][0]:.1f}, {c['position'][1]:.1f}) heading {c['heading']} "
              f"hfov {c['hfov']} ({c['provenance']}) -> target {pv['targetBuildingId']} edge {pv['facadeEdgeIndex']}, "
              f"visible {pv['visibleBuildingIds']}")
    fig, ax = plt.subplots(figsize=(10, 10))
    vis_ids = {b for pv in views for b in pv["visibleBuildingIds"]}
    tgt_ids = {pv["targetBuildingId"] for pv in views}
    for r in scene.get("roads", []):
        xs, ys = zip(*r["line"])
        ax.plot(xs, ys, color="#dddddd", lw=2, zorder=0)
    for fp in scene["footprints"]:
        fid = fp["id"]
        col = "#e07800" if fid == scene["targetBuildingId"] else "#c00000" if fid in tgt_ids else "#3070d0" if fid in vis_ids else "#999999"
        ax.add_patch(Polygon(fp["ring"], closed=True, fill=fid in tgt_ids or fid == scene["targetBuildingId"],
                             facecolor=col + "33", edgecolor=col, lw=1.5 if col != "#999999" else 0.7))
    ring = next(f["ring"] for f in scene["footprints"] if f["id"] == scene["targetBuildingId"])
    e = scene["facadeEdgeIndex"]
    a, b = ring[e], ring[(e + 1) % len(ring)]
    ax.plot([a[0], b[0]], [a[1], b[1]], color="#e07800", lw=5, label="primary facade edge")
    pc = scene["camera"]
    for ang, ls in ((pc["heading"], "-"), (pc["heading"] - pc["hfov"] / 2, ":"), (pc["heading"] + pc["hfov"] / 2, ":")):
        d = bearing_vec(ang)
        ax.plot([pc["position"][0], pc["position"][0] + d[0] * 60], [pc["position"][1], pc["position"][1] + d[1] * 60], color="#e07800", ls=ls, lw=1)
    ax.plot(*pc["position"], "o", color="#e07800", ms=8, label="primary camera")
    colors = ["#c00000", "#8a2be2", "#008b8b"]
    xs_all, ys_all = [pc["position"][0], 0], [pc["position"][1], 0]
    for k, pv in enumerate(views):
        c = pv["camera"]
        col = colors[k % len(colors)]
        o = c["position"]
        for ang, ls in ((c["heading"], "-"), (c["heading"] - c["hfov"] / 2, "--"), (c["heading"] + c["hfov"] / 2, "--")):
            hit = first_hit(o, bearing_vec(ang), scene["footprints"], max_dist=120)
            L = hit[0] if hit else 120
            d = bearing_vec(ang)
            ax.plot([o[0], o[0] + d[0] * L], [o[1], o[1] + d[1] * L], color=col, ls=ls, lw=1.5)
            xs_all.append(o[0] + d[0] * L)
            ys_all.append(o[1] + d[1] * L)
        tr = next(f["ring"] for f in scene["footprints"] if f["id"] == pv["targetBuildingId"])
        i = pv["facadeEdgeIndex"]
        ax.plot([tr[i][0], tr[(i + 1) % len(tr)][0]], [tr[i][1], tr[(i + 1) % len(tr)][1]], color=col, lw=4)
        ax.plot(*o, "s", color=col, ms=8, label=f"{pv['id']} ({c['provenance']['position']} position)")
        xs_all.append(o[0])
        ys_all.append(o[1])
    cx, cy = (min(xs_all) + max(xs_all)) / 2, (min(ys_all) + max(ys_all)) / 2
    R = max(max(xs_all) - min(xs_all), max(ys_all) - min(ys_all)) / 2 + 30
    ax.set_xlim(cx - R, cx + R)
    ax.set_ylim(cy - R, cy + R)
    ax.set_aspect("equal")
    ax.set_title(f"{eid}: extra views (ENU m, north up). Orange = primary target; filled = view targets; blue = visible")
    ax.legend(loc="lower left", fontsize=8)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / ("views_plan.png" if out_dir.name == "views" else f"views_plan_{eid}.png")
    fig.savefig(out, dpi=90)
    plt.close(fig)
    print("plot ->", out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["fetch", "build", "plot"])
    ap.add_argument("examples", nargs="*")
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "sunvision-views-cache"),
                    help="where downloaded originals are kept (not committed)")
    ap.add_argument("--out", default=None, help="plot output directory (default data/raw/<id>/views)")
    args = ap.parse_args()
    ids = args.examples or list(VIEWS)
    for eid in ids:
        if eid not in VIEWS:
            raise SystemExit(f"unknown example {eid}")
        if args.command == "fetch":
            cache = Path(args.cache)
            cache.mkdir(parents=True, exist_ok=True)
            fetch(eid, cache)
        elif args.command == "build":
            build(eid)
        else:
            plot(eid, Path(args.out) if args.out else RAW_DIR / eid / "views")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
