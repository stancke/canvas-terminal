import type { TerminalWindow } from "./terminal-window";
import { SnapGuideOverlay } from "./snapping";

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

/** Limites do zoom do canvas. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

/** Teclas de navegação da câmera (WASD + setas), quando o canvas está em foco. */
const PAN_KEYS: Record<string, Point> = {
  KeyW: { x: 0, y: 1 },
  ArrowUp: { x: 0, y: 1 },
  KeyS: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: -1 },
  KeyA: { x: 1, y: 0 },
  ArrowLeft: { x: 1, y: 0 },
  KeyD: { x: -1, y: 0 },
  ArrowRight: { x: -1, y: 0 },
};

/** Velocidade da navegação por teclado, em pixels de tela por segundo. */
const KEY_PAN_SPEED = 900;

export class Canvas {
  readonly viewport: HTMLElement;
  readonly world: HTMLElement;
  readonly snapGuides: SnapGuideOverlay;
  private terminals: Map<number, TerminalWindow> = new Map();

  panX = 0;
  panY = 0;
  zoom = 1;
  /** No modo maximizado o zoom fica travado em 100%. */
  zoomLocked = false;
  /** Verdadeiro quando o último clique foi em área vazia (modo navegação). */
  canvasActive = false;

  private isPanning = false;
  private panButton = -1;
  private lastMouse: Point = { x: 0, y: 0 };
  private spacePressed = false;
  private panStart: Point = { x: 0, y: 0 };
  private panMoved = false;
  private suppressContextMenu = false;
  private rafPending = false;
  private autoPanTimer: ReturnType<typeof setInterval> | null = null;
  private heldPanKeys = new Set<string>();
  private keyPanRaf: number | null = null;
  private lastKeyPanTime = 0;

  onEmptyContextMenu?: (point: Point) => void;
  /** Avisa o app que pan/zoom mudaram (atualiza o indicador do menu). */
  onViewChange?: () => void;
  /**
   * Chamado quando o zoom está travado (modo maximizado) e o usuário tenta
   * ampliar com Ctrl+roda. O app aplica o fator ao terminal maximizado.
   */
  onLockedZoom?: (factor: number) => void;

  constructor(viewportSelector: string, worldSelector: string) {
    const viewport = document.querySelector(viewportSelector);
    const world = document.querySelector(worldSelector);
    if (!viewport || !world) throw new Error("Canvas: viewport ou world não encontrado");
    this.viewport = viewport as HTMLElement;
    this.world = world as HTMLElement;
    this.snapGuides = new SnapGuideOverlay(this.viewport);

    this.bindEvents();
    this.updateGrid();
  }

  addTerminal(id: number, terminal: TerminalWindow): void {
    this.terminals.set(id, terminal);
    this.world.appendChild(terminal.element);
    terminal.render(this.zoom);
    terminal.refit();
    this.notifyTerminalsChanged();
    this.requestRender();
  }

  removeTerminal(id: number): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(id);
    }
    this.notifyTerminalsChanged();
    this.requestRender();
  }

  /** Remove as janelas ativas do world sem destruí-las (troca de workspace). */
  detachTerminals(): void {
    for (const terminal of this.terminals.values()) {
      terminal.blur();
      terminal.element.remove();
    }
    this.terminals.clear();
    this.notifyTerminalsChanged();
    this.requestRender();
  }

  /** Anexa as janelas de uma área de trabalho e sincroniza o tamanho do xterm. */
  attachTerminals(terminals: TerminalWindow[]): void {
    for (const terminal of terminals) {
      this.terminals.set(terminal.id, terminal);
      this.world.appendChild(terminal.element);
      terminal.render(this.zoom);
      terminal.refit();
    }
    this.notifyTerminalsChanged();
    this.requestRender();
  }

  private notifyTerminalsChanged(): void {
    document.dispatchEvent(new CustomEvent("canvas-terminals-changed"));
  }

  getTerminal(id: number): TerminalWindow | undefined {
    return this.terminals.get(id);
  }

  getAllTerminals(): TerminalWindow[] {
    return Array.from(this.terminals.values());
  }

  /** Origem do viewport na janela (o painel lateral desloca o canvas). */
  private screenOrigin(): Point {
    const rect = this.viewport.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }

  screenToWorld(x: number, y: number): Point {
    const origin = this.screenOrigin();
    return {
      x: (x - origin.x - this.panX) / this.zoom,
      y: (y - origin.y - this.panY) / this.zoom,
    };
  }

  worldToScreen(x: number, y: number): Point {
    const origin = this.screenOrigin();
    return {
      x: x * this.zoom + this.panX + origin.x,
      y: y * this.zoom + this.panY + origin.y,
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
    const rect = this.viewport.getBoundingClientRect();
    return this.screenToWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  }

  setView(panX: number, panY: number, zoom: number, notify = true): void {
    this.panX = panX;
    this.panY = panY;
    this.zoom = this.zoomLocked ? 1 : this.clampZoom(zoom);
    this.requestRender();
    if (notify) this.onViewChange?.();
  }

  private clampZoom(zoom: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  }

  /** Zoom mantendo o centro do viewport como âncora. */
  setZoomAtCenter(zoom: number): void {
    const rect = this.viewport.getBoundingClientRect();
    this.zoomAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      zoom,
    );
  }

  zoomBy(factor: number): void {
    this.setZoomAtCenter(this.zoom * factor);
  }

  /**
   * Marca o canvas como “em foco” (clique em área vazia). Nesse modo, WASD e
   * as setas navegam; ao focar um terminal, o teclado volta para o shell.
   */
  setCanvasActive(active: boolean): void {
    if (this.canvasActive === active) return;
    this.canvasActive = active;
    this.viewport.classList.toggle("canvas-active", active);
    if (active) {
      for (const terminal of this.terminals.values()) terminal.blur();
      this.viewport.focus({ preventScroll: true });
    } else {
      this.stopKeyPan();
    }
  }

  /** Só navega por teclado quando o foco está no canvas e não há modal aberto. */
  private canUseCanvasKeys(): boolean {
    if (!this.canvasActive) return false;
    if (document.querySelector('[aria-modal="true"]:not(.hidden)')) return false;
    const active = document.activeElement;
    return active === this.viewport || active === document.body;
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
    window.addEventListener("blur", () => this.stopKeyPan());
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.target !== this.viewport && e.target !== this.world) return;

    // Clique em área vazia: ativa a navegação por WASD/setas.
    this.setCanvasActive(true);

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
      // Zoom multiplicativo: cada passo mantém a mesma sensação em qualquer
      // nível (de 25% a 300%).
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      // Maximizado o canvas fica travado em 100%: o gesto vale para o zoom
      // próprio do terminal que está ocupando a tela.
      if (this.zoomLocked) {
        this.onLockedZoom?.(factor);
        return;
      }
      this.zoomAt(e.clientX, e.clientY, this.zoom * factor);
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
    if (this.zoomLocked) return;
    const clamped = this.clampZoom(newZoom);
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

    if (!this.canUseCanvasKeys() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!PAN_KEYS[e.code]) return;
    e.preventDefault();
    e.stopPropagation();
    this.heldPanKeys.add(e.code);
    this.startKeyPan();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === "Space") {
      this.spacePressed = false;
    }
    if (PAN_KEYS[e.code]) {
      this.heldPanKeys.delete(e.code);
      if (this.heldPanKeys.size === 0) this.stopKeyPan();
    }
  }

  private startKeyPan(): void {
    if (this.keyPanRaf !== null) return;
    this.lastKeyPanTime = performance.now();
    this.keyPanRaf = requestAnimationFrame((now) => this.tickKeyPan(now));
  }

  private stopKeyPan(): void {
    this.heldPanKeys.clear();
    if (this.keyPanRaf !== null) {
      cancelAnimationFrame(this.keyPanRaf);
      this.keyPanRaf = null;
    }
  }

  private tickKeyPan(now: number): void {
    this.keyPanRaf = null;
    if (!this.canvasActive || this.heldPanKeys.size === 0) return;

    const dt = Math.min(0.05, (now - this.lastKeyPanTime) / 1000);
    this.lastKeyPanTime = now;

    let dx = 0;
    let dy = 0;
    for (const code of this.heldPanKeys) {
      const dir = PAN_KEYS[code];
      if (!dir) continue;
      dx += dir.x;
      dy += dir.y;
    }
    if (dx === 0 && dy === 0) return;

    const length = Math.hypot(dx, dy);
    const step = KEY_PAN_SPEED * dt;
    this.panX += (dx / length) * step;
    this.panY += (dy / length) * step;
    this.requestRender();
    this.keyPanRaf = requestAnimationFrame((next) => this.tickKeyPan(next));
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
    this.stopKeyPan();
  }
}
