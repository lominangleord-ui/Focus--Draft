import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The main app is deliberately emitted as a single HTML file. Build the camera
 * worker separately as a same-origin module worker so it never needs a blob:
 * URL (blocked in some sandboxed/opaque-origin hosts).
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: path.resolve(root, "dist/attention-guard"),
    emptyOutDir: false,
    lib: {
      entry: path.resolve(root, "src/attention-guard/worker.ts"),
      formats: ["es"],
      fileName: () => "worker.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
