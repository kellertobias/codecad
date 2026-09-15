# CodeCAD application icon

Generated with the built-in image-generation tool. Source: `codecad-icon.png`.
Tauri's icon generator creates the platform sizes in `src-tauri/icons`; the
256-pixel PNG is also used on the desktop welcome screen.

## Generation prompt

Use case: logo-brand. Asset type: production macOS application icon for CodeCAD, a code-driven 3D CAD and fabrication studio. Create one polished sculptural icon: an unmistakable isometric C-shaped machined solid that also hints at an open cube and code bracket. Elegant thick solid geometry, beautifully chamfered edges, restrained cyan/teal illuminated edge accents with cool brushed aluminum faces, on a deep graphite rounded-square macOS icon tile. Strong legible silhouette at 32 pixels, minimal details, professional engineering tool rather than gaming aesthetic. Centered front-isometric composition, generous safe margins, subtle studio lighting and tactile depth. Square 1024x1024 canvas. Transparent alpha outside the rounded-square tile. No text, no tiny dimension labels, no additional symbols, no watermark, no surrounding scene. Final app icon asset, not a mockup.

## Regenerate platform sizes

```sh
npx tauri icon assets/codecad-icon.png --output src-tauri/icons
cp src-tauri/icons/128x128@2x.png desktop/icon.png
```
