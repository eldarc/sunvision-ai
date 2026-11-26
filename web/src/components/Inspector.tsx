import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore } from '../state/store';
import { useSimContext } from './SimContext';
import { Btn, Prov, Segmented, Slider, Toggle, fmtDur } from './ui';
import { calibratePitch } from '../lib/reconstruct';
import { facadePoint } from '../lib/obstacles';
import { useSun } from '../lib/useSim';
import { evaluateWindowAt } from '../engine';
import type { WindowSampleResult } from '../engine/types';
import type { CameraParams, Vec2 } from '../schema/scene';
import { useActiveView } from '../lib/views';
import { FIT_EXACT_HINT, applyViewCamera, autoAlignView, fitChipColor, fitRedundancy, solveViewCamera } from './photo/AlignCheck';
import { Dot } from './kit';

type Tab = 'building' | 'camera' | 'apartment' | 'whatif' | 'sources';

const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
export const facadeAzimuth = (n: [number, number, number]) => ((Math.atan2(n[0], n[1]) * 180) / Math.PI + 360) % 360;

/* -------------------------------------------------------------------------- */
/* Panel building blocks: hairline sections, label/value rows, layer rows      */
/* -------------------------------------------------------------------------- */

const ico = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

function IconX() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" {...ico}>
      <path d="M2 2l8 8M10 2L2 10" />
    </svg>
  );
}

function IconArrow({ dir }: { dir: 'up' | 'down' | 'left' }) {
  const rot = dir === 'up' ? 0 : dir === 'down' ? 180 : -90;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" {...ico} style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M6 10V2M2.75 5.25 6 2l3.25 3.25" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" {...ico} strokeWidth={1.3} className={clsx('shrink-0 text-ink-400 transition-transform motion-reduce:transition-none', open && 'rotate-90')}>
      <path d="M2.5 1.5 5.5 4l-3 2.5" />
    </svg>
  );
}

function IconWarn() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" {...ico} className="mt-px shrink-0 text-sun-400">
      <path d="M6 1.5 11 10.25H1L6 1.5z" />
      <path d="M6 5v2.25M6 8.75v.01" />
    </svg>
  );
}

/** A full-width panel section: hairline on top, 32 px title row, 12 px side padding. */
function Section({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('border-t border-ink-700 px-3 pb-3 first:border-t-0', title == null && 'pt-3', className)}>
      {title != null && (
        <div className="flex h-8 items-center justify-between gap-2">
          <h3 className="min-w-0 truncate text-[11px] font-semibold leading-4 text-paper">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** Label on the left, value on the right; one 28 px row of a <dl>. */
function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 text-xs">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd className={clsx('min-w-0 text-right text-paper', className)}>{children}</dd>
    </div>
  );
}

/** Compact tinted warning rows. */
function Warnings({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((w, i) => (
        <li key={i} className="flex gap-2 rounded-md bg-sun-500/10 px-2 py-1.5 text-[11px] leading-snug text-ink-200">
          <IconWarn />
          <span className="min-w-0">{w}</span>
        </li>
      ))}
    </ul>
  );
}

const note = 'text-[11px] leading-snug text-ink-400';
const link = 'text-accent-300 hover:underline focus-visible:outline-2 focus-visible:outline-accent';
const rowIconBtn =
  'grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-400 hover:bg-ink-700 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11 pointer-coarse:w-11';
const stepBtn =
  'grid h-7 w-7 place-items-center rounded-md text-sm text-ink-200 transition-colors hover:bg-ink-700 hover:text-paper focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11 pointer-coarse:w-11';

/* -------------------------------------------------------------------------- */

export default function Inspector() {
  const [tab, setTab] = useState<Tab>('building');
  return (
    <div className="flex h-full flex-col">
      {/* Scrolls sideways on narrow screens rather than clipping the last tab. */}
      <div className="flex shrink-0 items-center overflow-x-auto border-b border-ink-700 px-2 py-1.5">
        {(
          [
            ['building', 'Building'],
            ['camera', 'Camera'],
            ['apartment', 'Apartment'],
            ['whatif', 'What-if'],
            ['sources', 'Provenance'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={tab === k}
            onClick={() => setTab(k)}
            className={clsx(
              'inline-flex h-7 shrink-0 items-center rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              tab === k ? 'bg-ink-800 text-paper' : 'text-ink-400 hover:text-paper',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'building' && <BuildingTab />}
        {tab === 'camera' && <CameraTab />}
        {tab === 'apartment' && <ApartmentTab />}
        {tab === 'whatif' && <WhatIfTab />}
        {tab === 'sources' && <SourcesTab />}
      </div>
    </div>
  );
}

function RangeBar({ low, value, high, max }: { low: number; value: number; high: number; max: number }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div className="relative mt-2 h-1 rounded-full bg-ink-700">
      <div className="absolute inset-y-0 rounded-full bg-ink-500" style={{ left: pct(low), right: `calc(100% - ${pct(high)})` }} />
      <div className="absolute -top-1 h-3 w-0.5 -translate-x-1/2 rounded-full bg-paper" style={{ left: pct(value) }} />
    </div>
  );
}

function BuildingTab() {
  const sim = useSimContext();
  const scene = useStore((s) => s.scene)!;
  const sel = useStore((s) => s.selectedBuildingId) ?? scene.targetBuildingId;
  const settings = useStore((s) => s.settings);
  const overrides = useStore((s) => s.overrides);
  const setOverride = useStore((s) => s.setOverride);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState<number | null>(null);
  if (!sim) return null;
  const m = sim.recon.buildings[sel];
  const fp = scene.footprints.find((f) => f.id === sel);
  if (!m || !fp) return <p className="px-3 py-3 text-xs text-ink-400">Click a building in the 3D view to inspect it.</p>;
  const isTarget = sel === scene.targetBuildingId;
  const ov = overrides[sel] ?? {};
  const h = m.height;
  const winCount = sim.recon.windows.filter((w) => w.buildingId === sel).length;
  const vals = isTarget ? scene.validation ?? [] : [];
  const areaM2 = Math.abs(fp.ring.reduce((a, p, i) => a + p[0] * fp.ring[(i + 1) % fp.ring.length][1] - fp.ring[(i + 1) % fp.ring.length][0] * p[1], 0) / 2);
  const floors = m.floors ? ov.floors ?? m.floors.value : 0;

  const relevant = sim.recon.warnings.filter((w) => !w.includes(' on ') || w.includes(sel));
  return (
    <div className="fade-in">
      <Section>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] leading-4 text-ink-400">{isTarget ? 'Photographed building' : m.reconstructedFrom === 'photo' ? 'Visible neighbour' : 'Surrounding building'}</div>
            <div className="truncate text-[13px] font-semibold leading-5 text-paper">{fp.tags['addr:street'] ? `${fp.tags['addr:street']} ${fp.tags['addr:housenumber'] ?? ''}` : fp.tags.name ?? fp.id}</div>
            <a className="num text-[11px] leading-4 text-ink-400 hover:text-paper" href={fp.id.startsWith('way/') || fp.id.startsWith('relation/') ? `https://www.openstreetmap.org/${fp.id}` : undefined} target="_blank" rel="noreferrer">
              {fp.id} · {areaM2.toFixed(0)} m² footprint
            </a>
          </div>
          {!isTarget && (
            <Btn kind="solid" onClick={() => set({ selectedBuildingId: scene.targetBuildingId })} className="shrink-0">
              <IconArrow dir="left" />
              target
            </Btn>
          )}
        </div>
        {isTarget && relevant.length > 0 && (
          <div className="mt-3">
            <Warnings items={relevant.slice(0, 3)} />
          </div>
        )}
      </Section>

      <Section title="Estimated height" right={<Prov p={h.source} />}>
        <div className="flex items-baseline gap-1.5">
          <span className="num text-[20px] font-semibold leading-7 tracking-[-0.01em] text-paper">{h.value.toFixed(1)}</span>
          <span className="text-xs text-ink-400">m</span>
          {h.low != null && h.high != null && h.source !== 'manual' && (
            <span className="num ml-auto text-[11px] text-ink-400">
              plausible {h.low.toFixed(1)}–{h.high.toFixed(1)} m
            </span>
          )}
        </div>
        {h.low != null && h.high != null && <RangeBar low={h.low} value={h.value} high={h.high} max={Math.max(30, (h.high ?? h.value) * 1.2)} />}
        {h.note && <p className={clsx(note, 'mt-2')}>{h.note}</p>}
      </Section>

      {vals.length > 0 && (
        <Section title="Independent references · comparison only">
          <div className="space-y-2 text-[11px]">
            {vals.map((v, i) => (
              <div key={i}>
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  {v.height != null && <span className="num text-paper">{v.height.toFixed(1)} m</span>}
                  {v.height != null && (
                    <span className="num" style={{ color: Math.abs(h.value - v.height) < 2 ? 'var(--color-obs)' : 'var(--color-sun-400)' }}>
                      Δ {(h.value - v.height >= 0 ? '+' : '') + (h.value - v.height).toFixed(1)} m
                    </span>
                  )}
                  {v.levels != null && (
                    <span className="num text-paper">
                      {v.levels} levels{m.floors ? <span className="text-ink-400"> (ours {m.floors.value})</span> : null}
                    </span>
                  )}
                </div>
                <div className="text-ink-400">{v.source}</div>
                {v.note && <div className="text-ink-400">{v.note}</div>}
              </div>
            ))}
            <p className={note}>Vision measures the top of the visible facade (cornice/eave); references may include roofs, gables or mansards above it. Never used as input in vision mode.</p>
          </div>
        </Section>
      )}

      {m.methods && (
        <Section title="How it was estimated">
          <div className="-mx-2">
            {m.methods.map((mm, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className={clsx('block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent', !mm.used && 'opacity-55')}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <IconChevron open={open === i} />
                  <span className="min-w-0 flex-1 text-ink-200">{mm.method}</span>
                  <span className="num shrink-0 text-paper">
                    {mm.value.toFixed(1)} m <span className="text-ink-400">({mm.low.toFixed(1)}–{mm.high.toFixed(1)})</span>
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-[14px]">
                  <div className="h-1 flex-1 rounded-full bg-ink-700">
                    <div className="h-1 rounded-full bg-ink-300" style={{ width: `${(mm.used ? mm.weight : 0) * 100}%` }} />
                  </div>
                  <span className="num w-12 text-right text-[11px] text-ink-400">{mm.used ? `w ${(mm.weight * 100).toFixed(0)}%` : 'unused'}</span>
                </div>
                {open === i && <p className={clsx(note, 'mt-1 pl-[14px]')}>{mm.detail}</p>}
              </button>
            ))}
          </div>
          <p className={clsx(note, 'mt-2')}>Weights are heuristic inverse-variance from each method’s plausible range; bounds are not statistically calibrated confidence intervals.</p>
        </Section>
      )}
      {!m.methods && (
        <Section>
          <p className={note}>
            This building is not visible in the photograph. Its height comes from {m.reconstructedFrom === 'assumed-default' ? 'an assumption (median of photo-derived heights in this scene)' : m.reconstructedFrom === 'manual' ? 'your manual correction' : 'OpenStreetMap tags'} — it was <em>not</em> reconstructed from the image.
          </p>
        </Section>
      )}

      <Section
        title="Correct the estimate"
        right={
          (ov.height != null || ov.floors != null || ov.floorHeight != null) && (
            <Btn onClick={() => setOverride(sel, null)} className="-mr-1.5 px-1.5 text-[11px]">
              Reset all
            </Btn>
          )
        }
      >
        <Slider label="Height" value={ov.height ?? h.value} min={3} max={Math.max(60, h.value * 1.6)} step={0.1} unit=" m" prov={ov.height != null ? 'manual' : h.source} onChange={(v) => setOverride(sel, { height: v })} onReset={ov.height != null ? () => setOverride(sel, { height: undefined }) : undefined} />
        {m.floors && (
          <div className="flex min-h-8 items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-ink-400">
              Floors <Prov p={m.floors.source} />
            </span>
            <span className="inline-flex items-center rounded-md bg-ink-800">
              <button type="button" className={stepBtn} aria-label="One floor fewer" onClick={() => setOverride(sel, { floors: Math.max(1, floors - 1) })}>
                <span aria-hidden>−</span>
              </button>
              <span className="num w-7 text-center font-medium text-paper">{floors}</span>
              <button type="button" className={stepBtn} aria-label="One floor more" onClick={() => setOverride(sel, { floors: floors + 1 })}>
                <span aria-hidden>+</span>
              </button>
            </span>
          </div>
        )}
        {m.floors?.note && <p className={clsx(note, 'mb-1')}>{m.floors.note}</p>}
        <Slider label="Floor-to-floor" value={ov.floorHeight ?? m.floorHeight?.value ?? settings.defaultFloorHeight} min={2.4} max={5} step={0.05} unit=" m" prov={ov.floorHeight != null ? 'manual' : m.floorHeight?.source} onChange={(v) => setOverride(sel, { floorHeight: v })} onReset={ov.floorHeight != null ? () => setOverride(sel, { floorHeight: undefined }) : undefined} />
        {m.floorHeight?.note && <p className={note}>{m.floorHeight.note}</p>}
      </Section>

      {isTarget && (
        <Section title="Observed facade">
          <dl>
            <Row label="Facade width" className="num inline-flex items-center justify-end gap-1.5">
              {sim.recon.targetPlane.length.toFixed(1)} m <Prov p="map" />
            </Row>
            <Row label="Orientation" className="num inline-flex items-center justify-end gap-1.5">
              {facadeAzimuth(sim.recon.targetPlane.normal).toFixed(0)}° {compass(facadeAzimuth(sim.recon.targetPlane.normal))} <Prov p="map" />
            </Row>
            <Row label="Windows placed" className="num">{winCount}</Row>
            <Row label="Balconies" className="num">{sim.geo.balconies.filter((b) => b.id !== 'balc-user').length}</Row>
            <Row label="Vegetation dets." className="num">{scene.analysis.detections.filter((d) => d.cls === 'vegetation').length}</Row>
          </dl>
        </Section>
      )}
    </div>
  );
}

function CameraTab() {
  const scene = useStore((s) => s.scene)!;
  const view = useActiveView()!;
  const set = useStore((s) => s.set);
  const setViewCamera = useStore((s) => s.setViewCamera);
  const pushCameraUndo = useStore((s) => s.pushCameraUndo);
  const undoViewCamera = useStore((s) => s.undoViewCamera);
  const resetViewCamera = useStore((s) => s.resetViewCamera);
  const undoDepth = useStore((s) => s.cameraUndo[view.id]?.length ?? 0);
  const layers = useStore((s) => s.layers);
  const settings = useStore((s) => s.settings);
  const alignMode = useStore((s) => s.alignMode);
  const sim = useSimContext();
  const [msg, setMsg] = useState<string | null>(null);
  const [relaxManual, setRelaxManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const isPrimary = view.id === 'primary';
  const cam = view.camera;
  const setCam = (p: Partial<CameraParams>, prov?: Partial<CameraParams['provenance']>) => setViewCamera(view.id, p, prov);
  // "Reset" returns to the camera the view was loaded with (for the main photo: after the load-time pitch solve).
  const base = isPrimary ? scene.camera : (scene.extraViews?.find((v) => v.id === view.id)?.camera ?? cam);
  const res = isPrimary ? sim?.recon.groundResidual : undefined;
  const alignment = cam.alignment;
  const pts = alignment?.points ?? [];
  const autoAlign = () => {
    setBusy(true);
    setMsg('Aligning from the window grid…');
    // autoAlignCamera runs 60–190 ms on the main thread; let the busy state paint first.
    setTimeout(() => {
      try {
        const out = autoAlignView(view, { relaxManual: relaxManual || pts.length > 0 });
        if (out.changed) {
          pushCameraUndo(view.id);
          applyViewCamera(view.id, out.camera);
        }
        setMsg(out.message);
      } catch (e) {
        setMsg(`Auto-align failed: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    }, 16);
  };
  const removePoint = (id: string) => {
    const next = pts.filter((p) => p.id !== id);
    // Re-solve from the current camera with the remaining points.
    const out = solveViewCamera(view, cam, next);
    pushCameraUndo(view.id);
    applyViewCamera(view.id, out.camera);
    setMsg(next.length ? (out.notes[0] ?? null) : 'All corner points removed; camera kept as it is.');
  };
  return (
    <div className="fade-in">
      <Section className="space-y-2">
        {!isPrimary && (
          <p className="text-xs leading-snug text-ink-300">
            Camera of the surroundings photo <span className="font-medium text-paper">“{view.label}”</span>. Switch photos under the photo panel.
          </p>
        )}
        <p className={note}>
          Camera pose links photo pixels to map geometry. Turn on{' '}
          <button type="button" className={clsx(link, 'rounded-sm font-medium')} onClick={() => set({ layers: { ...layers, alignment: true } })}>
            Alignment
          </button>{' '}
          in the photo panel: the projected footprint wireframe should sit on the real facade edges.
        </p>
      </Section>

      <Section title="Alignment">
        <dl>
          <Row label="Corner fit">
            {typeof alignment?.rms === 'number' ? (
              <span className="num inline-flex items-center gap-1.5" style={{ color: fitChipColor(alignment.rms, pts, 'text') }} title={fitRedundancy(pts) > 0 ? 'Reprojection rms of the picked corners, from the camera solver' : FIT_EXACT_HINT}>
                {alignment.rms.toFixed(1)} px · {pts.length} point{pts.length === 1 ? '' : 's'}
                {fitRedundancy(pts) <= 0 && <span className="text-ink-400">(exact, add corners)</span>}
              </span>
            ) : (
              <span className="text-ink-400">no corners picked</span>
            )}
          </Row>
          {alignment?.method && (
            <Row label="Method" className="num text-ink-200">
              {alignment.method}
            </Row>
          )}
          {isPrimary && (
            <Row label="Ground-line residual">
              <span className="num" style={{ color: res == null ? 'var(--color-ink-400)' : Math.abs(res) < 0.5 ? 'var(--color-obs)' : 'var(--color-sun-400)' }}>
                {res == null ? 'n/a' : `${res >= 0 ? '+' : ''}${res.toFixed(2)} m`}
              </span>
            </Row>
          )}
        </dl>
        {pts.length > 0 && (
          <ul className="-mx-2 mt-1 text-[11px]" aria-label="Picked corner points">
            {pts.map((p) => (
              <li key={p.id} className="group flex min-h-7 items-center gap-2 rounded-md pl-2 pr-0.5 hover:bg-ink-800">
                <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', p.kind === 'ground' ? 'bg-ink-300' : 'bg-ink-500')} />
                <span className="min-w-0 flex-1 truncate text-ink-200">
                  Corner {p.vertex + 1} · {p.kind === 'ground' ? 'street level' : 'on the edge'}
                </span>
                <span className="num shrink-0 text-ink-400">
                  ({Math.round(p.px[0])}, {Math.round(p.px[1])}) px
                </span>
                <button type="button" onClick={() => removePoint(p.id)} aria-label={`Remove corner ${p.vertex + 1} (${p.kind})`} className={clsx(rowIconBtn, 'hover:text-danger-text')}>
                  <IconX />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Btn kind="primary" onClick={autoAlign} disabled={busy} title="Self-calibrate pitch, roll, FOV, heading and position from the window grid (values marked manual stay fixed)">
            {busy ? 'Aligning…' : 'Auto-align from windows'}
          </Btn>
          <Btn kind="solid" active={alignMode} onClick={() => set({ alignMode: !alignMode, leftTab: 'photo' })} title="Drag footprint corners onto the photo to solve the camera">
            {alignMode ? 'Stop dragging corners' : 'Drag corners on the photo'}
          </Btn>
        </div>
        <div className="mt-2">
          <Toggle checked={relaxManual} onChange={setRelaxManual} label={<span title="Lets auto-align move values marked manual (e.g. a maintainer's resection). Picked corners always allow this.">Also adjust values marked manual</span>} />
          <Toggle checked={settings.regularizeWindows} onChange={(v) => set({ settings: { ...settings, regularizeWindows: v } })} label="Snap windows to a neat grid" />
          <p className={clsx(note, 'pl-8')}>Levels window rows and columns on each facade in 3D (moves of at most 0.6 m; manual windows stay put).</p>
        </div>
      </Section>

      <Section>
        <div className="-ml-2 flex flex-wrap gap-0.5">
          <Btn
            onClick={() => {
              const p = calibratePitch(view, cam, view.detections);
              if (p == null) setMsg('No usable ground line in the photo — adjust pitch manually.');
              else {
                pushCameraUndo(view.id);
                setCam({ pitch: Math.round(p * 10) / 10 }, { pitch: 'inferred' });
                setMsg(`Pitch solved to ${p.toFixed(1)}° so the detected facade ground line lies at street level.`);
              }
            }}
          >
            Auto-align pitch
          </Btn>
          <Btn
            onClick={() => {
              resetViewCamera(view.id);
              setMsg('Camera reset to the initial estimate.');
            }}
          >
            Reset camera
          </Btn>
          <Btn
            disabled={!undoDepth}
            onClick={() => {
              if (undoViewCamera(view.id)) setMsg('Previous camera restored.');
            }}
            title="Undo the last auto-align, pitch solve, corner removal or reset"
          >
            Undo camera change
          </Btn>
        </div>
        {msg && (
          <p className="mt-1 text-[11px] leading-snug text-ink-300" aria-live="polite">
            {msg}
          </p>
        )}
        <div className="mt-2">
          <Slider label="Heading" value={cam.heading} min={base.heading - 40} max={base.heading + 40} step={0.5} unit="°" prov={cam.provenance.heading} onChange={(v) => setCam({ heading: v })} />
          <Slider label="Pitch" value={cam.pitch} min={-15} max={45} step={0.1} unit="°" prov={cam.provenance.pitch} onChange={(v) => setCam({ pitch: v })} />
          <Slider label="Roll" value={cam.roll} min={-10} max={10} step={0.1} unit="°" prov={cam.provenance.pitch} onChange={(v) => setCam({ roll: v })} />
          <Slider label="Horizontal FOV" value={cam.hfov} min={20} max={110} step={0.5} unit="°" prov={cam.provenance.hfov} onChange={(v) => setCam({ hfov: v })} />
          <Slider label="Lens height" value={cam.height} min={0.5} max={30} step={0.1} unit=" m" prov={cam.provenance.height} onChange={(v) => setCam({ height: v })} />
          <Slider label="Position east" value={cam.position[0] - base.position[0]} min={-25} max={25} step={0.25} unit=" m" prov={cam.provenance.position} format={(v) => (v >= 0 ? '+' : '') + v.toFixed(2)} onChange={(v) => setCam({ position: [base.position[0] + v, cam.position[1]] as Vec2 })} />
          <Slider label="Position north" value={cam.position[1] - base.position[1]} min={-25} max={25} step={0.25} unit=" m" prov={cam.provenance.position} format={(v) => (v >= 0 ? '+' : '') + v.toFixed(2)} onChange={(v) => setCam({ position: [cam.position[0], base.position[1] + v] as Vec2 })} />
        </div>
        {sim && isPrimary && (
          <p className="mt-1 text-[11px] text-ink-400">
            Distance to facade plane: <span className="num text-paper">{Math.abs((cam.position[0] - sim.recon.targetPlane.a[0]) * sim.recon.targetPlane.normal[0] + (cam.position[1] - sim.recon.targetPlane.a[1]) * sim.recon.targetPlane.normal[1]).toFixed(1)} m</span>
          </p>
        )}
      </Section>

      {(cam.notes?.length || isPrimary) && (
        <Section className="space-y-1.5">
          {cam.notes?.length ? (
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-ink-400 marker:text-ink-500">
              {cam.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
          {isPrimary && <p className={note}>The map tab (left panel) lets you drag the camera position directly.</p>}
        </Section>
      )}
    </div>
  );
}

function ApartmentTab() {
  const sim = useSimContext();
  const scene = useStore((s) => s.scene)!;
  const sel = useStore((s) => s.selectedWindowIds);
  const ap = useStore((s) => s.apartment);
  const set = useStore((s) => s.set);
  const toggleWindow = useStore((s) => s.toggleWindow);
  const sun = useSun()?.sun;
  // Same evaluation as useInstant, for the selected windows only.
  const instant = useMemo(() => {
    const out: Record<string, WindowSampleResult> = {};
    if (!sim || !sun) return out;
    for (const w of sim.geo.windows) {
      if (!sel.includes(w.fw.id)) continue;
      try {
        out[w.fw.id] = evaluateWindowAt(sim.index, w.spec, sun);
      } catch (e) {
        console.warn('[sunvisionai] window', w.fw.id, e); // left out rather than blanking the panel
      }
    }
    return out;
  }, [sim, sun, sel]);
  if (!sim) return null;
  const wins = sim.geo.windows.filter((w) => sel.includes(w.fw.id));
  const apt = sim.geo.apartment;
  const moveFloor = (d: number) => {
    const next: string[] = [];
    for (const w of wins) {
      const cands = sim.geo.windows.filter((c) => c.fw.buildingId === w.fw.buildingId && c.fw.edgeIndex === w.fw.edgeIndex && c.fw.floor === w.fw.floor + d);
      if (!cands.length) continue;
      cands.sort((a, b) => Math.abs(a.fw.u - w.fw.u) - Math.abs(b.fw.u - w.fw.u));
      if (Math.abs(cands[0].fw.u - w.fw.u) < 2.5 && !next.includes(cands[0].fw.id)) next.push(cands[0].fw.id);
    }
    if (next.length) set({ selectedWindowIds: next });
  };
  if (!wins.length)
    return (
      <div className="fade-in">
        <Section>
          <p className="text-xs leading-relaxed text-ink-300">Click a window in the photograph (Shift/⌘-click for several) to define a hypothetical apartment. Its volume is generated behind the selected windows and lit by the simulation.</p>
          <div className="mt-3">
            <Btn
              kind="primary"
              onClick={() => {
                // pick a sensible default: middle window on the 2nd–3rd floor of the target facade
                const t = sim.geo.windows.filter((w) => w.fw.buildingId === scene.targetBuildingId).sort((a, b) => b.fw.z - a.fw.z);
                if (t.length) {
                  const f = t[Math.floor(t.length / 2)].fw.floor;
                  set({ selectedWindowIds: t.filter((w) => w.fw.floor === f).slice(0, 3).map((w) => w.fw.id) });
                }
              }}
            >
              Pick a sample apartment
            </Btn>
          </div>
        </Section>
      </div>
    );
  return (
    <div className="fade-in">
      <Section>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] leading-4 text-ink-400">Hypothetical apartment</div>
            <div className="truncate text-[13px] font-semibold leading-5 text-paper">
              Floor {apt?.apartment.floor ?? wins[0].fw.floor} · {wins.length} window{wins.length > 1 ? 's' : ''}
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Btn kind="solid" onClick={() => moveFloor(1)} title="Same windows one floor up">
              <IconArrow dir="up" />
              floor
            </Btn>
            <Btn kind="solid" onClick={() => moveFloor(-1)} title="Same windows one floor down">
              <IconArrow dir="down" />
              floor
            </Btn>
          </div>
        </div>
        <ul className="-mx-2 mt-2">
          {wins.map((w) => {
            const st = instant[w.fw.id];
            return (
              <li key={w.fw.id} className="flex min-h-7 items-center gap-2 rounded-md pl-2 pr-0.5 text-xs hover:bg-ink-800">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: st && st.litFraction > 0 ? 'var(--color-lit)' : st?.daylight && st.facing ? 'var(--color-shade-500)' : 'var(--color-ink-600)' }} />
                <span className="num shrink-0 font-medium text-paper">F{w.fw.floor}</span>
                <span className="num min-w-0 flex-1 truncate text-ink-400">
                  {w.fw.width.toFixed(1)}×{w.fw.height.toFixed(1)} m · {w.fw.z.toFixed(1)} m up
                </span>
                <Prov p={w.fw.source} />
                <span className="num w-9 shrink-0 text-right text-ink-300">{st ? `${Math.round(st.litFraction * 100)}%` : '—'}</span>
                <button type="button" className={rowIconBtn} onClick={() => toggleWindow(w.fw.id, true)} aria-label="Remove window from apartment">
                  <IconX />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[11px] leading-snug text-ink-400">
          Facade faces <span className="num text-paper">{facadeAzimuth(wins[0].spec.normal).toFixed(0)}° {compass(facadeAzimuth(wins[0].spec.normal))}</span>. Lowest sill <span className="num text-paper">{apt ? Math.min(...apt.windows.map((w) => w.fw.z - w.fw.height / 2)).toFixed(1) : '—'} m</span> above the street.
        </p>
      </Section>
      <Section title="Room volume" right={<Prov p="assumed" />}>
        <Slider label="Depth into building" value={ap.depth} min={2} max={16} step={0.25} unit=" m" onChange={(v) => set({ apartment: { ...ap, depth: v } })} />
        <Slider label="Side margin" value={ap.margin} min={0} max={4} step={0.1} unit=" m" onChange={(v) => set({ apartment: { ...ap, margin: v } })} />
        <Slider label="Window sill above floor" value={ap.sillHeight} min={0} max={1.6} step={0.05} unit=" m" onChange={(v) => set({ apartment: { ...ap, sillHeight: v } })} />
        <Slider label="Ceiling height" value={apt?.apartment.ceilingHeight ?? ap.ceilingHeight} min={2.2} max={4.5} step={0.05} unit=" m" onChange={(v) => set({ apartment: { ...ap, ceilingHeight: v } })} />
        <Slider label="Internal walls" value={ap.partitions} min={0} max={4} step={1} onChange={(v) => set({ apartment: { ...ap, partitions: v } })} />
        <Slider label="Balcony / overhang above" value={ap.balconyDepth} min={0} max={3} step={0.1} unit=" m" onChange={(v) => set({ apartment: { ...ap, balconyDepth: v } })} />
        {apt && <p className="num mt-1 text-[11px] text-ink-400">Width {apt.apartment.width.toFixed(1)} m · floor area {(apt.apartment.width * ap.depth).toFixed(0)} m² (hypothetical)</p>}
      </Section>
      <WindowEditor />
      <Section>
        <p className={note}>This is a hypothetical interior generated from the facade, not the real floor plan. Internal walls are illustrative only.</p>
      </Section>
    </div>
  );
}

/** Edit the photo detection of the first selected window: nudging its box changes the 3D window and the simulation. */
function WindowEditor() {
  const sel = useStore((s) => s.selectedWindowIds);
  const dets = useStore((s) => s.detections);
  const updateDetection = useStore((s) => s.updateDetection);
  const d = dets.find((x) => 'win-' + x.id === sel[0]);
  if (!d) return null;
  const [x0, y0, x1, y1] = d.bbox;
  const h = y1 - y0;
  const w = x1 - x0;
  const setBox = (b: [number, number, number, number]) => updateDetection(d.id, { bbox: b, polygon: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], source: 'manual', confidence: d.source === 'manual' ? 1 : d.confidence });
  return (
    <Section title={<>Window {sel.length > 1 ? <span className="font-normal text-ink-400">(first selected)</span> : ''}</>} right={<Prov p={d.source === 'manual' ? 'manual' : 'observed'} />}>
      <Slider label="Height (px)" value={h} min={4} max={h * 2 + 20} step={1} onChange={(v) => setBox([x0, y1 - v, x1, y1])} />
      <Slider label="Width (px)" value={w} min={4} max={w * 2 + 20} step={1} onChange={(v) => setBox([(x0 + x1) / 2 - v / 2, y0, (x0 + x1) / 2 + v / 2, y1])} />
      <Slider label="Sill (px from top)" value={y1} min={y0 + 4} max={y1 + h} step={1} onChange={(v) => setBox([x0, v - h, x1, v])} />
      <p className={clsx(note, 'mt-1')}>Edits the detection in image space; the 3D window is re-projected through the camera.</p>
    </Section>
  );
}

function WhatIfTab() {
  const sim = useSimContext();
  const scene = useStore((s) => s.scene)!;
  const settings = useStore((s) => s.settings);
  const trees = useStore((s) => s.trees);
  const extra = useStore((s) => s.extraBuildings);
  const set = useStore((s) => s.set);
  const [dist, setDist] = useState(18);
  const [h, setH] = useState(25);
  const [w, setW] = useState(20);
  const nearTrees = useMemo(() => {
    if (!sim) return trees;
    const c = sim.recon.targetPlane;
    const mid: Vec2 = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
    return [...trees].sort((a, b) => Math.hypot(a.position[0] - mid[0], a.position[1] - mid[1]) - Math.hypot(b.position[0] - mid[0], b.position[1] - mid[1])).slice(0, 12);
  }, [trees, sim]);
  const S = (p: Partial<typeof settings>) => set({ settings: { ...settings, ...p } });
  if (!sim) return null;
  const addBuilding = () => {
    const pl = sim.recon.targetPlane;
    const um = pl.length / 2;
    const ring: Vec2[] = [
      facadePoint(pl, um - w / 2, 0, dist),
      facadePoint(pl, um - w / 2, 0, dist + 12),
      facadePoint(pl, um + w / 2, 0, dist + 12),
      facadePoint(pl, um + w / 2, 0, dist),
    ].map((p) => [p[0], p[1]] as Vec2);
    set({ extraBuildings: [...extra, { id: 'hypo-' + (extra.length + 1), ring, height: h, label: `Hypothetical ${h} m building at ${dist} m`, source: 'manual' }] });
  };
  return (
    <div className="fade-in">
      <Section title="Reconstruction mode">
        <Segmented
          value={settings.heightMode}
          onChange={(v) => S({ heightMode: v })}
          options={[
            { value: 'vision', label: 'Vision-first', title: 'Ignore OSM height tags for photographed buildings' },
            { value: 'map-prior', label: 'Map prior', title: 'Fuse OSM height tags with vision estimates' },
            { value: 'map-only', label: 'Map only', title: 'Baseline: OSM tags / assumptions only, no vision' },
          ]}
        />
        <p className={clsx(note, 'mt-2')}>Switch to “Map only” to see what the plain map knows — and what the photograph adds.</p>
      </Section>
      <Section title="Obstacle uncertainty scenario">
        <Segmented value={settings.scenario} onChange={(v) => S({ scenario: v })} options={[{ value: 'low', label: 'Low' }, { value: 'best', label: 'Best estimate' }, { value: 'high', label: 'High' }]} />
        <p className={clsx(note, 'mt-2')}>Sets surrounding buildings to their plausible lower/upper bound heights and trees to ±25%.</p>
      </Section>
      <Section title="Model layers">
        <Toggle checked={settings.showNeighbors} onChange={(v) => S({ showNeighbors: v })} label="Surrounding buildings" />
        <Toggle checked={settings.showTrees} onChange={(v) => S({ showTrees: v })} label="Vegetation" />
        <Toggle checked={settings.showBalconies} onChange={(v) => S({ showBalconies: v })} label="Balconies & overhangs" />
      </Section>
      <Section title="Add a hypothetical building">
        <Slider label="Distance in front of facade" value={dist} min={6} max={80} step={1} unit=" m" onChange={setDist} />
        <Slider label="Height" value={h} min={3} max={120} step={1} unit=" m" onChange={setH} />
        <Slider label="Width" value={w} min={4} max={80} step={1} unit=" m" onChange={setW} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Btn kind="primary" onClick={addBuilding}>
            Add building
          </Btn>
          {extra.length > 0 && (
            <Btn kind="solid" onClick={() => set({ extraBuildings: [] })}>
              Remove all ({extra.length})
            </Btn>
          )}
        </div>
      </Section>
      <Section title="Nearby trees">
        {nearTrees.length === 0 && <p className={note}>No mapped trees nearby.</p>}
        <div>
          {nearTrees.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 text-xs">
              <Toggle checked={t.enabled} onChange={(v) => set({ trees: trees.map((x) => (x.id === t.id ? { ...x, enabled: v } : x)) })} label={<span className="num">{t.osmId ?? t.id} · {t.height.toFixed(0)} m</span>} />
              <Prov p={t.source} />
            </div>
          ))}
        </div>
      </Section>
      <Section>
        <p className={note}>Select any building in 3D and correct its height in the Building tab to test taller or lower neighbours.</p>
      </Section>
    </div>
  );
}

function SourcesTab() {
  const scene = useStore((s) => s.scene)!;
  const sim = useSimContext();
  const a = scene.image.attribution;
  const m = scene.analysis.model;
  const counts = useMemo(() => {
    const c = { photo: 0, map: 0, assumed: 0, manual: 0 };
    if (sim)
      for (const b of Object.values(sim.recon.buildings)) {
        if (b.reconstructedFrom === 'photo') c.photo++;
        else if (b.reconstructedFrom === 'manual') c.manual++;
        else if (b.reconstructedFrom === 'assumed-default') c.assumed++;
        else c.map++;
      }
    return c;
  }, [sim]);
  return (
    <div className="text-xs fade-in">
      {sim && sim.recon.warnings.length > 0 && (
        <Section title="Warnings">
          <Warnings items={[...sim.recon.warnings, ...scene.analysis.warnings]} />
        </Section>
      )}
      <Section title="Geometry provenance">
        <dl>
          <Row label="Heights reconstructed from photo" className="num">{counts.photo}</Row>
          <Row label="Heights from OpenStreetMap" className="num">{counts.map}</Row>
          <Row label="Assumed (no data)" className="num">{counts.assumed}</Row>
          <Row label="Manually corrected" className="num">{counts.manual}</Row>
          <Row label="Footprints from OpenStreetMap" className="num">{scene.footprints.filter((f) => f.source !== 'user').length}</Row>
          {scene.footprints.some((f) => f.source === 'user') && (
            <Row
              label={
                <span className="inline-flex items-center gap-1.5">
                  Footprints drawn by you <Dot p="manual" />
                </span>
              }
              className="num"
            >
              {scene.footprints.filter((f) => f.source === 'user').length}
            </Row>
          )}
          <Row label="Trees" className="num">{scene.trees.length}</Row>
        </dl>
        <div className="mt-2 flex flex-wrap gap-1">
          {(['observed', 'inferred', 'map', 'assumed', 'manual'] as const).map((p) => (
            <Prov key={p} p={p} />
          ))}
        </div>
      </Section>
      <Section title="Computer vision">
        <dl>
          <Row label="Model" className="num break-all">{m.modelId}</Row>
          <Row label="Architecture">{m.architecture ?? '—'}</Row>
          <Row label="Provider">{m.provider}</Row>
          <Row label="Inferred" className="num">{m.inferredAt ? new Date(m.inferredAt).toLocaleString() : '—'}</Row>
          <Row label="Threshold" className="num">{m.confidenceThreshold ?? '—'}</Row>
          <Row label="Depth">{scene.analysis.depth ? `${scene.analysis.depth.model} (${scene.analysis.depth.kind})` : 'not available'}</Row>
          <Row label="Pipeline" className="num">{scene.analysis.pipelineVersion}</Row>
        </dl>
        {m.universeUrl && (
          <a className={clsx(link, 'mt-1 inline-flex min-h-7 items-center rounded-sm font-medium')} href={m.universeUrl} target="_blank" rel="noreferrer">
            Model on Roboflow Universe
            <svg width="10" height="10" viewBox="0 0 10 10" {...ico} strokeWidth={1.3} className="ml-1 shrink-0">
              <path d="M3.5 1.5h5v5M8.5 1.5l-7 7" />
            </svg>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {m.provider !== 'manual' && m.modelId.startsWith('building-facade-segmentation-instance') && (
          <p className={clsx(note, 'mt-1')}>
            By Building Facade on Roboflow Universe,{' '}
            <a className="underline hover:text-paper" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
            . Detection powered by Roboflow.
          </p>
        )}
        <p className={clsx(note, 'mt-2')}>Detection confidence is the model’s score. It is separate from geometric uncertainty, which comes from camera alignment and is shown as height bounds.</p>
      </Section>
      {a && (
        <Section title="Photograph">
          <p className="text-ink-200">
            “{a.title}” by {a.creator}
          </p>
          <p className="mt-0.5 text-ink-400">
            <a className="hover:text-paper hover:underline" href={a.licenseUrl} target="_blank" rel="noreferrer">
              {a.license}
            </a>{' '}
            ·{' '}
            <a className="hover:text-paper hover:underline" href={a.sourceUrl} target="_blank" rel="noreferrer">
              source
            </a>
            {a.captureDate && ` · captured ${a.captureDate}`}
          </p>
          {a.transformations?.length ? <p className={clsx(note, 'mt-1')}>Transformations: {a.transformations.join('; ')}</p> : null}
        </Section>
      )}
      <Section title="Data sources">
        <ul className="-mx-2">
          {scene.dataSources.map((d, i) => (
            <li key={i} className="flex min-h-7 flex-wrap items-center gap-x-1.5 rounded-md px-2 py-1 hover:bg-ink-800">
              <a className="font-medium text-ink-200 hover:text-paper hover:underline" href={d.url} target="_blank" rel="noreferrer">
                {d.name}
              </a>{' '}
              <span className="text-[11px] text-ink-400">· {d.license} · {d.retrieved}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section>
        <p className={note}>Results are potential direct sunlight under clear skies from a simplified geometric model — not weather forecasts, measured indoor illuminance, or a professional daylight assessment.</p>
      </Section>
    </div>
  );
}

export { fmtDur };
