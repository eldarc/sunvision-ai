#!/usr/bin/env python3
"""
Build `web/public/examples/<id>/scene.base.json` from real, recorded inputs.

Inputs (all committed to the repo, so the build is reproducible offline):
  data/examples.config.json        hand-curated per-example config (photo metadata, camera geotag, notes)
  data/raw/<id>/osm.json           raw Overpass API response (OpenStreetMap, ODbL)
  web/public/examples/<id>/photo.jpg   resized photograph (for its pixel size)

Output: a `Scene` (see web/src/schema/scene.ts) WITHOUT the `analysis` field.
The CV pipeline writes `analysis.json` next to it; the browser merges both.
Also written: web/public/examples/<id>/osm.json (the bundled ODbL snapshot the app reuses near the
example) and web/public/examples/index.json (with each example's `center` = scene origin, and
`card` when scripts/make_thumbs.py has written card.webp).

Coordinates: exact WGS84 geodetic -> ECEF -> local ENU tangent plane at the
origin (h = 0). See docs/coordinates.md. Origin = area centroid of the target
building footprint.

Usage (no third-party dependencies needed except Pillow for the image size):
    uv run --python 3.12 --with pillow scripts/build_scene.py            # all examples
    uv run --python 3.12 --with pillow scripts/build_scene.py --plot     # + debug PNG plots
    uv run --python 3.12 --with pillow scripts/build_scene.py nyc-ridge-street
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "data" / "examples.config.json"
EXAMPLES_DIR = ROOT / "web" / "public" / "examples"

# --------------------------------------------------------------------------------------
# WGS84 geodetic <-> ECEF <-> ENU (exact; mirrors web/src/engine/geo.ts)
# --------------------------------------------------------------------------------------
WGS84_A = 6378137.0
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)


def geodetic_to_ecef(lat: float, lon: float, h: float = 0.0) -> tuple[float, float, float]:
    phi, lam = math.radians(lat), math.radians(lon)
    s, c = math.sin(phi), math.cos(phi)
    n = WGS84_A / math.sqrt(1.0 - WGS84_E2 * s * s)
    return ((n + h) * c * math.cos(lam), (n + h) * c * math.sin(lam), (n * (1.0 - WGS84_E2) + h) * s)


def ecef_to_geodetic(x: float, y: float, z: float) -> tuple[float, float, float]:
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1.0 - WGS84_E2))
    h = 0.0
    for _ in range(10):  # converges to < 1e-12 rad in ~4 iterations near the surface
        s = math.sin(lat)
        n = WGS84_A / math.sqrt(1.0 - WGS84_E2 * s * s)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1.0 - WGS84_E2 * n / (n + h)))
    return math.degrees(lat), math.degrees(lon), h


class ENU:
    """Local East-North-Up frame at (lat0, lon0, h=0)."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.o = geodetic_to_ecef(lat0, lon0, 0.0)
        phi, lam = math.radians(lat0), math.radians(lon0)
        sp, cp, sl, cl = math.sin(phi), math.cos(phi), math.sin(lam), math.cos(lam)
        self.e = (-sl, cl, 0.0)
        self.n = (-sp * cl, -sp * sl, cp)
        self.u = (cp * cl, cp * sl, sp)

    def forward(self, lat: float, lon: float, h: float = 0.0) -> tuple[float, float, float]:
        x, y, z = geodetic_to_ecef(lat, lon, h)
        d = (x - self.o[0], y - self.o[1], z - self.o[2])
        dot = lambda a: a[0] * d[0] + a[1] * d[1] + a[2] * d[2]
        return dot(self.e), dot(self.n), dot(self.u)

    def inverse(self, e: float, n: float, u: float = 0.0) -> tuple[float, float, float]:
        x = self.o[0] + e * self.e[0] + n * self.n[0] + u * self.u[0]
        y = self.o[1] + e * self.e[1] + n * self.n[1] + u * self.u[1]
        z = self.o[2] + e * self.e[2] + n * self.n[2] + u * self.u[2]
        return ecef_to_geodetic(x, y, z)

    def xy(self, lat: float, lon: float) -> list[float]:
        """Horizontal ENU position of a ground point (h = 0). The up component (earth curvature,
        < 4 mm at 220 m) is intentionally dropped: the scene treats the ground as the plane z = 0."""
        e, n, _ = self.forward(lat, lon, 0.0)
        return [round(e, 3), round(n, 3)]


# --------------------------------------------------------------------------------------
# 2D geometry helpers
# --------------------------------------------------------------------------------------
def signed_area(ring):
    return 0.5 * sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))


def centroid(ring):
    a = signed_area(ring)
    if abs(a) < 1e-9:
        return [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]
    cx = cy = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        cr = x0 * y1 - x1 * y0
        cx += (x0 + x1) * cr
        cy += (y0 + y1) * cr
    return [cx / (6 * a), cy / (6 * a)]


def point_in_ring(p, ring):
    x, y, inside = p[0], p[1], False
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


def ring_distance(p, ring):
    best = float("inf")
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        ex, ey = b[0] - a[0], b[1] - a[1]
        L2 = ex * ex + ey * ey or 1e-12
        t = max(0.0, min(1.0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2))
        best = min(best, math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey))
    return best


def ray_segment(o, d, a, b):
    """Return distance t >= 0 along ray o + t d to segment ab, or None."""
    ex, ey = b[0] - a[0], b[1] - a[1]
    den = d[0] * ey - d[1] * ex
    if abs(den) < 1e-12:
        return None
    wx, wy = a[0] - o[0], a[1] - o[1]
    t = (wx * ey - wy * ex) / den
    s = (wx * d[1] - wy * d[0]) / den
    return t if t > 1e-6 and 0.0 <= s <= 1.0 else None


def bearing_vec(deg):
    r = math.radians(deg)
    return (math.sin(r), math.cos(r))


def outward_normal(ring, i):
    """Outward normal of edge i for a CCW ring (right-hand side of the edge direction)."""
    a, b = ring[i], ring[(i + 1) % len(ring)]
    ex, ey = b[0] - a[0], b[1] - a[1]
    L = math.hypot(ex, ey) or 1.0
    return (ey / L, -ex / L)


def bearing_of(v):
    return (math.degrees(math.atan2(v[0], v[1])) + 360.0) % 360.0


# --------------------------------------------------------------------------------------
# OSM parsing
# --------------------------------------------------------------------------------------
KEEP_TAGS = {
    "building", "building:levels", "roof:levels", "roof:shape", "height", "min_height", "building:min_level",
    "name", "addr:housenumber", "addr:street", "ref:bag", "start_date", "building:material", "nycdoitt:bin",
    "source:height",
}


def parse_float(v):
    if v is None:
        return None
    try:
        return float(str(v).replace(",", ".").replace("m", "").strip())
    except ValueError:
        return None


def assemble_rings(segments):
    """Join open way segments (lists of (lat, lon)) into closed rings."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def drop_collinear(ring, tol=0.10):
    """Remove vertices lying within `tol` metres of the line through their neighbours (lossless for the
    footprint shape; merges facade edges that OSM split into collinear pieces)."""
    pts = list(ring)
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, p, b = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            ex, ey = b[0] - a[0], b[1] - a[1]
            L = math.hypot(ex, ey)
            if L < 1e-9:
                continue
            dist = abs((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / L
            t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (L * L)
            if dist < tol and 0.0 < t < 1.0:
                pts.pop(i)
                changed = True
                break
    return pts


def to_enu_ring(enu, latlon_ring, ccw=True):
    pts = [enu.xy(la, lo) for la, lo in latlon_ring]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    # drop consecutive duplicates
    out = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
    out = drop_collinear(out)
    if (signed_area(out) > 0) != ccw:
        out.reverse()
    return out


def osm_buildings(osm):
    """Yield (id, tags, outer_latlon_ring, [inner_latlon_rings])."""
    for el in osm["elements"]:
        tags = el.get("tags", {})
        if "building" not in tags:
            continue
        if el["type"] == "way" and "geometry" in el:
            ring = [(g["lat"], g["lon"]) for g in el["geometry"]]
            if len(ring) >= 4 and ring[0] == ring[-1]:
                yield f"way/{el['id']}", tags, ring, []
        elif el["type"] == "relation":
            outers = [[(g["lat"], g["lon"]) for g in m.get("geometry", [])] for m in el.get("members", []) if m.get("role") == "outer"]
            inners = [[(g["lat"], g["lon"]) for g in m.get("geometry", [])] for m in el.get("members", []) if m.get("role") == "inner"]
            orings, irings = assemble_rings(outers), assemble_rings(inners)
            for k, o in enumerate(orings):
                yield (f"relation/{el['id']}" + (f"#{k}" if len(orings) > 1 else "")), tags, o, irings if k == 0 else []


# --------------------------------------------------------------------------------------
# Scene assembly
# --------------------------------------------------------------------------------------
def first_hit(cam, d, footprints, max_dist=200.0, exclude=()):
    best = None
    for fp in footprints:
        if fp["id"] in exclude:
            continue
        ring = fp["ring"]
        for i in range(len(ring)):
            t = ray_segment(cam, d, ring[i], ring[(i + 1) % len(ring)])
            if t is not None and t <= max_dist and (best is None or t < best[0]):
                best = (t, fp["id"], i)
    return best


def auto_validation(eid: str, target: dict, enu: ENU) -> list[dict]:
    """Reference heights for the target building from authoritative open datasets (validation ONLY).

    Raw API responses are stored under data/raw/<id>/ so this is reproducible offline."""
    refs = []
    raw_dir = ROOT / "data" / "raw" / eid
    c = centroid(target["ring"])
    # 3D BAG (Netherlands, CC BY 4.0): match by BAG pand id from the OSM ref:bag tag.
    bag = raw_dir / "3dbag_pand_items.json"
    if bag.exists() and target["tags"].get("ref:bag"):
        for f in json.loads(bag.read_text())["features"]:
            key = f"NL.IMBAG.Pand.{target['tags']['ref:bag']}"
            if key in f["CityObjects"]:
                a = f["CityObjects"][key]["attributes"]
                g = a["b3_h_maaiveld"]
                refs.append(dict(
                    source="3D BAG v2 (api.3dbag.nl, CC BY 4.0), pand " + key,
                    height=round(a["b3_h_dak_max"] - g, 2),
                    note=(f"height = b3_h_dak_max ({a['b3_h_dak_max']:.2f} m NAP) - b3_h_maaiveld ({g:.2f} m NAP); "
                          f"70th-percentile roof height b3_h_dak_70p - b3_h_maaiveld = {a['b3_h_dak_70p'] - g:.2f} m; "
                          f"construction year {a.get('oorspronkelijkbouwjaar')}. Derived from AHN lidar."),
                ))
    # IGN BD TOPO (France, Licence Ouverte 2.0): polygon containing the target centroid.
    bdt = raw_dir / "ign_bdtopo_batiment.json"
    if bdt.exists():
        for f in json.loads(bdt.read_text())["features"]:
            for poly in f["geometry"]["coordinates"]:
                ring = to_enu_ring(enu, [(p[1], p[0]) for p in poly[0]])
                if point_in_ring(c, ring):
                    pr = f["properties"]
                    refs.append(dict(
                        source=f"IGN BD TOPO v3 batiment {pr['cleabs']} (data.geopf.fr WFS, Licence Ouverte 2.0)",
                        height=pr.get("hauteur"), levels=pr.get("nombre_d_etages"),
                        note=(f"fields 'hauteur' and 'nombre_d_etages'; altimetric method: "
                              f"{pr.get('methode_d_acquisition_altimetrique')}, stated precision {pr.get('precision_altimetrique')} m."),
                    ))
    # OSM tags on the target itself (often imported from the datasets above).
    t = target["tags"]
    if "mapHeight" in target or "mapLevels" in target:
        src = t.get("source:height") or ("NYC DoITT building footprints import" if "nycdoitt:bin" in t else "unspecified")
        refs.append(dict(source=f"OpenStreetMap tags on {target['id']} (ODbL)", height=target.get("mapHeight"),
                         levels=target.get("mapLevels"), note=f"tags height / building:levels; OSM height source: {src}."))
    return [{k: v for k, v in r.items() if v is not None} for r in refs]


def build(eid: str, cfg: dict, plot: bool = False) -> dict:
    raw = json.loads((ROOT / "data" / "raw" / eid / "osm.json").read_text())
    cam_ll = (cfg["camera"]["lat"], cfg["camera"]["lon"])

    # Pass 1: temporary frame at the camera to pick the target building.
    tmp = ENU(*cam_ll)
    tmp_fps = [dict(id=i, ring=to_enu_ring(tmp, r)) for i, _, r, _ in osm_buildings(raw)]
    cam0 = [0.0, 0.0]
    if cfg.get("targetOsmId"):
        target_id = cfg["targetOsmId"]
    elif cfg.get("targetPoint"):
        # Footprint containing a geocoded address point (e.g. Nominatim result for the photographed address).
        tp = tmp.xy(*cfg["targetPoint"])
        cands = [f for f in tmp_fps if point_in_ring(tp, f["ring"])]
        if cands:
            target_id = min(cands, key=lambda f: abs(signed_area(f["ring"])))["id"]
        else:  # address points are often placed on the facade line: take the nearest footprint within 6 m
            d, fid = min((ring_distance(tp, f["ring"]), f["id"]) for f in tmp_fps)
            if d > 6.0:
                raise SystemExit(f"{eid}: targetPoint is {d:.1f} m from the nearest footprint")
            target_id = fid
    else:
        hit = first_hit(cam0, bearing_vec(cfg["camera"]["heading"]), tmp_fps)
        if not hit:
            raise SystemExit(f"{eid}: heading ray hits no building; set targetOsmId in config")
        target_id = hit[1]
    tfp = next(f for f in tmp_fps if f["id"] == target_id)
    c = centroid(tfp["ring"])
    lat0, lon0, _ = tmp.inverse(c[0], c[1], 0.0)
    enu = ENU(lat0, lon0)

    # Pass 2: final frame at the target centroid.
    footprints = []
    for oid, tags, ring_ll, holes_ll in osm_buildings(raw):
        ring = to_enu_ring(enu, ring_ll, ccw=True)
        if len(ring) < 3:
            continue
        cc = centroid(ring)
        if math.hypot(*cc) > cfg.get("radius", 230):
            continue
        fp = dict(id=oid, ring=ring, tags={k: v for k, v in tags.items() if k in KEEP_TAGS}, source="osm")
        holes = [to_enu_ring(enu, h, ccw=False) for h in holes_ll]
        holes = [h for h in holes if len(h) >= 3]
        if holes:
            fp["holes"] = holes
        mh = parse_float(tags.get("height"))
        ml = parse_float(tags.get("building:levels"))
        if mh is not None:
            fp["mapHeight"] = mh
        if ml is not None:
            fp["mapLevels"] = int(round(ml))
        footprints.append(fp)

    cam = enu.xy(*cam_ll)
    cam_cfg = cfg["camera"]
    target = next(f for f in footprints if f["id"] == target_id)

    # Facade edge: edge of the target hit by the heading ray (or forced in config), must face the camera.
    if "facadeEdgeIndex" in cfg:
        edge = cfg["facadeEdgeIndex"]
    else:
        if cfg.get("facadeBearing") is not None:
            # Edge whose outward normal is closest to the configured bearing (ties -> longer edge).
            ring = target["ring"]
            ang = lambda i: abs(((bearing_of(outward_normal(ring, i)) - cfg["facadeBearing"]) + 180) % 360 - 180)
            best = min(range(len(ring)), key=lambda i: (round(ang(i) / 10), -math.dist(ring[i], ring[(i + 1) % len(ring)])))
            hit = (0, target["id"], best)
        else:
            hit = first_hit(cam, bearing_vec(cam_cfg["heading"]), [target])
        if not hit:
            raise SystemExit(f"{eid}: heading ray misses target footprint; set facadeEdgeIndex or facadeBearing")
        edge = hit[2]
    nrm = outward_normal(target["ring"], edge)
    a, b = target["ring"][edge], target["ring"][(edge + 1) % len(target["ring"])]
    mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    to_cam = (cam[0] - mid[0], cam[1] - mid[1])
    if not cam_cfg.get("placeOnFacadeNormal") and nrm[0] * to_cam[0] + nrm[1] * to_cam[1] <= 0:
        raise SystemExit(f"{eid}: facade edge {edge} faces away from the camera")

    heading = cam_cfg["heading"]
    heading_prov = cam_cfg.get("headingProvenance", "observed")
    position_prov = "observed"
    notes = list(cam_cfg.get("notes", []))
    if cam_cfg.get("placeOnFacadeNormal"):
        # The geotag marks the subject, not the photographer: put the camera in front of the facade.
        dist = cam_cfg["placeOnFacadeNormal"]
        cam = [round(mid[0] + nrm[0] * dist, 3), round(mid[1] + nrm[1] * dist, 3)]
        heading, heading_prov, position_prov = round(bearing_of((-nrm[0], -nrm[1])), 2), "inferred", "inferred"
    if cam_cfg.get("refineHeadingToFacadeNormal"):
        refined = bearing_of((-nrm[0], -nrm[1]))
        notes.append(
            f"Commons heading '{cam_cfg.get('headingRaw', heading)}' is coarse; refined to the facade normal "
            f"({refined:.1f}°) because the photo is near-frontal."
        )
        heading, heading_prov = round(refined, 2), "inferred"

    # Visible neighbours: buildings first hit by rays spread across the horizontal FOV.
    hfov = cam_cfg["hfov"]
    visible = []
    for k in range(121):
        ang = heading - hfov / 2 + hfov * k / 120
        h = first_hit(cam, bearing_vec(ang), footprints, max_dist=150)
        if h and h[1] != target_id and h[1] not in visible:
            visible.append(h[1])

    # Trees (OSM natural=tree nodes + tree_row ways sampled every 8 m)
    trees = []
    for el in raw["elements"]:
        tags = el.get("tags", {})
        if tags.get("natural") == "tree" and el["type"] == "node":
            pts = [(el["lat"], el["lon"])]
        elif tags.get("natural") == "tree_row" and el["type"] == "way":
            line = [enu.xy(g["lat"], g["lon"]) for g in el.get("geometry", [])]
            pts = []
            for i in range(len(line) - 1):
                L = math.dist(line[i], line[i + 1])
                for s in range(int(L // 8) + 1):
                    t = s * 8 / L if L else 0
                    pts.append(enu.inverse(line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1]))[:2])
        else:
            continue
        for j, (la, lo) in enumerate(pts):
            p = enu.xy(la, lo)
            if math.hypot(*p) > cfg.get("treeRadius", 160):
                continue
            h = parse_float(tags.get("height"))
            dc = parse_float(tags.get("diameter_crown"))
            trees.append(dict(
                id=f"{el['type']}/{el['id']}" + (f"#{j}" if len(pts) > 1 else ""),
                position=p,
                height=h if h else cfg.get("defaultTreeHeight", 10.0),
                crownRadius=round(dc / 2, 2) if dc else 3.0,
                source="map",
                osmId=f"{el['type']}/{el['id']}",
                enabled=True,
            ))

    roads = []
    for el in raw["elements"]:
        tags = el.get("tags", {})
        if el["type"] == "way" and "highway" in tags and "geometry" in el:
            roads.append(dict(id=f"way/{el['id']}", line=[enu.xy(g["lat"], g["lon"]) for g in el["geometry"]],
                              tags={k: v for k, v in tags.items() if k in ("highway", "name", "lanes", "width", "oneway")}))

    from PIL import Image

    photo = EXAMPLES_DIR / eid / "photo.jpg"
    w, h = Image.open(photo).size
    m = cfg["photo"]
    retrieved = raw.get("_sunvision", {}).get("retrieved", "")
    scene = dict(
        id=eid,
        title=cfg["title"],
        city=cfg["city"],
        country=cfg["country"],
        description=cfg["description"],
        origin=dict(lat=round(lat0, 8), lon=round(lon0, 8)),
        timezone=cfg["timezone"],
        image=dict(
            url="photo.jpg",
            width=w,
            height=h,
            attribution=dict(
                title=m["title"], creator=m["creator"], license=m["license"], licenseUrl=m["licenseUrl"],
                sourceUrl=m["sourceUrl"], originalUrl=m["originalUrl"], captureDate=m.get("captureDate"),
                transformations=m.get("transformations", []),
            ),
            exif={k: v for k, v in dict(
                gps=dict(lat=cam_ll[0], lon=cam_ll[1]) if position_prov == "observed" else None,
                focalLength35mm=m.get("focalLength35mm"),
                focalLengthMm=m.get("focalLengthMm"),
                heading=cam_cfg.get("headingRawDeg"),
                captureTime=m.get("captureDate"),
                make=m.get("make"),
                model=m.get("model"),
            ).items() if v is not None},
        ),
        camera=dict(
            position=cam,
            height=cam_cfg.get("height", 1.6),
            heading=heading,
            pitch=cam_cfg["pitch"],
            roll=cam_cfg.get("roll", 0.0),
            hfov=hfov,
            **({"hfovRange": cam_cfg["hfovRange"]} if cam_cfg.get("hfovRange") else {}),
            provenance=dict(
                position=position_prov, heading=heading_prov, pitch=cam_cfg.get("pitchProvenance", "assumed"),
                hfov=cam_cfg.get("hfovProvenance", "assumed"), height="assumed",
            ),
            notes=notes,
        ),
        footprints=footprints,
        roads=roads,
        trees=trees,
        targetBuildingId=target_id,
        facadeEdgeIndex=edge,
        visibleBuildingIds=visible,
        validation=cfg.get("validation", []) + auto_validation(eid, target, enu),
        dataSources=[
            dict(name="OpenStreetMap contributors (via Overpass API)", url="https://www.openstreetmap.org/copyright",
                 license="ODbL 1.0", retrieved=retrieved),
            dict(name=f"Wikimedia Commons: {m['title']}", url=m["sourceUrl"], license=m["license"],
                 retrieved=m.get("retrieved", "")),
        ] + cfg.get("extraDataSources", []),
    )
    for k in ("_debug",):
        scene.pop(k, None)

    out = EXAMPLES_DIR / eid / "scene.base.json"
    out.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")))
    # Bundled OSM snapshot (ODbL): the app reuses it near the example instead of querying Overpass
    # (web/src/lib/osm.ts bundledSnapshot, keyed by index.json "center" / "osmSnapshot").
    (EXAMPLES_DIR / eid / "osm.json").write_text(json.dumps(dict(
        elements=raw["elements"], osm3s=raw.get("osm3s"), attribution="© OpenStreetMap contributors, ODbL 1.0"),
        separators=(",", ":")))
    dist = math.dist(cam, mid)
    print(f"{eid}: {len(footprints)} footprints, {len(trees)} trees, {len(roads)} roads | target {target_id} edge {edge} "
          f"(normal bearing {bearing_of(nrm):.1f}°, facade width {math.dist(a, b):.1f} m, camera→facade {dist:.1f} m) | "
          f"heading {heading} ({heading_prov}) | visible {visible}")
    if plot:
        debug_plot(eid, scene, mid)
    return scene


def debug_plot(eid, scene, mid):
    from PIL import Image, ImageDraw

    S, R = 1000, 120.0  # px, metres half-extent
    cam = scene["camera"]["position"]
    cx, cy = (cam[0] + mid[0]) / 2, (cam[1] + mid[1]) / 2
    tx = lambda p: (S / 2 + (p[0] - cx) * S / (2 * R), S / 2 - (p[1] - cy) * S / (2 * R))
    im = Image.new("RGB", (S, S), "white")
    dr = ImageDraw.Draw(im)
    for r in scene["roads"]:
        dr.line([tx(p) for p in r["line"]], fill=(220, 220, 220), width=3)
    for fp in scene["footprints"]:
        col = (230, 120, 0) if fp["id"] == scene["targetBuildingId"] else (80, 140, 220) if fp["id"] in scene["visibleBuildingIds"] else (160, 160, 160)
        dr.polygon([tx(p) for p in fp["ring"]], outline=col, fill=None, width=2)
    ring = next(f["ring"] for f in scene["footprints"] if f["id"] == scene["targetBuildingId"])
    e = scene["facadeEdgeIndex"]
    dr.line([tx(ring[e]), tx(ring[(e + 1) % len(ring)])], fill=(220, 0, 0), width=6)
    for t in scene["trees"]:
        x, y = tx(t["position"])
        rr = t["crownRadius"] * S / (2 * R)
        dr.ellipse([x - rr, y - rr, x + rr, y + rr], outline=(0, 150, 0))
    hd, fov = scene["camera"]["heading"], scene["camera"]["hfov"]
    for ang, col in ((hd, (255, 0, 0)), (hd - fov / 2, (0, 0, 0)), (hd + fov / 2, (0, 0, 0))):
        d = bearing_vec(ang)
        dr.line([tx(cam), tx((cam[0] + d[0] * 100, cam[1] + d[1] * 100))], fill=col, width=2)
    x, y = tx(cam)
    dr.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(255, 0, 0))
    dr.text((10, 10), f"{eid}  N up, {2 * R:.0f} m across; orange=target, red=facade edge, blue=visible", fill="black")
    out = ROOT / "data" / "raw" / eid / "debug_plan.png"
    im.save(out)
    print("  plot ->", out)


def write_manifest(cfg: dict) -> None:
    """data/manifest.json: one machine-readable provenance record per example."""
    commons = json.loads((ROOT / "data" / "raw" / "commons_metadata.json").read_text())
    exif = json.loads((ROOT / "data" / "raw" / "exif.json").read_text())
    items = []
    for ex in cfg["examples"]:
        eid, m = ex["id"], ex["photo"]
        cm = commons.get(m["title"], {})
        osm_meta = {}
        osm_path = ROOT / "data" / "raw" / eid / "osm.json"
        if osm_path.exists():
            osm_meta = json.loads(osm_path.read_text()).get("_sunvision", {})
        scene_path = EXAMPLES_DIR / eid / "scene.base.json"
        scene = json.loads(scene_path.read_text()) if scene_path.exists() else {}
        items.append(dict(
            id=eid,
            photo=dict(
                commonsTitle=m["title"], filePage=m["sourceUrl"], originalUrl=m["originalUrl"],
                originalSize=[cm.get("width"), cm.get("height")], originalSha1=cm.get("sha1"),
                creator=m["creator"], license=m["license"], licenseUrl=m["licenseUrl"], captureDate=m.get("captureDate"),
                commonsLocationTemplate=(cm.get("location") or [None])[0], exif=exif.get(eid, {}).get("exif"),
                shippedFile=f"web/public/examples/{eid}/photo.jpg", transformations=m.get("transformations", []),
            ),
            camera=dict(lat=ex["camera"]["lat"], lon=ex["camera"]["lon"], headingRaw=ex["camera"].get("headingRawDeg"),
                        final=scene.get("camera")),
            subject=dict(targetBuildingId=scene.get("targetBuildingId"), facadeEdgeIndex=scene.get("facadeEdgeIndex"),
                         geocode=ex.get("targetPointSource")),
            osm=dict(endpoint=osm_meta.get("endpoint"), retrieved=osm_meta.get("retrieved"), query=osm_meta.get("query"),
                     rawFile=f"data/raw/{eid}/osm.json", license="ODbL 1.0", attribution="© OpenStreetMap contributors"),
            validation=scene.get("validation", []),
            origin=scene.get("origin"), timezone=ex["timezone"],
        ))
    (ROOT / "data" / "manifest.json").write_text(json.dumps(dict(
        generatedBy="scripts/build_scene.py",
        model=dict(id="building-facade-segmentation-instance/4", url="https://universe.roboflow.com/building-facade/building-facade-segmentation-instance",
                   license="CC BY 4.0", note="Inference provenance is recorded per example in analysis.json"),
        examples=items), ensure_ascii=False, indent=2))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    plot = "--plot" in sys.argv
    cfg = json.loads(CONFIG.read_text())
    index = []
    for ex in cfg["examples"]:
        if args and ex["id"] not in args:
            pass
        else:
            build(ex["id"], ex, plot=plot)
        entry = dict(id=ex["id"], title=ex["title"], city=ex["city"], country=ex["country"],
                     description=ex["description"], thumbnail="photo.jpg")
        # Landing card preview written by scripts/make_thumbs.py.
        if (EXAMPLES_DIR / ex["id"] / "card.webp").exists():
            entry["card"] = "card.webp"
        entry["credit"] = f"{ex['photo']['creator']} · {ex['photo']['license']}"
        scene_path = EXAMPLES_DIR / ex["id"] / "scene.base.json"
        if scene_path.exists():
            entry["center"] = json.loads(scene_path.read_text())["origin"]
        if (EXAMPLES_DIR / ex["id"] / "osm.json").exists():
            entry["osmSnapshot"] = "osm.json"
        index.append(entry)
    (EXAMPLES_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2))
    write_manifest(cfg)

    # Coordinate self-check (documented in docs/coordinates.md; mirrored by TS tests).
    enu = ENU(52.0, 5.0)
    e, n, u = enu.forward(52.001, 5.001, 0.0)
    lat, lon, _ = enu.inverse(e, n, u)
    assert abs(lat - 52.001) < 1e-9 and abs(lon - 5.001) < 1e-9
    print(f"check: ENU(52,5) of (52.001, 5.001, 0) = ({e:.4f}, {n:.4f}, {u:.4f})")


if __name__ == "__main__":
    main()
