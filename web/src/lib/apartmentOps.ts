/**
 * Pure helpers behind the simple-mode room controls.
 *
 * The room itself is built by `buildGeometry` in lib/obstacles.ts from the selected
 * windows that share the first selected window's building and facade edge, plus a
 * side margin. These helpers only decide *which* windows are selected and how large
 * the margin / depth are; they never touch geometry, so they are trivially testable.
 */
import type { FacadeWindow } from '../schema/scene';

export interface WinLite {
  id: string;
  buildingId: string;
  edgeIndex: number;
  floor: number;
  u: number;
  width: number;
}

/** m, the largest facade gap bridged when widening. */
export const MAX_GAP = 2.5;
/** m, the margin change per Wider/Narrower press when no window is added or removed. */
export const MARGIN_STEP = 0.5;
export const MARGIN_MIN = 0.3;
export const MARGIN_MAX = 4;
/** The store's default side margin (state/store.ts `apartment.margin`). */
export const INITIAL_MARGIN = 0.8;

export const DEPTH_STEP = 1;
export const DEPTH_MIN = 2;
export const DEPTH_MAX = 16;

const EPS = 1e-6;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function toWinLite(fw: FacadeWindow): WinLite {
  return { id: fw.id, buildingId: fw.buildingId, edgeIndex: fw.edgeIndex, floor: fw.floor, u: fw.u, width: fw.width };
}

/** "Ground floor" for floor 0, otherwise "Floor {n}" (counted from the ground floor, 0). */
export function floorLabel(floor: number): string {
  return floor === 0 ? 'Ground floor' : `Floor ${floor}`;
}

const sameWall = (a: WinLite, b: WinLite) => a.buildingId === b.buildingId && a.edgeIndex === b.edgeIndex && a.floor === b.floor;

/** The windows that define the room: same building, edge and floor as the first selected window. */
export function roomWindows(sel: string[], all: WinLite[]): WinLite[] {
  if (!sel.length) return [];
  const byId = new Map(all.map((w) => [w.id, w]));
  const anchor = byId.get(sel[0]);
  if (!anchor) return [];
  const out: WinLite[] = [];
  for (const id of sel) {
    const w = byId.get(id);
    if (w && sameWall(w, anchor) && !out.includes(w)) out.push(w);
  }
  return out;
}

function span(ws: WinLite[]): [number, number] {
  return [Math.min(...ws.map((w) => w.u - w.width / 2)), Math.max(...ws.map((w) => w.u + w.width / 2))];
}

/** m, windows on a wall whose spans overlap by more than this form one column (e.g. duplicate detections). */
const COLUMN_OVERLAP = 0.05;

interface Column {
  members: WinLite[];
  lo: number;
  hi: number;
  u: number;
}

/**
 * The windows of one wall grouped into columns: windows whose spans overlap (transitively) are one column.
 * Widen adds, and narrow removes, a whole column, so every press changes the room's width even when the
 * reconstruction holds two overlapping windows at the same place.
 */
function wallColumns(anchor: WinLite, all: WinLite[]): Column[] {
  const wall = all.filter((w) => sameWall(w, anchor)).sort((a, b) => a.u - a.width / 2 - (b.u - b.width / 2) || a.u - b.u || (a.id < b.id ? -1 : 1));
  const cols: Column[] = [];
  for (const w of wall) {
    const lo = w.u - w.width / 2;
    const hi = w.u + w.width / 2;
    const last = cols[cols.length - 1];
    if (last && lo < last.hi - COLUMN_OVERLAP) {
      last.members.push(w);
      last.hi = Math.max(last.hi, hi);
    } else cols.push({ members: [w], lo, hi, u: 0 });
  }
  for (const c of cols) c.u = (c.lo + c.hi) / 2;
  return cols;
}

/** The column on the room's wall without any selected window that is nearest to the room (ties go right). */
function nearestColumn(sel: string[], all: WinLite[]): { col: Column; gap: number } | null {
  const room = roomWindows(sel, all);
  if (!room.length) return null;
  const [uMin, uMax] = span(room);
  let best: { col: Column; gap: number } | null = null;
  for (const col of wallColumns(room[0], all)) {
    if (col.members.some((m) => sel.includes(m.id))) continue;
    const gap = Math.max(0, col.lo - uMax, uMin - col.hi);
    if (!best || gap < best.gap - EPS || (Math.abs(gap - best.gap) <= EPS && col.u > best.col.u)) best = { col, gap };
  }
  return best;
}

/** True when the room (window span ± margin) already reaches both ends of a facade of length L. */
function spansFacade(room: WinLite[], margin: number, facadeLength?: number): boolean {
  if (facadeLength == null || !room.length) return false;
  const [uMin, uMax] = span(room);
  return uMin - margin <= EPS && uMax + margin >= facadeLength - EPS;
}

/**
 * Add the unselected window on the same building, edge and floor whose gap to [uMin,uMax] is smallest
 * (together with any window overlapping it, see `wallColumns`). Ties go right (larger u). If the smallest
 * gap > MAX_GAP or there is no candidate, increase margin by MARGIN_STEP (≤ MARGIN_MAX). With
 * `facadeLength` (the wall's length, `FacadePlane.length`), margin is not added once the room already spans
 * the whole wall, since buildGeometry clamps the room to the facade.
 * The returned selection only holds the room's windows (anchor first).
 */
export function widen(sel: string[], all: WinLite[], margin: number, facadeLength?: number): { selectedWindowIds: string[]; margin: number } {
  const room = roomWindows(sel, all);
  if (!room.length) return { selectedWindowIds: sel, margin };
  const ids = room.map((w) => w.id);
  const best = nearestColumn(sel, all);
  if (best && best.gap <= MAX_GAP + EPS) return { selectedWindowIds: [...ids, ...best.col.members.map((m) => m.id)], margin };
  if (spansFacade(room, margin, facadeLength)) return { selectedWindowIds: ids, margin };
  return { selectedWindowIds: ids, margin: Math.max(margin, Math.min(MARGIN_MAX, r2(margin + MARGIN_STEP))) };
}

/** True when `widen` would change anything (a window to add, or margin to add). */
export function canWiden(sel: string[], all: WinLite[], margin: number, facadeLength?: number): boolean {
  const room = roomWindows(sel, all);
  if (!room.length) return false;
  const best = nearestColumn(sel, all);
  if (best != null && best.gap <= MAX_GAP + EPS) return true;
  return margin < MARGIN_MAX - EPS && !spansFacade(room, margin, facadeLength);
}

/**
 * Inverse of widen: while margin > the initial value, reduce margin first (never below the initial value);
 * otherwise drop the outermost window (with any window overlapping it) farthest from the anchor (sel[0]);
 * ties drop the right one, mirroring widen. Never removes the anchor, so never empties the selection.
 * At one window (column), reduce margin towards MARGIN_MIN.
 */
export function narrow(sel: string[], all: WinLite[], margin: number, initialMargin: number = INITIAL_MARGIN): { selectedWindowIds: string[]; margin: number } {
  const room = roomWindows(sel, all);
  if (!room.length) return { selectedWindowIds: sel, margin };
  const ids = room.map((w) => w.id);
  if (margin > initialMargin + EPS) return { selectedWindowIds: ids, margin: Math.max(initialMargin, r2(margin - MARGIN_STEP)) };
  const anchor = room[0];
  const cols = wallColumns(anchor, all).filter((c) => c.members.some((m) => ids.includes(m.id)));
  if (cols.length > 1) {
    const home = cols.find((c) => c.members.includes(anchor))!;
    const left = cols[0];
    const right = cols[cols.length - 1];
    const drop = left === home ? right : right === home ? left : Math.abs(right.u - home.u) >= Math.abs(left.u - home.u) - EPS ? right : left;
    const gone = new Set(drop.members.map((m) => m.id));
    return { selectedWindowIds: ids.filter((id) => !gone.has(id)), margin };
  }
  if (margin > MARGIN_MIN + EPS) return { selectedWindowIds: ids, margin: Math.max(MARGIN_MIN, r2(margin - MARGIN_STEP)) };
  return { selectedWindowIds: ids, margin };
}

/** True when `narrow` would change anything. */
export function canNarrow(sel: string[], all: WinLite[], margin: number, initialMargin: number = INITIAL_MARGIN): boolean {
  const room = roomWindows(sel, all);
  if (!room.length) return false;
  if (margin > initialMargin + EPS || margin > MARGIN_MIN + EPS) return true;
  return wallColumns(room[0], all).filter((c) => c.members.some((m) => sel.includes(m.id))).length > 1;
}

/**
 * Move every selected window to the nearest window (|Δu| < MAX_GAP) on floor+delta. Returns null if none exist.
 * Windows are visited in `all` order, the same order as the Inspector's `moveFloor`.
 */
export function shiftFloor(sel: string[], all: WinLite[], delta: 1 | -1): string[] | null {
  const next: string[] = [];
  for (const w of all) {
    if (!sel.includes(w.id)) continue;
    const cands = all.filter((c) => c.buildingId === w.buildingId && c.edgeIndex === w.edgeIndex && c.floor === w.floor + delta);
    if (!cands.length) continue;
    cands.sort((a, b) => Math.abs(a.u - w.u) - Math.abs(b.u - w.u));
    if (Math.abs(cands[0].u - w.u) < MAX_GAP && !next.includes(cands[0].id)) next.push(cands[0].id);
  }
  return next.length ? next : null;
}

/** Room depth one step deeper (+1) or shallower (−1), clamped to [DEPTH_MIN, DEPTH_MAX]. */
export function stepDepth(depth: number, dir: 1 | -1): number {
  return Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, r2(depth + dir * DEPTH_STEP)));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The default apartment: on the target building's facade edge, the median floor among floors ≥ 1
 * (or floor 0 if there are no others), and on that floor the window whose u is closest to the median u.
 * Deterministic (ties: smaller u, then id). If the facade edge has no windows, the target building's
 * edge with the most windows is used; null if the target building has none.
 */
export function defaultWindow(all: WinLite[], targetBuildingId: string, facadeEdgeIndex: number): string | null {
  const onTarget = all.filter((w) => w.buildingId === targetBuildingId);
  if (!onTarget.length) return null;
  let wall = onTarget.filter((w) => w.edgeIndex === facadeEdgeIndex);
  if (!wall.length) {
    const counts = new Map<number, number>();
    for (const w of onTarget) counts.set(w.edgeIndex, (counts.get(w.edgeIndex) ?? 0) + 1);
    const edge = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    wall = onTarget.filter((w) => w.edgeIndex === edge);
  }
  const floors = [...new Set(wall.map((w) => w.floor))].sort((a, b) => a - b);
  const upper = floors.filter((f) => f >= 1);
  const floor = upper.length ? upper[(upper.length - 1) >> 1] : floors[0];
  const row = wall.filter((w) => w.floor === floor);
  const mu = median(row.map((w) => w.u));
  const pick = [...row].sort((a, b) => Math.abs(a.u - mu) - Math.abs(b.u - mu) || a.u - b.u || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return pick.id;
}
