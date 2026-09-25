# Third-party notices

Copyright 2026 Tobias Keller.

CodeCAD is licensed under Apache-2.0. Its bundled components keep their own
licenses; this file records the components materially included in source and
desktop distributions.

| Component | License | Distribution note |
| --- | --- | --- |
| OpenCascade via `occt-wasm` 5.0.0 | LGPL-2.1-only | The compiled WebAssembly kernel is a separate, replaceable component. |
| brepjs 19.0.4 | Apache-2.0 | Geometry abstraction layer. |
| FreeCAD planegcs via `@salusoft89/planegcs` 1.2.0 | LGPL-2.0-or-later | 2D sketch constraint solver; the compiled WebAssembly solver is a separate, replaceable component. |
| TypeScript / TypeScript Native 6.0.2 / 7.0.2 | Apache-2.0 | Compiler and language services. |
| Tauri 2.11.5 and CLI | MIT or Apache-2.0 | Desktop framework. |
| PDF.js 6.3.289 | Apache-2.0 | PDF viewer. |
| Monaco Editor 0.56.0 | MIT | Code editor. |
| Three.js 0.186.0 | MIT | 3D preview. |
| PDFKit 0.20.2; svg-to-pdfkit 0.1.8; fflate 0.8.3; esbuild 0.28.2; tsx 4.23.13 | MIT | Rendering, compression, build and runtime utilities. |
| DOMPurify 3.4.15 | MPL-2.0 or Apache-2.0 | Browser sanitization dependency. |
| Remaining npm transitive dependencies | MIT, Apache-2.0, ISC, or 0BSD | Exact versions and SPDX metadata are pinned in `package-lock.json`. |

## OpenCascade LGPL component

The `occt-wasm` package's JavaScript tooling is MIT or Apache-2.0, but its
compiled OpenCascade WebAssembly output is LGPL-2.1-only. CodeCAD does not
modify that kernel. Desktop distributions retain it as a standalone `.wasm`
resource in `Contents/Resources/runtime/node_modules/occt-wasm`; replacing
that file with a compatible build is supported. The kernel can also be loaded
from another URL through `OcctKernel.init({ wasm: "…" })` in web deployments.

The same applies to the planegcs sketch solver (LGPL-2.0-or-later): CodeCAD
uses the unmodified `planegcs.wasm` from `@salusoft89/planegcs` as a separate
file that can be replaced with a compatible build.

The complete LGPL-2.1 text is available from the Free Software Foundation at
<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>. Distributors must
include that license text with any binary distribution containing the kernel
and comply with its applicable source and relinking/replacement requirements.

This notice is not legal advice. Before commercial distribution, review the
LGPL obligations for the exact bundle layout and any changes to OpenCascade.
