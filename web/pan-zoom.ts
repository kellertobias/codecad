export class PanZoom {
  scale = 1;
  x = 0;
  y = 0;
  reset() {
    this.scale = 1;
    this.x = this.y = 0;
  }
  pan(x: number, y: number) {
    this.x += x;
    this.y += y;
  }
  zoom(factor: number, x = 0, y = 0) {
    const next = Math.max(0.25, Math.min(12, this.scale * factor));
    const ratio = next / this.scale;
    this.x = x - (x - this.x) * ratio;
    this.y = y - (y - this.y) * ratio;
    this.scale = next;
  }
}

/**
 * The region of a page, in page units, that a pan/zoom state shows inside an
 * element of the given pixel size. Driving an SVG viewBox with this keeps the
 * drawing sharp at every zoom level, where scaling the element would only
 * stretch the pixels it was first rasterised with.
 */
export function viewBoxFor(
  view: { scale: number; x: number; y: number },
  page: { width: number; height: number },
  width: number,
  height: number,
) {
  const perUnit =
    Math.min(width / page.width, height / page.height) * view.scale;
  const boxWidth = width / perUnit,
    boxHeight = height / perUnit;
  return {
    minX: page.width / 2 - view.x / perUnit - boxWidth / 2,
    minY: page.height / 2 - view.y / perUnit - boxHeight / 2,
    width: boxWidth,
    height: boxHeight,
  };
}

/** Independent, vector-sharp viewport for each drawing or sheet page. */
export function drawingViewport(src: string, title: string) {
  const wrapper = document.createElement("div");
  wrapper.className = "drawing-viewer";
  const toolbar = document.createElement("div");
  toolbar.className = "drawing-tools";
  const viewport = document.createElement("div");
  viewport.className = "drawing-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", `${title}: zoomable preview`);
  const img = document.createElement("img");
  img.src = src;
  img.alt = title;
  img.draggable = false;
  const state = new PanZoom();
  const readout = document.createElement("span");
  const render = () => {
    img.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    readout.textContent = `${Math.round(state.scale * 100)}%`;
  };
  for (const [label, action] of [
    ["Zoom out", () => state.zoom(1 / 1.25)],
    ["Zoom in", () => state.zoom(1.25)],
    ["Fit page", () => state.reset()],
  ] as const) {
    const button = document.createElement("button");
    button.textContent = label;
    button.setAttribute("aria-label", `${label}: ${title}`);
    button.onclick = () => {
      action();
      render();
    };
    toolbar.append(button);
  }
  const hint = document.createElement("small");
  hint.textContent = "Scroll to zoom · drag to pan · double-click to fit";
  toolbar.append(readout, hint);
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? bounds.height
            : 1);
      state.zoom(
        Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002),
        event.clientX - bounds.left - bounds.width / 2,
        event.clientY - bounds.top - bounds.height / 2,
      );
      render();
    },
    { passive: false },
  );
  const pointers = new Map<number, { x: number; y: number }>();
  viewport.onpointerdown = (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.classList.add("panning");
  };
  viewport.onpointermove = (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const other = [...pointers.entries()].find(
      ([id]) => id !== event.pointerId,
    )?.[1];
    if (other) {
      const oldDistance = Math.hypot(
        previous.x - other.x,
        previous.y - other.y,
      );
      const distance = Math.hypot(
        event.clientX - other.x,
        event.clientY - other.y,
      );
      const bounds = viewport.getBoundingClientRect();
      if (oldDistance > 0 && distance > 0)
        state.zoom(
          distance / oldDistance,
          (previous.x + other.x) / 2 - bounds.left - bounds.width / 2,
          (previous.y + other.y) / 2 - bounds.top - bounds.height / 2,
        );
      state.pan(
        (event.clientX - previous.x) / 2,
        (event.clientY - previous.y) / 2,
      );
    } else state.pan(event.clientX - previous.x, event.clientY - previous.y);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    render();
  };
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (!pointers.size) viewport.classList.remove("panning");
  };
  viewport.onpointerup = release;
  viewport.onpointercancel = release;
  viewport.onlostpointercapture = release;
  viewport.ondblclick = () => {
    state.reset();
    render();
  };
  viewport.onkeydown = (event) => {
    if (event.key === "+" || event.key === "=") state.zoom(1.25);
    else if (event.key === "-") state.zoom(1 / 1.25);
    else if (event.key === "0" || event.key === "Home") state.reset();
    else if (event.key === "ArrowLeft") state.pan(40, 0);
    else if (event.key === "ArrowRight") state.pan(-40, 0);
    else if (event.key === "ArrowUp") state.pan(0, 40);
    else if (event.key === "ArrowDown") state.pan(0, -40);
    else return;
    event.preventDefault();
    render();
  };
  viewport.append(img);
  wrapper.append(toolbar, viewport);
  render();
  return wrapper;
}
