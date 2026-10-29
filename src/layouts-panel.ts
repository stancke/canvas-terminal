import {
  BUILTIN_LAYOUTS,
  loadLayouts,
  saveLayouts,
  type SavedLayout,
} from "./layouts";

export interface LayoutsPanelHandlers {
  /** Aplica o layout à área de trabalho ativa. */
  apply: (layout: SavedLayout) => void;
  /** Cria um layout a partir das janelas atuais; `null` se não há terminais. */
  capture: (name: string, details: boolean) => SavedLayout | null;
  /** Quantas janelas a área ativa tem (para o rótulo do botão de salvar). */
  terminalCount: () => number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Miniatura do arranjo: um retângulo por janela. */
function previewHtml(layout: SavedLayout): string {
  const boxes = layout.slots
    .map(
      (s) =>
        `<i style="left:${s.x * 100}%;top:${s.y * 100}%;width:${s.w * 100}%;height:${s.h * 100}%"></i>`,
    )
    .join("");
  return `<span class="layout-preview" aria-hidden="true">${boxes}</span>`;
}

/** Janela modal "Layouts": aplicar arranjos prontos ou salvos e salvar o atual. */
export class LayoutsPanel {
  private readonly modal: HTMLElement;
  private readonly body: HTMLElement;
  private layouts: SavedLayout[] = loadLayouts();

  constructor(private readonly handlers: LayoutsPanelHandlers) {
    this.modal = document.getElementById("layouts-modal")!;
    this.body = document.getElementById("layouts-body")!;
    document.getElementById("layouts-close")?.addEventListener("click", () => this.close());
    this.modal.addEventListener("mousedown", (event) => {
      if (event.target === this.modal) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains("hidden");
  }

  open(): void {
    this.layouts = loadLayouts();
    this.render();
    this.modal.classList.remove("hidden");
  }

  /** Fecha se estiver aberto; devolve se havia algo para fechar. */
  close(): boolean {
    if (!this.isOpen) return false;
    this.modal.classList.add("hidden");
    return true;
  }

  private render(): void {
    const card = (layout: SavedLayout, removable: boolean) => `
      <div class="layout-item">
        <button type="button" class="layout-apply" data-apply="${layout.id}"
          title="Aplicar “${escapeHtml(layout.name)}”">
          ${previewHtml(layout)}
          <span class="layout-name">${escapeHtml(layout.name)}</span>
          <span class="layout-meta">${layout.slots.length} ${layout.slots.length === 1 ? "terminal" : "terminais"}</span>
        </button>
        ${
          removable
            ? `<button type="button" class="layout-remove" data-remove="${layout.id}"
                 title="Excluir layout" aria-label="Excluir layout ${escapeHtml(layout.name)}">×</button>`
            : ""
        }
      </div>`;

    const count = this.handlers.terminalCount();
    this.body.innerHTML = `
      <p class="layouts-intro">
        Aplicar um layout reorganiza os terminais da área atual e abre os que
        faltarem. Terminais já abertos nunca são fechados.
      </p>
      <h4>Modelos</h4>
      <div class="layout-grid">${BUILTIN_LAYOUTS.map((l) => card(l, false)).join("")}</div>
      <h4>Meus layouts</h4>
      ${
        this.layouts.length
          ? `<div class="layout-grid">${this.layouts.map((l) => card(l, true)).join("")}</div>`
          : `<p class="layouts-empty">Nenhum layout salvo ainda.</p>`
      }
      <h4>Salvar o arranjo atual</h4>
      <form id="layouts-save-form" class="layouts-save">
        <input id="layouts-name" class="dialog-input" type="text" maxlength="60"
          placeholder="Nome do layout" ${count === 0 ? "disabled" : ""} />
        <label class="layouts-check">
          <input id="layouts-details" type="checkbox" checked ${count === 0 ? "disabled" : ""} />
          Incluir shell, pasta e comando de inicialização
        </label>
        <button type="submit" class="layouts-save-btn" ${count === 0 ? "disabled" : ""}>
          Salvar ${count} ${count === 1 ? "terminal" : "terminais"}
        </button>
      </form>`;

    this.body.querySelectorAll<HTMLButtonElement>("[data-apply]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.apply;
        const layout = [...BUILTIN_LAYOUTS, ...this.layouts].find((l) => l.id === id);
        if (!layout) return;
        this.close();
        this.handlers.apply(layout);
      });
    });

    this.body.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        this.layouts = this.layouts.filter((l) => l.id !== button.dataset.remove);
        saveLayouts(this.layouts);
        this.render();
      });
    });

    const form = this.body.querySelector<HTMLFormElement>("#layouts-save-form")!;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const typed = (form.querySelector("#layouts-name") as HTMLInputElement).value.trim();
      const name = typed || `Layout ${this.layouts.length + 1}`;
      const details = (form.querySelector("#layouts-details") as HTMLInputElement).checked;
      const layout = this.handlers.capture(name, details);
      if (!layout) return;
      this.layouts.push(layout);
      saveLayouts(this.layouts);
      this.render();
    });
  }
}
