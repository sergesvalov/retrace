import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Assets relative to the page: the site is at / at home and at /retrace/ behind haproxy
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    // maplibre-gl alone is ~800 kB minified and cannot be split further
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Big libraries in their own files: an app deploy does not re-download them
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
