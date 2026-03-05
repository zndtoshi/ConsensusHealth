import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: "avatars-cache-control",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith("/avatars/")) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
          next();
        });
      },
    },
  ],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/auth": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/dev": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
})
