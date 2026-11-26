/**
 * Colours for what the upload flow draws on the MapLibre basemap (footprints, hover, selection,
 * the camera dot and aim line, the facade picked in the direction picker, drawn corners).
 * MapLibre paint properties cannot read CSS variables, so each theme has its own set, chosen
 * for ≥ 3:1 contrast against its basemap (OpenFreeMap "dark" or "positron").
 */
import { useResolvedTheme, type Theme } from '../../lib/theme';

export interface MapPalette {
  footprint: string;
  footprintFillOpacity: number;
  hover: string;
  selFill: string;
  selFillOpacity: number;
  selLine: string;
  facade: string;
  camera: string;
  /** Ring around markers (white), separating them from the basemap. */
  halo: string;
  drawFill: string;
  drawLine: string;
  /** Fill of a drawn corner; its outline is `drawLine`. */
  drawPoint: string;
}

export const MAP_PALETTE: Record<Theme, MapPalette> = {
  // Selection is the UI accent blue; footprints are neutral grey.
  dark: {
    footprint: '#8c8c8c',
    footprintFillOpacity: 0.08,
    hover: '#7cc4ff',
    selFill: '#0d99ff',
    selFillOpacity: 0.28,
    selLine: '#0d99ff',
    facade: '#ffffff',
    camera: '#6fcf97',
    halo: '#ffffff',
    drawFill: '#0d99ff',
    drawLine: '#0d99ff',
    drawPoint: '#ffffff',
  },
  light: {
    footprint: '#737373',
    footprintFillOpacity: 0.08,
    hover: '#2b8ad6',
    selFill: '#0b84e5',
    selFillOpacity: 0.22,
    selLine: '#0a72c7',
    facade: '#1e1e1e',
    camera: '#17804a',
    halo: '#ffffff',
    drawFill: '#0b84e5',
    drawLine: '#0a72c7',
    drawPoint: '#ffffff',
  },
};

export function useMapPalette(): MapPalette {
  return MAP_PALETTE[useResolvedTheme()];
}
