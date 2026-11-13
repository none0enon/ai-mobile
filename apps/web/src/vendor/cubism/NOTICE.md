Live2D Cubism SDK for Web 5-r.5

- `live2dcubismcore.min.js`: official SDK Core, also supplied in the Madara v19 test package. See `Core-LICENSE.md`.
- `framework.js`: generated ESM subset of the official Framework tag `5-r.5`, commit `198a3769c26ca3d7b600e932590433badd392edd`. See `Framework-LICENSE.md`.
- The build embeds the official WebGL shaders to avoid runtime network fetches and work in the app's single-file preview build.
- The app loads Core before evaluating Framework, using the same bundled version in previews and video calls.

Rebuild from the extracted official SDK directory with `pnpm --filter @app/web build:cubism /path/to/CubismSdkForWeb-5-r.5`.

Sources: https://github.com/Live2D/CubismWebFramework/tree/5-r.5 and https://www.live2d.com/en/sdk/download/web/.

`../../live2d/gesture.ts` adapts the continuous, retargetable gesture controller from the user-supplied `Madara-Live2D-v19-complete-interactive.zip`. Uploaded packages contribute model data only; their JavaScript and HTML are never executed.
