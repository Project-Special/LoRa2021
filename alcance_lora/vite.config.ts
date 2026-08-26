import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: { port: 3100, host: '0.0.0.0' },
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Leaflet e Supabase sao pesados e mudam pouco; em chunk proprio o
        // navegador reaproveita entre versoes do app.
        manualChunks: {
          react: ['react', 'react-dom'],
          leaflet: ['leaflet'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
