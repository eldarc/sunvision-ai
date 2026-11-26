import { Canvas, useFrame, useThree, type RootState, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import clsx from 'clsx';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore, type ViewMode } from '../state/store';
import { useSimContext } from './SimContext';
import { useInstant, useSun } from '../lib/useSim';
import { facadePoint, floorSunPatches, type PlacedWindow } from '../lib/obstacles';
import type { Vec2, Vec3 } from '../schema/scene';
import { daySamples } from '../engine';
import { Segmented } from './ui';
import { cameraPose, fallbackView } from '../lib/twinCamera';
import type { WindowSampleResult } from '../engine/types';
import RoomControls from './twin/RoomControls';
import { floorLabel } from '../lib/apartmentOps';
import { useResolvedTheme, useThemeColors, type Theme } from '../lib/theme';

/* Floating chrome over the canvas (DESIGN.md: toolbars, chips, tooltips). */
const LABEL = 'pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-md bg-ink-900 px-2 py-1 text-[11px] font-medium leading-4 text-paper shadow-float';
const CHIP = 'flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md bg-ink-900 px-2 text-[11px] text-ink-300 shadow-float';
const TOOL = 'inline-flex h-6 items-center rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
const TOOL_ON = 'bg-selected text-paper';
const TOOL_OFF = 'text-ink-300 hover:bg-ink-800 hover:text-paper';

/** ENU (e, n, u) → three (e, u, -n). Everything else is drawn inside a rotated group. */
const enu2three = (p: Vec3) => new THREE.Vector3(p[0], p[2], -p[1]);

/* ---- NaN guards: a single non-finite coordinate in a camera, light or geometry blanks the canvas -- */
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const finVec = (v: readonly unknown[] | null | undefined): v is Vec3 => !!v && v.length >= 2 && v.every(fin);
const finPts = (pts: readonly (readonly unknown[])[] | null | undefined) => !!pts && pts.length > 0 && pts.every((p) => finVec(p));
const isGeomApartment = (a: ApartmentGeom | null | undefined): a is ApartmentGeom =>
  !!a &&
  Array.isArray(a.floorCorners) &&
  a.floorCorners.length === 4 &&
  finPts(a.floorCorners) &&
  fin(a.u0) &&
  fin(a.u1) &&
  a.u1 > a.u0 &&
  fin(a.zFloor) &&
  fin(a.plane?.length) &&
  a.plane.length > 0 &&
  finVec(a.plane.normal) &&
  fin(a.apartment?.depth) &&
  a.apartment.depth > 0 &&
  fin(a.apartment?.ceilingHeight) &&
  a.apartment.ceilingHeight > 0 &&
  Array.isArray(a.windows) &&
  a.windows.length > 0;

type ApartmentGeom = NonNullable<NonNullable<ReturnType<typeof useSimContext>>['geo']['apartment']>;

/**
 * Scene colours that ThemeColors (lib/theme.ts) does not carry: lighting and accents. The light
 * theme gets a brighter fill (so shadows on the light ground stay readable rather than black) and
 * a slightly softer sun (light materials would otherwise clip under ACES tone mapping).
 * `accent` (amber) is sunlight data: the sun path and the uncertainty envelopes keep it. `select`
 * is the UI selection blue (= --color-accent): the selected building's edges and the outline of the
 * apartment behind the selected windows.
 */
const SCENE_EXTRA: Record<Theme, { sunPath: string; accent: string; select: string; partition: string; ghost: string; balcony: string; wall: string; wallSide: string; floor: string; hemiSkyDay: string; hemiSkyNight: string; hemiGround: string; hemiDay: number; hemiNight: number; ambientDay: number; ambientNight: number; sun: number; edgeOpacity: number }> = {
  dark: { sunPath: '#f5b544', accent: '#f5b544', select: '#0d99ff', partition: '#c792ea', ghost: '#e0e0e0', balcony: '#c6c6c6', wall: '#d6d6d6', wallSide: '#c8c8c8', floor: '#6a6a6a', hemiSkyDay: '#d0d6de', hemiSkyNight: '#2c3445', hemiGround: '#2a2a2a', hemiDay: 0.55, hemiNight: 0.25, ambientDay: 0.12, ambientNight: 0.18, sun: 2.6, edgeOpacity: 0.35 },
  light: { sunPath: '#a35a08', accent: '#d9922a', select: '#0b84e5', partition: '#8a56c2', ghost: '#777777', balcony: '#d2d2d2', wall: '#dcdcdc', wallSide: '#cdcdcd', floor: '#747474', hemiSkyDay: '#eceff3', hemiSkyNight: '#3d4556', hemiGround: '#adadad', hemiDay: 0.85, hemiNight: 0.3, ambientDay: 0.2, ambientNight: 0.22, sun: 2.2, edgeOpacity: 0.45 },
};

function shapeFromRing(ring: Vec2[]) {
  const s = new THREE.Shape();
  ring.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}

function Building({ id, ring, zMin, zMax, color, opacity = 1, selected, onSelect, ghost, edge, accent, edgeOpacity = 0.35 }: { id: string; ring: Vec2[]; zMin: number; zMax: number; color: string; opacity?: number; selected?: boolean; onSelect?: (id: string) => void; ghost?: boolean; edge: string; accent: string; edgeOpacity?: number }) {
  const geom = useMemo(() => {
    const g = new THREE.ExtrudeGeometry(shapeFromRing(ring), { depth: Math.max(0.5, zMax - zMin), bevelEnabled: false });
    g.translate(0, 0, zMin);
    return g;
  }, [ring, zMin, zMax]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geom, 25), [geom]);
  useEffect(() => () => { geom.dispose(); edges.dispose(); }, [geom, edges]);
  return (
    <group>
      <mesh
        geometry={geom}
        castShadow={!ghost}
        receiveShadow={!ghost}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (!onSelect) return;
          e.stopPropagation();
          onSelect(id);
        }}
      >
        <meshStandardMaterial color={color} roughness={0.92} metalness={0} transparent={opacity < 1} opacity={opacity} depthWrite={opacity >= 1} side={THREE.FrontSide} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={selected ? accent : edge} transparent opacity={selected ? 1 : ghost ? 0.25 : edgeOpacity} />
      </lineSegments>
    </group>
  );
}

function WindowMesh({ w, state, selected, hovered, glass, onClick, onHover }: { w: PlacedWindow; state?: WindowSampleResult; selected: boolean; hovered: boolean; glass?: boolean; onClick: (e: ThreeEvent<MouseEvent>) => void; onHover: (on: boolean) => void }) {
  const { geom, mat } = useMemo(() => {
    const [bl, br, tr, tl] = w.corners.map((c) => [c[0] + w.plane.normal[0] * 0.04, c[1] + w.plane.normal[1] * 0.04, c[2]] as Vec3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...bl, ...br, ...tr, ...bl, ...tr, ...tl], 3));
    g.computeVertexNormals();
    return { geom: g, mat: null };
  }, [w]);
  void mat;
  useEffect(() => () => geom.dispose(), [geom]);
  const lit = fin(state?.litFraction) ? Math.min(1, Math.max(0, state.litFraction)) : 0;
  const color = selected ? '#ffffff' : !state?.daylight ? '#1b2330' : lit > 0 ? new THREE.Color('#2a3444').lerp(new THREE.Color('#ffc65c'), 0.35 + 0.65 * lit) : state?.facing ? '#3e5573' : '#222a36';
  return (
    <mesh geometry={geom} onClick={onClick} onPointerOver={(e) => { e.stopPropagation(); onHover(true); }} onPointerOut={() => onHover(false)}>
      {glass ? (
        <meshStandardMaterial color="#bcd3ea" transparent opacity={0.12} roughness={0.05} metalness={0.2} side={THREE.DoubleSide} depthWrite={false} />
      ) : (
        <meshStandardMaterial color={color} emissive={lit > 0 ? '#f5b544' : selected ? '#f5b544' : '#000000'} emissiveIntensity={selected ? 0.5 : lit * 0.9} roughness={0.25} metalness={0.1} side={THREE.DoubleSide} />
      )}
    </mesh>
  );
}

function Tree({ p, h, r, enabled }: { p: Vec2; h: number; r: number; enabled: boolean }) {
  if (!enabled) return null;
  const trunkH = Math.max(1, h - r * 1.6);
  return (
    <group position={[p[0], p[1], 0]}>
      <mesh position={[0, 0, trunkH / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.3, trunkH, 8]} />
        <meshStandardMaterial color="#5b4a3a" roughness={1} />
      </mesh>
      <mesh position={[0, 0, h - r]} castShadow receiveShadow>
        <icosahedronGeometry args={[r, 1]} />
        <meshStandardMaterial color="#4f7a52" roughness={1} flatShading />
      </mesh>
    </group>
  );
}

function SunRig({ dir, theme }: { dir: Vec3; theme: Theme }) {
  const x = SCENE_EXTRA[theme];
  const light = useRef<THREE.DirectionalLight>(null);
  const up = dir[2] > 0;
  const pos = enu2three([dir[0] * 220, dir[1] * 220, Math.max(dir[2], 0.02) * 220]);
  useEffect(() => {
    if (!light.current) return;
    light.current.target.position.set(0, 0, 0);
    light.current.target.updateMatrixWorld();
  }, []);
  const elev = Math.max(0, dir[2]);
  const warm = new THREE.Color('#ffd9a0').lerp(new THREE.Color('#fff6e8'), Math.min(1, elev * 1.6));
  return (
    <>
      <directionalLight
        ref={light}
        position={pos}
        intensity={up ? x.sun * Math.min(1, 0.25 + elev * 2) : 0}
        color={warm}
        castShadow={up}
        shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-170}
        shadow-camera-right={170}
        shadow-camera-top={170}
        shadow-camera-bottom={-170}
        shadow-camera-near={1}
        shadow-camera-far={600}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
      />
      {/* key on theme too: hemisphereLight's constructor args are not re-applied on change */}
      <hemisphereLight key={theme + String(up)} args={[up ? x.hemiSkyDay : x.hemiSkyNight, x.hemiGround, up ? x.hemiDay : x.hemiNight]} />
      <ambientLight intensity={up ? x.ambientDay : x.ambientNight} color="#a3abb6" />
      {up && (
        <mesh position={enu2three([dir[0] * 190, dir[1] * 190, dir[2] * 190])}>
          <sphereGeometry args={[4, 24, 24]} />
          <meshBasicMaterial color="#ffd78a" toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

/**
 * Phones and tablets below 1024px, where the 3D view sits inside a scrolling column: one finger is
 * left to the page (scroll), two fingers orbit and zoom. Elsewhere one finger orbits.
 */
const SCROLL_COLUMN_TOUCH = '(pointer: coarse) and (max-width: 1023.98px)';
function useMatch(q: string) {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== 'function') return () => {};
      const m = matchMedia(q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => typeof matchMedia === 'function' && matchMedia(q).matches,
    () => false,
  );
}

/** OrbitControls.connect() forces touch-action:none on its element; set the policy after it. */
function TouchPolicy({ pageScroll }: { pageScroll: boolean }) {
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const canvas = useThree((s) => s.gl.domElement);
  useEffect(() => {
    const els = [controls?.domElement as HTMLElement | undefined, canvas].filter((e): e is HTMLElement => !!e);
    const value = pageScroll ? 'pan-y' : 'none';
    for (const el of els) el.style.touchAction = value;
  }, [controls, canvas, pageScroll]);
  return null;
}

function CameraRig({ mode, focus, street, apt }: { mode: ViewMode; focus: Vec3; street: { eye: Vec3; dir: Vec3; vfov: number } ; apt: { eye: Vec3; target: Vec3; interior: { eye: Vec3; target: Vec3 } } | null }) {
  const { camera } = useThree();
  useEffect(() => {
    const pc = camera as THREE.PerspectiveCamera;
    // The wide indoor lens only once there is a room to stand in; otherwise the camera stays put.
    pc.fov = mode === 'interior' && apt ? 78 : mode === 'street' && fin(street.vfov) && street.vfov > 1 && street.vfov < 170 ? street.vfov : 42;
    pc.updateProjectionMatrix();
  }, [mode, camera, street.vfov, !!apt]);
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const anim = useRef<{ from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; k: number } | null>(null);
  useEffect(() => {
    // null: an apartment view without an apartment, or a non-finite pose. Leave the camera alone.
    const pose = cameraPose(mode, focus, street, apt);
    if (!pose) return;
    const { eye, target: tgt } = pose;
    const tFrom = controls && finVec(controls.target.toArray()) ? controls.target.clone() : enu2three(focus);
    const from = finVec(camera.position.toArray()) ? camera.position.clone() : enu2three(eye);
    anim.current = { from, to: enu2three(eye), tFrom, tTo: enu2three(tgt), k: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, focus[0], focus[1], apt?.eye[0], apt?.eye[1], apt?.interior.eye[2], mode === 'interior' ? apt?.interior.eye[0] : null, mode === 'interior' ? apt?.interior.eye[1] : null]);
  useFrame((_, dt) => {
    const a = anim.current;
    if (!a) return;
    a.k = Math.min(1, a.k + (fin(dt) ? dt : 0.016) * 1.6);
    const e = 1 - Math.pow(1 - a.k, 3);
    camera.position.lerpVectors(a.from, a.to, e);
    if (controls) {
      controls.target.lerpVectors(a.tFrom, a.tTo, e);
      controls.update();
    } else camera.lookAt(a.tTo);
    if (a.k >= 1) anim.current = null;
  });
  return null;
}

export default function TwinView() {
  const sim = useSimContext();
  const scene = useStore((s) => s.scene);
  const storeCamera = useStore((s) => s.camera);
  if (!scene) return <div className="canvas-dots grid h-full place-items-center text-xs text-ink-400">No scene loaded.</div>;
  // The primary camera can briefly be null while a scene loads; fall back to the scene's own.
  return <TwinViewBody sim={sim} scene={scene} camParams={storeCamera ?? scene.camera} />;
}

type SceneT = NonNullable<ReturnType<typeof useStore.getState>['scene']>;
type CameraT = NonNullable<ReturnType<typeof useStore.getState>['camera']>;

function TwinViewBody({ sim, scene, camParams }: { sim: ReturnType<typeof useSimContext>; scene: SceneT; camParams: CameraT }) {
  const selected = useStore((s) => s.selectedWindowIds);
  const hovered = useStore((s) => s.hoveredWindowId);
  const viewMode = useStore((s) => s.viewMode);
  const uiMode = useStore((s) => s.uiMode);
  const advanced = uiMode === 'advanced';
  const pageScroll = useMatch(SCROLL_COLUMN_TOUCH);
  const cutawayPref = useStore((s) => s.cutaway);
  const showUncPref = useStore((s) => s.showUncertainty);
  const showSunPathPref = useStore((s) => s.showSunPath);
  // Simple mode hides Cutaway / Uncertainty / Sun path: the sun path is always on, the other two off.
  const cutaway = advanced && cutawayPref;
  const showUnc = advanced && showUncPref;
  const showSunPath = !advanced || showSunPathPref;
  const selectedBuildingId = useStore((s) => s.selectedBuildingId);
  const date = useStore((s) => s.date);
  const trees = useStore((s) => s.trees);
  const settings = useStore((s) => s.settings);
  const set = useStore((s) => s.set);
  const toggleWindow = useStore((s) => s.toggleWindow);
  const theme = useResolvedTheme();
  const tc = useThemeColors();
  const sx = SCENE_EXTRA[theme];
  const sunInfoRaw = useSun();
  // A sun sample with a non-finite direction (bad date/time input) is treated as "no sun".
  const sunInfo = sunInfoRaw && finVec(sunInfoRaw.sun.dir) && fin(sunInfoRaw.sun.altitude) && fin(sunInfoRaw.sun.azimuth) ? sunInfoRaw : null;
  const instant = useInstant(sim, sunInfo?.sun);
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const aptLabelRef = useRef<HTMLDivElement>(null);
  const dir: Vec3 = sunInfo ? sunInfo.sun.dir : [0, 0, -1];
  const sunUp = !!sunInfo && sunInfo.sun.altitude > 0;

  // ---- WebGL context loss: keep the page alive, offer to rebuild the canvas --------------------
  const [glLost, setGlLost] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => () => detachRef.current?.(), []);
  const onCreated = useCallback((state: RootState) => {
    detachRef.current?.();
    const el = state.gl.domElement;
    canvasElRef.current = el;
    el.style.touchAction = 'none';
    const lost = (e: Event) => {
      e.preventDefault(); // allows the browser to restore the context
      if (canvasElRef.current === el) setGlLost(true);
    };
    const restored = () => {
      if (canvasElRef.current !== el) return;
      // Three's own restore does not re-upload everything reliably: rebuild the canvas instead.
      canvasElRef.current = null;
      setGlLost(false);
      setCanvasKey((k) => k + 1);
    };
    el.addEventListener('webglcontextlost', lost, false);
    el.addEventListener('webglcontextrestored', restored, false);
    detachRef.current = () => {
      el.removeEventListener('webglcontextlost', lost, false);
      el.removeEventListener('webglcontextrestored', restored, false);
    };
  }, []);
  const reload3d = () => {
    // Detach first: unmounting the old canvas forces its context loss, which must not re-open the overlay.
    detachRef.current?.();
    detachRef.current = null;
    canvasElRef.current = null;
    setGlLost(false);
    setCanvasKey((k) => k + 1);
  };

  // Before anything is selected the twin opens on the photographer's view, so it can be compared with the photo.
  const sceneId = scene.id;
  useEffect(() => {
    const st = useStore.getState();
    if (!st.selectedWindowIds.length && st.viewMode !== 'street') st.set({ viewMode: 'street' });
  }, [sceneId]);
  // Simple mode: selecting a window from nothing shows the apartment once (leaving it is the apartment effect below).
  const prevSelCount = useRef(selected.length);
  useEffect(() => {
    const before = prevSelCount.current;
    prevSelCount.current = selected.length;
    const st = useStore.getState();
    if (st.uiMode === 'simple' && before === 0 && selected.length > 0) st.set({ viewMode: 'exterior' });
  }, [selected.length]);

  const sunPath = useMemo(() => {
    try {
      const pts = daySamples(date, scene.timezone, scene.origin.lat, scene.origin.lon, 10)
        .filter((s) => fin(s.altitude) && s.altitude > -2 && finVec(s.dir))
        .map((s) => enu2three([s.dir[0] * 190, s.dir[1] * 190, s.dir[2] * 190]));
      return pts.length > 1 ? pts : null;
    } catch {
      return null; // an unparseable date must not take the 3D view down
    }
  }, [date, scene]);

  const focus: Vec3 = useMemo(() => {
    const t = scene.footprints.find((f) => f.id === scene.targetBuildingId) ?? scene.footprints[0];
    const ring = (t?.ring ?? []).filter((p) => fin(p[0]) && fin(p[1]));
    if (!ring.length) return [fin(camParams.position[0]) ? camParams.position[0] : 0, fin(camParams.position[1]) ? camParams.position[1] : 0, 0];
    const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    return [c[0], c[1], 0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  const aptRaw = sim?.geo.apartment ?? null;
  // An apartment whose geometry is degenerate (no windows, zero-length facade, NaN) is not drawn.
  const apt = isGeomApartment(aptRaw) ? aptRaw : null;
  const hoverInfo = useMemo(() => {
    if (!sim || !hovered || selected.includes(hovered)) return null;
    const w = sim.geo.windows.find((x) => x.fw.id === hovered);
    if (!w) return null;
    const c = w.spec.center;
    const lit = instant[w.fw.id]?.litFraction;
    const anchor = [c[0] + w.spec.normal[0] * 0.3, c[1] + w.spec.normal[1] * 0.3, c[2] + w.fw.height / 2] as Vec3;
    if (!finVec(anchor)) return null;
    return { anchor, text: `${floorLabel(w.fw.floor)} · ${fin(lit) ? `${Math.round(lit * 100)}% lit` : 'no sun data'}` };
  }, [sim, hovered, selected, instant]);
  const aptLabel = useMemo(() => {
    if (!apt) return null;
    const a = apt.apartment;
    const anchor = facadePoint(apt.plane, (apt.u0 + apt.u1) / 2, apt.zFloor + a.ceilingHeight + 0.6, -a.depth / 2);
    return finVec(anchor) ? { anchor, text: `Your apartment (a guess) · ${floorLabel(a.floor)}` } : null;
  }, [apt]);
  const aptCams = useMemo(() => {
    if (!apt) return null;
    const pl = apt.plane;
    const um = (apt.u0 + apt.u1) / 2;
    const zc = apt.zFloor + apt.apartment.ceilingHeight / 2;
    const out = facadePoint(pl, um, zc, 0);
    const cams = {
      eye: facadePoint(pl, um - 8, zc + 6, 26),
      target: out,
      // back wall centre at standing eye height, looking at the window wall and the floor in front of it
      interior: { eye: facadePoint(pl, um, apt.zFloor + 1.65, -apt.apartment.depth + 0.25), target: facadePoint(pl, um, apt.zFloor + 0.9, 0) },
    };
    return finPts([cams.eye, cams.target, cams.interior.eye, cams.interior.target]) ? cams : null;
  }, [apt]);
  // Apartment and Inside need an apartment. When there is none (selection cleared, the selected window deleted
  // or no longer on a facade, a restored selection that no longer exists, degenerate geometry), go back to the
  // street rather than sit on a view that cannot show anything. Only once the reconstruction exists: while it
  // is being built there is no apartment yet, and the pending pick sets the selection and view together.
  const hasAptCams = !!aptCams;
  useEffect(() => {
    const st = useStore.getState();
    const next = fallbackView(st.viewMode, hasAptCams, !!sim);
    if (next) st.set({ viewMode: next });
  }, [sim, hasAptCams, viewMode]);
  const street = useMemo(() => {
    const h = ((fin(camParams.heading) ? camParams.heading : 0) * Math.PI) / 180;
    const p = ((fin(camParams.pitch) ? camParams.pitch : 0) * Math.PI) / 180;
    const aspect = scene.image.width > 0 && scene.image.height > 0 ? scene.image.height / scene.image.width : 0.75;
    const hfov = fin(camParams.hfov) && camParams.hfov > 1 && camParams.hfov < 179 ? camParams.hfov : 60;
    // vertical FOV of the photograph so the street view frames the twin like the photo
    const vfov = (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * aspect) * 180) / Math.PI;
    const eye = [camParams.position[0], camParams.position[1], camParams.height] as Vec3;
    return { eye: finVec(eye) ? eye : ([focus[0], focus[1] - 40, 1.6] as Vec3), dir: [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)] as Vec3, vfov };
  }, [camParams, scene, focus]);

  const patches = useMemo(() => {
    if (!apt || !sunUp) return [];
    try {
      return floorSunPatches(apt, dir).filter((poly) => poly.length >= 3 && finPts(poly));
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apt, sunUp, dir[0], dir[1], dir[2]]);
  const aptLitRaw = apt ? apt.windows.reduce((a, w) => a + (fin(instant[w.fw.id]?.litFraction) ? instant[w.fw.id].litFraction : 0), 0) / Math.max(1, apt.windows.length) : 0;
  const aptLit = fin(aptLitRaw) ? aptLitRaw : 0;

  if (!sim) return <div className="canvas-dots grid h-full place-items-center text-xs text-ink-400">Reconstructing…</div>;
  const { geo, recon } = sim;
  // Inside without an apartment shows nothing to stand in, so keep the building.
  const hideTarget = cutaway || (viewMode === 'interior' && !!aptCams);
  // The building that is ghosted for cutaway/interior: the apartment's own building (it may be a
  // neighbour photographed in an extra view), else the target.
  const cutBuildingId = apt?.windows[0]?.fw.buildingId ?? scene.targetBuildingId;
  const camOk = finVec([camParams.position[0], camParams.position[1], camParams.height]);
  const camH = fin(camParams.heading) ? camParams.heading : 0;
  const camF = fin(camParams.hfov) ? camParams.hfov : 60;
  const scenarioScale = settings.scenario === 'low' ? 0.75 : settings.scenario === 'high' ? 1.25 : 1;
  const prisms = geo.obstacles.prisms.filter((p) => p.ring.length >= 3 && finPts(p.ring) && fin(p.zMin) && fin(p.zMax));
  const windows = geo.windows.filter((w) => finPts(w.corners) && finVec(w.plane.normal));
  const bg = sunUp ? tc.sceneBgDay : tc.sceneBgNight;

  return (
    <div className="relative h-full w-full">
      <Canvas
        key={canvasKey}
        shadows
        dpr={[1, 2]}
        camera={{ fov: 42, near: 0.1, far: 4000, position: [-110, 120, 140] }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        onCreated={onCreated}
        onPointerMissed={() => set({ selectedBuildingId: null })}
        // In the phone column one finger scrolls the page (pan-y) and two fingers orbit/zoom;
        // TouchPolicy re-applies this after OrbitControls sets touch-action:none.
        style={{ touchAction: pageScroll ? 'pan-y' : 'none' }}
        aria-label="3D model of the building and its surroundings"
      >
        <color attach="background" args={[bg]} />
        <fog attach="fog" args={[sunUp ? tc.fog : tc.sceneBgNight, 350, 1200]} />
        <SunRig dir={dir} theme={theme} />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          maxPolarAngle={Math.PI / 2 - 0.02}
          minDistance={1}
          maxDistance={900}
          touches={pageScroll ? { TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        />
        <TouchPolicy pageScroll={pageScroll} />
        <CameraRig mode={viewMode} focus={focus} street={street} apt={aptCams} />
        {showSunPath && sunPath && <Line points={sunPath} color={sx.sunPath} lineWidth={1.2} transparent opacity={theme === 'light' ? 1 : 0.55} dashed dashSize={4} gapSize={3} />}
        <group rotation={[-Math.PI / 2, 0, 0]}>
          {/* ground */}
          <mesh receiveShadow position={[focus[0], focus[1], -0.02]}>
            <circleGeometry args={[420, 64]} />
            <meshStandardMaterial color={tc.ground} roughness={1} />
          </mesh>
          {scene.roads
            ?.filter((r) => r.line.length >= 2 && finPts(r.line))
            .map((r) => (
              <Line key={r.id} points={r.line.map(([x, y]) => [x, y, 0.03] as [number, number, number])} color={tc.road} lineWidth={r.tags.highway === 'footway' ? 1 : 2.5} />
            ))}
          {prisms.map((p) => {
            const isT = p.kind === 'target-building';
            if (p.id === cutBuildingId && hideTarget) return <Building key={p.id} id={p.id} ring={p.ring} zMin={p.zMin} zMax={p.zMax} color={sx.ghost} opacity={0.12} ghost edge={tc.edge} accent={sx.accent} />;
            const m = recon.buildings[p.id];
            const fromPhoto = m?.reconstructedFrom === 'photo' || m?.reconstructedFrom === 'manual';
            const col = p.kind === 'hypothetical' ? tc.buildingHypothetical : isT ? tc.buildingTarget : fromPhoto ? tc.buildingPhoto : tc.buildingMap;
            return (
              <Building
                key={p.id}
                id={p.id}
                ring={p.ring}
                zMin={p.zMin}
                zMax={p.zMax}
                color={col}
                opacity={p.kind === 'hypothetical' ? 0.85 : 1}
                selected={selectedBuildingId === p.id}
                onSelect={(id) => set({ selectedBuildingId: id })}
                edge={tc.edge}
                accent={sx.select}
                edgeOpacity={sx.edgeOpacity}
              />
            );
          })}
          {showUnc &&
            scene.footprints.map((fp) => {
              const m = recon.buildings[fp.id];
              if (!m?.height.high || !fin(m.height.high) || m.height.source === 'manual' || fp.ring.length < 3 || !finPts(fp.ring)) return null;
              return <Building key={'u' + fp.id} id={fp.id} ring={fp.ring} zMin={0} zMax={m.height.high} color={sx.accent} opacity={theme === 'light' ? 0.12 : 0.08} ghost edge={tc.edge} accent={sx.accent} />;
            })}
          {geo.balconies
            .filter((b) => finVec(b.center) && finVec(b.halfSize) && b.axes.every((ax) => finVec(ax)))
            .map((b) => (
              <mesh key={b.id} position={b.center} quaternion={new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.axes[0]), new THREE.Vector3(...b.axes[1]), new THREE.Vector3(...b.axes[2])))} castShadow receiveShadow>
                <boxGeometry args={[b.halfSize[0] * 2, b.halfSize[1] * 2, b.halfSize[2] * 2]} />
                <meshStandardMaterial color={b.id === 'balc-user' ? '#c792ea' : sx.balcony} roughness={0.8} />
              </mesh>
            ))}
          {settings.showTrees &&
            trees
              .filter((t) => finVec(t.position) && fin(t.height) && fin(t.crownRadius) && t.height > 0 && t.crownRadius > 0)
              .filter((t) => viewMode !== 'street' || !camOk || Math.hypot(t.position[0] - camParams.position[0], t.position[1] - camParams.position[1]) > t.crownRadius + 1.5)
              .map((t) => <Tree key={t.id} p={t.position} h={t.height * scenarioScale} r={t.crownRadius * scenarioScale} enabled={t.enabled} />)}
          {windows.map((w) => (
            <WindowMesh
              key={w.fw.id}
              w={w}
              state={instant[w.fw.id]}
              selected={selected.includes(w.fw.id)}
              hovered={hovered === w.fw.id}
              glass={hideTarget && selected.includes(w.fw.id)}
              onHover={(on) => set({ hoveredWindowId: on ? w.fw.id : null })}
              onClick={(e) => {
                e.stopPropagation();
                toggleWindow(w.fw.id, e.shiftKey || e.metaKey || e.ctrlKey);
              }}
            />
          ))}
          {apt && <ApartmentVolume apt={apt} patches={patches} lit={aptLit} accent={sx.select} partition={sx.partition} wall={sx.wall} wallSide={sx.wallSide} floor={sx.floor} />}
          {/* photo camera marker */}
          {camOk && (
            <group position={[camParams.position[0], camParams.position[1], camParams.height]}>
              <mesh>
                <sphereGeometry args={[0.6, 16, 16]} />
                <meshBasicMaterial color={theme === 'light' ? '#2f9a5e' : '#6fcf97'} />
              </mesh>
              <Line
                points={[
                  [0, 0, 0],
                  [Math.sin(((camH - camF / 2) * Math.PI) / 180) * 12, Math.cos(((camH - camF / 2) * Math.PI) / 180) * 12, 0],
                  [Math.sin(((camH + camF / 2) * Math.PI) / 180) * 12, Math.cos(((camH + camF / 2) * Math.PI) / 180) * 12, 0],
                  [0, 0, 0],
                ]}
                color={theme === 'light' ? '#2f9a5e' : '#6fcf97'}
                lineWidth={1.5}
              />
            </group>
          )}
        </group>
        <ProjectedLabel anchor={hoverInfo?.anchor ?? null} elRef={hoverLabelRef} />
        <ProjectedLabel anchor={aptLabel?.anchor ?? null} elRef={aptLabelRef} />
      </Canvas>
      {/* 3D labels: small floating tooltips, positioned every frame by ProjectedLabel (display: block). */}
      <div ref={hoverLabelRef} className={LABEL} style={{ display: 'none' }}>
        {hoverInfo?.text}
      </div>
      <div ref={aptLabelRef} className={LABEL} style={{ display: 'none' }}>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          {aptLabel?.text}
        </span>
      </div>

      {glLost && (
        <div role="alert" className="absolute inset-0 z-20 grid place-items-center bg-scrim p-4">
          <div className="w-full max-w-xs rounded-xl bg-ink-900 p-4 shadow-panel">
            <p className="text-[13px] font-semibold leading-5 text-paper">3D view paused</p>
            <p className="mt-1 text-xs text-ink-300">The browser stopped the graphics context (low memory or a GPU reset). Your work is kept.</p>
            <button type="button" onClick={reload3d} className="mt-3 inline-flex h-7 items-center rounded-md bg-accent-500 px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:min-h-11">
              Reload 3D
            </button>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute left-2 top-2 flex max-w-[calc(100%-1rem)] flex-col gap-2 sm:left-3 sm:top-3">
        {/* The view switcher floats on the canvas: the segmented well itself, lifted by a shadow. */}
        <div className="pointer-events-auto w-fit rounded-md shadow-panel max-sm:[&_button]:min-h-11 pointer-coarse:[&_button]:min-h-11" aria-label="3D view">
          {advanced ? (
            <Segmented<ViewMode>
              value={viewMode}
              onChange={(v) => set({ viewMode: v })}
              options={[
                { value: 'overview', label: 'Overview' },
                { value: 'street', label: 'Street', title: 'From the photographer’s position' },
                { value: 'exterior', label: 'Apartment', title: aptCams ? 'Selected apartment exterior' : 'Pick a window first', disabled: !aptCams },
                { value: 'interior', label: 'Interior', title: aptCams ? 'Inside the hypothetical apartment' : 'Pick a window first', disabled: !aptCams },
                { value: 'top', label: 'Top' },
              ]}
            />
          ) : (
            <Segmented<ViewMode>
              value={viewMode}
              onChange={(v) => set({ viewMode: v })}
              options={[
                { value: 'street', label: 'Street', title: 'From where the photo was taken' },
                { value: 'exterior', label: 'Apartment', title: aptCams ? 'Your apartment from outside' : 'Pick a window first', disabled: !aptCams },
                { value: 'interior', label: 'Inside', title: aptCams ? 'Inside your apartment (a guess)' : 'Pick a window first', disabled: !aptCams },
              ]}
            />
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute right-2 top-14 flex flex-col items-end gap-2 sm:right-3 sm:top-3">
        {advanced && (
          <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-0.5 rounded-lg bg-ink-900 p-0.5 shadow-panel max-sm:[&_button]:min-h-11 pointer-coarse:[&_button]:min-h-11">
            <button type="button" aria-pressed={cutawayPref} className={clsx(TOOL, cutawayPref ? TOOL_ON : TOOL_OFF)} onClick={() => set({ cutaway: !cutawayPref })}>
              Cutaway
            </button>
            <button type="button" aria-pressed={showUncPref} className={clsx(TOOL, showUncPref ? TOOL_ON : TOOL_OFF)} onClick={() => set({ showUncertainty: !showUncPref })} title="Show upper-bound height envelopes">
              Uncertainty
            </button>
            <button type="button" aria-pressed={showSunPathPref} className={clsx(TOOL, showSunPathPref ? TOOL_ON : TOOL_OFF)} onClick={() => set({ showSunPath: !showSunPathPref })}>
              Sun path
            </button>
          </div>
        )}
        {sunInfo ? (
          <div className={CHIP}>
            <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', sunUp ? 'bg-sun-500' : 'bg-ink-500')} />
            <span className="num">{sunUp ? `Sun az ${sunInfo.sun.azimuth.toFixed(0)}° · alt ${sunInfo.sun.altitude.toFixed(1)}°` : `Sun below horizon (alt ${sunInfo.sun.altitude.toFixed(1)}°)`}</span>
          </div>
        ) : sunInfoRaw ? (
          <div className={CHIP}>No sun position for this time</div>
        ) : null}
      </div>
      {apt && selected.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 hidden justify-center lg:flex">
          <RoomControls variant="overlay" />
        </div>
      ) : (
        <div className="pointer-events-none absolute bottom-3 left-1/2 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-md bg-ink-900 px-2.5 py-1 text-[11px] leading-4 text-ink-300 shadow-float sm:whitespace-nowrap">
          <span className="pointer-coarse:hidden">Click a window to put an apartment behind it.</span>
          <span className="hidden pointer-coarse:inline">Tap a window to put an apartment behind it. {pageScroll ? 'Two fingers to orbit and zoom.' : 'Drag to orbit, pinch to zoom.'}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Positions a plain DOM label over the canvas at a 3D (ENU) anchor every frame. Used instead of
 * drei <Html>, whose per-label React roots unmount synchronously during renders (React 19
 * "synchronously unmount a root" / removeChild errors).
 */
function ProjectedLabel({ anchor, elRef }: { anchor: Vec3 | null; elRef: React.RefObject<HTMLDivElement | null> }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const el = elRef.current;
    if (!el) return;
    if (!anchor) {
      el.style.display = 'none';
      return;
    }
    v.set(anchor[0], anchor[2], -anchor[1]).project(camera);
    if (!fin(v.x) || !fin(v.y) || !fin(v.z) || v.z > 1 || v.z < -1 || !(size.width > 0) || !(size.height > 0)) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -120%)`;
  });
  return null;
}

function ApartmentVolume({ apt, patches, lit, accent, partition, wall, wallSide, floor }: { apt: ApartmentGeom; patches: Vec3[][]; lit: number; accent: string; partition: string; wall: string; wallSide: string; floor: string }) {
  const { floorCorners: fc, apartment: a, zFloor } = apt;
  const box = useMemo(() => {
    const top = fc.map((p) => [p[0], p[1], zFloor + a.ceilingHeight] as Vec3);
    const segs: Vec3[] = [];
    for (let i = 0; i < 4; i++) {
      segs.push(fc[i], fc[(i + 1) % 4], top[i], top[(i + 1) % 4], fc[i], top[i]);
    }
    return segs;
  }, [fc, zFloor, a.ceilingHeight]);
  const floorGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const [p0, p1, p2, p3] = fc;
    g.setAttribute('position', new THREE.Float32BufferAttribute([...p0, ...p1, ...p2, ...p0, ...p2, ...p3], 3));
    g.computeVertexNormals();
    return g;
  }, [fc]);
  useEffect(() => () => floorGeom.dispose(), [floorGeom]);
  // Walls in facade-local space: x = along facade (u), y = up (z), z = outward normal.
  const walls = useMemo(() => {
    const pl = apt.plane;
    const e = new THREE.Vector3((pl.b[0] - pl.a[0]) / pl.length, (pl.b[1] - pl.a[1]) / pl.length, 0);
    const up = new THREE.Vector3(0, 0, 1);
    const n = new THREE.Vector3(...pl.normal);
    const m = new THREE.Matrix4().makeBasis(e, up, n).setPosition(pl.a[0], pl.a[1], 0);
    const H = a.ceilingHeight;
    // facade wall with window openings (casts the shadow that shapes the sunlight patch)
    const s = new THREE.Shape();
    s.moveTo(apt.u0, zFloor);
    s.lineTo(apt.u1, zFloor);
    s.lineTo(apt.u1, zFloor + H);
    s.lineTo(apt.u0, zFloor + H);
    s.closePath();
    for (const w of apt.windows) {
      const hw = w.fw.width / 2;
      const hh = w.fw.height / 2;
      const z0 = Math.max(zFloor + 0.02, w.fw.z - hh);
      const z1 = Math.min(zFloor + H - 0.02, w.fw.z + hh);
      if (z1 <= z0) continue;
      const hole = new THREE.Path();
      hole.moveTo(w.fw.u - hw, z0);
      hole.lineTo(w.fw.u - hw, z1);
      hole.lineTo(w.fw.u + hw, z1);
      hole.lineTo(w.fw.u + hw, z0);
      hole.closePath();
      s.holes.push(hole);
    }
    const front = new THREE.ShapeGeometry(s);
    front.applyMatrix4(m);
    const box = (u0: number, u1: number, z0: number, z1: number, d0: number, d1: number) => {
      const g = new THREE.BoxGeometry(u1 - u0, z1 - z0, Math.abs(d1 - d0));
      g.translate((u0 + u1) / 2, (z0 + z1) / 2, (d0 + d1) / 2);
      g.applyMatrix4(m);
      return g;
    };
    const t = 0.12;
    const D = a.depth;
    return {
      front,
      back: box(apt.u0, apt.u1, zFloor, zFloor + H, -D - t, -D),
      left: box(apt.u0 - t, apt.u0, zFloor, zFloor + H, -D, 0),
      right: box(apt.u1, apt.u1 + t, zFloor, zFloor + H, -D, 0),
      ceiling: box(apt.u0, apt.u1, zFloor + H, zFloor + H + t, -D, 0),
    };
  }, [apt, a.ceilingHeight, a.depth, zFloor]);
  useEffect(() => () => Object.values(walls).forEach((g) => g.dispose()), [walls]);
  const partitionLines = useMemo(() => {
    const out: Vec3[][] = [];
    for (let i = 1; i <= a.partitions; i++) {
      const u = apt.u0 + ((apt.u1 - apt.u0) * i) / (a.partitions + 1);
      out.push([facadePoint(apt.plane, u, zFloor, -a.depth * 0.35), facadePoint(apt.plane, u, zFloor, -a.depth), facadePoint(apt.plane, u, zFloor + a.ceilingHeight, -a.depth), facadePoint(apt.plane, u, zFloor + a.ceilingHeight, -a.depth * 0.35)]);
    }
    return out;
  }, [apt, a.partitions, a.depth, a.ceilingHeight, zFloor]);
  const patchGeoms = useMemo(
    () =>
      patches.map((poly) => {
        const g = new THREE.BufferGeometry();
        const pos: number[] = [];
        for (let i = 1; i < poly.length - 1; i++) pos.push(...poly[0], ...poly[i], ...poly[i + 1]);
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        return g;
      }),
    [patches],
  );
  useEffect(() => () => patchGeoms.forEach((g) => g.dispose()), [patchGeoms]);
  return (
    <group>
      <pointLight position={facadePoint(apt.plane, (apt.u0 + apt.u1) / 2, zFloor + a.ceilingHeight - 0.3, -a.depth / 2)} intensity={6} distance={a.depth * 2.5} decay={1.6} color="#ffe9cc" />
      <mesh geometry={floorGeom} receiveShadow>
        <meshStandardMaterial color={floor} roughness={0.85} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={walls.front} castShadow receiveShadow>
        <meshStandardMaterial color={wall} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      {(['back', 'left', 'right'] as const).map((k) => (
        <mesh key={k} geometry={walls[k]} castShadow receiveShadow>
          <meshStandardMaterial color={wallSide} roughness={0.95} />
        </mesh>
      ))}
      <mesh geometry={walls.ceiling} castShadow>
        <meshStandardMaterial color={wallSide} roughness={0.95} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      {patchGeoms.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshBasicMaterial color="#ffcf70" transparent opacity={0.25 + 0.6 * lit} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
      {Array.from({ length: box.length / 2 }, (_, i) => (
        <Line key={i} points={[box[i * 2], box[i * 2 + 1]]} color={accent} lineWidth={1.2} transparent opacity={0.9} />
      ))}
      {partitionLines.map((p, i) => (
        <Line key={'p' + i} points={p} color={partition} lineWidth={1} dashed dashSize={0.4} gapSize={0.3} />
      ))}
    </group>
  );
}
