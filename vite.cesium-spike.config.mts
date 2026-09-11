import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  envFile: false,
  resolve: {
    dedupe: ['@cesium/engine', '@cesium/widgets'],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { host: '127.0.0.1', port: 4186, strictPort: true },
});
