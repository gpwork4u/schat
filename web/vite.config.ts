import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two independent run modes (decoupled — neither depends on the other):
//   • dev server  — `npm run dev` → http://localhost:5173 (HMR), bridged via the
//     extension's app-bridge content script (window.postMessage transport).
//   • in-extension — `npm run build:ext` → bundles into extension/app, opened as
//     a chrome-extension:// page that talks to background directly (no server).
// Relative base on build makes assets resolve under chrome-extension://<id>/app/.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
}));
