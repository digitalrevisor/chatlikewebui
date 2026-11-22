import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the page runs on 5180 and calls the server on 3800
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, proxy: { '/api': { target: 'http://127.0.0.1:3800', changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
