/**
 * Light / dark theme. CSS colours come from tokens in index.css (`--color-*`, swapped under
 * `:root[data-theme="light"]`). Non-CSS consumers (Three.js, MapLibre, Supervision.js,
 * SVG/canvas drawing) read `useThemeColors()` instead of hard-coding hex values.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../state/store';

export type Theme = 'light' | 'dark';

const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null);

function subscribeSystem(cb: () => void) {
  const m = mq();
  if (!m) return () => {};
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}
const systemTheme = (): Theme => (mq()?.matches ? 'light' : 'dark');

/** The theme in effect: the user's choice, or the system preference when set to 'system'. */
export function useResolvedTheme(): Theme {
  const pref = useStore((s) => s.themePreference);
  const sys = useSyncExternalStore(subscribeSystem, systemTheme, () => 'dark' as Theme);
  return pref === 'system' ? sys : pref;
}

/** Mirrors the resolved theme onto <html data-theme> and the native color-scheme. Mount once (App). */
export function useApplyTheme() {
  const theme = useResolvedTheme();
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = theme;
    el.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme].pageBg);
  }, [theme]);
  return theme;
}

export interface ThemeColors {
  pageBg: string;
  /** 3D view */
  sceneBgDay: string;
  sceneBgNight: string;
  fog: string;
  ground: string;
  road: string;
  buildingTarget: string;
  buildingPhoto: string;
  buildingMap: string;
  buildingHypothetical: string;
  edge: string;
  /** Photo panel (Supervision.js renderer clear colour, as 0xRRGGBB) */
  photoBg: number;
  /** Text / outlines drawn in SVG or canvas */
  overlayText: string;
  overlayMuted: string;
  overlayStroke: string;
  /** MapLibre style URL (OpenFreeMap) */
  mapStyle: string;
}

export const THEME_COLORS: Record<Theme, ThemeColors> = {
  dark: {
    pageBg: '#1e1e1e', // = --color-ink-950 (dark)
    // Neutral greys that sit next to the #1e1e1e canvas and #2c2c2c panels; the fog matches the
    // background so the ground disc fades out instead of ending in an edge.
    sceneBgDay: '#232323',
    sceneBgNight: '#171717',
    fog: '#232323',
    ground: '#2f2f2f',
    road: '#454545',
    // Buildings: the target a clean light neutral, photo and map neighbours progressively greyer.
    buildingTarget: '#ededed',
    buildingPhoto: '#b5b5b5',
    buildingMap: '#8a8a8a',
    buildingHypothetical: '#a98bd6',
    edge: '#111111',
    photoBg: 0x1e1e1e,
    overlayText: '#f5f5f5',
    overlayMuted: '#c2c2c2',
    overlayStroke: '#111111',
    mapStyle: 'https://tiles.openfreemap.org/styles/dark',
  },
  light: {
    pageBg: '#f5f5f5', // = --color-ink-950 (light)
    sceneBgDay: '#e8e8e8',
    sceneBgNight: '#333333',
    fog: '#e8e8e8',
    ground: '#d2d2d2',
    road: '#b4b4b4',
    buildingTarget: '#fafafa',
    buildingPhoto: '#d9d9d9',
    buildingMap: '#c0c0c0',
    buildingHypothetical: '#b9a0e0',
    edge: '#666666',
    photoBg: 0xf5f5f5,
    overlayText: '#1e1e1e', // = --color-paper (light)
    overlayMuted: '#545454', // = --color-ink-300 (light)
    overlayStroke: '#ffffff',
    mapStyle: 'https://tiles.openfreemap.org/styles/positron',
  },
};

export function useThemeColors(): ThemeColors {
  return THEME_COLORS[useResolvedTheme()];
}
