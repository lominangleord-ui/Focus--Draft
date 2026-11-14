import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";

const requiredFiles = [
  "dist/index.html",
  "dist/attention-guard/worker.js",
  "dist/attention-guard/face_landmarker.task",
  "dist/attention-guard/wasm/vision_wasm_module_internal.js",
  "dist/attention-guard/wasm/vision_wasm_module_internal.wasm",
];

for (const file of requiredFiles) {
  try {
    await access(file, constants.R_OK);
    const { size } = await stat(file);
    if (size === 0) throw new Error("file is empty");
  } catch (error) {
    throw new Error(
      `Camera deployment asset is missing or empty: ${file}. ` +
      "Build both Vite targets and publish the dist directory (Vercel: npm run build, output dist).",
      { cause: error },
    );
  }
}

console.log("Camera deployment assets verified.");
