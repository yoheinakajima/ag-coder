import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// PORT / BASE_PATH default to local-dev-friendly values so `pnpm dev` and
// `pnpm build` work with zero config. Deployments (e.g. Replit) set these
// explicitly to override.
const rawPort = process.env.PORT ?? "24669";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

// Where the dev server forwards /api. Defaults to the API server's default port
// (8080) so a plain `pnpm dev` works with zero config. Override with
// API_PROXY_TARGET if the API runs elsewhere.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8080";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) => m.devBanner()),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Local-dev convenience: forward /api to the API server so the app works
    // with a plain `pnpm dev` outside Replit. On Replit the shared reverse proxy
    // routes /api before requests reach Vite, so this is inert there.
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        // Fail loudly: without this, an unreachable API silently surfaces as a
        // bare "Cannot GET /api/..." in the browser. Make the real cause obvious.
        configure: (proxy) => {
          proxy.on("error", (err) => {
            console.error(
              `[vite] /api proxy error — is the API server running at ${apiProxyTarget}? ` +
                `Start it with \`pnpm dev\` (root) or set API_PROXY_TARGET. (${err.message})`,
            );
          });
        },
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
