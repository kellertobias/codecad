// Pinch to zoom and drag to pan on touch; wheel and drag with a mouse.
// A double tap puts the content back. Taps pass through to the content.
import {
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";

interface Transform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
const identity: Transform = { x: 0, y: 0, scale: 1 };
const clampScale = (scale: number) => Math.min(20, Math.max(1, scale));

export function ZoomPan({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState<Transform>(identity);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    start: Transform;
    /** Centre and spread of the fingers when the gesture began. */
    cx: number;
    cy: number;
    spread: number;
  }>(undefined);
  const lastTap = useRef(0);

  /** Zooms about a point given relative to the box. */
  const zoomAt = (from: Transform, px: number, py: number, scale: number) => {
    const s = clampScale(scale);
    const k = s / from.scale;
    return s === 1
      ? identity
      : { scale: s, x: px - (px - from.x) * k, y: py - (py - from.y) * k };
  };
  const local = (x: number, y: number) => {
    const rect = box.current!.getBoundingClientRect();
    return { x: x - rect.left, y: y - rect.top };
  };
  const begin = () => {
    const points = [...pointers.current.values()];
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    const spread =
      points.length > 1
        ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y)
        : 0;
    gesture.current = { start: t, cx, cy, spread };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const p = local(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, p);
    begin();
    if (pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        setT(t.scale > 1 ? identity : zoomAt(t, p.x, p.y, 2.5));
        lastTap.current = 0;
      } else lastTap.current = now;
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, local(event.clientX, event.clientY));
    const points = [...pointers.current.values()];
    const g = gesture.current;
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    // Only take the pointer once it really moves, so taps still click.
    if (
      points.length === 1 &&
      g.start.scale === 1 &&
      Math.hypot(cx - g.cx, cy - g.cy) < 8
    )
      return;
    if (!box.current!.hasPointerCapture(event.pointerId))
      box.current!.setPointerCapture(event.pointerId);
    let next: Transform = {
      ...g.start,
      x: g.start.x + cx - g.cx,
      y: g.start.y + cy - g.cy,
    };
    if (points.length > 1 && g.spread > 0) {
      const spread = Math.hypot(
        points[0]!.x - points[1]!.x,
        points[0]!.y - points[1]!.y,
      );
      next = zoomAt(next, cx, cy, (g.start.scale * spread) / g.spread);
    }
    if (next.scale === 1) next = identity;
    setT(next);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size) begin();
    else gesture.current = undefined;
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && t.scale === 1 && Math.abs(event.deltaY) < 50) return;
    const p = local(event.clientX, event.clientY);
    setT(zoomAt(t, p.x, p.y, t.scale * Math.exp(-event.deltaY / 300)));
  };

  return (
    <div
      ref={box}
      className={`zoom-pan${t.scale > 1 ? " zoomed" : ""} ${className ?? ""}`}
      role="img"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div
        className="zoom-pan-content"
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
