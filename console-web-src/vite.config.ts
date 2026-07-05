import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The bot serves the built SPA under /console (publicGuard only lets /console*
// through the tunnel), so every emitted asset URL MUST be prefixed /console/.
// Output lands directly in ../console-web, which is what express.static serves
// (CONSOLE_WEB = resolve(__dirname, '../../console-web')). emptyOutDir wipes the
// old hand-rolled index.html on each build.
export default defineConfig({
  base: '/console/',
  plugins: [react()],
  build: {
    outDir: '../console-web',
    emptyOutDir: true,
    // Single small chunk is fine; keep asset names hashed for cache-busting.
    assetsDir: 'assets',
    target: 'es2020',
  },
});
