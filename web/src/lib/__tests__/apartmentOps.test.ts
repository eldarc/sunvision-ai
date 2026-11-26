import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FacadeAnalysis, FacadeWindow, Scene } from '../../schema/scene';
import { defaultSettings } from '../../state/store';
import { calibratePitch, reconstruct } from '../reconstruct';
import { buildGeometry } from '../obstacles';
import {
  canNarrow,
  canWiden,
  defaultWindow,
  floorLabel,
  INITIAL_MARGIN,
  MARGIN_MAX,
  MARGIN_MIN,
  MARGIN_STEP,
  narrow,
  roomWindows,
  shiftFloor,
  stepDepth,
  toWinLite,
  widen,
  type WinLite,
} from '../apartmentOps';

/** A row of windows on building B, edge 0. Window i of floor f sits at u = 2 + 3*i (1.2 m wide → 1.8 m gaps). */
function grid(floors: number[], cols: number, opts: { building?: string; edge?: number; spacing?: number; width?: number } = {}): WinLite[] {
  const { building = 'B', edge = 0, spacing = 3, width = 1.2 } = opts;
  const out: WinLite[] = [];
  for (const f of floors) for (let i = 0; i < cols; i++) out.push({ id: `${building}${edge}-f${f}-c${i}`, buildingId: building, edgeIndex: edge, floor: f, u: 2 + spacing * i, width });
  return out;
}

describe('roomWindows', () => {
  it('keeps only windows on the anchor’s building, edge and floor', () => {
    const all = [...grid([1, 2], 3), ...grid([1], 2, { edge: 1 }), ...grid([1], 2, { building: 'N' })];
    const r = roomWindows(['B0-f1-c1', 'B0-f2-c1', 'B1-f1-c0', 'N0-f1-c0', 'B0-f1-c2', 'missing'], all);
    expect(r.map((w) => w.id)).toEqual(['B0-f1-c1', 'B0-f1-c2']);
    expect(roomWindows([], all)).toEqual([]);
    expect(roomWindows(['missing'], all)).toEqual([]);
  });
});

describe('widen', () => {
  it('adds the nearest window on the same wall and floor', () => {
    const all = grid([1, 2], 4);
    // c0 at u=2, c1 at 5, c2 at 8, c3 at 11; select c2 → nearest are c1 and c3 (tie) → right wins
    const r = widen(['B0-f1-c2'], all, INITIAL_MARGIN);
    expect(r).toEqual({ selectedWindowIds: ['B0-f1-c2', 'B0-f1-c3'], margin: INITIAL_MARGIN });
  });

  it('breaks ties to the right, otherwise picks the strictly nearer side', () => {
    const all: WinLite[] = [
      { id: 'l', buildingId: 'B', edgeIndex: 0, floor: 1, u: 4.1, width: 1 },
      { id: 'a', buildingId: 'B', edgeIndex: 0, floor: 1, u: 6, width: 1 },
      { id: 'r', buildingId: 'B', edgeIndex: 0, floor: 1, u: 7.8, width: 1 },
    ];
    // gaps: l → 5.5 - 4.6 = 0.9; r → 7.3 - 6.5 = 0.8 → r
    expect(widen(['a'], all, 0.8).selectedWindowIds).toEqual(['a', 'r']);
    all[0].u = 4.2; // gap l = 0.8 → tie → right
    expect(widen(['a'], all, 0.8).selectedWindowIds).toEqual(['a', 'r']);
    all[0].u = 4.3; // gap l = 0.7 → left
    expect(widen(['a'], all, 0.8).selectedWindowIds).toEqual(['a', 'l']);
  });

  it('never takes windows from another floor, edge or building', () => {
    const all = [...grid([1], 1), ...grid([2], 3), ...grid([1], 3, { edge: 1 }), ...grid([1], 3, { building: 'N' })];
    const r = widen(['B0-f1-c0'], all, 0.8);
    expect(r.selectedWindowIds).toEqual(['B0-f1-c0']);
    expect(r.margin).toBeCloseTo(0.8 + MARGIN_STEP);
  });

  it('falls back to margin when the gap is > 2.5 m', () => {
    const all = grid([1], 2, { spacing: 4, width: 1.2 }); // gap = 4 - 1.2 = 2.8 m
    const r = widen(['B0-f1-c0'], all, 0.8);
    expect(r).toEqual({ selectedWindowIds: ['B0-f1-c0'], margin: 1.3 });
    const ok = grid([1], 2, { spacing: 3.7, width: 1.2 }); // gap = 2.5 m exactly → bridged
    expect(widen(['B0-f1-c0'], ok, 0.8).selectedWindowIds).toEqual(['B0-f1-c0', 'B0-f1-c1']);
  });

  it('caps the margin at 4 m', () => {
    const all = grid([1], 1);
    let sel = ['B0-f1-c0'];
    let m = INITIAL_MARGIN;
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = widen(sel, all, m);
      sel = r.selectedWindowIds;
      m = r.margin;
      seen.push(m);
    }
    expect(Math.max(...seen)).toBe(MARGIN_MAX);
    expect(m).toBe(MARGIN_MAX);
    expect(canWiden(sel, all, m)).toBe(false);
    // margin already above the cap (set by the Advanced slider) is never reduced by Wider
    expect(widen(sel, all, 4).margin).toBe(4);
  });

  it('drops selected windows that are not on the room wall', () => {
    const all = [...grid([1], 3), ...grid([1], 1, { building: 'N' })];
    expect(widen(['B0-f1-c0', 'N0-f1-c0'], all, 0.8).selectedWindowIds).toEqual(['B0-f1-c0', 'B0-f1-c1']);
  });
});

describe('narrow', () => {
  it('undoes margin first, then drops the outermost window farthest from the anchor', () => {
    const all = grid([1], 4);
    // anchor c1 with c0, c2, c3 selected, margin raised to 1.8
    let r = narrow(['B0-f1-c1', 'B0-f1-c0', 'B0-f1-c2', 'B0-f1-c3'], all, 1.8, 0.8);
    expect(r).toEqual({ selectedWindowIds: ['B0-f1-c1', 'B0-f1-c0', 'B0-f1-c2', 'B0-f1-c3'], margin: 1.3 });
    r = narrow(r.selectedWindowIds, all, r.margin, 0.8);
    expect(r.margin).toBe(0.8);
    r = narrow(r.selectedWindowIds, all, r.margin, 0.8);
    expect(r.selectedWindowIds).toEqual(['B0-f1-c1', 'B0-f1-c0', 'B0-f1-c2']); // c3 (2 cols away) dropped
    r = narrow(r.selectedWindowIds, all, r.margin, 0.8);
    expect(r.selectedWindowIds).toEqual(['B0-f1-c1', 'B0-f1-c0']); // tie between c0 and c2 → right dropped
    r = narrow(r.selectedWindowIds, all, r.margin, 0.8);
    expect(r.selectedWindowIds).toEqual(['B0-f1-c1']);
  });

  it('never empties the selection; at one window it shrinks margin to MARGIN_MIN', () => {
    const all = grid([1], 3);
    let r = { selectedWindowIds: ['B0-f1-c1'], margin: 0.8 };
    for (let i = 0; i < 10; i++) r = narrow(r.selectedWindowIds, all, r.margin, 0.8);
    expect(r.selectedWindowIds).toEqual(['B0-f1-c1']);
    expect(r.margin).toBe(MARGIN_MIN);
    expect(canNarrow(r.selectedWindowIds, all, r.margin, 0.8)).toBe(false);
    // a margin below MARGIN_MIN (Advanced slider allows 0) is left alone
    expect(narrow(['B0-f1-c1'], all, 0, 0.8)).toEqual({ selectedWindowIds: ['B0-f1-c1'], margin: 0 });
  });

  it('Wider then Narrower is an exact round trip', () => {
    const cases: { all: WinLite[]; sel: string[]; margin: number }[] = [
      { all: grid([1], 5), sel: ['B0-f1-c2'], margin: 0.8 }, // adds a window
      { all: grid([1], 1), sel: ['B0-f1-c0'], margin: 0.8 }, // adds margin
      { all: grid([1], 1), sel: ['B0-f1-c0'], margin: 3.3 }, // margin raised to 3.8 (a press that hits the 4 m cap is not reversible)
      { all: grid([1], 5), sel: ['B0-f1-c2', 'B0-f1-c3'], margin: 0.8 },
    ];
    for (const c of cases) {
      const w = widen(c.sel, c.all, c.margin);
      const n = narrow(w.selectedWindowIds, c.all, w.margin, INITIAL_MARGIN);
      expect(n).toEqual({ selectedWindowIds: c.sel, margin: c.margin });
    }
  });
});

describe('overlapping windows (one column)', () => {
  const all: WinLite[] = [
    { id: 'a', buildingId: 'B', edgeIndex: 0, floor: 3, u: 7, width: 1.2 },
    { id: 'a2', buildingId: 'B', edgeIndex: 0, floor: 3, u: 7, width: 1.2 }, // same opening detected twice
    { id: 'l', buildingId: 'B', edgeIndex: 0, floor: 3, u: 5, width: 1.2 },
    { id: 'l2', buildingId: 'B', edgeIndex: 0, floor: 3, u: 5.05, width: 1.2 },
    { id: 'r', buildingId: 'B', edgeIndex: 0, floor: 3, u: 11.5, width: 1.8 },
  ];
  it('widen takes the whole nearest column, never just a duplicate of a selected window', () => {
    const r = widen(['a'], all, 0.8);
    expect(r.selectedWindowIds).toEqual(['a', 'l', 'l2']);
  });
  it('narrow removes that column again (exact round trip) and keeps the anchor', () => {
    const w = widen(['a'], all, 0.8);
    expect(narrow(w.selectedWindowIds, all, w.margin, 0.8)).toEqual({ selectedWindowIds: ['a'], margin: 0.8 });
    // a selected duplicate of the anchor is not a second column: Narrower shrinks the margin instead
    expect(canNarrow(['a', 'a2'], all, MARGIN_MIN, 0.8)).toBe(false);
    expect(narrow(['a', 'a2'], all, 0.8, 0.8)).toEqual({ selectedWindowIds: ['a', 'a2'], margin: MARGIN_MIN });
  });
});

describe('stepDepth', () => {
  it('steps by 1 m within 2–16 m', () => {
    expect(stepDepth(6, 1)).toBe(7);
    expect(stepDepth(6, -1)).toBe(5);
    expect(stepDepth(16, 1)).toBe(16);
    expect(stepDepth(2, -1)).toBe(2);
    expect(stepDepth(15.5, 1)).toBe(16);
    expect(stepDepth(2.25, -1)).toBe(2);
  });
});

describe('floorLabel', () => {
  it('names floor 0 the ground floor', () => {
    expect(floorLabel(0)).toBe('Ground floor');
    expect(floorLabel(3)).toBe('Floor 3');
  });
});

describe('shiftFloor (synthetic)', () => {
  it('moves the same windows one floor up or down, null when there is none', () => {
    const all = grid([0, 1, 2], 3);
    expect(shiftFloor(['B0-f1-c0', 'B0-f1-c1'], all, 1)).toEqual(['B0-f2-c0', 'B0-f2-c1']);
    expect(shiftFloor(['B0-f1-c0'], all, -1)).toEqual(['B0-f0-c0']);
    expect(shiftFloor(['B0-f2-c0'], all, 1)).toBeNull();
    expect(shiftFloor(['B0-f0-c0'], all, -1)).toBeNull();
  });
});

describe('defaultWindow', () => {
  it('picks the median upper floor and the middle window, deterministically and on the target facade', () => {
    const all = [...grid([0, 1, 2, 3, 4], 5), ...grid([1, 2, 3], 9, { edge: 1 }), ...grid([2, 3], 3, { building: 'N' })];
    const id = defaultWindow(all, 'B', 0);
    expect(id).toBe('B0-f2-c2');
    // order of the input does not matter
    expect(defaultWindow([...all].reverse(), 'B', 0)).toBe(id);
    const w = all.find((x) => x.id === id)!;
    expect(w.buildingId).toBe('B');
    expect(w.edgeIndex).toBe(0);
  });

  it('uses floor 0 when it is the only floor, and null without windows on the target', () => {
    expect(defaultWindow(grid([0], 4), 'B', 0)).toBe('B0-f0-c1'); // median u = 6.5, c1 (5) and c2 (8) tie → smaller u
    expect(defaultWindow(grid([1], 3, { building: 'N' }), 'B', 0)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Curated examples                                                             */
/* -------------------------------------------------------------------------- */

const EX = resolve(__dirname, '../../../public/examples');
const exampleIds = ['paris-boulevard-diderot', 'amsterdam-herengracht', 'nyc-ridge-street', 'sarajevo-obala-kulina-bana'].filter((id) => existsSync(join(EX, id, 'scene.base.json')) && existsSync(join(EX, id, 'analysis.json')));

function loadExample(id: string) {
  const s = JSON.parse(readFileSync(join(EX, id, 'scene.base.json'), 'utf8'));
  const analysis = JSON.parse(readFileSync(join(EX, id, 'analysis.json'), 'utf8')) as FacadeAnalysis;
  const scene: Scene = { ...s, analysis };
  const pitch = calibratePitch(scene, scene.camera);
  const camera = pitch != null && scene.camera.provenance.pitch === 'assumed' ? { ...scene.camera, pitch } : scene.camera;
  const recon = reconstruct({ scene, camera, detections: analysis.detections, settings: defaultSettings, overrides: {} });
  return { scene, camera, recon, windows: recon.windows };
}

/** Verbatim copy of Inspector.tsx `moveFloor`, as the reference behaviour. */
function inspectorMoveFloor(geoWindows: { fw: FacadeWindow }[], sel: string[], d: number): string[] | null {
  const wins = geoWindows.filter((w) => sel.includes(w.fw.id));
  const next: string[] = [];
  for (const w of wins) {
    const cands = geoWindows.filter((c) => c.fw.buildingId === w.fw.buildingId && c.fw.edgeIndex === w.fw.edgeIndex && c.fw.floor === w.fw.floor + d);
    if (!cands.length) continue;
    cands.sort((a, b) => Math.abs(a.fw.u - w.fw.u) - Math.abs(b.fw.u - w.fw.u));
    if (Math.abs(cands[0].fw.u - w.fw.u) < 2.5 && !next.includes(cands[0].fw.id)) next.push(cands[0].fw.id);
  }
  return next.length ? next : null;
}

describe.skipIf(!exampleIds.includes('paris-boulevard-diderot'))('shiftFloor on the Paris windows', () => {
  it('matches the Inspector’s moveFloor for every single window and every floor row', () => {
    const { windows } = loadExample('paris-boulevard-diderot');
    expect(windows.length).toBeGreaterThan(5);
    const geo = windows.map((fw) => ({ fw }));
    const lite = windows.map(toWinLite);
    const selections: string[][] = windows.map((w) => [w.id]);
    const rows = new Map<string, string[]>();
    for (const w of windows) {
      const k = `${w.buildingId}#${w.edgeIndex}#${w.floor}`;
      rows.set(k, [...(rows.get(k) ?? []), w.id]);
    }
    selections.push(...rows.values());
    for (const row of rows.values()) if (row.length >= 3) selections.push([row[2], row[0], row[1]]);
    let moved = 0;
    for (const sel of selections) {
      for (const d of [1, -1] as const) {
        const a = shiftFloor(sel, lite, d);
        expect(a).toEqual(inspectorMoveFloor(geo, sel, d));
        if (a) moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe.skipIf(!exampleIds.length)('room controls on the curated examples', () => {
  for (const id of exampleIds) {
    it(`${id}: every Wider press keeps one floor and edge and makes the room wider, until it stops`, () => {
      const { scene, camera, recon, windows } = loadExample(id);
      const lite = windows.map(toWinLite);
      const start = defaultWindow(lite, scene.targetBuildingId, scene.facadeEdgeIndex);
      expect(start).not.toBeNull();
      const anchor = lite.find((w) => w.id === start)!;
      expect(anchor.buildingId).toBe(scene.targetBuildingId);
      const ap = { depth: 6, ceilingHeight: 2.7, balconyDepth: 0, partitions: 1, margin: INITIAL_MARGIN, sillHeight: 0.9 };
      const geoOf = (sel: string[], margin: number) =>
        buildGeometry({ scene, recon, settings: defaultSettings, trees: [], extraBuildings: [], selectedWindowIds: sel, apartment: { ...ap, margin }, detections: scene.analysis.detections, camera }).apartment!;
      const widthOf = (sel: string[], margin: number) => geoOf(sel, margin).apartment.width;
      const L = geoOf([start!], INITIAL_MARGIN).plane.length;

      let sel = [start!];
      let margin = INITIAL_MARGIN;
      let w = widthOf(sel, margin);
      let presses = 0;
      for (let i = 0; i < 60 && canWiden(sel, lite, margin, L); i++) {
        const r = widen(sel, lite, margin, L);
        const room = roomWindows(r.selectedWindowIds, lite);
        expect(room.length).toBe(r.selectedWindowIds.length);
        expect(new Set(room.map((x) => `${x.buildingId}#${x.edgeIndex}#${x.floor}`)).size).toBe(1);
        expect(room[0].id).toBe(start);
        const w2 = widthOf(r.selectedWindowIds, r.margin);
        expect(w2).toBeGreaterThan(w + 1e-6);
        presses++;
        sel = r.selectedWindowIds;
        margin = r.margin;
        w = w2;
      }
      // Wider stops at the 4 m margin cap, or earlier when the room already spans the whole wall.
      const g = geoOf(sel, margin);
      expect(margin === MARGIN_MAX || (g.u0 <= 1e-9 && g.u1 >= L - 1e-9)).toBe(true);
      console.info(`[apartmentOps] ${id}: ${presses} Wider presses; final ${sel.length} window(s), margin ${margin} m, ${w.toFixed(1)} m of a ${L.toFixed(1)} m wall`);
      // and back down: Narrower until nothing changes never empties the room
      for (let i = 0; i < 60 && canNarrow(sel, lite, margin); i++) {
        const r = narrow(sel, lite, margin, INITIAL_MARGIN);
        expect(r.selectedWindowIds.length).toBeGreaterThan(0);
        expect(r.selectedWindowIds[0]).toBe(start);
        sel = r.selectedWindowIds;
        margin = r.margin;
      }
      expect(sel).toEqual([start]);
      expect(margin).toBe(MARGIN_MIN);
    });
  }
});
