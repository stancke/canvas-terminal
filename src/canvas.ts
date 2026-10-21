import type { TerminalWindow } from "./terminal-window";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Canvas {
  readonly viewport: HTMLElement;
  readonly world: HTMLElement;
  private terminals: Map<number, TerminalWindow> = new Map();

  panX = 0;
  panY = 0;
  zoom = 1;

  private isPanning = false;
  private panButton = -1;
  private lastMouse: Point = { x: 0, y: 0 };
  private spacePressed = false;
  private panStart: Point = { x: 0, y: 0 };
  private panMoved = false;
  private suppressContextMenu = false;
  private rafPending = false;
  private autoPanTimer: ReturnType<typeof setInterval> | null = null;

  onEmptyContextMenu?: (point: Point) => void;
  /** Avisa o app que pan/zoom mudaram (atualiza o indicador da toolbar). */
  onViewChange?: () => void;

  constructor(viewportSelector: string, worldSelector: string) {
    const viewport = document.querySelector(viewportSelector);
    const world = document.querySelector(worldSelector);
    if (!viewport || !world) throw new Error("Canvas: viewport ou world não encontrado");
    this.viewport = viewport as HTMLElement;
    this.world = world as HTMLElement;

    this.bindEvents();
    this.updateGrid();
  }

  addTerminal(id: number, terminal: TerminalWindow): void {
    this.terminals.set(id, terminal);
    this.world.appendChild(terminal.element);
    this.requestRender();
  }

  removeTerminal(id: number): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(id);
    }
    this.requestRender();
  }

  getTerminal(id: number): TerminalWindow | undefined {
    return this.terminals.get(id);
  }

  getAllTerminals(): TerminalWindow[] {
    return Array.from(this.terminals.values());
  }

  screenToWorld(x: number, y: number): Point {
    return {
      x: (x - this.panX) / this.zoom,
      y: (y - this.panY) / this.zoom,
    };
  }

  worldToScreen(x: number, y: number): Point {
    return {
      x: x * this.zoom + this.panX,
      y: y * this.zoom + this.panY,
    };
  }

  worldRectVisible(): Rect {
    const w = this.viewport.clientWidth / this.zoom;
    const h = this.viewport.clientHeight / this.zoom;
    return {
      x: -this.panX / this.zoom,
      y: -this.panY / this.zoom,
      w,
      h,
    };
  }

  centerWorldPoint(): Point {
    return this.screenToWorld(
      this.viewport.clientWidth / 2,
      this.viewport.clientHeight / 2,
    );
  }

  setView(panX: number, panY: number, zoom: number): void {
    this.panX = panX;
    this.panY = panY;
    this.zoom = Math.max(0.35, Math.min(2.5, zoom));
    this.requestRender();
    this.onViewChange?.();
  }

  requestRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  }

  private render(): void {
    this.world.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    this.updateGrid();
    for (const terminal of this.terminals.values()) {
      terminal.render(this.zoom);
    }
  }

  private updateGrid(): void {
    const size = 32 * this.zoom;
    this.viewport.style.backgroundSize = `${size * 4}px ${size * 4}px, ${size * 4}px ${size * 4}px, ${size}px ${size}px, ${size}px ${size}px`;
    this.viewport.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
  }

  private bindEvents(): void {
    this.viewport.addEventListener("mousedown", (e) => this.onMouseDown(e));
    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", (e) => this.onMouseUp(e));
    this.viewport.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    this.viewport.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    window.addEventListener("resize", () => this.requestRender());
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.target !== this.viewport && e.target !== this.world) return;

    if (e.button === 0 && this.spacePressed) {
      this.startPan(e, 0);
      e.preventDefault();
    } else if (e.button === 1 || e.button === 2) {
      this.startPan(e, e.button);
      e.preventDefault();
    } else if (e.button === 0) {
      this.startPan(e, 0);
    }
  }

  private startPan(e: MouseEvent, button: number): void {
    this.isPanning = true;
    this.panButton = button;
    this.panMoved = false;
    this.panStart = { x: e.clientX, y: e.clientY };
    this.lastMouse = { x: e.clientX, y: e.clientY };
    this.viewport.classList.add("panning");
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.isPanning) {
      if (
        Math.abs(e.clientX - this.panStart.x) + Math.abs(e.clientY - this.panStart.y) >
        4
      ) {
        this.panMoved = true;
      }
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.panX += dx;
      this.panY += dy;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.requestRender();
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.isPanning) return;
    if (e.button === this.panButton) {
      this.isPanning = false;
      this.panButton = -1;
      this.viewport.classList.remove("panning");
      if (this.panMoved && e.button === 2) {
        // Arrastar com o botão direito faz pan: não abrir o menu em seguida.
        this.suppressContextMenu = true;
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    if (e.ctrlKey) {
      e.preventDefault();
      const zoomStep = 0.1;
      const newZoom = e.deltaY < 0 ? this.zoom + zoomStep : this.zoom - zoomStep;
      this.zoomAt(e.clientX, e.clientY, newZoom);
    } else {
      e.preventDefault();
      const dx = e.shiftKey ? -e.deltaY : 0;
      const dy = e.shiftKey ? 0 : -e.deltaY;
      this.panX += dx;
      this.panY += dy;
      this.requestRender();
    }
  }

  private zoomAt(screenX: number, screenY: number, newZoom: number): void {
    const clamped = Math.max(0.35, Math.min(2.5, newZoom));
    if (clamped === this.zoom) return;
    const worldBefore = this.screenToWorld(screenX, screenY);
    this.zoom = clamped;
    const screenAfter = this.worldToScreen(worldBefore.x, worldBefore.y);
    this.panX += screenX - screenAfter.x;
    this.panY += screenY - screenAfter.y;
    this.requestRender();
    this.onViewChange?.();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === "Space" && !this.isTyping()) {
      e.preventDefault();
      this.spacePressed = true;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === "Space") {
      this.spacePressed = false;
    }
  }

  private onContextMenu(e: MouseEvent): void {
    if (this.suppressContextMenu) {
      this.suppressContextMenu = false;
      return;
    }
    if (e.target !== this.viewport && e.target !== this.world) return;
    e.preventDefault();
    const point = this.screenToWorld(e.clientX, e.clientY);
    this.onEmptyContextMenu?.(point);
  }

  private isTyping(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  }

  startAutoPan(dx: number, dy: number): void {
    if (this.autoPanTimer) return;
    this.autoPanTimer = setInterval(() => {
      this.panX += dx;
      this.panY += dy;
      this.requestRender();
    }, 16);
  }

  stopAutoPan(): void {
    if (this.autoPanTimer) {
      clearInterval(this.autoPanTimer);
      this.autoPanTimer = null;
    }
  }

  dispose(): void {
    this.stopAutoPan();
  }
}
