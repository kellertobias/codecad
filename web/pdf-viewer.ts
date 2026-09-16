import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

export interface PdfReport {
  title: string;
  url: string;
  download: HTMLElement;
}
/** One continuous document workspace and one zoom level for the entire section. */
export function pdfViewer(reports: PdfReport[]) {
  const element = document.createElement("section");
  element.className = "pdf-viewer";
  const tools = document.createElement("div"),
    viewport = document.createElement("div"),
    stack = document.createElement("div");
  tools.className = "pdf-tools";
  tools.setAttribute("role", "toolbar");
  tools.setAttribute("aria-label", "PDF navigation and zoom");
  viewport.className = "pdf-scroll";
  stack.className = "pdf-stack";
  viewport.tabIndex = 0;
  viewport.setAttribute(
    "aria-label",
    "PDF pages: drag to pan, Ctrl or Command scroll to zoom",
  );
  const status = document.createElement("span");
  status.textContent = "Loading PDF…";
  status.setAttribute("role", "status");
  const pages: {
    page: PDFPageProxy;
    slot: HTMLElement;
    width: number;
    height: number;
    rendered: number;
    task?: RenderTask;
  }[] = [];
  const loading: PDFDocumentLoadingTask[] = [];
  let scale = 1,
    fit = true,
    disposed = false,
    started = false,
    frame = 0;
  const readout = document.createElement("span");
  const pageNumber = document.createElement("input");
  pageNumber.type = "number";
  pageNumber.min = "1";
  pageNumber.value = "1";
  pageNumber.setAttribute("aria-label", "PDF page number");
  const widest = () => Math.max(1, ...pages.map((p) => p.width));
  const update = () => {
    if (disposed) return;
    const bounds = viewport.getBoundingClientRect();
    for (const p of pages) {
      const rect = p.slot.getBoundingClientRect();
      const visible =
        rect.bottom > bounds.top - 200 &&
        rect.top < bounds.bottom + 200 &&
        bounds.height > 0;
      if (!visible) {
        p.task?.cancel();
        delete p.task;
        p.slot.replaceChildren();
        p.rendered = 0;
        continue;
      }
      if (p.rendered === scale) continue;
      p.task?.cancel();
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", p.slot.getAttribute("aria-label")!);
      const view = p.page.getViewport({ scale });
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8_000_000 / (view.width * view.height)),
      );
      canvas.width = Math.ceil(view.width * dpr);
      canvas.height = Math.ceil(view.height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      p.slot.replaceChildren(canvas);
      p.rendered = scale;
      const task = p.page.render({
        canvas,
        viewport: view,
        transform: [dpr, 0, 0, dpr, 0, 0],
      });
      p.task = task;
      task.promise.catch((error) => {
        if (error?.name !== "RenderingCancelledException" && !disposed)
          status.textContent = `PDF render failed: ${String(error)}`;
      });
    }
    let active = -1,
      mostVisible = 0;
    pages.forEach((p, index) => {
      const rect = p.slot.getBoundingClientRect();
      const visible = Math.max(
        0,
        Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top),
      );
      if (visible > mostVisible) {
        active = index;
        mostVisible = visible;
      }
    });
    if (active >= 0 && document.activeElement !== pageNumber)
      pageNumber.value = String(active + 1);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  const layout = () => {
    if (!pages.length || viewport.clientWidth === 0) return;
    if (fit)
      scale = Math.min(
        4,
        Math.max(0.1, (viewport.clientWidth - 48) / widest()),
      );
    stack.style.width = `${Math.max(viewport.clientWidth, widest() * scale + 48)}px`;
    for (const p of pages) {
      p.slot.style.width = `${p.width * scale}px`;
      p.slot.style.height = `${p.height * scale}px`;
    }
    readout.textContent = `${Math.round(scale * 100)}%${fit ? " · Fit width" : ""}`;
    schedule();
  };
  const zoom = (
    factor: number,
    x = viewport.clientWidth / 2,
    y = viewport.clientHeight / 2,
  ) => {
    fit = false;
    const before = scale,
      left = viewport.scrollLeft + x,
      top = viewport.scrollTop + y;
    scale = Math.max(0.1, Math.min(4, scale * factor));
    layout();
    viewport.scrollLeft = (left * scale) / before - x;
    viewport.scrollTop = (top * scale) / before - y;
  };
  for (const [label, action] of [
    ["Zoom out", () => zoom(1 / 1.25)],
    ["Zoom in", () => zoom(1.25)],
    [
      "Fit width",
      () => {
        fit = true;
        layout();
      },
    ],
  ] as const) {
    const button = document.createElement("button");
    button.textContent = label;
    button.onclick = action;
    tools.append(button);
  }
  pageNumber.onchange = () => {
    const p =
      pages[
        Math.max(0, Math.min(pages.length - 1, Number(pageNumber.value) - 1))
      ];
    if (p)
      viewport.scrollTop +=
        p.slot.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        16;
  };
  const hint = document.createElement("small");
  hint.textContent = "Scroll pages · drag to pan · Ctrl/⌘ + scroll to zoom";
  tools.append(readout, pageNumber, status, hint);
  viewport.append(stack);
  element.append(tools, viewport);
  viewport.addEventListener("scroll", schedule);
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const r = viewport.getBoundingClientRect();
      zoom(
        Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.005),
        event.clientX - r.left,
        event.clientY - r.top,
      );
    },
    { passive: false },
  );
  const pointers = new Map<number, { x: number; y: number }>();
  viewport.onpointerdown = (event) => {
    if (
      (event.target as HTMLElement).closest("button,a,select,input") ||
      (event.button !== 0 && event.button !== 1)
    )
      return;
    event.preventDefault();
    viewport.focus();
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.classList.add("panning");
  };
  viewport.onpointermove = (event) => {
    const drag = pointers.get(event.pointerId);
    if (!drag) return;
    const other = [...pointers.entries()].find(
      ([id]) => id !== event.pointerId,
    )?.[1];
    if (other) {
      const oldDistance = Math.hypot(drag.x - other.x, drag.y - other.y);
      const distance = Math.hypot(
        event.clientX - other.x,
        event.clientY - other.y,
      );
      const rect = viewport.getBoundingClientRect();
      if (oldDistance > 0 && distance > 0)
        zoom(
          distance / oldDistance,
          (drag.x + other.x) / 2 - rect.left,
          (drag.y + other.y) / 2 - rect.top,
        );
    }
    viewport.scrollLeft -= (event.clientX - drag.x) / (other ? 2 : 1);
    viewport.scrollTop -= (event.clientY - drag.y) / (other ? 2 : 1);
    drag.x = event.clientX;
    drag.y = event.clientY;
  };
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (!pointers.size) viewport.classList.remove("panning");
  };
  viewport.onpointerup = release;
  viewport.onpointercancel = release;
  viewport.onlostpointercapture = release;
  viewport.onkeydown = (event) => {
    if (event.key === "+" || event.key === "=") {
      zoom(1.25);
      event.preventDefault();
    } else if (event.key === "-") {
      zoom(1 / 1.25);
      event.preventDefault();
    } else if (event.key === "0") {
      fit = true;
      layout();
    }
  };
  const observer = new ResizeObserver(layout);
  observer.observe(viewport);
  const start = () => {
    if (started || disposed) return;
    started = true;
    void (async () => {
      try {
        for (const report of reports) {
          if (disposed) return;
          const heading = document.createElement("h3");
          heading.textContent = report.title;
          heading.append(report.download);
          stack.append(heading);
          const task = getDocument({ url: report.url });
          loading.push(task);
          const pdf = await task.promise;
          if (disposed) return;
          for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            if (disposed) return;
            const size = page.getViewport({ scale: 1 }),
              slot = document.createElement("div");
            slot.className = "pdf-page";
            slot.setAttribute("aria-label", `${report.title} · page ${n}`);
            stack.append(slot);
            pages.push({
              page,
              slot,
              width: size.width,
              height: size.height,
              rendered: 0,
            });
          }
        }
        status.textContent = `${pages.length} pages`;
        pageNumber.max = String(pages.length);
        layout();
      } catch (error) {
        if (!disposed)
          status.textContent = `Could not load PDF: ${String(error)}`;
      }
    })();
  };
  return {
    element,
    start,
    dispose() {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      pages.forEach((p) => p.task?.cancel());
      loading.forEach((task) => {
        void task.destroy();
      });
    },
  };
}
