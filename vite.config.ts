import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH || loadEnv(mode, process.cwd(), 'VITE_').VITE_BASE_PATH || '/',
  esbuild: { jsx: 'automatic' },
  server: { hmr: { overlay: false } },
}));
