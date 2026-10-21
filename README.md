# Canvas Terminal

Aplicativo desktop de **canvas infinito** com terminais reais (PowerShell, cmd, Git Bash, WSL no Windows; bash, zsh, fish, pwsh, sh no Linux), construído com **Tauri 2**, **Vite**, **TypeScript** e **xterm.js**.

O mesmo código-fonte compila tanto no **Windows** quanto no **Linux** (e macOS, com os devidos cuidados de empacotamento).

![Canvas Terminal rodando](docs/screenshot.png)

---

## Requisitos

### Windows

- Windows 10 19045 ou superior
- WebView2 Runtime instalado
- Node.js 22+
- Rust stable (toolchain `msvc`)
- MSVC 2019 BuildTools

### Linux (Ubuntu/Debian)

- Node.js 22+
- Rust stable
- Dependências de sistema do Tauri/GTK/WebKit:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev \
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
```

---

## Instalação

```bash
npm install
cd src-tauri
cargo add portable-pty base64
```

---

## Desenvolvimento

```bash
npm run tauri dev
```

A janela será aberta com a toolbar, canvas infinito e um terminal inicial no centro.

---

## Build / empacotamento

### Windows

```bash
npm run build
cd src-tauri && cargo build
```

Para gerar o instalador (NSIS/MSI):

```bash
npm run tauri build
```

Os instaladores ficarão em `src-tauri/target/release/bundle/` (subpastas `nsis/` e `msi/`).

### Linux

```bash
npm run build
cd src-tauri && cargo build
```

Para gerar os pacotes (`.deb`, `.rpm`, `.AppImage`):

```bash
npm run tauri build
```

Os pacotes ficarão em `src-tauri/target/release/bundle/` (subpastas `deb/`, `rpm/` e `appimage/`).

---

## Atalhos

| Atalho | Ação |
|--------|------|
| `Ctrl+T` (ou `Cmd+T`) | Novo terminal no centro do viewport |
| `Ctrl+Shift+W` (ou `Cmd+Shift+W`) | Fechar terminal em foco (funciona com o terminal focado) |
| `Ctrl+W` com o terminal em foco | Vai para o shell (apaga a palavra anterior); fora dele, fecha o terminal |
| `Ctrl+PageDown` / `Ctrl+PageUp` | Ciclar foco entre terminais |
| `Ctrl+0` (ou `Cmd+0`) | Resetar zoom |
| `Ctrl+Shift+V` / `Ctrl+V` (ou `Cmd+Shift+V` / `Cmd+V`) | Colar no terminal |
| `Ctrl+C` (ou `Cmd+C`) com seleção | Copiar do terminal |
| `F2` | Renomear título do terminal |
| `Espaço + arrastar` | Pan do canvas |
| `Botão do meio` / `botão direito` | Pan do canvas |
| `Ctrl + roda do mouse` | Zoom no cursor |
| `Shift + roda do mouse` | Pan horizontal |

---

## Preferências

O layout (posição, zoom e terminais) é salvo automaticamente em:

```
localStorage["canvas-terminal.layout.v1"]
```

---

## Shell padrão

O app detecta automaticamente os shells disponíveis no sistema operacional:

### Windows

1. PowerShell 7 (`pwsh.exe`)
2. Windows PowerShell (`powershell.exe`)
3. Prompt de Comando (`cmd.exe`)
4. Git Bash (`bash.exe`)
5. WSL (`wsl.exe`)

### Linux

1. `bash`
2. `zsh`
3. `fish`
4. `pwsh` (PowerShell 7)
5. `sh`

O shell padrão escolhido é `$SHELL` (se válido) → `bash` → `zsh` → `sh`.

Para forçar um shell específico em qualquer plataforma, defina a variável de ambiente:

```bash
export CANVAS_TERMINAL_SHELL="/caminho/para/meu-shell"
```

No Windows (PowerShell):

```powershell
$env:CANVAS_TERMINAL_SHELL = "C:\caminho\para\meu-shell.exe"
```

---

## Lentidão no terminal (Windows): hospedeiros ConPTY órfãos

Cada terminal é um **ConPTY**, e todo ConPTY tem um processo hospedeiro
(`conhost.exe`). Se o processo do app morrer de forma abrupta — Gerenciador de
Tarefas, `taskkill /F`, um crash — em um momento em que o terminal está
produzindo saída, o `conhost.exe` pode sobreviver **sem cliente** e entrar em
laço de CPU, queimando um núcleo inteiro para sempre. Alguns desses acumulados
saturam a máquina, e o sintoma é exatamente "o terminal ficou lento, as letras
demoram a aparecer" — inclusive em outros programas.

Medição real desta máquina (mesma sonda, mesmo código, antes e depois de
encerrar 11 conhosts órfãos que somavam ~160.000 s de CPU):

| cenário | comando inteiro | tecla | rajada de 50 linhas |
| --- | --- | --- | --- |
| CPU saturada (100%) | 3.858 ms | 2.425 ms | sem resposta |
| CPU livre (16%) | **19,9 ms** | **3,3 ms** | **292 ms** |

Fechar a janela normalmente **não** deixa resíduo: o app encerra todos os PTYs
em `RunEvent::ExitRequested` / `WindowEvent::Destroyed`. Prefira sempre fechar
pela janela (ou `taskkill /IM`, sem `/F`) em vez de "Finalizar tarefa".

Se a máquina ficar lenta, a ferramenta `tools/limpar-conhosts-orfaos.ps1`
encerra apenas hospedeiros órfãos **e girando** (filtros: processo-pai morto,
sem janela visível, consumo de CPU sustentado — consoles clássicos que você
esteja usando são ignorados):

```powershell
# só lista o que seria encerrado
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/limpar-conhosts-orfaos.ps1 -Simular

# encerra
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/limpar-conhosts-orfaos.ps1
```

---

## Estrutura

- `src/main.ts` — bootstrap da UI
- `src/canvas.ts` — viewport infinito (pan/zoom/grid)
- `src/terminal-window.ts` — janela de terminal com xterm.js
- `src/pty.ts` — wrapper do backend Tauri
- `src/persistence.ts` — salvamento de layout
- `src/styles.css` — tema escuro
- `src-tauri/src/shells.rs` — descoberta de shells por plataforma (`#[cfg(windows)]` / `#[cfg(unix)]`)
- `src-tauri/src/pty.rs` — backend PTY com `portable-pty`
- `src-tauri/tests/pty_test.rs` — teste de integração headless
- `tools/limpar-conhosts-orfaos.ps1` — limpeza de hospedeiros ConPTY órfãos (Windows)

---

## Testes

```bash
cd src-tauri && cargo test    # teste de integração do PTY (Windows e Linux)
npx tsc --noEmit              # checagem de tipos do frontend
```

A integração contínua (`.github/workflows/ci.yml`) roda os dois em `ubuntu-22.04`
e `windows-latest` a cada push.

---

## Licença

MIT — veja [LICENSE](LICENSE).

Copyright (c) 2026 Wilian Stancke.

