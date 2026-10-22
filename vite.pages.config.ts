import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/activity-atlas";
const basePath = `/${configuredBasePath.trim().replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");

export default defineConfig({
  root: path.join(projectRoot, "static-site"),
  base: basePath ? `${basePath}/` : "/",
  publicDir: path.join(projectRoot, "public"),
  define: {
    "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify(basePath),
  },
  plugins: [react()],
  build: {
    outDir: path.join(projectRoot, "dist", "pages"),
    emptyOutDir: true,
  },
});
