# AGENTS.md — orientações para agentes de IA

Este arquivo resume como trabalhar neste repositório sem quebrar o que já
existe. Leia antes de editar código, gerar builds ou instalar a aplicação.

## Visão geral

**Canvas Terminal** é um app desktop (Tauri 2) com canvas infinito e terminais
reais (PTY) em janelas arrastáveis. O mesmo código roda em **Windows** e
**Linux**.

- Frontend: TypeScript puro + Vite + xterm.js. **Sem framework** — a UI é DOM
  construído à mão em `src/main.ts` e módulos, estilizada por variáveis CSS com
  `:root[data-theme="..."]` em `src/styles.css`.
- Backend: Rust (Tauri 2) em `src-tauri/src`, comandos expostos via `invoke`.
- Estado: perfil completo em `localStorage` (chaves `canvas-terminal.*`),
  salvo com debounce; demais preferências em chaves próprias por módulo.
- Idioma: **docs, comentários, mensagens de UI e commits em pt-BR**;
  identificadores de código em inglês (`webview`, `workspace`, `terminalPalette`).

## Comandos essenciais

```bash
npm install                                   # dependências do frontend
npm run tauri dev                             # desenvolvimento (Vite + Tauri)
npx tsc --noEmit                              # checagem de tipos
npm run build                                 # tsc + vite build → dist/
cargo test                                    # em src-tauri/: testes de integração
```

Build de release (Linux/macOS):

```bash
npm run build
cd src-tauri && cargo build --release --features custom-protocol
```

Instalação local com atalho (Linux):

```bash
./tools/install.sh                # build + backup + instala em ~/.local/bin + atalhos
./tools/install.sh --skip-build   # reaproveita o binário compilado
```

## Armadilhas que já causaram bug

1. **`--features custom-protocol` é obrigatório no release.** Sem essa feature
   o binário é compilado em modo dev e carrega a UI de `http://localhost:1420`,
   exibindo **"Could not connect to localhost: Connection refused"**. `cargo
   build` sem `--release` tem o mesmo problema. `npm run tauri build` já passa a
   feature e é a opção recomendada para empacotar.
2. **Não sobrescreva o binário em execução.** O Linux recusa (`ETXTBSY`).
   `tools/install.sh` detecta via `/proc/<pid>/exe` e aborta com mensagem.
3. **O atalho usa caminho fixo** `~/.local/bin/canvas-terminal`. Atualizar a
   versão = recompilar e copiar para esse caminho; não é preciso editar o
   `.desktop` (o script recria por garantia). O autostart
   (`~/.config/autostart/Canvas Terminal.desktop`) aponta para o mesmo binário.
4. **Rodar o app sem sessão gráfica trava o comando** (a janela fica aberta).
   Para validar build, prefira `cargo build`, testes e checagem de tipos; para
   testar a UI use `npm run tauri dev` ou Chrome headless + CDP com a API Tauri
   stubbada (ver `IMPLEMENTATION_LOG.md`).
5. **Janela sem moldura**: `decorations: false` em `tauri.conf.json`. Minimizar,
   maximizar e fechar são desenhados pela UI; qualquer mudança de layout do
   cabeçalho precisa preservar esses controles e as alças de redimensionamento.

## Mapa do código

Frontend (`src/`):

- `main.ts` — bootstrap, cabeçalho, menu do app, configurações, áreas de
  trabalho, zoom, restauração do perfil. É o maior arquivo; mudanças de UI
  global passam por aqui.
- `canvas.ts` — viewport infinito (pan/zoom/grade), conversão de coordenadas.
- `terminal-window.ts` — janela do terminal (xterm), abas, drag/resize, overlay
  de saída, maximizado, indicador de atividade.
- `pty.ts` — ponte com o backend (`invoke`/`listen`, dados em base64).
- `persistence.ts` — formato e gravação do perfil (com migração do layout antigo).
- `theme.ts` — catálogo de temas, paleta ANSI do xterm, persistência e
  `onThemeChange` (usado para repintar terminais vivos).
- `osc-colors.ts` — responde OSC 4/10/11/12 e avisa troca de tema (modo 2031),
  para TUIs como o OpenCode seguirem o tema do app.
- `shortcuts.ts` — atalhos editáveis (persistidos) e mapa de ações.
- `git-panel.ts` — modal de alterações do Git, PRs e seletor de pasta.
- `token-usage.ts`, `clickup.ts`, `plugins.ts`, `autostart.ts` — plugins e
  integrações, com configuração própria.
- `snapping.ts` — encaixe e linhas-guia ao arrastar/redimensionar.
- `styles.css` — variáveis dos temas e todo o cromo da interface.

Backend (`src-tauri/src/`):

- `lib.rs` — monta o app e registra **todos** os comandos em
  `generate_handler![]`; comando novo só existe depois de adicionado ali.
- `pty.rs` — sessões PTY com `portable-pty`, trait `Sink` (permite testar sem
  `AppHandle`), evento `pty-event` para o frontend.
- `shells.rs` — descoberta de shells por plataforma (`#[cfg(windows)]` /
  `#[cfg(unix)]`).
- `git.rs`, `folders.rs` — status/diff/PRs do Git e navegação de pastas.

Testes: `src-tauri/tests/pty_test.rs` e `src-tauri/tests/git_test.rs` (rodam com
`cargo test` e no CI em Ubuntu e Windows).

## Convenções de código

- TypeScript `strict: true`: evite `any` e `@ts-ignore`; prefira tipos
  explícitos nas APIs dos módulos.
- Estilo já usado: 2 espaços, aspas duplas, ponto e vírgula, métodos privados
  com `private`, guardas de estado (`if (this.disposed) return`).
- UI: crie elementos com `document.createElement`/template strings e classes
  CSS existentes; **não** introduza dependência de framework sem pedido.
- Cores: sempre via variáveis CSS do tema ativo; nunca hardcode hexadecimal em
  componente. Tema novo exige entrada em `ThemeName`, `THEME_GROUPS`,
  `THEMES`, paleta xterm em `terminalPalette()` e bloco CSS
  `:root[data-theme="novo-tema"]`.
- Tema trocado com terminal aberto deve atualizar `term.options.theme` e chamar
  `notifyThemeChange` (ver `terminal-window.ts`).
- Comentários explicam **por que**, em pt-BR; não comente o óbvio.
- Rust: `cargo fmt`; erros como `Result<_, String>` nos comandos; comandos
  novos precisam de serde `Serialize`/`Deserialize` quando trocam structs.
- Não logar nem commitar segredos: tokens do ClickUp/GitHub ficam em
  `localStorage` e nunca devem aparecer em código, logs ou no README.

## Fluxo de trabalho esperado

1. `git pull` antes de começar. Com alterações locais não commitadas, use
   `git stash push -u` → `git merge --ff-only origin/main` → `git stash pop`
   para não perder trabalho em andamento.
2. Implemente em mudanças pequenas e coesas.
3. Valide: `npx tsc --noEmit`, `npm run build` e, se tocou Rust,
   `cargo test` e `cargo build --release --features custom-protocol`.
4. Registre a rodada em `IMPLEMENTATION_LOG.md` (seção `## Rodada — ...` com o
   que mudou, comandos rodados e resultado da verificação). O README descreve o
   comportamento para o usuário; atualize-o quando a mudança for visível.
5. Commits em pt-BR, no imperativo e descrevendo o efeito:
   `Adiciona ...`, `Corrige ...`, `Remove ...`, `Reformula ...`.
6. Nunca commite `dist/`, `src-tauri/target/`, `src-tauri/gen/` nem binários
   (já cobertos pelo `.gitignore`).

## Versionamento

A versão aparece em quatro lugares e deve ser bumpada em todos juntos:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `index.html` (elemento `.app-menu-version`, rodapé do menu do app)
