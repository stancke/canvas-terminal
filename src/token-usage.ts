/**
 * Plugin "Uso de tokens" (modal).
 *
 * O botão fica no rodapé do painel lateral, acima do ClickUp e do Git. O modal
 * abre/fecha pelo botão e resume o consumo também no cabeçalho da janela.
 *
 * Os dados vêm do comando `usage_report` (backend em `src-tauri/src/usage.rs`),
 * que lê apenas os arquivos locais do Claude Code e do OpenCode.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";

export interface WindowUsage {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  messages: number;
  resetsAt: number | null;
}

export interface AgentUsage {
  id: string;
  name: string;
  installed: boolean;
  fiveHours: WindowUsage;
  week: WindowUsage;
  lastActivity: number | null;
  sources: string[];
  warnings: string[];
  error: string | null;
}

export interface UsageReport {
  generatedAt: number;
  agents: AgentUsage[];
}

/** Intervalo de atualização enquanto o plugin está ligado. */
const REFRESH_MS = 20_000;
/** Evita reler os arquivos a cada abertura do painel. */
const STALE_MS = 5_000;

export async function fetchUsageReport(): Promise<UsageReport> {
  return invoke<UsageReport>("usage_report");
}

/* ---- Formatação ---- */

/** 1.234.567 → "1,2M" (compacto, para caber no painel). */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${decimal(value / 1_000_000_000, 1)} bi`;
  if (value >= 1_000_000) return `${decimal(value / 1_000_000, 1)}M`;
  if (value >= 1_000) return `${decimal(value / 1_000, 1)}k`;
  return String(Math.round(value));
}

function decimal(value: number, digits: number): string {
  const rounded = value >= 100 ? Math.round(value) : Number(value.toFixed(digits));
  return String(rounded).replace(".", ",");
}

function formatExact(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("pt-BR");
}

/** "há 3 min", "há 2 h", "há 4 d". */
function formatAgo(timestamp: number | null, now: number): string {
  if (!timestamp) return "";
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return "agora";
  if (diff < 3_600_000) return `há ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`;
  return `há ${Math.floor(diff / 86_400_000)} d`;
}

/** Tempo até a janela renovar: "renova em 2 h 10 min". */
function formatReset(resetsAt: number | null, now: number): string {
  if (!resetsAt) return "";
  const diff = resetsAt - now;
  if (diff <= 0) return "renova agora";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `renova em ${minutes} min`;
  if (diff < 86_400_000) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `renova em ${hours} h ${rest} min` : `renova em ${hours} h`;
  }
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  return hours > 0 ? `renova em ${days} d ${hours} h` : `renova em ${days} d`;
}

/* ---- Modal ---- */

export class TokenUsageModal {
  private readonly panel: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly body: HTMLElement;
  private readonly updated: HTMLElement;
  private readonly headerChip: HTMLElement;
  private refreshButton: HTMLButtonElement | null;
  private timer: number | null = null;
  private enabled = false;
  private loading = false;
  private lastFetchAt = 0;
  private report: UsageReport | null = null;
  private failure: string | null = null;

  constructor() {
    this.panel = document.getElementById("usage-modal")!;
    this.handle = document.getElementById("rail-token-usage")!;
    this.body = document.getElementById("usage-body")!;
    this.updated = document.getElementById("usage-modal-updated")!;
    this.headerChip = document.getElementById("header-usage")!;
    this.refreshButton = document.getElementById("usage-refresh") as HTMLButtonElement | null;

    this.bindControls();
    this.refreshButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.refresh(true);
    });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    document.body.classList.toggle("token-usage-enabled", enabled);

    if (enabled) {
      // Já busca os dados; o modal só abre no clique do botão.
      void this.refresh(true);
      this.timer = window.setInterval(() => {
        if (!document.hidden) void this.refresh();
      }, REFRESH_MS);
      // Atualiza ao voltar para a janela, sem esperar o próximo ciclo.
      document.addEventListener("visibilitychange", this.onVisibility);
    } else {
      this.stop();
      this.hide();
      this.headerChip.classList.add("hidden");
    }
  }

  /** Abre o modal (o botão do painel e o resumo do cabeçalho chamam isto). */
  open(): void {
    if (!this.enabled) {
      document.dispatchEvent(
        new CustomEvent("plugin-activate-request", { detail: "token-usage" }),
      );
      return;
    }
    document.dispatchEvent(
      new CustomEvent("plugin-panel-opened", { detail: "token-usage" }),
    );
    this.panel.classList.remove("hidden");
    if (!this.report || Date.now() - this.lastFetchAt > STALE_MS) {
      void this.refresh(true);
    }
  }

  hide(): void {
    this.panel.classList.add("hidden");
  }

  private toggle(): void {
    if (this.panel.classList.contains("hidden")) this.open();
    else this.hide();
  }

  private readonly onVisibility = (): void => {
    if (!document.hidden && this.enabled) void this.refresh(true);
  };

  private stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private bindControls(): void {
    this.handle.addEventListener("click", () => this.toggle());
    this.handle.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggle();
    });
    this.headerChip.addEventListener("click", () => this.open());
    document
      .getElementById("usage-modal-close")
      ?.addEventListener("click", () => this.hide());
    this.panel.addEventListener("mousedown", (event) => {
      if (event.target === this.panel) this.hide();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.panel.classList.contains("hidden")) {
        event.preventDefault();
        event.stopPropagation();
        this.hide();
      }
    });
    // Outro plugin abriu o modal dele? Fecha este.
    document.addEventListener("plugin-panel-opened", ((event: Event) => {
      if ((event as CustomEvent<string>).detail !== "token-usage") this.hide();
    }) as EventListener);
  }

  async refresh(force = false): Promise<void> {
    if (!this.enabled || this.loading) return;
    if (!force && Date.now() - this.lastFetchAt < STALE_MS) return;

    this.loading = true;
    if (!this.report) this.render();
    try {
      if (!isTauri()) throw new Error("Disponível apenas no aplicativo.");
      this.report = await fetchUsageReport();
      this.failure = null;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.lastFetchAt = Date.now();
      this.render();
    }
  }

  private render(): void {
    const now = Date.now();
    this.body.innerHTML = "";
    this.updated.textContent = this.lastFetchAt
      ? this.loading
        ? "atualizando…"
        : formatAgo(this.lastFetchAt, now)
      : "";
    this.renderHeaderChip(now);

    if (this.failure) {
      this.body.appendChild(this.message(this.failure, "usage-error"));
      return;
    }
    if (!this.report) {
      this.body.appendChild(this.message("Lendo dados locais…", "usage-empty"));
      return;
    }

    const installed = this.report.agents.filter(
      (agent) => agent.installed && !agent.error,
    );
    if (installed.length === 0) {
      this.body.appendChild(
        this.message(
          "Nenhum agente encontrado. Rode o Claude Code ou o OpenCode uma vez para gerar os dados locais.",
          "usage-empty",
        ),
      );
      return;
    }

    const grid = document.createElement("div");
    grid.className = "usage-grid";
    for (const agent of installed) {
      grid.appendChild(this.renderAgent(agent, now));
    }
    this.body.appendChild(grid);
  }

  /** Resumo compacto no cabeçalho: "Claude 5h 370k · 7d 4,6M". */
  private renderHeaderChip(now: number): void {
    this.headerChip.innerHTML = "";
    if (!this.enabled || this.failure || !this.report) {
      this.headerChip.classList.add("hidden");
      return;
    }

    const installed = this.report.agents.filter(
      (agent) => agent.installed && !agent.error,
    );
    if (installed.length === 0) {
      this.headerChip.classList.add("hidden");
      return;
    }

    installed.slice(0, 2).forEach((agent, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "usage-chip-sep";
        sep.textContent = "|";
        this.headerChip.appendChild(sep);
      }

      const name = document.createElement("span");
      name.className = "usage-chip-agent";
      name.textContent = agent.name.replace(/\s+Code$/, "");

      const five = document.createElement("span");
      five.className = "usage-chip-value";
      five.textContent = `5h ${agent.fiveHours.total > 0 ? formatTokens(agent.fiveHours.total) : "0"}`;

      const week = document.createElement("span");
      week.className = "usage-chip-value";
      week.textContent = `7d ${agent.week.total > 0 ? formatTokens(agent.week.total) : "0"}`;

      this.headerChip.append(name, five, week);
    });

    this.headerChip.title = installed
      .map(
        (agent) =>
          `${agent.name}: 5 h ${formatExact(agent.fiveHours.total)} tokens · semana ${formatExact(agent.week.total)} tokens`,
      )
      .join("\n");
    this.headerChip.setAttribute(
      "aria-label",
      `Uso de tokens atualizado ${formatAgo(this.lastFetchAt, now)}`,
    );
    this.headerChip.classList.remove("hidden");
  }

  private renderAgent(agent: AgentUsage, now: number): HTMLElement {
    const section = document.createElement("section");
    section.className = "usage-agent";
    section.dataset.agent = agent.id;

    const head = document.createElement("div");
    head.className = "usage-agent-head";

    const dot = document.createElement("span");
    dot.className = `usage-dot usage-dot-${agent.id}`;

    const name = document.createElement("span");
    name.className = "usage-agent-name";
    name.textContent = agent.name;
    name.title = agent.sources.join("\n") || agent.name;

    const when = document.createElement("span");
    when.className = "usage-agent-when";
    when.textContent = formatAgo(agent.lastActivity, now);
    when.title = agent.lastActivity
      ? `Última atividade: ${new Date(agent.lastActivity).toLocaleString("pt-BR")}`
      : "Sem atividade registrada";

    head.append(dot, name, when);
    section.appendChild(head);

    section.appendChild(this.renderWindow("5 h", agent.fiveHours, now));
    section.appendChild(this.renderWindow("Semana", agent.week, now));

    if (agent.warnings.length > 0) {
      const warning = document.createElement("div");
      warning.className = "usage-warning";
      warning.textContent = `⚠ ${agent.warnings[0]}`;
      warning.title = agent.warnings.join("\n");
      section.appendChild(warning);
    }
    return section;
  }

  private renderWindow(label: string, usage: WindowUsage, now: number): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "usage-window";

    const row = document.createElement("div");
    row.className = "usage-window-row";

    const title = document.createElement("span");
    title.className = "usage-window-label";
    title.textContent = label;

    const amount = document.createElement("span");
    amount.className = "usage-amount";
    amount.textContent = usage.total > 0 ? formatTokens(usage.total) : "—";
    amount.title = [
      `${formatExact(usage.total)} tokens novos (entrada + saída + cache escrito)`,
      `entrada ${formatExact(usage.input)} · saída ${formatExact(usage.output)}`,
      `cache escrito ${formatExact(usage.cacheWrite)} · cache lido ${formatExact(usage.cacheRead)}`,
      `${formatExact(usage.messages)} mensagens`,
    ].join("\n");

    row.append(title, amount);
    wrapper.appendChild(row);
    wrapper.appendChild(this.renderBar(usage));

    const parts: string[] = [];
    const reset = formatReset(usage.resetsAt, now);
    if (reset) parts.push(reset);
    // O cache lido infla o volume bruto; fica visível, mas fora do total.
    if (usage.cacheRead > 0) parts.push(`cache lido ${formatTokens(usage.cacheRead)}`);
    if (parts.length > 0) {
      const foot = document.createElement("div");
      foot.className = "usage-window-foot";
      foot.textContent = parts.join(" · ");
      wrapper.appendChild(foot);
    }
    return wrapper;
  }

  private renderBar(usage: WindowUsage): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "usage-bar";

    // Mesma composição do total: entrada, saída, cache escrito e raciocínio.
    const segments: Array<[number, string, string]> = [
      [usage.input, "usage-seg-input", "entrada"],
      [usage.output, "usage-seg-output", "saída"],
      [usage.cacheWrite, "usage-seg-cache", "cache escrito"],
      [usage.reasoning, "usage-seg-output", "raciocínio"],
    ];

    for (const [value, className, label] of segments) {
      if (value <= 0) continue;
      const segment = document.createElement("span");
      segment.className = `usage-seg ${className}`;
      segment.style.flexGrow = String(value);
      segment.title = `${label}: ${formatExact(value)} tokens`;
      bar.appendChild(segment);
    }

    if (bar.childElementCount === 0) bar.classList.add("empty");
    return bar;
  }

  private message(text: string, className: string): HTMLElement {
    const paragraph = document.createElement("p");
    paragraph.className = className;
    paragraph.textContent = text;
    return paragraph;
  }
}
