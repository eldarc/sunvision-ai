/**
 * Multi-photo abstraction. A scene has one primary photograph (scene.image /
 * camera / analysis) and optional extra views of the surroundings
 * (scene.extraViews). Everything geometric works per view through
 * `ViewGeometry`; the store keeps each view's editable camera and detections.
 */
import type { CameraParams, Detection, FacadeAnalysis, ImageInfo, Scene } from '../schema/scene';
import type { ViewGeometry } from './reconstruct';
import { useStore } from '../state/store';

export interface ViewInput extends ViewGeometry {
  id: string; // 'primary' or PhotoView.id
  label: string;
  purpose: 'primary' | 'surroundings';
  image: ImageInfo;
  camera: CameraParams; // current (possibly edited) camera
  detections: Detection[]; // current (possibly edited) detections
  analysis: FacadeAnalysis;
}

/** All views of a scene with the user's current cameras/detections applied. */
export function sceneViews(
  scene: Scene,
  state: { camera: CameraParams | null; detections: Detection[]; viewCameras: Record<string, CameraParams>; viewDetections: Record<string, Detection[]> },
): ViewInput[] {
  const primary: ViewInput = {
    id: 'primary',
    label: scene.title,
    purpose: 'primary',
    image: scene.image,
    camera: state.camera ?? scene.camera,
    detections: state.detections,
    analysis: scene.analysis,
    footprints: scene.footprints,
    targetBuildingId: scene.targetBuildingId,
    facadeEdgeIndex: scene.facadeEdgeIndex,
    visibleBuildingIds: scene.visibleBuildingIds ?? [],
  };
  const extra = (scene.extraViews ?? []).map<ViewInput>((v) => ({
    id: v.id,
    label: v.label,
    purpose: v.purpose,
    image: v.image,
    camera: state.viewCameras[v.id] ?? v.camera,
    detections: state.viewDetections[v.id] ?? v.analysis.detections,
    analysis: v.analysis,
    footprints: scene.footprints,
    targetBuildingId: v.targetBuildingId,
    facadeEdgeIndex: v.facadeEdgeIndex,
    visibleBuildingIds: v.visibleBuildingIds,
  }));
  return [primary, ...extra];
}

/** The view currently shown in the photo panel. */
export function useActiveView(): ViewInput | null {
  const scene = useStore((s) => s.scene);
  const camera = useStore((s) => s.camera);
  const detections = useStore((s) => s.detections);
  const viewCameras = useStore((s) => s.viewCameras);
  const viewDetections = useStore((s) => s.viewDetections);
  const activeViewId = useStore((s) => s.activeViewId);
  if (!scene) return null;
  const views = sceneViews(scene, { camera, detections, viewCameras, viewDetections });
  return views.find((v) => v.id === activeViewId) ?? views[0];
}
