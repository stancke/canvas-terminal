/**
 * Alinhamento em grade dos terminais: calcula encaixes nas bordas e nos centros
 * dos terminais vizinhos enquanto uma janela é movida ou redimensionada.
 *
 * As coordenadas são de mundo (as mesmas de `TerminalWindow.x/y/w/h`). As linhas
 * guias são desenhadas num overlay dentro do viewport, em pixels de tela.
 */

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapResult extends SnapRect {
  /** Coordenadas de mundo das linhas verticais (x) a exibir. */
  vertical: number[];
  /** Coordenadas de mundo das linhas horizontais (y) a exibir. */
  horizontal: number[];
}

/** Distância (em px de tela) para grudar nas bordas/centros de outro terminal. */
const MOVE_TOLERANCE_PX = 6;
const RESIZE_TOLERANCE_PX = 5;
/** Grade visual do canvas, em unidades de mundo. */
const GRID_SIZE = 32;
const GRID_TOLERANCE_PX = 3;

function unique(values: number[]): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (result.some((other) => Math.abs(other - value) < 0.001)) continue;
    result.push(value);
    if (result.length >= 4) break;
  }
  return result;
}

function xCoordinates(rect: SnapRect): number[] {
  return [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
}

function yCoordinates(rect: SnapRect): number[] {
  return [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
}

function bestDelta(
  values: number[],
  targets: number[],
  tolerance: number,
): number | null {
  let best: number | null = null;
  for (const value of values) {
    for (const target of targets) {
      const delta = target - value;
      if (Math.abs(delta) > tolerance) continue;
      if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
    }
  }
  return best;
}

function bestSize(
  current: number,
  targets: number[],
  tolerance: number,
): number | null {
  let best: number | null = null;
  for (const target of targets) {
    if (Math.abs(target - current) > tolerance) continue;
    if (best === null || Math.abs(target - current) < Math.abs(best - current)) {
      best = target;
    }
  }
  return best;
}

function gridDelta(value: number, tolerance: number): number | null {
  const nearest = Math.round(value / GRID_SIZE) * GRID_SIZE;
  const delta = nearest - value;
  return Math.abs(delta) <= tolerance ? delta : null;
}

/** Linhas nas quais a janela já está alinhada a algum vizinho. */
function guidesFor(
  rect: SnapRect,
  targets: SnapRect[],
): { vertical: number[]; horizontal: number[] } {
  const vertical: number[] = [];
  const horizontal: number[] = [];
  const xs = xCoordinates(rect);
  const ys = yCoordinates(rect);

  for (const target of targets) {
    for (const tx of xCoordinates(target)) {
      if (xs.some((x) => Math.abs(x - tx) < 0.01)) vertical.push(tx);
    }
    for (const ty of yCoordinates(target)) {
      if (ys.some((y) => Math.abs(y - ty) < 0.01)) horizontal.push(ty);
    }
  }

  return { vertical: unique(vertical), horizontal: unique(horizontal) };
}

/** Encaixa a posição de uma janela sendo arrastada. */
export function snapMovingRect(
  rect: SnapRect,
  targets: SnapRect[],
  zoom: number,
): SnapResult {
  const tolerance = MOVE_TOLERANCE_PX / zoom;
  const gridTolerance = GRID_TOLERANCE_PX / zoom;

  const targetXs = targets.flatMap(xCoordinates);
  const targetYs = targets.flatMap(yCoordinates);

  let x = rect.x;
  let y = rect.y;

  const deltaX = bestDelta(xCoordinates(rect), targetXs, tolerance);
  if (deltaX !== null) {
    x += deltaX;
  } else {
    const grid = gridDelta(rect.x, gridTolerance);
    if (grid !== null) x += grid;
  }

  const deltaY = bestDelta(yCoordinates(rect), targetYs, tolerance);
  if (deltaY !== null) {
    y += deltaY;
  } else {
    const grid = gridDelta(rect.y, gridTolerance);
    if (grid !== null) y += grid;
  }

  const snapped: SnapRect = { x, y, w: rect.w, h: rect.h };
  return { ...snapped, ...guidesFor(snapped, targets) };
}

/**
 * Encaixa o redimensionamento. O lado oposto ao puxado permanece fixo; as
 * bordas puxadas grudam nas bordas/centros dos vizinhos e, na falta delas, na
 * grade do canvas.
 */
export function snapResizingRect(
  rect: SnapRect,
  targets: SnapRect[],
  zoom: number,
  handle: string,
  minW: number,
  minH: number,
): SnapResult {
  const tolerance = RESIZE_TOLERANCE_PX / zoom;
  const gridTolerance = GRID_TOLERANCE_PX / zoom;
  const targetXs = targets.flatMap(xCoordinates);
  const targetYs = targets.flatMap(yCoordinates);
  const targetWidths = targets.map((target) => target.w);
  const targetHeights = targets.map((target) => target.h);

  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;

  if (handle.includes("e")) {
    const right = x + w;
    const delta =
      bestDelta([right], targetXs, tolerance) ?? gridDelta(right, gridTolerance);
    if (delta !== null) {
      const nextW = w + delta;
      if (nextW >= minW) w = nextW;
    } else {
      const size = bestSize(w, targetWidths, tolerance);
      if (size !== null && size >= minW) w = size;
    }
  } else if (handle.includes("w")) {
    const right = x + w;
    const delta = bestDelta([x], targetXs, tolerance) ?? gridDelta(x, gridTolerance);
    if (delta !== null) {
      const nextW = w - delta;
      if (nextW >= minW) {
        x += delta;
        w = nextW;
      }
    } else {
      const size = bestSize(w, targetWidths, tolerance);
      if (size !== null && size >= minW) {
        w = size;
        x = right - w;
      }
    }
  }

  if (handle.includes("s")) {
    const bottom = y + h;
    const delta =
      bestDelta([bottom], targetYs, tolerance) ?? gridDelta(bottom, gridTolerance);
    if (delta !== null) {
      const nextH = h + delta;
      if (nextH >= minH) h = nextH;
    } else {
      const size = bestSize(h, targetHeights, tolerance);
      if (size !== null && size >= minH) h = size;
    }
  } else if (handle.includes("n")) {
    const bottom = y + h;
    const delta = bestDelta([y], targetYs, tolerance) ?? gridDelta(y, gridTolerance);
    if (delta !== null) {
      const nextH = h - delta;
      if (nextH >= minH) {
        y += delta;
        h = nextH;
      }
    } else {
      const size = bestSize(h, targetHeights, tolerance);
      if (size !== null && size >= minH) {
        h = size;
        y = bottom - h;
      }
    }
  }

  const snapped: SnapRect = { x, y, w, h };
  return { ...snapped, ...guidesFor(snapped, targets) };
}

/** Overlay das linhas-guia, relativo ao viewport (sem capturar o mouse). */
export class SnapGuideOverlay {
  private readonly layer: HTMLDivElement;

  constructor(viewport: HTMLElement) {
    this.layer = document.createElement("div");
    this.layer.className = "snap-guides";
    this.layer.setAttribute("aria-hidden", "true");
    viewport.appendChild(this.layer);
  }

  /**
   * @param vertical coordenadas de mundo das linhas verticais
   * @param horizontal coordenadas de mundo das linhas horizontais
   */
  show(
    vertical: number[],
    horizontal: number[],
    zoom: number,
    panX: number,
    panY: number,
  ): void {
    const fragment = document.createDocumentFragment();

    for (const x of vertical) {
      const line = document.createElement("div");
      line.className = "snap-guide vertical";
      line.style.left = `${x * zoom + panX}px`;
      fragment.appendChild(line);
    }

    for (const y of horizontal) {
      const line = document.createElement("div");
      line.className = "snap-guide horizontal";
      line.style.top = `${y * zoom + panY}px`;
      fragment.appendChild(line);
    }

    this.layer.replaceChildren(fragment);
  }

  clear(): void {
    this.layer.replaceChildren();
  }
}
