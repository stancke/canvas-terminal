/**
 * Mini-mapa do canvas: mostra a distribuição dos terminais e a posição do
 * viewport. Visível apenas quando os terminais estão minimizados.
 */

import type { Canvas } from "./canvas";

const PADDING = 8;
const WIDTH = 180;
const HEIGHT = 120;

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvasApp: Canvas;
  private visible = false;

  constructor(canvasApp: Canvas) {
    this.canvasApp = canvasApp;
    this.canvas = document.getElementById("minimap") as HTMLCanvasElement;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("minimap: 2d context unavailable");
    this.ctx = ctx;
    this.canvas.width = WIDTH * window.devicePixelRatio;
    this.canvas.height = HEIGHT * window.devicePixelRatio;
    this.canvas.style.width = `${WIDTH}px`;
    this.canvas.style.height = `${HEIGHT}px`;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    document.body.classList.toggle("minimap-visible", visible);
    if (visible) this.draw();
  }

  update(): void {
    if (!this.visible) return;
    this.draw();
  }

  private draw(): void {
    const terminals = this.canvasApp.getAllTerminals();
    const viewport = this.canvasApp.worldRectVisible();

    let minX = viewport.x;
    let minY = viewport.y;
    let maxX = viewport.x + viewport.w;
    let maxY = viewport.y + viewport.h;

    for (const terminal of terminals) {
      minX = Math.min(minX, terminal.x);
      minY = Math.min(minY, terminal.y);
      maxX = Math.max(maxX, terminal.x + terminal.w);
      maxY = Math.max(maxY, terminal.y + terminal.h);
    }

    const boundsW = Math.max(maxX - minX, 1);
    const boundsH = Math.max(maxY - minY, 1);
    const scaleX = (WIDTH - PADDING * 2) / boundsW;
    const scaleY = (HEIGHT - PADDING * 2) / boundsH;
    const scale = Math.min(scaleX, scaleY);

    const offsetX = PADDING + (WIDTH - PADDING * 2 - boundsW * scale) / 2 - minX * scale;
    const offsetY = PADDING + (HEIGHT - PADDING * 2 - boundsH * scale) / 2 - minY * scale;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Fundo
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--window").trim() || "#1e1e2e";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Borda
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--window-border").trim() || "#45475a";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, WIDTH, HEIGHT);

    // Viewport
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#89b4fa";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      offsetX + viewport.x * scale,
      offsetY + viewport.y * scale,
      Math.max(viewport.w * scale, 2),
      Math.max(viewport.h * scale, 2),
    );

    // Terminais
    for (const terminal of terminals) {
      const isActive = terminal.element.classList.contains("active");
      ctx.fillStyle = isActive
        ? getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#89b4fa"
        : getComputedStyle(document.body).getPropertyValue("--text-muted").trim() || "#6c7086";
      ctx.fillRect(
        offsetX + terminal.x * scale,
        offsetY + terminal.y * scale,
        Math.max(terminal.w * scale, 3),
        Math.max(terminal.h * scale, 2),
      );
    }
  }
}
