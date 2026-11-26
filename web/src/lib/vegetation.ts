/**
 * Trees reconstructed from RF-DETR `vegetation` detections.
 *
 * The bottom-centre pixel of a vegetation mask is assumed to touch the street:
 * its ray is intersected with the ground plane (z = 0) to place the trunk.
 * Height and crown radius follow from the top pixel and the mask width at that
 * same horizontal distance. Only added where OpenStreetMap has no tree nearby,
 * and never inside a building footprint. Provenance: 'observed' detection,
 * geometry 'inferred' — shown as such in the UI.
 */
import type { CameraParams, Detection, Footprint, Tree, Vec2 } from '../schema/scene';
import { cameraBasis, intersectGround, pixelToRay } from './camera';
import type { ViewGeometry } from './reconstruct';
import { pointInRing } from './sceneBuilder';

/**
 * `scene` is any photograph's geometry: a Scene (primary photo) or an extra view adapted
 * with the scene's footprints. `camera` and `detections` must belong to that photograph.
 */
export function treesFromVegetation(scene: Pick<ViewGeometry, 'image' | 'footprints'>, camera: CameraParams, detections: Detection[], existing: Tree[]): Tree[] {
  const b = cameraBasis(camera, scene.image.width, scene.image.height);
  const out: Tree[] = [];
  const inside = (p: Vec2, fps: Footprint[]) => fps.some((f) => pointInRing(p, f.ring));
  for (const d of detections) {
    if (d.cls !== 'vegetation' || d.deleted) continue;
    const [x0, y0, x1, y1] = d.bbox;
    const w = x1 - x0;
    const h = y1 - y0;
    if (h < scene.image.height * 0.08) continue; // too small to be a street tree
    // Mask must reach low in the frame (a tree standing on the street, not a window box).
    if (y1 < scene.image.height * 0.55) continue;
    const g = intersectGround(b.eye, pixelToRay(b, (x0 + x1) / 2, y1));
    if (!g) continue;
    const pos: Vec2 = [g[0], g[1]];
    const dist = Math.hypot(pos[0] - b.eye[0], pos[1] - b.eye[1]);
    if (dist < 2 || dist > 60) continue;
    if (inside(pos, scene.footprints)) continue;
    // height: ray through the top pixel at the same horizontal distance
    const top = pixelToRay(b, (x0 + x1) / 2, y0);
    const horiz = Math.hypot(top[0], top[1]);
    const height = b.eye[2] + (dist / horiz) * top[2];
    // crown radius: half the mask width at that distance (pinhole)
    const crown = ((w / b.focalPx) * dist) / 2;
    if (!(height > 3 && height < 35) || crown < 0.8) continue;
    const near = [...existing, ...out].some((t) => Math.hypot(t.position[0] - pos[0], t.position[1] - pos[1]) < Math.max(4, crown));
    if (near) continue;
    out.push({
      id: 'veg-' + d.id,
      position: pos,
      height: Math.round(height * 10) / 10,
      crownRadius: Math.round(Math.min(8, crown) * 10) / 10,
      source: 'inferred',
      enabled: true,
    });
  }
  return out;
}
