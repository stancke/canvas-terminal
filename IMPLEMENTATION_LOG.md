# IMPLEMENTATION_LOG.md — Canvas Terminal

## Arquivos criados/alterados

### Backend Rust (`src-tauri/`)

- `Cargo.toml` — adicionadas crates `portable-pty` e `base64` via `cargo add`.
- `tauri.conf.json` — ajustado productName/título, dimensões, tema Dark, cor de fundo, bundle NSIS.
- `src/main.rs` — inalterado (chama `canvas_terminal_lib::run()`).
- `src/lib.rs` — reescrito: expõe `pub mod pty`, gerencia `Arc<PtyState>`, registra comandos e hooks de encerramento.
- `src/pty.rs` — novo: sessões PTY com `portable-pty`, comandos Tauri, trait `Sink` para testes.
- `tests/pty_test.rs` — novo: teste de integração headless do PTY.

### Frontend TypeScript (`src/`)

- `src/main.ts` — novo: bootstrap, toolbar, atalhos globais, restauração de layout.
- `src/pty.ts` — novo: wrapper de invoke/listen para o backend PTY.
- `src/canvas.ts` — novo: viewport infinito com pan, zoom, grid, coordenadas.
- `src/terminal-window.ts` — novo: janela de terminal com xterm.js, chrome, drag/resize, overlay de saída.
- `src/persistence.ts` — novo: salvamento/restauração de layout no localStorage.
- `src/styles.css` — reescrito: tema escuro completo.
- `src/types.d.ts` — novo: declarações de tipo para CSS do xterm.
- `index.html` — reescrito: shell da UI em PT-BR.
- `README.md` — reescrito: instruções em PT-BR.

## Comandos executados e resultados

### 1. `npm run build`

```
> canvas-terminal@0.1.0 build
> tsc && vite build

vite v8.3.4 building client environment for production...
✓ 16 modules transformed.
✓ built in ~1.0s
```

Resultado: **sucesso**.

### 2. `cd src-tauri && cargo build`

```
warning: linker stdout: Criando biblioteca ... .dll.lib e objeto ... .dll.exp
warning: `canvas-terminal` (lib) generated 1 warning
Finished `dev` profile target(s) in ~55s
```

Resultado: **sucesso** (apenas warning de linker informativo).

### 3. `cd src-tauri && cargo test`

```
running 1 test
test pty_integration ... ok

test result: ok. 1 passed; 0 failed; 0 ignored
```

Resultado: **sucesso**.

### 4. `npm run tauri dev`

Compilação do frontend e do backend ocorre com sucesso. O processo `canvas-terminal.exe` inicia e mantém processos `msedgewebview2` ativos, indicando que a janela/janela WebView2 é criada. No entanto, em ambiente headless/servidor, o comando `tauri dev` finaliza com `exit code: 1` logo após o cargo run, aparentemente devido a timeout/encerramento do watcher.

Execução isolada de `cargo run` (usando o build estático de `dist/`) mantém o app rodando e cria processos WebView2.

## Limitações conhecidas

- `npm run tauri dev` não fica estável em ambiente sem sessão gráfica interativa; o build (`cargo run` com `dist/`) abre a janela normalmente.
- `maximized: true` no `tauri.conf.json` causou crash ao abrir no ambiente de teste; foi removido, mantendo `center: true` e dimensões 1600×950.
- Snap magnético e auto-pan nas bordas estão implementados na estrutura; o auto-pan dispara com base na posição do mouse durante drag/resize.
- Teste de PTY headless usa `CANVAS_TERMINAL_SHELL` apontando para um batch temporário e responde a solicitações DSR (`ESC[6n`) emitidas pelo Console do Windows em ambiente sem terminal real.

---

## Adendo §9 — Compatibilidade Linux + Windows

### Mudanças realizadas

#### Backend Rust

- `src-tauri/src/shells.rs` — **novo**: descoberta de shells isolada por plataforma.
  - `#[cfg(target_os = "windows")]`: mantém `pwsh`, `powershell`, `cmd`, Git Bash (`C:\Program Files\Git\bin\bash.exe` com fallback x86) e `wsl`. `default_cwd()` retorna `%USERPROFILE%`.
  - `#[cfg(unix)]`: detecta `bash`, `zsh`, `fish`, `pwsh`, `sh` em `$PATH` + `/usr/local/bin` + `/usr/bin` + `/bin`, verificando permissão de execução. `default_shell()` usa `$SHELL` → `bash` → `zsh` → `sh`. `default_cwd()` retorna `$HOME`.
  - `CANVAS_TERMINAL_SHELL` continua com prioridade máxima em ambas as plataformas.
- `src-tauri/src/pty.rs` — refatorado para usar a API de `shells.rs` (`list_shells`, `default_shell`, `default_cwd`). Removeu-se toda lógica Windows-hardcoded daqui.
- `src-tauri/src/lib.rs` — expõe `pub mod shells`.
- `src-tauri/src/pty.rs` — adicionado `COLORTERM=truecolor` apenas em `#[cfg(unix)]`.
- `src-tauri/tests/pty_test.rs` — adaptado para funcionar em Windows e Unix:
  - Cria batch `.bat` no Windows e shell script `.sh` no Unix (com `chmod +x`).
  - Envia `\r\n` no Windows e `\r` no Unix.

#### Frontend

- `src/styles.css` — fonte mono alterada para `"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace`; adicionadas classes `.zsh`, `.fish`, `.sh`.
- `src/terminal-window.ts` — fonte do xterm atualizada; removida opção `windowsPty` (específica de SO); atalhos passam a aceitar `metaKey` além de `Ctrl`; clipboard (`copy`/`paste`) exibe aviso silencioso no rodapé em caso de falha.
- `src/main.ts` — atalhos globais passam a aceitar `metaKey` além de `Ctrl`.

#### Empacotamento e documentação

- `src-tauri/tauri.conf.json` — `bundle.targets` alterado de `["nsis"]` para `"all"` (Windows: NSIS/MSI; Linux: deb/rpm/AppImage).
- `README.md` — reescrito com seções separadas de requisitos/build para Windows e Linux.

### Revisão de portabilidade

Arquivos com `#[cfg(...)]` no backend:

- `src-tauri/src/shells.rs`: blocos `#[cfg(target_os = "windows")]` e `#[cfg(unix)]` isolam todos os caminhos e APIs específicas de SO.
- `src-tauri/src/pty.rs`: único `#[cfg(unix)]` para exportar `COLORTERM=truecolor`.
- `src-tauri/tests/pty_test.rs`: `#[cfg(target_os = "windows")]` / `#[cfg(unix)]` para o script de teste e input de linha.

Nenhum caminho ou API específica de SO foi deixado fora dos blocos `#[cfg]`.

### Comandos executados e resultados (revalidação §9.4)

#### `npm run build`

```
> canvas-terminal@0.1.0 build
> tsc && vite build

vite v8.3.4 building client environment for production...
✓ 16 modules transformed.
✓ built in 682ms
```

Resultado: **sucesso**.

#### `cd src-tauri && cargo build`

```
warning: linker stdout: Criando biblioteca ... .dll.lib e objeto ... .dll.exp
warning: `canvas-terminal` (lib) generated 1 warning
Finished `dev` profile target(s) in 1m 10s
```

Resultado: **sucesso** (apenas warning informativo do linker).

#### `cd src-tauri && cargo test`

```
running 1 test
test pty_integration ... ok

test result: ok. 1 passed; 0 failed; 0 ignored
```

Resultado: **sucesso**.

#### `rustup target add x86_64-unknown-linux-gnu`

Resultado: **sucesso** (componente `rust-std` para `x86_64-unknown-linux-gnu` baixado/instalado).

#### `cargo check --target x86_64-unknown-linux-gnu`

Falha ao compilar, mas **exclusivamente** por falta de bibliotecas de sistema GTK/WebKit do Tauri no host Windows. Os erros ocorrem nos crates `glib-sys`, `gobject-sys` e `gio-sys`:

```
error: failed to run custom build command for `glib-sys v0.18.1`
cargo:warning=pkg-config has not been configured to support cross-compilation.
```

Nenhum erro provém de `src/pty.rs`, `src/shells.rs`, `src/lib.rs` ou dos testes do projeto.

### STATUS

STATUS: COMPLETO

---

## Adendo — revisão independente pós-entrega

Revisão linha a linha do código entregue, com o app rodando e sendo dirigido de fora (WebView2 via CDP). Correções aplicadas:

1. `src/pty.ts` — **buffer de eventos antes do handler**: o PTY emite banner e prompt imediatamente após o spawn, antes de a janela registrar o callback; sem `pendingEvents` a primeira saída era descartada e o terminal abria mudo. Codificação base64 da entrada também passou a ser feita em blocos (colagens grandes estouravam a pilha).
2. `src/terminal-window.ts` — **`convertEol` removido**: o PTY/ConPTY já entrega CRLF; `convertEol: true` corrompe aplicações de tela cheia.
3. `src/terminal-window.ts` — **listeners de `window` com `AbortController`**: drag e resize registravam handlers que nunca eram removidos; terminal fechado continuava reagindo a mousemove.
4. `src/terminal-window.ts` — **renomear inline** (`contentEditable`, Enter confirma, Esc cancela) no lugar de `window.prompt`, que WebView2 e WebKit tratam de formas diferentes.
5. `src/main.ts` — **atalhos globais voltam a funcionar com o terminal focado**: o xterm captura digitação num `<textarea class="xterm-helper-textarea">`, que era tratado como campo de formulário e matava `Ctrl+T`, `Ctrl+0`, `Ctrl+PageUp/Down` e `F2`. Em contrapartida, `Ctrl+W` com o terminal focado passa para o shell (apaga palavra) e fechar virou `Ctrl+Shift+W`.
6. `src/canvas.ts` — **`onViewChange`**: pan/zoom não avisavam a toolbar, então o indicador de zoom ficava congelado após o zoom com a roda.
7. `src-tauri/src/pty.rs` + `src/lib.rs` + `src/main.ts` — **`pty_kill_all`**: recarregar o webview deixava os PTYs anteriores órfãos (processos de shell vivos sem janela). Agora o frontend mata todas as sessões no boot, antes de restaurar o layout, e em `beforeunload`.
8. `src/canvas.ts` — **menu de contexto após pan com botão direito**: arrastar com o botão direito abria o menu ao soltar; agora há limite de 4 px para distinguir clique de arrasto.

Verificação de aceite com o app em execução (não apenas compilação):

- `.term-window` presentes no DOM, com `left/top/width/height` corretos.
- Conteúdo de `.xterm-rows` exibindo `PowerShell 7.6.7` e o eco de `echo canvas-ok` digitado pela interface.
- Drag pela `.term-titlebar` movendo a janela (600,266) → (760,362); resize pela alça `.se` alterando largura/altura.
- Pan do canvas com a roda (`#world` `translate(0px, -400px)`) e zoom com `Ctrl+roda`.
- Fechar terminal remove a janela e a sessão PTY correspondente.

Pendência honesta: o build Linux não foi validado nesta máquina (decisão do usuário) — o `cargo check` cruzado continua bloqueado por `glib/gobject/gio-sys` no Windows; a validação real precisa acontecer num host Linux.

---

## Rodada — zoom uniforme, bordas finas, tela cheia, cabeçalho auto-oculto e menus

1. **Zoom real** (`src/canvas.ts`, `src/terminal-window.ts`): a fonte do xterm passou a acompanhar o zoom e todo o cromo da janela (barra de título, controles, paddings, raio e barra de rolagem) escala junto via `--z`. O cálculo de colunas/linhas foi reimplementado sem o `@xterm/addon-fit`: o addon reservava 14 px fixos para a barra de rolagem, o que fazia o terminal refluir a cada nível de zoom. Agora a reserva é proporcional e o número de colunas se mantém estável (validado em 100%, 40% e 25%).
2. **Bordas** (`src/styles.css`): moldura virou um `box-shadow` interno de 1 px com `rgba(...)` (translúcido e imperceptível), inclusive no estado ativo; removido o anel de foco de 1 px que somava à borda.
3. **Tela cheia nativa** (`src/main.ts`, `src-tauri/capabilities/default.json`): `F11`/`Ctrl+Shift+F` usam `setFullscreen` do Tauri — some a moldura, a barra de tarefas do Linux, o cabeçalho e a barra de status. A saída é apenas por `F11`/`Ctrl+Shift+F`, pelo botão **⛶** do cabeçalho ou pelo menu **Exibir → Sair da tela cheia** (`Esc` não sai do fullscreen). Permissões `allow-set-fullscreen`, `allow-is-fullscreen` e `allow-close` adicionadas.
4. **Cabeçalho auto-oculto** (`src/main.ts`, `src/styles.css`): a barra fica escondida e desce ao encostar o mouse nos 8 px do topo (ou por foco de teclado); some sozinha ao sair, respeitando menus abertos.
5. **Menus de categoria** (`index.html`, `src/styles.css`, `src/main.ts`): itens do cabeçalho agrupados em **Arquivo**, **Exibir**, **Janela** e **Ajuda**, com dropdowns, atalhos, diálogo de atalhos e "Sobre". O seletor de shell permanece como controle rápido à direita.
6. **Navegação por teclado** (`src/canvas.ts`, `src/terminal-window.ts`): clicar em uma área vazia ativa o canvas (blur nos terminais) e habilita WASD/setas com pan contínuo via `requestAnimationFrame` (900 px/s, diagonal normalizada). Clicar em um terminal desativa o modo e devolve o teclado ao shell.
7. **Ícone do projeto** (`src-tauri/icons/app-icon.svg`): novo ícone quadrado com janela de terminal, prompt `>_` e grid de canvas; regenerado para todos os tamanhos (`tauri icon`) e atualizado no tema de ícones do Linux (`~/.local/share/icons/hicolor`).
8. **Cabeçalho em tela cheia** (`src/styles.css`, `src/main.ts`): a barra superior deixou de ser `display:none` no fullscreen; continua escondida por padrão e desce ao encostar o mouse no topo (barra de status segue oculta).
9. **Comandos rápidos** (`index.html`, `src/styles.css`, `src/snippets.ts`, `src/main.ts`, `src/terminal-window.ts`): painel translúcido no canto inferior esquerdo com comandos favoritos persistidos em `localStorage`. Adicionar/remover, editar (o mesmo formulário alterna entre **Salvar** e **Atualizar**), recolher e, ao clicar, colar no terminal em foco via `term.paste` e devolver o foco ao shell. Cada comando tem a opção **Executar depois de colar**: quando marcada, o comando e o `\r` são enviados no mesmo evento de entrada (`term.input`) para garantir a ordem; quando desmarcada, apenas cola e o usuário confirma com `Enter`. O painel fica oculto e é revelado ao encostar o mouse no canto inferior esquerdo.
10. **Áreas de trabalho (abas)** (`index.html`, `src/styles.css`, `src/main.ts`, `src/canvas.ts`, `src/persistence.ts`): abas no cabeçalho, cada uma com terminais, pan e zoom próprios. As sessões permanecem vivas ao trocar de área (os `TerminalWindow` são desanexados/anexados ao mundo, sem matar o PTY); áreas inativas são restauradas sob demanda. Inclui criar (`Ctrl+Shift+T`), fechar (com confirmação), renomear por duplo clique, alternar (`Ctrl+Tab`/`Ctrl+Shift+Tab`) e persistência em `canvas-terminal.workspaces.v1`, com migração do layout antigo (`layout.v1`).
11. **Abas no terminal maximizado** (`src/terminal-window.ts`, `src/styles.css`, `src/canvas.ts`, `src/main.ts`): ao maximizar, o cabeçalho da janela troca o título por abas **agrupadas por área de trabalho**, com os nomes de todos os terminais de todas as áreas (inclusive áreas ainda não abertas, usando o layout salvo). Clicar em uma aba de outra área ativa aquela área, maximiza o terminal escolhido e restaura o maximizado anterior (apenas um maximizado por área). Fora do modo maximizado, o canvas continua na visão normal. As abas se atualizam ao criar/remover/renomear terminais e áreas.
12. **Persistência do perfil completo** (`src/persistence.ts`, `src/main.ts`, `src/terminal-window.ts`): além de geometria, títulos, zoom/pan e área ativa, o perfil agora salva o estado **minimizado** de cada terminal e o **terminal em foco** de cada área. A gravação é garantida em `beforeunload`, `pagehide` e `visibilitychange`, além do debounce normal. O layout antigo é migrado automaticamente.
13. **Correção do fechamento** (`src/main.ts`, `src-tauri/capabilities/default.json`): removido o listener `onCloseRequested` que, se o salvamento lançasse exceção, impedia o Tauri de chamar `destroy()` e deixava a janela presa. O salvamento de fechamento agora é blindado com `try/catch`, o menu **Sair**/`Ctrl+Q` persiste o perfil antes de fechar e tem fallback para `destroy()` após 1,5 s (permissão `core:window:allow-destroy`). Validado fechando a janela pelo WM e por `Ctrl+Q`, com o perfil de áreas/terminais gravado corretamente no `localStorage`.
14. **Cabeçalho no modo maximizado** (`src/main.ts`, `src/canvas.ts`, `src/terminal-window.ts`, `src/styles.css`): não existe mais linha fixa. O auto-hide não abre por hover quando há terminal maximizado; o primeiro item da barra de abas é um botão **☰** que abre/fecha o cabeçalho sob demanda. Enquanto aberto, `canvas.topInset` desloca o terminal 42 px para baixo (e reajusta o xterm), evitando cobrir as abas; `Esc`/clique fora fecham. Também foi adicionado **botão direito → Renomear área de trabalho** nas abas e o `fit()` imediato ao maximizar/trocar de aba, eliminando o efeito de o terminal aparecer primeiro pela metade e só depois em 100%.
15. **Comando automático por terminal** (`src/terminal-window.ts`, `src/persistence.ts`, `src/main.ts`, `src/styles.css`, `index.html`): cada terminal pode salvar um `startupCommand` no perfil. Configurável pelo botão direito no título do terminal ou por **Janela → Comando de inicialização...**, em um diálogo com campo de texto. O comando é enviado ao shell 500 ms após o terminal ser criado/restaurado (inclusive ao reiniciar o terminal e ao restaurar uma área sob demanda) e é executado com Enter. Campo vazio desativa. O valor é migrado com defaults nos perfis antigos.
16. **Reordenação das abas maximizadas** (`src/terminal-window.ts`, `src/main.ts`, `src/styles.css`, `src/persistence.ts`): no modo maximizado, arrastar um nome de terminal reordena as abas dentro do grupo; arrastar o nome da área reordena os grupos. A ordem dos grupos é salva em `tabGroupOrder` (independente do header/canvas) e a ordem dos terminais é salva na própria lista da área. Nada é movido no canvas normal; a mudança aparece somente na faixa de abas maximizada.
17. **Salvar manual com aviso** (`index.html`, `src/main.ts`, `src/styles.css`): adicionado **Arquivo → Salvar** e `Ctrl+S`, que chamam `persist()` + `flushSave()` e mostram um toast verde no canto superior direito (“Perfil salvo com sucesso”) por alguns segundos.
18. **Correção: tela em branco ao trocar de área por uma aba de terminal** (`src/main.ts`): `switchToWorkspace` instancia os terminais da área de destino **antes** de desanexar a atual (sem canvas em branco durante o spawn) e recebe a aba clicada como `focusRef`. O `showWorkspace` anexa a área, aplica a view e **maximiza o terminal alvo imediatamente**, antes de qualquer persistência/etapa posterior; assim o clique sempre abre o terminal escolhido em tela cheia, mesmo que algo falhe depois. Validado com um perfil de teste: A2 maximizado → clique em B1 de área não instanciada → área antiga permanece durante o spawn → B1 abre maximizado imediatamente.
19. **Q/E no modo de navegação** (`src/main.ts`, `index.html`, `README.md`): com o canvas em foco (clique em área vazia) e sem terminal maximizado, `Q` e `E` trocam para a área anterior/seguinte, mantendo o modo de navegação para trocar várias áreas em sequência. Não interfere quando o foco está em um terminal ou campo de texto.
20. **Navegação entre áreas sempre no modo normal** (`src/main.ts`): `activateWorkspace` (abas do cabeçalho, `Ctrl+Tab` e `Q/E`) detecta se a área atual está no modo normal e passa `forceNormal` para a troca. `showWorkspace` restaura qualquer terminal maximizado da área de destino antes de focar, então a área escolhida abre sempre sem maximização quando a navegação começou normal. O clique em aba de terminal dentro do modo maximizado continua maximizando o alvo.
21. **Plugins + plugin "Uso de tokens"** (`index.html`, `src/styles.css`, `src/main.ts`, `src/plugins.ts`, `src/token-usage.ts`, `src-tauri/src/usage.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`): novo menu **Plugins** no cabeçalho com um interruptor por plugin, estado em `localStorage["canvas-terminal.plugins.v1"]`. O primeiro plugin mostra o consumo de tokens do **Claude Code** (`~/.claude/projects/**/*.jsonl`) e do **OpenCode** (SQLite `~/.local/share/opencode/opencode.db`, tabelas `session_message`/`message`, e os JSON de `storage/message` em versões antigas) em duas janelas: **5 h** e **semana** (7 dias), com previsão de liberação de cada janela e barra de composição entrada/saída/cache. A leitura é 100% local, com cache por (mtime, tamanho) dos transcripts e `busy_timeout` no SQLite (o banco do OpenCode pode estar aberto). O widget fica no canto inferior direito, escondido atrás de uma alça e abre/fecha ao clicar nela (mesmo comportamento dos comandos rápidos); atualiza a cada 20 s, ao abrir e ao voltar para a janela. Comando Tauri `usage_report` executa em `spawn_blocking`; testes unitários cobrem os parsers, as janelas e o schema SQLite.
22. **Alça visível nos painéis laterais** (`index.html`, `src/styles.css`, `README.md`): os comandos rápidos ganharam a mesma alça discreta do plugin de tokens — uma pastilha translúcida de 22×60 px na borda esquerda com o ícone `>_`, 55% de opacidade, que acende no hover. A alça do plugin fica espelhada na borda direita. Os painéis passaram a abrir 26 px para dentro (em vez de 14 px) para não cobrir a alça, então ela continua visível e clicável com o painel aberto.
23. **Painéis laterais só por clique** (`src/main.ts`, `src/token-usage.ts`, `README.md`): os comandos rápidos e o uso de tokens deixaram de abrir/fechar por hover. Agora a alça funciona como interruptor: um clique abre, outro clique fecha (com `Enter`/`Espaço` quando a alça está focada). O widget de tokens não aparece mais sozinho ao ativar o plugin — só é revelado pelo clique, e continua atualizando em segundo plano a cada 20 s.
24. **Plugin ClickUp** (`index.html`, `src/styles.css`, `src/main.ts`, `src/plugins.ts`, `src/clickup.ts`, `src-tauri/src/clickup.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`): segundo plugin, com alça própria acima da alça de tokens. Ao ativar, abre o painel para colar o **token pessoal da API**; depois o usuário escolhe **workspace → espaço → pasta → lista** (persistido em `localStorage["canvas-terminal.clickup.v1"]`). A lista mostra ID (`custom_id` quando existir), nome e status colorido; clicar abre uma modal com nome, status, responsáveis, tags, descrição e **imagens anexadas** (anexos `image/*` e imagens em markdown da descrição), com abertura externa via `plugin-opener` e botão **Abrir no ClickUp**. Backend em `reqwest` (rustls, sem OpenSSL) com apenas leitura: `team`, `team/{id}/space`, `space/{id}/folder`, `space/{id}/list`, `folder/{id}/list`, `list/{id}/task` e `task/{id}`; erros da API são traduzidos em mensagens legíveis (token inválido, sem permissão etc.). Painéis de plugins são exclusivos: abrir um fecha o outro. Quatro testes unitários cobrem resumo, detalhe, status em texto simples e detecção de imagens.
25. **Alinhamento do "Uso de tokens" com o medidor oficial do Claude Code** (`src-tauri/src/usage.rs`, `src/token-usage.ts`, `README.md`): o painel somava o `cache_read` ao total e usava janelas móveis, então os valores cresciam muito mais rápido que os limites mostrados pelo Claude Code e o reset semanal aparecia como "renova em minutos". O total agora conta **tokens novos** (entrada + saída + cache escrito + raciocínio) e o cache lido aparece no rodapé, separado. A sessão de 5 h passou a ser um **bloco fixo** ancorado na primeira mensagem (mesma semântica do servidor) e a semana usa o `seven_day.resets_at` de `~/.claude.json` (`cachedUsageUtilization`), rolado em passos de 7 dias para achar a janela atual — sem esse dado, mantém o recorte móvel. Com os dados da máquina, a janela de 5 h caiu de ~9,7 M para ~0,37 M e a semana de ~438 M para ~4,6 M, com o reset semanal correto (segunda-feira) e o de 5 h batendo com o bloco real. Testes novos cobrem bloco de 5 h, sessão encerrada e semana ancorada no reset oficial.


---

## Rodada — painel lateral, editor de áreas e alterações do Git

1. **Painel lateral esquerdo** (`index.html`, `src/styles.css`, `src/main.ts`, `src/workspace-icons.ts`): o cabeçalho fixo e o auto-hide foram removidos. O painel de 62 px concentra, de cima para baixo, o **menu do aplicativo** (antigas categorias Arquivo/Exibir/Janela/Plugins/Ajuda + seletor de shell, tela cheia e zoom/contagem), a lista vertical de **áreas de trabalho**, o botão **+** e o botão de **Git** no rodapé. Cada área aparece como um quadrado arredondado com cor, ícone ou imagem, inicial de fallback e um ponto verde quando tem terminais. O viewport passou a começar em `--rail-w` (62 px).
2. **Menu do aplicativo** (`index.html`, `src/styles.css`, `src/main.ts`): o antigo cabeçalho virou um popover aberto pelo primeiro item do painel (ou pelo **☰** do modo maximizado). As categorias funcionam como acordeão; o menu fecha ao clicar fora, com `Esc` ou ao executar uma ação. No modo maximizado ele abre abaixo da faixa de abas para não cobrir o botão **☰**. O botão de tela cheia e o seletor de shell continuam no rodapé do menu.
3. **Editor de área de trabalho** (`src/main.ts`, `src/styles.css`, `src/persistence.ts`, `src/workspace-icons.ts`): duplo clique no item do painel, botão direito → **Editar área de trabalho** ou **Janela → Editar área atual...** abrem o modal com nome, 8 cores, 26 ícones (incluindo iniciais), imagem (reduzida a 96×96 px e salva como data URL) e pasta. A pasta vale para os novos terminais da área e para o painel do Git; a imagem/ícone substituem a inicial no painel. Os campos novos são validados e persistidos no perfil (`color`, `icon`, `folder`, `image`).
4. **Painel do Git** (`src-tauri/src/git.rs`, `src-tauri/src/lib.rs`, `src/git-panel.ts`, `index.html`, `src/styles.css`): o botão de branch no rodapé abre um modal com repositório, branch, saldo `+`/`−`, lista de arquivos (M/A/D/R/U) e o diff do arquivo escolhido com números de linha e realces. O backend executa apenas `git status`/`git diff` (sem escrita), resolve a raiz do repositório, monta diff sintético para arquivos não rastreados, recusa caminhos fora do repositório e trunca diffs/arquivos muito grandes. No Windows o processo usa `CREATE_NO_WINDOW`. Teste de integração em `src-tauri/tests/git_test.rs` cobre arquivo modificado, não rastreado e caminho inválido.
5. **Zoom global** (`src/main.ts`, `src/persistence.ts`, `src/canvas.ts`): o zoom deixou de ser por área. `SavedWorkspaceLayout.zoom` guarda um único nível; `showWorkspace` aplica o zoom atual ao anexar qualquer área e o modo maximizado usa o mesmo valor. O bug relatado (zoom só valia na área atual, com terminais normais) fica coberto: ao trocar de área o nível é preservado e todos os terminais maximizados usam o mesmo zoom. Layouts antigos herdam o zoom da área ativa.
6. **Coordenadas com o painel** (`src/canvas.ts`, `src/main.ts`): `screenToWorld`/`worldToScreen`, `centerWorldPoint`, `setZoomAtCenter`, zoom no cursor e o menu de contexto passaram a considerar a origem do viewport (62 px), que antes era 0. Sem isso, o zoom com `Ctrl+roda` e o "Novo terminal aqui" ficariam deslocados.
7. **Correção de robustez nos atalhos** (`src/main.ts`): `isTyping`/`isInsideTerminal` só acessam `classList` depois de confirmar `instanceof HTMLElement`. Eventos sintéticos disparados em `document`/`window` (e futuros alvos não-elemento) não quebram mais o handler global.
8. **Verificação de aceite**: além de `npm run build` e `cargo check`, o app foi dirigido por CDP em um Chrome headless com o backend Tauri stubbado: criação de 8 áreas, troca de área, editor (nome/cor/ícone), fechamento com confirmação, menu do app, zoom global (121% preservado ao trocar de área; 133% no maximizado, terminal ocupando exatamente o viewport) e modal do Git (4 arquivos, diff renderizado, `Esc` fecha). Nenhuma exceção no console. `cargo test --test git_test` passou.

---

## Rodada — painel recolhível, seletor de pasta do Git e alinhamento em grade

1. **Painel lateral mais fino e recolhível** (`index.html`, `src/styles.css`, `src/main.ts`): a largura caiu de 62 px para **46 px** (ícones de 34 px, botões de 32 px). Uma alça fina presa à borda direita (`#rail-toggle`, seta para esquerda) recolhe/expande o painel; o viewport, a alça do menu e os painéis flutuantes usam a variável `--rail-w`, que vai a 0 quando recolhido. A preferência fica em `localStorage["canvas-terminal.rail-collapsed.v1"]`.
2. **Recolhimento automático no modo maximizado** (`src/main.ts`, `src/styles.css`): `syncMaximizedView` aplica `rail-collapsed` sempre que há terminal maximizado e esconde a alça; ao restaurar, o painel volta à preferência do usuário. O canvas é re-renderizado/refit para o terminal maximizado ocupar exatamente a largura toda.
3. **Pasta rastreada do Git** (`index.html`, `src/styles.css`, `src/git-panel.ts`, `src-tauri/src/folders.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/git_test.rs`): na primeira abertura do painel o usuário escolhe a pasta num navegador interno (só diretórios, com selo **git** para repositórios, botão de subir e de voltar ao início). A escolha é persistida em `localStorage["canvas-terminal.git-folder.v1"]` e usada em todas as aberturas seguintes; o ícone de pasta no cabeçalho troca a pasta quando quiser. O backend `list_folders` resolve `~`, canonicaliza o caminho, ignora ocultos e devolve pai/home. Se a pasta não for um repositório, o erro permite escolher outra. `Esc` fecha primeiro o seletor e depois o modal. Teste de integração cobre listagem, selo de repositório e caminho inválido.
4. **Alinhamento em grade** (`src/snapping.ts`, `src/canvas.ts`, `src/terminal-window.ts`, `src/styles.css`): ao arrastar/redimensionar, a janela encaixa nas bordas e nos centros dos outros terminais visíveis (tolerância de 6 px de tela para mover e 5 px para redimensionar) e, no redimensionamento, também em larguras/alturas iguais. Sem vizinho por perto, encaixa discretamente na grade de 32 px. As linhas-guia (azuis, 1 px, full-viewport) são desenhadas num overlay `#viewport` que não captura o mouse e somem ao soltar. Terminais minimizados/maximizados são ignorados como alvo.
5. **Verificação de aceite** (Chrome headless + CDP, backend Tauri stubbado): painel 46 px → recolhido (viewport em 0) → expandido; maximizado recolhe, esconde a alça e o terminal ocupa 1280/1280 px; restaurar devolve o painel. Primeira abertura do Git mostra o seletor, a escolha grava `/home/.../canvas-terminal`, reabrir já mostra o status e o botão de pasta reabre no caminho salvo. Com 3 terminais organizados, arrastar 2 px na horizontal volta ao alinhamento e mostra 3 guias verticais; redimensionar 2 px mantém a largura e mostra as guias. `cargo test --test git_test` passou (2 testes), `npm run build` e `cargo check` sem erros.

---

## Rodada — zoom por área, clique direito fora da barra e ClickUp em modal

1. **Zoom por área de trabalho** (`src/main.ts`, `src/persistence.ts`, `src/canvas.ts`): o zoom voltou a ser salvo em `view.zoom` de cada área (o campo global `layout.zoom` foi removido). `showWorkspace` aplica o zoom da área; áreas novas começam em 100%. Trocar de área restaura o nível de cada uma.
2. **Modo maximizado em 100%** (`src/main.ts`, `src/canvas.ts`): `Canvas.zoomLocked` trava o zoom em 1 enquanto há terminal maximizado (roda, `Ctrl+=/-`, `Ctrl+0` e botões não mudam). Ao maximizar, o zoom normal é preservado em `view.zoom`; ao restaurar, a área volta a ele. `persist` e `switchToWorkspace` detectam o estado maximizado/travado e não sobrescrevem o zoom normal com 100%. A ordem de `updateStatus` foi ajustada para o indicador mostrar 100% no maximizado.
3. **Menu de contexto fora da barra** (`src/main.ts`): `renderContextMenu` limita o `left` à borda direita do painel lateral + 6 px, então **Editar/Fechar área de trabalho** não ficam mais parcialmente atrás da barra.
4. **ClickUp em modal grande** (`index.html`, `src/styles.css`, `src/clickup.ts`): a alça do plugin foi para o **canto superior direito** (`top: 48px`). O painel lateral foi substituído por uma modal de 1120 px com duas colunas: filtros/lista à esquerda (380 px) e detalhe completo à direita (nome, código + copiar, status, lista, responsáveis, entrega, tags, descrição, imagens, comentários e Abrir no ClickUp). Configuração, refresh e fechar ficam no cabeçalho; `Esc`/clique fora fecham. O HTML/CSS antigo do widget e da modal pequena foi removido.
5. **Verificação** (Chrome headless + CDP com API do ClickUp stubbada): área 1 em 121%, área 2 criada em 100% e ajustada para 83%; trocar entre elas restaura 121/83; maximizar mostra 100% (fonte 13 px), trava o zoom e ocupa a largura toda; restaurar volta a 83% (fonte 10,7 px). Perfil salvo com `[1.21, 0.826]`. Menu de contexto em `left=52` com a barra em 46. ClickUp abre em 1120×653 com 2 tarefas, detalhe com descrição e 2 comentários. `npm run build`, `cargo check` e o teste de integração do Git passaram.

---

## Rodada — temas no cabeçalho, plugins no painel lateral e inicialização automática

1. **Cabeçalho de janela com moldura própria** (`index.html`, `src/styles.css`, `src/main.ts`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`): a janela passou a usar `decorations: false` e ganhou uma barra de 40 px com o **menu do aplicativo**, o **nome da área ativa** ao centro, o resumo de **uso de tokens**, o **zoom**, o **seletor de temas**, as **configurações** e os controles **minimizar / maximizar / fechar**. O cabeçalho é uma região de arraste (`data-tauri-drag-region`, duplo clique maximiza). Oito alças invisíveis nas bordas chamam `startResizeDragging`, substituindo o redimensionamento da moldura nativa. O painel lateral e o viewport começam abaixo do cabeçalho; em tela cheia o cabeçalho é ocultado. Permissões novas: `minimize`, `unminimize`, `maximize`, `unmaximize`, `toggle-maximize`, `is-maximized`, `start-dragging` e `start-resize-dragging`.
2. **Oito temas completos** (`src/theme.ts`, `src/styles.css`, `index.html`): Catppuccin **Latte/Frappé/Macchiato/Mocha**, **One Light/One Dark** e **Apple Light/Apple Dark**. Cada tema define as variáveis CSS da interface e a paleta ANSI do xterm.js. O tema é aplicado por `data-theme` + `data-theme-mode` (`light`/`dark`) e persiste em `localStorage["canvas-terminal.theme.v1"]`; valores antigos `dark`/`light` são migrados para `one-dark`/`one-light`. Sem escolha, segue o sistema. O script inline do `<head>` resolve o tema antes da primeira pintura.
3. **Seletor de temas no cabeçalho** (`index.html`, `src/styles.css`, `src/main.ts`): o item de tema saiu do menu **Exibir**. O ícone de paleta abre um popover com os grupos Catppuccin/One/Apple, marca o tema ativo e traz **Obter mais temas...** (abre **Configurações → Aparência**). `Ctrl+Shift+L` abre o mesmo seletor. A aba **Aparência** das configurações mostra amostras de cor clicáveis.
4. **Configurações com inicialização automática** (`index.html`, `src/styles.css`, `src/main.ts`, `src/autostart.ts`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`): novo modal de configurações com as abas **Geral**, **Aparência** e **Atalhos** (além do atalho `Ctrl+,`). A aba Geral traz o interruptor **Abrir o Canvas Terminal ao iniciar a sessão**, ligado ao plugin oficial `tauri-plugin-autostart` 2.7 (`autostart:default`). No navegador a preferência é simulada em `localStorage`. O estado é consultado ao abrir a tela e o interruptor fica bloqueado enquanto a operação está em andamento.
5. **Uso de tokens em modal** (`index.html`, `src/styles.css`, `src/token-usage.ts`): o painel flutuante da direita virou um **modal** com os agentes lado a lado, barras de composição, reset e cache lido. O acesso é o novo botão do rodapé do painel lateral (acima do ClickUp e do Git) ou o resumo clicável do cabeçalho (`Claude 5h … 7d … | OpenCode …`). O resumo só aparece com o plugin ligado e dados carregados. O modal fecha com `Esc`, `×` ou clique fora e é exclusivo com o ClickUp.
6. **ClickUp no rodapé do painel** (`index.html`, `src/styles.css`, `src/clickup.ts`): a alça do canto superior direito foi removida; o botão agora fica **acima do Git**, abaixo do uso de tokens, com cor rosa quando o plugin está ligado. O modal não abre mais sozinho ao iniciar o app — só pelo botão (ou pelo menu Plugins, que apenas liga/desliga). Botões de plugin desligado ficam esmaecidos e o primeiro clique ativa + abre o modal.
7. **Verificação com o app real (Tauri/WebKitGTK em X11)**: tema One Light e Catppuccin Mocha aplicados na interface e no xterm; menu de temas com os três grupos e marcação do ativo; modal de uso de tokens com Claude/OpenCode; ClickUp aberto pelo botão do rodapé; configurações nas abas Geral e Aparência; interruptor de autostart criou/removeu `~/.config/autostart/Canvas Terminal.desktop`; o botão de maximizar restaurou a janela maximizada para o tamanho normal (1600 px de largura). `npm run build`, `cargo check` e `cargo test` passaram sem erros.

---

## Rodada — preferências centralizadas nas configurações

1. **Menu do aplicativo enxugado** (`index.html`, `src/main.ts`, `src/styles.css`): as categorias **Plugins** e **Ajuda** foram removidas; restaram **Arquivo**, **Exibir** e **Janela**, com apenas ações (novo/fechar terminal, salvar, sair, áreas de trabalho, zoom, centralizar, tela cheia, maximizar/minimizar e comando de inicialização). O seletor de shell saiu do rodapé do menu.
2. **Nova aba Terminal** (`src/main.ts`, `src/styles.css`, `index.html`): o shell padrão agora é escolhido em **Configurações → Terminal**, com a lista de shells detectados e o caminho do shell atual. A escolha é persistida em `localStorage["canvas-terminal.shell.v1"]`; sem escolha, mantém o fallback do backend. O menu não exibe mais o seletor nem a duplicata do indicador de zoom (o zoom fica só no cabeçalho).
3. **Nova aba Plugins** (`src/main.ts`, `index.html`, `src/styles.css`): os interruptores de **Uso de tokens** e **ClickUp** foram movidos do menu para as configurações, com nome, descrição, estado e o mesmo visual de switch. As linhas atualizam `aria-checked` em tempo real; ligar/desligar continua aplicando o estado no painel lateral e nos modais.
4. **Atalhos e Sobre** (`src/main.ts`, `index.html`): a tabela de atalhos deixou de ser um diálogo de Ajuda e virou a aba **Atalhos**; o antigo “Sobre” virou a aba **Sobre** (versão, licença e persistência). O menu **Ajuda** foi removido por completo.
5. **Configurações em seis abas** (`index.html`, `src/main.ts`): **Geral**, **Aparência**, **Terminal**, **Plugins**, **Atalhos** e **Sobre**, com grupos “Aplicativo” e “Suporte” na barra lateral. A navegação por `Esc`, clique fora e `Ctrl+,` continua; o modal de autostart e o seletor de temas seguem nas abas Geral e Aparência.
6. **Verificação**: `npm run build` e `cargo check` passaram. O menu agora abre com três categorias; a aba Terminal lista os shells detectados e o shell escolhido; a aba Plugins reflete os estados salvos; a aba Atalhos usa a mesma tabela de antes; a aba Sobre substitui o diálogo.

---

## Rodada — busca, links, sessão restaurável, broadcast e layouts

1. **Busca no terminal** (`src/terminal-search.ts`, `src/terminal-window.ts`, `src/styles.css`, `src/shortcuts.ts`): `@xterm/addon-search` com barra flutuante (`Ctrl+Shift+F`, editável), contador, maiúsculas/regex e realce com cores lidas das variáveis CSS do tema. O `mousedown` da barra não propaga, senão a janela devolvia o foco ao xterm.
2. **Links clicáveis** (`src/terminal-links.ts`, `src-tauri/src/links.rs`): URLs abrem pelo `plugin-opener` com `Ctrl`+clique (`window.open` não funciona no webview) e caminhos de arquivo (`src/x.ts:12:3`, `~/p`, `./a`) viram link só se existirem — conferidos pelo comando `resolve_path` (com cache) e abertos por `open_path`. Testes em `src-tauri/tests/links_test.rs`.
3. **Sessão persistida** (`src/session-store.ts`, `src/persistence.ts`, `src/main.ts`, `src-tauri/src/pty.rs`): cada terminal ganhou `sessionId`; o histórico é serializado com `@xterm/addon-serialize` (sem modos e sem tela alternativa, reduzido até 150 mil caracteres) e guardado à parte do perfil, gravado a cada 20 s e ao salvar/sair/ocultar. Na restauração é escrito antes da saída do novo shell, seguido de reset de modos de mouse/colagem. A pasta atual vem do novo comando `pty_cwd` (`/proc/<pid>/cwd` no Linux) e do OSC 7. Opção em Configurações → Terminal para desligar (apaga o histórico). Teste `pty_cwd_reflete_a_pasta_do_shell`.
4. **Broadcast** (`src/terminal-window.ts`, `src/main.ts`): `Ctrl+Shift+B`; só digitação/colagem/composição do usuário é reenviada (respostas automáticas do xterm, como DA, são filtradas por janela de 40 ms após o evento de entrada); comandos rápidos participam. Borda tracejada, botão por terminal e contador na barra de status; trocar de área desliga.
5. **Layouts** (`src/layouts.ts`, `src/layouts-panel.ts`, `index.html`, `src/styles.css`): cinco modelos prontos e layouts do usuário (frações da caixa envolvente das janelas, com shell/pasta/título/comando opcionais), modal com miniaturas, `Ctrl+Shift+Y` e item no menu Janela. Aplicar reposiciona os terminais existentes e abre os faltantes; nunca fecha nenhum.
6. **README**: novas seções e atalhos; corrigida a menção a `Ctrl+Shift+F` como tela cheia (o código só usa F11).
7. **Verificação**: `npx tsc --noEmit`, `npm run build` e `cargo test` passaram. Chrome headless (Playwright) com backend Tauri stubbado: busca achou `1/1` e fechou com `Esc`; broadcast levou `ls` ao segundo terminal e o contador mostrou 2; layout 2×2 abriu 2 terminais novos (4 no total) e o layout salvo foi gravado; após recarregar, os 4 terminais voltaram com `── sessão anterior ──` e o histórico; links de caminho existentes ganharam o cursor de link ao passar o mouse. Não testado em Tauri real nem no Windows.

## Ajuste — sem histórico em terminais com comando de inicialização

`src/main.ts`: terminais com `startupCommand` não gravam nem restauram histórico (o comando os reconstrói; o quadro antigo de TUIs como o Claude Code só poluía a tela). A pasta continua sendo restaurada, e históricos já salvos desses terminais são descartados no próximo salvamento. README atualizado. `npx tsc --noEmit` e `npm run build` passaram.

## Ajuste — acentos duplicando texto e seletor de temas

1. **Seletor de temas** (`src/main.ts`): removido o item **Obter mais temas...** e o separador dele.
2. **Acentos** (`src/terminal-window.ts`): `guardComposition` esvazia a textarea oculta do xterm 50 ms depois de cada `compositionend` (se não houver nova composição nem tecla no intervalo). O `CompositionHelper` do xterm relê essa textarea e, com resíduo e eventos fora de ordem (IME do WebKitGTK), reenviava o texto anterior. Verificação em Chrome headless com composição simulada via CDP (`´`+á, `~`+ã, `^`+ê intercalados com letras): saída `ola áxãxêx` e textarea vazia. O defeito original depende do IME do WebKitGTK e não foi reproduzido; precisa ser confirmado no app instalado.
