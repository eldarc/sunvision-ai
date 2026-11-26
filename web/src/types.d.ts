declare module 'tz-lookup' {
  export default function tzlookup(lat: number, lon: number): string;
}

/** Build-time variables read through `import.meta.env` (see .env.example). */
interface ImportMetaEnv {
  /** Absolute origin of the API (no trailing slash). Unset: requests go to relative `/api/...`. */
  readonly VITE_API_BASE_URL?: string;
}
