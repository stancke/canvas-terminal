/**
 * Ícones disponíveis para as áreas de trabalho.
 *
 * O `markup` é constante e confiável (não vem do usuário), por isso pode ser
 * injetado com `innerHTML`. Todos usam `currentColor` para herdarem a cor da
 * área de trabalho.
 */

export interface WorkspaceIcon {
  id: string;
  label: string;
  markup: string;
}

export const WORKSPACE_ICONS: WorkspaceIcon[] = [
  {
    id: "letters",
    label: "Iniciais",
    markup:
      '<path d="M2.5 12.5 5.5 3.5 8.5 12.5M3.6 9.5h3.8M10 12.5h3.5"/>',
  },
  {
    id: "terminal",
    label: "Terminal",
    markup:
      '<path d="M3 4.5 6.5 8 3 11.5M8.5 11.5h4.5"/>',
  },
  {
    id: "grid",
    label: "Aplicativos",
    markup:
      '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.1"/>' +
      '<rect x="9" y="2.5" width="4.5" height="4.5" rx="1.1"/>' +
      '<rect x="2.5" y="9" width="4.5" height="4.5" rx="1.1"/>' +
      '<rect x="9" y="9" width="4.5" height="4.5" rx="1.1"/>',
  },
  {
    id: "code",
    label: "Código",
    markup: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  },
  {
    id: "folder",
    label: "Pasta",
    markup:
      '<path d="M2 5.2A1.2 1.2 0 0 1 3.2 4h2.6l1.4 1.6h4.6A1.2 1.2 0 0 1 13 6.8v4.4a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.2z"/>',
  },
  {
    id: "server",
    label: "Servidor",
    markup:
      '<rect x="2.5" y="3" width="11" height="4" rx="1"/>' +
      '<rect x="2.5" y="9" width="11" height="4" rx="1"/>' +
      '<path d="M4.5 5h.01M4.5 11h.01M7 5h4M7 11h4" stroke-linecap="round"/>',
  },
  {
    id: "database",
    label: "Banco de dados",
    markup:
      '<ellipse cx="8" cy="4" rx="5" ry="2"/>' +
      '<path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  },
  {
    id: "globe",
    label: "Web",
    markup:
      '<circle cx="8" cy="8" r="5.5"/>' +
      '<path d="M2.5 8h11M8 2.5c1.6 1.5 2.4 3.4 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.5z"/>',
  },
  {
    id: "sparkle",
    label: "IA",
    markup: '<path d="M8 2.5 9.3 6 13 7.3 9.3 8.6 8 12l-1.3-3.4L3 7.3 6.7 6z"/>',
  },
  {
    id: "flask",
    label: "Laboratório",
    markup:
      '<path d="M6.5 2.5h3M7 2.5v4l-3.2 5.6a1.1 1.1 0 0 0 .9 1.6h6.6a1.1 1.1 0 0 0 .9-1.6L9 6.5v-4M5 10h6"/>',
  },
  {
    id: "book",
    label: "Documentação",
    markup:
      '<path d="M3 3.2A1.2 1.2 0 0 1 4.2 2H8v11H4.2A1.2 1.2 0 0 0 3 14.2zM13 3.2A1.2 1.2 0 0 0 11.8 2H8v11h3.8A1.2 1.2 0 0 1 13 14.2z"/>',
  },
  {
    id: "bank",
    label: "Empresa",
    markup:
      '<path d="M2 5.5 8 2.5l6 3M4 6.5v5M6.7 6.5v5M9.3 6.5v5M12 6.5v5M3 12.5h10"/>',
  },
  {
    id: "home",
    label: "Casa",
    markup: '<path d="M3 7.5 8 3l5 4.5V13H3z"/><path d="M6.5 13V9.5h3V13"/>',
  },
  {
    id: "heart",
    label: "Favorito",
    markup:
      '<path d="M8 13S2.5 9.8 2.5 6.4A2.9 2.9 0 0 1 8 5.2a2.9 2.9 0 0 1 5.5 1.2C13.5 9.8 8 13 8 13z"/>',
  },
  {
    id: "star",
    label: "Estrela",
    markup:
      '<path d="m8 2.5 1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8L2.6 6.5l3.8-.5z"/>',
  },
  {
    id: "bolt",
    label: "Rápido",
    markup: '<path d="M9 2.5 4 9h3.2l-.6 4.5L11.5 7H8.3z"/>',
  },
  {
    id: "cloud",
    label: "Nuvem",
    markup:
      '<path d="M4.6 12.5h6.9a2.6 2.6 0 0 0 .3-5.2 3.6 3.6 0 0 0-6.9-.4 2.3 2.3 0 0 0-.3 5.6z"/>',
  },
  {
    id: "box",
    label: "Caixa",
    markup:
      '<path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="M2.5 5 8 7.5 13.5 5M8 7.5v6"/>',
  },
  {
    id: "layers",
    label: "Camadas",
    markup: '<path d="M8 2.5 13.5 5 8 7.5 2.5 5zM2.5 8 8 10.5 13.5 8M2.5 11 8 13.5 13.5 11"/>',
  },
  {
    id: "wrench",
    label: "Ferramentas",
    markup:
      '<path d="M10.4 2.6a3 3 0 0 0-3.9 3.9L3 10.1 5.9 13l3.6-3.5a3 3 0 0 0 3.9-3.9l-2 2-2-2z"/>',
  },
  {
    id: "droplet",
    label: "Design",
    markup:
      '<path d="M8 2.5s3.7 4.2 3.7 6.8A3.7 3.7 0 0 1 4.3 9.3C4.3 6.7 8 2.5 8 2.5z"/>',
  },
  {
    id: "gamepad",
    label: "Jogos",
    markup:
      '<rect x="2" y="5.5" width="12" height="6" rx="3"/>' +
      '<path d="M5 7.5v2M4 8.5h2M10.5 7.5h.01M12 9.5h.01" stroke-linecap="round"/>',
  },
  {
    id: "music",
    label: "Música",
    markup:
      '<path d="M6.5 11.5V4l6-1.2v7.7"/><circle cx="5" cy="11.8" r="1.7"/><circle cx="11" cy="10.5" r="1.7"/>',
  },
  {
    id: "camera",
    label: "Mídia",
    markup:
      '<rect x="2.5" y="5" width="11" height="8" rx="1.5"/>' +
      '<circle cx="8" cy="9" r="2.2"/><path d="M6 5V3.8h4V5"/>',
  },
  {
    id: "coffee",
    label: "Pausa",
    markup:
      '<path d="M3 5h8v5.2a2.8 2.8 0 0 1-2.8 2.8H5.8A2.8 2.8 0 0 1 3 10.2z"/>' +
      '<path d="M11 6.2h1.2a2 2 0 0 1 0 4H11M2.5 13.5h10"/>',
  },
  {
    id: "rocket",
    label: "Deploy",
    markup:
      '<path d="M9.5 2.5c2 0 4 2 4 4l-3.2 3.2-3-3z"/>' +
      '<path d="M6.5 6.5 4 9l3 3 2.5-2.5M4.5 11.5 2.5 13.5"/>',
  },
];

export const DEFAULT_WORKSPACE_ICON = "terminal";

/** Cores oferecidas para identificar uma área de trabalho. */
export const WORKSPACE_COLORS = [
  "#d1242f",
  "#bc4c00",
  "#c69026",
  "#1a7f37",
  "#0969da",
  "#bf3989",
  "#8250df",
  "#1b7c83",
];

export const DEFAULT_WORKSPACE_COLOR = WORKSPACE_COLORS[4];

const ICON_IDS = new Set(WORKSPACE_ICONS.map((icon) => icon.id));

export function isWorkspaceIcon(id: unknown): id is string {
  return typeof id === "string" && ICON_IDS.has(id);
}

export function workspaceIconMarkup(id: string): string {
  return (
    WORKSPACE_ICONS.find((icon) => icon.id === id)?.markup ??
    WORKSPACE_ICONS[0].markup
  );
}

/** Cria o `<svg>` do ícone já com o traço herdando `currentColor`. */
export function createWorkspaceIcon(id: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = workspaceIconMarkup(id);
  return svg;
}
