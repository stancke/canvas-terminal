# SPEC — Canvas Terminal (Tauri 2 + xterm.js + portable-pty)

Aplicativo desktop Windows: **canvas infinito** onde o usuário abre, move, redimensiona e usa
**terminais reais** (ConPTY — PowerShell, cmd, Git Bash, WSL). UI em **português do Brasil**.
Persona do app: sério, escuro, minimalista, tipo "cockpit".

O projeto já está scaffoldado (Tauri 2 + template `vanilla-ts` + Vite) em:
`C:\PROJETOS STANCKE\canvas-terminal`

**NÃO crie nem apague nada fora deste diretório.** Implemente tudo dentro dele.

---

## 1. Stack (já instalado / a instalar)

- Frontend: TypeScript + Vite (template vanilla-ts). Deps npm a usar: `@xterm/xterm`,
  `@xterm/addon-fit`, `@xterm/addon-web-links`, `@tauri-apps/api`. (já instaladas via npm; se
  faltar alguma, instale com npm).
- Backend Rust (`src-tauri`): `tauri 2`, `serde`, `serde_json`, mais `portable-pty` e `base64`
  (adicione com `cargo add portable-pty base64` rodando dentro de `src-tauri`).
- Windows 10 19045 + WebView2 + MSVC 2019 BuildTools + Rust stable (msvc). Sem WSL2 obrigatório.

## 2. Arquitetura de arquivos (obrigatória)

```
src-tauri/
  Cargo.toml                # deps + [[test]] se preciso
  tauri.conf.json           # productName/título/janela (ver §6)
  src/
    main.rs                 # chama lib::run()
    lib.rs                  # builder tauri + manage(PtyState) + invoke_handler
    pty.rs                  # sessões PTY (portable-pty), comandos + eventos
  tests/pty_test.rs         # teste de integração headless do PTY (§7)
src/
  main.ts                   # bootstrap: toolbar, eventos globais, restore de layout
  pty.ts                    # wrapper JS do backend (invoke + listen)
  canvas.ts                 # viewport infinito: pan, zoom, grid, auto-pan, coordenadas
  terminal-window.ts        # janela de terminal: chrome, drag, resize, foco, xterm
  persistence.ts            # salvar/restaurar layout (localStorage)
  styles.css                # tema escuro completo
index.html                  # shell da UI (toolbar + #viewport > #world)
README.md                   # como rodar/empacotar em PT-BR (substituir o atual)
```

## 3. Backend Rust — `pty.rs`

Estado: `pub struct PtyState(Mutex<HashMap<u32, Session>>)` onde
`Session { writer: Box<dyn Write + Send>, master: Box<dyn MasterPty + Send>, child: Box<dyn Child + Send>, cols: u16, rows: u16, shell_id: String }`.
IDs `u32` incrementais (`AtomicU32`).

Comandos (`#[tauri::command]`, todos retornam `Result<_, String>` com mensagem legível):

1. `pty_list_shells() -> Vec<ShellInfo>` — `ShellInfo { id, name, path, args: Vec<String> }`.
   Descoberta por existência de arquivo, nesta ordem (id → name):
   - `pwsh` → "PowerShell 7" → `C:\Program Files\PowerShell\7\pwsh.exe`
   - `powershell` → "Windows PowerShell" → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
   - `cmd` → "Prompt de Comando" → `%SystemRoot%\System32\cmd.exe`
   - `bash` → "Git Bash" → `C:\Program Files\Git\bin\bash.exe`, args `["--login","-i"]`
     (fallback `C:\Program Files (x86)\Git\bin\bash.exe`)
   - `wsl` → "WSL" → `%SystemRoot%\System32\wsl.exe`
   Inclua somente os que existem. O primeiro disponível é o default. Aceite override por
   `CANVAS_TERMINAL_SHELL` (env) se existir.
2. `pty_spawn(app: AppHandle, state, shell: Option<String>, cwd: Option<String>, cols: u16, rows: u16) -> Result<u32,String>`
   - `portable_pty::native_pty_system().openpty(PtySize { rows, cols, pixel_width:0, pixel_height:0 })`
   - `CommandBuilder::new(path)` + `.args(...)` + `.cwd(cwd)` (cwd inválido → fallback `USERPROFILE`)
     + `.env("TERM","xterm-256color")`.
   - `spawn_command` → **dropar o `slave` logo após o spawn** (necessário p/ EOF e p/ ConPTY).
   - Thread leitora: loop `read(&mut buf)` → bytes → `base64::engine::general_purpose::STANDARD.encode`
     → `app.emit("pty-event", PtyEvent { id, kind: "data", data: Some(b64), code: None })`.
     Em EOF/erro: `child.wait()` → emitir `kind:"exit"` com `code` → remover sessão do mapa.
     Buffer de 16 KiB; se quiser, junte saídas rápidas (coalescing ~5 ms) para não inundar o WebView.
3. `pty_write(id: u32, data: String)` — `data` é **base64**; decodifica e `write_all` + `flush`.
4. `pty_resize(id: u32, cols: u16, rows: u16)` — `master.resize(...)`, guarda cols/rows.
5. `pty_kill(id: u32)` — `child.kill()` + remove sessão (não é erro se já não existir).
6. `pty_alive(id: u32) -> bool`.
7. `pty_default_cwd() -> String` — `%USERPROFILE%`.

Evento enviado ao frontend: `PtyEvent { id: u32, kind: String, data: Option<String>, code: Option<i32> }`
(serialize com `serde::Serialize`).

Regras de robustez: nunca dê panic em comando; todo erro vira `Err(String)` em português
("Falha ao abrir PTY: …"). Ao fechar a janela do app, `pty_kill` em todas as sessões (hook
`RunEvent::ExitRequested` ou `WindowEvent::Destroyed`).

## 4. Frontend — canvas infinito (`canvas.ts`)

- DOM: `#viewport` (position:fixed; inset:0; overflow:hidden) contendo `#world`
  (position:absolute; transform: translate(panX,panY); transform-origin: 0 0) com os terminais.
- **Sem `scale()` no CSS**: zoom é aplicado em JS. Cada terminal tem coordenadas de mundo
  (`x,y,w,h` em unidades de layout). Render: `left = x*zoom`, `top = y*zoom`,
  `width = w*zoom`, `height = h*zoom` — e o `#world` só translada. Assim o texto do xterm
  fica **sempre nítido** e as cols/rows acompanham o tamanho visual.
- **Grid infinito**: `background-image: linear-gradient(...)` no `#viewport` com
  `background-size = 32*zoom` px, `background-position = panX panY` (atualizado no pan/zoom);
  linha mais forte a cada 4 células.
- **Pan** (scroll infinito nas 4 direções, sem limite):
  - botão do meio arrastando, **ou** botão direito arrastando (threshold 4 px p/ não conflitar
    com o menu de contexto), **ou** espaço+botão esquerdo, **ou** botão esquerdo em área vazia;
  - roda do mouse = pan vertical; Shift+roda = pan horizontal; Ctrl+roda = **zoom no cursor**
    (0.35–2.5, passos suaves);
  - durante o pan, mover apenas `transform: translate` (fluido); aplicar o `left/top/width/height`
    dos terminais no mesmo frame em que o zoom muda.
- **Auto-pan nas bordas**: ao arrastar/redimensionar um terminal a menos de 40 px da borda do
  viewport, o canvas desliza sozinho (velocidade proporcional à proximidade, ~60 fps).
- API pública do canvas: `screenToWorld(x,y)`, `worldRectVisible()`, `centerWorldPoint()`,
  `zoom`, `pan`, `setView(pan,zoom)`, `requestRender()`.
- Barra de zoom/rodapé mostra `zoom %` e a contagem de terminais.

## 5. Frontend — janela de terminal (`terminal-window.ts`)

Cada terminal = `div.term-window` (absoluto, no `#world`) com:
- **Barra de título** (28 px): ícone/ponto colorido por shell, nome do shell, `#{n}`,
  e botões à direita: **minimizar** (recolhe só à barra de título), **maximizar no viewport**
  (duplo-clique também; guarda geometria anterior p/ restaurar), **fechar** (X → `pty_kill` + remove).
  Arrastar pela barra move a janela em coordenadas de mundo.
- **Corpo**: `div.term-body` com o `xterm` (FitAddon + WebLinksAddon). Clique em qualquer ponto
  → foca (`term.focus()`), traz para frente (`z-index` incremental), destaca a borda ativa.
- **8 alças de redimensionar** (n,s,e,w,ne,nw,se,sw) de 6–8 px nas bordas/cantos, cursor correto.
  Tamanho mínimo 240×140 unidades de mundo; `fit()` durante o resize com throttle (~50 ms) e
  `pty_resize` só quando cols/rows mudarem de fato.
- Colar/copiar: Ctrl+Shift+V cola do clipboard; Ctrl+C com seleção copia (senão envia ^C, como
  um terminal normal); Ctrl+V também cola. (usar `navigator.clipboard.readText()`).
- Estado "processo finalizado": overlay discreto com código de saída, botões **Reiniciar** e
  **Fechar**. Botão **Reiniciar** também disponível na barra de título.
- Rolagem de histórico própria do xterm (scrollback 10000) — não confundir com o pan do canvas:
  a roda sobre o terminal rola o histórico; a roda sobre a área vazia faz pan do canvas.
- Ao mudar o tamanho visual (zoom/resize), recalcular `cols/rows` via `fit()` e enviar
  `pty_resize`, com debounce de ~120 ms.
- Snap magnético: ao mover/redimensionar, se a borda ficar a ≤6 px de alinhar com outro terminal
  ou com o grid, encaixa e desenha uma guia fina (linha accent) no canvas.

## 6. UI / tema

- `index.html`: barra superior fixa (fora do viewport) com: título "Canvas Terminal",
  botão primário **"+ Novo terminal"** + `<select>` de shell, botões **Organizar**
  (cascata/tile dos terminais visíveis no viewport), **Centralizar**, **Resetar zoom**,
  indicador `zoom %`, contador de terminais. Tooltips em PT-BR.
- `tauri.conf.json`: `productName` "Canvas Terminal", título da janela "Canvas Terminal",
  `width: 1600, height: 950, minWidth: 900, minHeight: 600`, `resizable: true`,
  `theme: "Dark"`, `center: true` e `"maximized": true`. Fundo escuro
  (`backgroundColor` escuro) e sem flash branco.
- Tema escuro: fundo `#0b0e12`, grid `#161b22`, janela `#12171e` com borda `#222b36`,
  barra de título `#1a212b`, accent ativo `#4ea1ff` (foco) / `#26313d` (inativo),
  fonte `Cascadia Mono, Consolas, monospace`, xterm com `fontSize: 13`, `cursorBlink: true`,
  `convertEol: true`, `scrollback: 10000`, `allowProposedApi: true`.
- Atalhos globais (fora de inputs): `Ctrl+T` novo terminal no centro do viewport,
  `Ctrl+W` fecha o focado, `Ctrl+PageDown`/`Ctrl+PageUp` cicla o foco,
  `Ctrl+0` reset zoom, `Ctrl+Shift+C/V` copiar/colar, `F2` renomeia o título do terminal,
  `Delete`? (não). Mostre os atalhos no tooltip dos botões.
- Menu de contexto (clique direito sem arrastar em área vazia): "Novo terminal aqui",
  "Organizar em cascata", "Centralizar vista", "Colar terminal" (se houver clipboard).
  Na barra de título de um terminal: "Renomear", "Reiniciar", "Maximizar", "Fechar".

## 7. Persistência e verificação

- `persistence.ts`: salva em `localStorage["canvas-terminal.layout.v1"]` (debounce 500 ms):
  `{ view: {panX, panY, zoom}, terminals: [{ x,y,w,h, shell, cwd, title, maximized, geom? }] }`.
  Ao abrir o app, restaura a vista e **respawna** os terminais com o shell e o `cwd` salvos
  (se o `cwd` não existir mais, usa o default). Mantém `+ Novo terminal` funcional.
- `src-tauri/tests/pty_test.rs`: teste de integração **headless** (sem GUI) que:
  1. abre um PTY com `cmd.exe` (ou `powershell.exe`) via as mesmas funções de `pty.rs`
     (exponha a API interna com `pub fn` reutilizável, sem depender de `AppHandle`;
     para isso a emissão de eventos deve ser abstraída por um `trait Sink { fn emit(&self, ev: &PtyEvent); }`
     com uma impl real (Tauri) e uma impl de teste que coleta em `Arc<Mutex<Vec<PtyEvent>>>`);
  2. escreve `echo canvas-terminal-ok\r\n`;
  3. espera até ~10 s por um evento `data` cujo texto decodificado contenha `canvas-terminal-ok`;
  4. verifica `pty_resize` (não dá panic) e `pty_kill` (sessão vira `pty_alive == false`).
- **Critérios de aceite (rode e mostre a saída real):**
  1. `npm run build` (tsc + vite) sem erros.
  2. `cd src-tauri && cargo build` sem erros e sem warnings novos relevantes.
  3. `cd src-tauri && cargo test` → teste do §7 passando.
  4. `npm run tauri dev` compila e abre a janela sem erro de runtime (deixe compilar; você pode
     fechar depois; relate o resultado real).
- `README.md` em PT-BR: o que é, requisitos, `npm install`, `npm run tauri dev`,
  `npm run tauri build` (instalador em `src-tauri/target/release/bundle/nsis/`), atalhos,
  onde ficam as preferências e como trocar o shell default (`CANVAS_TERMINAL_SHELL`).

## 8. Estilo de código

TypeScript estrito (sem `any` desnecessário), módulos pequenos e comentados em PT-BR,
sem libs de UI/frameworks (nada de React/Vue) e sem dependências além das listadas.
Rust idiomático, sem `unwrap()` em caminho de execução do usuário.
