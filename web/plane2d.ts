import type { Point2 } from "../src/model.js";
import type { View2DPrimitive } from "../src/view2d.js";

export function planeBounds(items: readonly View2DPrimitive[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const item of items) {
    if (item.kind === "path")
      for (const point of item.points) include(point.x, point.y);
    else {
      include(item.center.x - item.radius, item.center.y - item.radius);
      include(item.center.x + item.radius, item.center.y + item.radius);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}

export function gridStep(scale: number) {
  const target = 70 / scale;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  return [1, 2, 5, 10].find((step) => step * magnitude >= target)! * magnitude;
}

/** Millimetres in world space; Y points up while canvas Y points down. */
export class Plane2DViewport {
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  toScreen(point: Point2, width: number, height: number): Point2 {
    return {
      x: width / 2 + this.offsetX + point.x * this.scale,
      y: height / 2 + this.offsetY - point.y * this.scale,
    };
  }

  toWorld(point: Point2, width: number, height: number): Point2 {
    return {
      x: (point.x - width / 2 - this.offsetX) / this.scale,
      y: -(point.y - height / 2 - this.offsetY) / this.scale,
    };
  }

  pan(dx: number, dy: number) {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  zoomAt(factor: number, cursor: Point2, width: number, height: number) {
    const anchor = this.toWorld(cursor, width, height);
    this.scale = Math.max(0.01, Math.min(10000, this.scale * factor));
    this.offsetX = cursor.x - width / 2 - anchor.x * this.scale;
    this.offsetY = cursor.y - height / 2 + anchor.y * this.scale;
  }

  fit(items: readonly View2DPrimitive[], width: number, height: number) {
    const bounds = planeBounds(items);
    if (!bounds || width <= 0 || height <= 0) return;
    const extentX = Math.max(bounds.maxX - bounds.minX, 1);
    const extentY = Math.max(bounds.maxY - bounds.minY, 1);
    this.scale = Math.max(
      0.01,
      Math.min(
        10000,
        Math.min((width - 112) / extentX, (height - 112) / extentY),
      ),
    );
    this.offsetX = -((bounds.minX + bounds.maxX) / 2) * this.scale;
    this.offsetY = ((bounds.minY + bounds.maxY) / 2) * this.scale;
  }
}

export class Plane2DCanvas {
  private readonly viewport = new Plane2DViewport();
  private items: readonly View2DPrimitive[] = [];
  private needsFit = true;
  private dragging: { x: number; y: number } | undefined;

  constructor(private readonly canvas: HTMLCanvasElement) {
    new ResizeObserver(() => this.render()).observe(canvas);
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      this.dragging = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.dragging) return;
      this.viewport.pan(
        event.clientX - this.dragging.x,
        event.clientY - this.dragging.y,
      );
      this.dragging = { x: event.clientX, y: event.clientY };
      this.render();
    });
    canvas.addEventListener("pointerup", () => (this.dragging = undefined));
    canvas.addEventListener("pointercancel", () => (this.dragging = undefined));
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        this.viewport.zoomAt(
          Math.exp(-event.deltaY * 0.001),
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          canvas.clientWidth,
          canvas.clientHeight,
        );
        this.render();
      },
      { passive: false },
    );
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  setItems(items: readonly View2DPrimitive[]) {
    this.items = items;
    this.needsFit = true;
    this.render();
  }

  fit() {
    this.needsFit = true;
    this.render();
  }

  render() {
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight;
    if (!width || !height) return;
    if (this.needsFit) {
      this.viewport.fit(this.items, width, height);
      this.needsFit = false;
    }
    const ratio = Math.min(devicePixelRatio, 2);
    const pixelWidth = Math.round(width * ratio),
      pixelHeight = Math.round(height * ratio);
    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight
    ) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#16232b";
    ctx.fillRect(0, 0, width, height);
    const step = gridStep(this.viewport.scale);
    const low = this.viewport.toWorld({ x: 0, y: height }, width, height);
    const high = this.viewport.toWorld({ x: width, y: 0 }, width, height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2b3d46";
    ctx.beginPath();
    for (let x = Math.ceil(low.x / step) * step; x <= high.x; x += step) {
      const pixel = this.viewport.toScreen({ x, y: 0 }, width, height).x;
      ctx.moveTo(pixel, 0);
      ctx.lineTo(pixel, height);
    }
    for (let y = Math.ceil(low.y / step) * step; y <= high.y; y += step) {
      const pixel = this.viewport.toScreen({ x: 0, y }, width, height).y;
      ctx.moveTo(0, pixel);
      ctx.lineTo(width, pixel);
    }
    ctx.stroke();
    const origin = this.viewport.toScreen({ x: 0, y: 0 }, width, height);
    ctx.strokeStyle = "#526c72";
    ctx.beginPath();
    ctx.moveTo(origin.x, 0);
    ctx.lineTo(origin.x, height);
    ctx.moveTo(0, origin.y);
    ctx.lineTo(width, origin.y);
    ctx.stroke();
    for (const item of this.items) {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let labelAt: Point2;
      if (item.kind === "path") {
        labelAt = item.points[0]!;
        for (const [index, point] of item.points.entries()) {
          const pixel = this.viewport.toScreen(point, width, height);
          if (index === 0) ctx.moveTo(pixel.x, pixel.y);
          else ctx.lineTo(pixel.x, pixel.y);
        }
        if (item.closed) ctx.closePath();
      } else {
        labelAt = { x: item.center.x + item.radius, y: item.center.y };
        const center = this.viewport.toScreen(item.center, width, height);
        ctx.arc(
          center.x,
          center.y,
          item.radius * this.viewport.scale,
          0,
          Math.PI * 2,
        );
      }
      ctx.stroke();
      if (item.label) {
        const pixel = this.viewport.toScreen(labelAt, width, height);
        ctx.fillStyle = "#c9ddd9";
        ctx.font = "12px sans-serif";
        ctx.fillText(item.label, pixel.x + 7, pixel.y - 8);
      }
    }
  }
}
