# SPEC — ADENDO §9: Compatibilidade Linux + Windows (obrigatório)

O app deve **compilar e rodar em Linux e Windows** (mesmo código, sem forks).
`portable_pty` já abstrai ConPTY (Windows) e pty Unix (Linux) — use apenas essa API.

## 9.1 Rust — separação por plataforma

- Organizar a descoberta de shells em `src-tauri/src/shells.rs` com sub-módulos
  `#[cfg(target_os = "windows")]` e `#[cfg(unix)]`, expondo uma API única:
  `pub fn list_shells() -> Vec<ShellInfo>`, `pub fn default_shell(&[ShellInfo]) -> ShellInfo`,
  `pub fn default_cwd() -> String`.
- **Windows** (como na §3): `pwsh` (PowerShell 7), `powershell`, `cmd`, Git Bash
  (`C:\Program Files\Git\bin\bash.exe`, args `["--login","-i"]`; fallback x86), `wsl`.
  `default_cwd()` → `%USERPROFILE%`.
- **Unix (Linux/macOS)**: procurar em `$PATH` e também em `/usr/local/bin`, `/usr/bin`, `/bin`
  (por `std::path::Path::new(...).is_file()`):
  - `bash` ("Bash", args `["-l"]`), `zsh` ("Zsh", args `["-l"]`), `fish` ("Fish", args `[]`),
    `pwsh` ("PowerShell 7", `[]`), `sh` ("sh", `[]`).
  - Ordem de preferência do default: `$SHELL` (se existir e for válido) → `bash` → `zsh` → `sh`.
  - `default_cwd()` → `$HOME`.
- `CANVAS_TERMINAL_SHELL` (env, caminho absoluto do executável) continua tendo prioridade nas
  duas plataformas.
- Ambiente do PTY: `TERM=xterm-256color` nos dois; no Unix também `COLORTERM=truecolor`.
- **Regra dura:** nenhum caminho Windows, nenhum `std::os::windows::*`/`cfg!(windows)` fora de
  módulo/cfg `windows`; e a recíproca para `unix`. `#[cfg(windows)]`/`#[cfg(unix)]` no ponto de
  escolha, nunca dentro de helpers compartilhados.
- Teste `src-tauri/tests/pty_test.rs` deve funcionar nas duas plataformas: escolher o shell por
  `cfg!` (`cmd.exe` no Windows, `bash` no Unix) e terminar a linha digitada com `\r`
  (funciona nos dois: ConPTY e a line discipline Unix com ICRNL).

## 9.2 Frontend — sem nada exclusivo de Windows

- Fonte do xterm e da UI: `"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace`.
- Atalhos usam `Ctrl` (e aceitam `event.metaKey` também, para eventual macOS).
- Clipboard via `navigator.clipboard` com fallback silencioso (e `document.execCommand('paste')`
  não existe — se falhar, não quebrar a UI; registrar aviso no rodapé).
- Sem libs/APIs de SO no frontend.

## 9.3 Empacotamento e documentação

- `tauri.conf.json`: `bundle.targets: "all"` (Windows → NSIS/MSI; Linux → deb/rpm/AppImage).
  Não fixar alvo Windows-only. Manter `productName` "Canvas Terminal".
- `README.md` com duas seções de build:
  - **Windows**: `npm install`, `npm run tauri dev`, `npm run tauri build`
    → instalador em `src-tauri/target/release/bundle/nsis/`.
  - **Linux**: deps de sistema (Ubuntu/Debian)
    `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`,
    depois `npm install && npm run tauri dev` / `npm run tauri build`
    → `.deb` e `.AppImage` em `src-tauri/target/release/bundle/`.
- Relatar no log final: quais partes do código ficaram `cfg`-gated e se restou qualquer suposição
  específica de plataforma.

## 9.4 Critérios de aceite adicionais

1. `npm run build`, `cargo build` e `cargo test` continuam passando no Windows (sem regressão).
2. Tente `rustup target add x86_64-unknown-linux-gnu` e `cargo check --target x86_64-unknown-linux-gnu`.
   Se falhar, deve ser **somente** por falta das bibliotecas de sistema do Tauri/GTK/WebKit no host
   Windows — nenhum erro pode vir de `src/pty.rs`, `src/shells.rs` ou `src/lib.rs`.
   Reporte a saída real obtida.
3. Revisão final de portabilidade: liste os arquivos com `#[cfg(...)]` e confirme que
   não há caminho/API de SO fora deles.
