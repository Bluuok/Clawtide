import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The console is served by the Clawtide backend in production (built assets);
// in dev, Vite proxies API + WS to the backend so cookies flow same-origin.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
      '/auth': 'http://127.0.0.1:3000',
      '/workspaces': 'http://127.0.0.1:3000',
      '/profiles': 'http://127.0.0.1:3000',
      '/drafts': 'http://127.0.0.1:3000',
      '/chat': 'http://127.0.0.1:3000',
      '/tasks': 'http://127.0.0.1:3000',
      '/settings': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'console-document-routes',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (
            req.method === 'GET' &&
            req.headers.accept?.includes('text/html') &&
            /^\/(chat|profiles|tasks|workspaces|settings|login|setup)\/?(?:\?.*)?$/.test(
              req.url ?? '',
            )
          ) {
            req.url = '/index.html';
          }
          next();
        });
      },
    },
  ],
});
