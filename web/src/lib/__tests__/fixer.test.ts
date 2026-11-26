import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FacadeAnalysis, Scene } from '../../schema/scene';
import { fmtDur } from '../../components/ui';
import { useStore } from '../../state/store';

describe('fmtDur', () => {
  it('rounds the total before splitting hours and minutes', () => {
    expect(fmtDur(59.6)).toBe('1h 00m');
    expect(fmtDur(119.5)).toBe('2h 00m');
    expect(fmtDur(179.8)).toBe('3h 00m');
    expect(fmtDur(61.2)).toBe('1h 01m');
    expect(fmtDur(12.4)).toBe('12m');
  });
});

const EX = resolve(__dirname, '../../../public/examples');
const id = 'paris-boulevard-diderot';
describe.skipIf(!existsSync(join(EX, id, 'scene.base.json')))('store camera edits and scene loading', () => {
  const load = (): Scene => ({ ...JSON.parse(readFileSync(join(EX, id, 'scene.base.json'), 'utf8')), analysis: JSON.parse(readFileSync(join(EX, id, 'analysis.json'), 'utf8')) as FacadeAnalysis });
  it('a roll edit pins pitch as manual (roll follows pitch)', () => {
    useStore.getState().loadScene(load());
    useStore.getState().setViewCamera('primary', { roll: 4 });
    expect(useStore.getState().camera!.provenance.pitch).toBe('manual');
    for (const v of useStore.getState().scene!.extraViews ?? []) {
      useStore.getState().setViewCamera(v.id, { roll: -2 });
      expect(useStore.getState().viewCameras[v.id].provenance.pitch).toBe('manual');
    }
  });
  it('loadScene resets the photo tool, align mode and the add-view dialog', () => {
    useStore.setState({ photoTool: 'add-window', alignMode: true, addViewOpen: true });
    useStore.getState().loadScene(load());
    const st = useStore.getState();
    expect(st.photoTool).toBe('select');
    expect(st.alignMode).toBe(false);
    expect(st.addViewOpen).toBe(false);
  });
  it('pushCameraUndo + undoViewCamera restore the camera before a UI change', () => {
    useStore.getState().loadScene(load());
    const before = structuredClone(useStore.getState().camera!);
    useStore.getState().pushCameraUndo('primary');
    useStore.getState().setViewCamera('primary', { heading: before.heading + 5 });
    expect(useStore.getState().undoViewCamera('primary')).toBe(true);
    expect(useStore.getState().camera).toEqual(before);
  });
});
