#!/usr/bin/env python3
"""Resect a curated example's camera from picked footprint-vertex correspondences.

Usage: uv run --with numpy --with scipy python scripts/solve_camera.py <example-id> [--write]

Camera model is identical to web/src/lib/camera.ts (ENU, heading clockwise from
north, pitch up, roll, horizontal FOV, principal point at the image centre).
Only z = 0 points and vertical-edge directions are used: building heights never
enter the calibration, so the photo-based height estimate stays independent.
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.optimize import least_squares

ROOT = Path(__file__).resolve().parents[1]

def basis(x, y, h, heading, pitch, roll):
    H, P, R = map(math.radians, (heading, pitch, roll))
    f = np.array([math.sin(H) * math.cos(P), math.cos(H) * math.cos(P), math.sin(P)])
    r0 = np.array([math.cos(H), -math.sin(H), 0.0])
    u0 = np.cross(r0, f)
    c, s = math.cos(R), math.sin(R)
    r = r0 * c - u0 * s; r /= np.linalg.norm(r)
    u = r0 * s + u0 * c; u /= np.linalg.norm(u)
    return np.array([x, y, h]), f, r, u

def project(params, W, Hh, h, P):
    x, y, heading, pitch, roll, hfov = params
    eye, f, r, u = basis(x, y, h, heading, pitch, roll)
    fp = W / 2 / math.tan(math.radians(hfov) / 2)
    d = P - eye
    z = d @ f
    return np.array([W / 2 + (d @ r) / z * fp, Hh / 2 - (d @ u) / z * fp])

def main():
    ex = sys.argv[1]
    cal = json.loads((ROOT / f"data/calibration/{ex}.json").read_text())
    scene_p = ROOT / f"web/public/examples/{ex}/scene.base.json"
    scene = json.loads(scene_p.read_text())
    W, Hh = scene["image"]["width"], scene["image"]["height"]
    rings = {f["id"]: f["ring"] for f in scene["footprints"]}
    # A point's vertex indexes the target footprint unless the point names another building
    # (e.g. a facade split into several OSM ways whose outer corners are on different ways).
    vert = lambda g: rings[g.get("buildingId", scene["targetBuildingId"])][g["vertex"]]
    h = cal["fixed"]["height"]
    c0 = scene["camera"]
    x0 = [c0["position"][0], c0["position"][1], c0["heading"], c0["pitch"], c0["roll"], c0["hfov"]]

    def res(p):
        out = []
        for g in cal["groundPoints"]:
            v = vert(g)
            out.extend(project(p, W, Hh, h, np.array([v[0], v[1], 0.0])) - np.array(g["px"]))
        for g in cal["verticalPoints"]:
            v = vert(g)
            # find z so that the projected y matches, then compare x
            zs = np.linspace(0, 80, 801)
            pts = np.array([project(p, W, Hh, h, np.array([v[0], v[1], z])) for z in zs])
            i = int(np.argmin(np.abs(pts[:, 1] - g["px"][1])))
            out.append(pts[i, 0] - g["px"][0])
        return np.array(out)

    # Search near the geotag: within 40 m and ±30° of its heading (rejects mirror solutions behind the block).
    fr = cal.get("hfovRange", [25, 100])  # metadata-derived FOV bounds when available
    if "hfov" in cal["fixed"]:  # few points cannot separate FOV from distance: hold it at the metadata value
        fr = [cal["fixed"]["hfov"] - 0.004, cal["fixed"]["hfov"] + 0.004]
    lo = [x0[0] - 40, x0[1] - 40, x0[2] - 30, -10, -10, fr[0]]
    hi = [x0[0] + 40, x0[1] + 40, x0[2] + 30, 45, 10, fr[1]]
    best = None
    starts = np.linspace(fr[0] + 0.5, fr[1] - 0.5, 4) if fr[1] - fr[0] > 1 else [sum(fr) / 2]
    for hf in starts:  # multi-start on FOV
        start = list(x0)
        start[5] = hf
        cand = least_squares(res, start, x_scale=[5, 5, 5, 5, 2, 10], bounds=(lo, hi))
        if best is None or cand.cost < best.cost:
            best = cand
    sol = best
    r = res(sol.x)
    x, y, heading, pitch, roll, hfov = sol.x
    print(f"rms reprojection error {math.sqrt(np.mean(r**2)):.1f} px; residuals {np.round(r,1).tolist()}")
    print(f"position {x:.2f},{y:.2f} (moved {math.dist((x,y), c0['position']):.1f} m from geotag) heading {heading:.2f} pitch {pitch:.2f} roll {roll:.2f} hfov {hfov:.2f}")
    moved = math.dist((x, y), c0["position"])
    if "--write" in sys.argv:
        cam = scene["camera"]
        cam.update(position=[round(x, 3), round(y, 3)], heading=round(heading, 2), pitch=round(pitch, 2), roll=round(roll, 2), hfov=round(hfov, 2))
        prov = cal.get("provenance", "manual")
        cam["provenance"].update(position=prov, heading=prov, pitch=prov, hfov=prov)
        if prov != "manual":
            # Keep the picks with the camera so the app's facade-regularity alignment refines it
            # without drifting off them (align.ts: camera.alignment.points), within the FOV bounds.
            if cal.get("hfovRange"):
                cam["hfovRange"] = cal["hfovRange"]
            tgt = scene["targetBuildingId"]
            pts = [dict(id=f"{kind}-{i}", px=g["px"], buildingId=g.get("buildingId", tgt), vertex=g["vertex"], kind=kind, source="manual")
                   for kind, key in (("ground", "groundPoints"), ("vertical", "verticalPoints")) for i, g in enumerate(cal[key])]
            cam["alignment"] = dict(points=pts, rms=round(math.sqrt(np.mean(r**2)), 1), method="resection")
        cam["notes"] = [n for n in cam.get("notes", []) if not n.startswith("Resected")] + [
            f"Resected from {len(cal['groundPoints'])} ground + {len(cal['verticalPoints'])} vertical-edge correspondences picked on the photo (data/calibration/{ex}.json); rms {math.sqrt(np.mean(r**2)):.1f} px. Geotag was {moved:.1f} m away. No building height was used."
        ]
        scene_p.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")))
        print("wrote", scene_p)

if __name__ == "__main__":
    main()
