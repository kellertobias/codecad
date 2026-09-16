import { readFile, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";

const [modelPath, outputPath] = process.argv.slice(2);
if (!modelPath || !outputPath)
  throw new Error(
    "Usage: node scripts/render-project-preview.mjs <model.json> <preview.png>",
  );
const model = JSON.parse(await readFile(modelPath, "utf8"));
const width = 240,
  height = 150;
const canvas = createCanvas(width, height);
const context = canvas.getContext("2d");
context.fillStyle = "#14242b";
context.fillRect(0, 0, width, height);

function project(x, y, z, matrix) {
  const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  return [
    (worldX - worldY) * 0.7071,
    (worldX + worldY) * 0.4082 - worldZ * 0.8165,
  ];
}
const groups = [];
let left = Infinity,
  right = -Infinity,
  top = Infinity,
  bottom = -Infinity;
for (const mesh of model.meshes) {
  const lines = [];
  for (let i = 0; i + 5 < mesh.edges.length; i += 6) {
    const a = project(...mesh.edges.slice(i, i + 3), mesh.matrix);
    const b = project(...mesh.edges.slice(i + 3, i + 6), mesh.matrix);
    lines.push([a, b]);
    for (const [x, y] of [a, b]) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  groups.push({ color: mesh.color, lines });
}
if (!Number.isFinite(left)) throw new Error("Model has no previewable edges");
const scale = Math.min(
  (width - 20) / Math.max(right - left, 1),
  (height - 20) / Math.max(bottom - top, 1),
);
const offsetX = (width - (right - left) * scale) / 2 - left * scale;
const offsetY = (height - (bottom - top) * scale) / 2 - top * scale;
context.lineWidth = 0.8;
context.globalAlpha = 0.7;
for (const { color, lines } of groups) {
  context.strokeStyle = color;
  context.beginPath();
  for (const [a, b] of lines) {
    context.moveTo(offsetX + a[0] * scale, offsetY + a[1] * scale);
    context.lineTo(offsetX + b[0] * scale, offsetY + b[1] * scale);
  }
  context.stroke();
}
await writeFile(outputPath, canvas.toBuffer("image/png"));
