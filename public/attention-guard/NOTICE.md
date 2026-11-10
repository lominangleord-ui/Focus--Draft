# Attention Guard bundled MediaPipe assets

The following MediaPipe assets are distributed locally with Focus Draft. Their bytes are unmodified.

- `face_landmarker.task` — copied from `@beautinique/frontend-tryon-assets@1.0.2`, `models/face_landmarker.task`. That package's `NOTICE.md` identifies the model as Google's MediaPipe model, copied as downloaded and distributed under Apache License 2.0. SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.
- `wasm/vision_wasm_module_internal.js` and `wasm/vision_wasm_module_internal.wasm` — copied from `@mediapipe/tasks-vision@1.2.2` for the module worker.

Copyright Google LLC. These model/runtime assets are licensed under the Apache License, Version 2.0. The full license text is in `LICENSE-MediaPipe.txt`.

The JavaScript SDK itself is a build-time dependency and is bundled into the local worker. Attention Guard does not load the model, WASM, or SDK from a CDN at runtime.
