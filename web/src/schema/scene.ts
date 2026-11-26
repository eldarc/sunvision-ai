/**
 * Sunvision shared data contract.
 *
 * COORDINATE CONVENTIONS (see docs/coordinates.md)
 * ------------------------------------------------
 * World space is a local ENU (East-North-Up) tangent plane in METERS.
 *   x = east, y = north, z = up.
 *   The origin is `Scene.origin` (lat/lon), placed at ground level of the
 *   target building. Ground is assumed flat at z = 0 unless terrain is given.
 * Three.js is y-up: everything is rendered inside a group with
 *   rotation.x = -PI/2, which maps ENU (e, n, u) -> three (e, u, -n).
 * Compass headings / azimuths are DEGREES clockwise from north (0=N, 90=E).
 * Camera pitch is degrees above the horizon (+ = looking up).
 * Image pixel coordinates: origin top-left, x right, y down, in the
 *   ORIGINAL image resolution (`ImageInfo.width/height`).
 * Footprint rings are counter-clockwise in ENU, not closed (first != last).
 */

/** Where a value came from. Shown in the UI as a provenance chip. */
export type Provenance =
  | 'observed' // measured directly from the photograph (detections, pixels)
  | 'inferred' // computed from observations + geometry (e.g. height from roof angle)
  | 'map' // taken from OpenStreetMap or another geographic dataset
  | 'assumed' // a default assumption (e.g. 3.0 m floor height)
  | 'manual'; // corrected by the user

export interface Estimate {
  value: number;
  /** Plausible lower / upper bound. NOT a calibrated confidence interval. */
  low?: number;
  high?: number;
  source: Provenance;
  /** Short machine name of the method, e.g. 'floors×floorHeight', 'roof-angle', 'osm:height'. */
  method: string;
  note?: string;
}

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Attribution {
  title: string;
  creator: string;
  license: string; // e.g. 'CC BY-SA 4.0'
  licenseUrl: string;
  sourceUrl: string; // file description page
  originalUrl?: string; // full-resolution original
  captureDate?: string; // ISO date if known
  transformations?: string[]; // e.g. 'resized to 1600px wide', 'EXIF stripped'
}

export interface ImageInfo {
  url: string; // relative to example dir or blob/object URL
  width: number;
  height: number;
  attribution?: Attribution;
  exif?: {
    gps?: LatLon & { altitude?: number };
    focalLength35mm?: number;
    focalLengthMm?: number;
    heading?: number;
    captureTime?: string;
    make?: string;
    model?: string;
  };
}

/**
 * A user- or algorithm-supplied correspondence between an image pixel and a
 * footprint vertex. 'ground' = the vertex at street level (z = 0);
 * 'vertical' = some unknown height on the vertical edge through that vertex.
 */
export interface AlignPoint {
  id: string;
  px: Vec2;
  buildingId: string;
  vertex: number;
  kind: 'ground' | 'vertical';
  source: 'manual' | 'auto';
}

export interface CameraParams {
  /** ENU position of the camera's ground point. */
  position: Vec2;
  /** Height of the lens above local ground (m). Street photos ≈ 1.6 m. */
  height: number;
  heading: number; // compass degrees, direction of the optical axis
  pitch: number; // degrees, + = up
  roll: number; // degrees, + = clockwise image rotation
  hfov: number; // horizontal field of view, degrees
  /** Per-field provenance so the UI can show which values were guessed. */
  provenance: {
    position: Provenance;
    heading: Provenance;
    pitch: Provenance;
    hfov: Provenance;
    height: Provenance;
  };
  notes?: string[];
  /** Plausible horizontal-FOV bounds (deg), e.g. from EXIF focal length or a known crop. */
  hfovRange?: [number, number];
  /** Correspondences used to solve this camera (see web/src/lib/align.ts). */
  alignment?: { points: AlignPoint[]; rms?: number; method?: string };
}

export interface Footprint {
  id: string; // 'way/123456' (OSM element) or 'user/…'
  ring: Vec2[]; // ENU meters, CCW, open ring
  holes?: Vec2[][];
  tags: Record<string, string>;
  /** Height & levels from map tags if present (used only as prior / validation). */
  mapHeight?: number;
  mapLevels?: number;
  source: 'osm' | 'user';
}

/** Model detection in image pixel space. Mirrors Roboflow instance-segmentation output. */
export interface Detection {
  id: string;
  cls: string; // 'window' | 'facade' | 'balcony-fence' | 'vegetation' | ...
  confidence: number; // model score, 0..1 (manual = 1)
  /** Axis-aligned box: [xMin, yMin, xMax, yMax] in original image pixels. */
  bbox: [number, number, number, number];
  polygon?: Vec2[]; // segmentation outline in image pixels
  source: 'model' | 'manual';
  /** Relative depth sampled inside the mask (median, model units, larger = nearer for inverse depth). */
  depthMedian?: number;
  deleted?: boolean;
}

export interface ModelInfo {
  provider: 'roboflow-hosted' | 'roboflow-inference-local' | 'manual' | 'none';
  modelId: string; // 'building-facade-segmentation-instance/4'
  architecture?: string; // 'rfdetr-seg-2xlarge'
  universeUrl?: string;
  license?: string;
  confidenceThreshold?: number;
  inferredAt?: string; // ISO timestamp the inference was actually run
  inferenceMs?: number;
}

export interface DepthInfo {
  url: string; // 16-bit or 8-bit grayscale PNG (display)
  /** Raw uint16 LE row-major samples, same dims; value v maps to rawMin + v/65535*(rawMax-rawMin). */
  binUrl?: string;
  binBase64?: string;
  width: number;
  height: number;
  /** 'relative-inverse' = disparity-like, larger = nearer (Depth Anything V2 default). */
  kind: 'relative-inverse' | 'relative' | 'metric';
  /** Min/max of raw values before PNG quantisation, so pixel p maps to min + p/maxPix*(max-min). */
  rawMin: number;
  rawMax: number;
  bits: 8 | 16;
  model: string;
  provider: string;
  inferredAt?: string;
}

/** Output of the Python CV pipeline (api/sunvision_cv/analysis.py). */
export interface FacadeAnalysis {
  model: ModelInfo;
  imageWidth: number;
  imageHeight: number;
  detections: Detection[];
  depth?: DepthInfo;
  /** Window rows found by robust clustering of window centres (image space). */
  floorRows: {
    index: number; // 0 = lowest observed row
    yCenter: number;
    yMin: number;
    yMax: number;
    windowIds: string[];
  }[];
  /** Window columns (image space) from the Python pipeline. */
  windowColumns?: { index: number; xCenter: number; windowIds: string[] }[];
  /** Image-space y of the facade top / bottom (roofline / ground line) per sampled column. */
  roofline?: { x: number; y: number }[];
  groundline?: { x: number; y: number }[];
  /** Primary facade instance (largest / most central). */
  primaryFacadeId?: string;
  warnings: string[];
  pipelineVersion: string;
}

export interface Tree {
  id: string;
  position: Vec2;
  height: number;
  crownRadius: number;
  source: Provenance; // 'map' if from OSM natural=tree, 'observed' if from detection, 'manual'
  osmId?: string;
  enabled: boolean;
}

/** Hypothetical building or user-added obstacle. */
export interface ExtraBuilding {
  id: string;
  ring: Vec2[];
  height: number;
  label: string;
  source: 'manual';
}

/** A window placed on the 3D facade (derived from a detection or manual). */
export interface FacadeWindow {
  id: string;
  detectionId?: string;
  buildingId: string;
  edgeIndex: number; // footprint edge (ring[i] -> ring[i+1])
  /** Distance along the edge from ring[i] (m) of the window centre. */
  u: number;
  /** Height of the window centre above ground (m). */
  z: number;
  width: number;
  height: number;
  floor: number; // 0 = ground floor
  source: Provenance;
  /** True when position/size were snapped to the facade's row/column grid. */
  regularized?: boolean;
  /** Photograph the window was measured in: 'primary' or a PhotoView id (absent = primary). */
  viewId?: string;
}

export interface Apartment {
  id: string;
  name: string;
  windowIds: string[];
  depth: number; // m into the building
  width: number; // m along facade (auto from windows + margin unless manual)
  ceilingHeight: number;
  floor: number;
  balconyDepth: number; // 0 = none; overhang above the windows
  partitions: number; // number of internal walls (hypothetical)
}

export interface BuildingModel {
  id: string; // footprint id
  height: Estimate;
  floors?: Estimate;
  floorHeight?: Estimate;
  /** Explanation of fusion: one entry per contributing method. */
  methods?: {
    method: string;
    value: number;
    low: number;
    high: number;
    weight: number;
    used: boolean;
    detail: string;
  }[];
  /** 'photo' if reconstructed from the photograph, otherwise how the height was obtained. */
  reconstructedFrom: 'photo' | 'map-tag' | 'map-levels' | 'assumed-default' | 'manual';
}

export interface SceneSettings {
  /** 'vision' = ignore OSM height tags for every building visible in the photo. */
  heightMode: 'vision' | 'map-prior' | 'map-only';
  defaultFloorHeight: number;
  groundFloorExtra: number;
  showNeighbors: boolean;
  showTrees: boolean;
  showBalconies: boolean;
  /** Global multiplier on obstacle heights for low/best/high scenario analysis. */
  scenario: 'low' | 'best' | 'high';
  /** Snap detected windows to the facade's row/column grid in 3D. */
  regularizeWindows: boolean;
}

/**
 * An additional photograph of the scene (e.g. the buildings across the street),
 * used to measure obstacles from vision instead of map tags. Shares the scene's
 * ENU frame and footprints.
 */
export interface PhotoView {
  id: string;
  label: string;
  purpose: 'primary' | 'surroundings';
  image: ImageInfo;
  camera: CameraParams;
  analysis: FacadeAnalysis;
  /** Main building depicted (footprint id). */
  targetBuildingId: string;
  facadeEdgeIndex: number;
  visibleBuildingIds: string[];
}

export interface Scene {
  id: string;
  title: string;
  city: string;
  country: string;
  description: string;
  origin: LatLon;
  timezone: string; // IANA, e.g. 'Europe/Amsterdam'
  image: ImageInfo;
  camera: CameraParams;
  footprints: Footprint[];
  roads?: { id: string; line: Vec2[]; tags: Record<string, string> }[];
  trees: Tree[];
  targetBuildingId: string;
  /** Footprint edge of the target building that is visible in the photograph. */
  facadeEdgeIndex: number;
  /** Other buildings whose facades are also visible in the photo (may get photo heights). */
  visibleBuildingIds?: string[];
  analysis: FacadeAnalysis;
  /** Extra photographs of the surroundings (multi-view obstacle reconstruction). */
  extraViews?: PhotoView[];
  /** Reference values for validation only (never used for reconstruction in vision mode). */
  validation?: { source: string; height?: number; levels?: number; note?: string }[];
  dataSources: { name: string; url: string; license: string; retrieved: string }[];
}
