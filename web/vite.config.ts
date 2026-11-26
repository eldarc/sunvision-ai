import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Read the repository-root .env (only VITE_* variables are exposed to the client bundle).
  envDir: '..',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 3000 },
});
