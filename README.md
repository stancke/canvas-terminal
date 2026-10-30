# Canvas Terminal

Aplicativo desktop de **canvas infinito** com terminais reais (PowerShell, cmd, Git Bash, WSL no Windows; bash, zsh, fish, pwsh, sh no Linux), construído com **Tauri 2**, **Vite**, **TypeScript** e **xterm.js**.

O mesmo código-fonte compila tanto no **Windows** quanto no **Linux** (e macOS, com os devidos cuidados de empacotamento).

Catppuccin Mocha com o seletor de temas do cabeçalho aberto:

![Canvas Terminal no tema Catppuccin Mocha](docs/screenshot.png)

Catppuccin Latte:

![Canvas Terminal no tema Catppuccin Latte](docs/screenshot-claro.png)

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

> **Atenção:** o build de release precisa da feature `custom-protocol`, que
> embute o `dist/` no binário. Sem ela, o executável abre em modo dev e mostra
> **"Could not connect to localhost: Connection refused"** ao procurar o Vite em
> `http://localhost:1420`. Use `--features custom-protocol` (ou `npm run tauri
> build`, que já passa a flag).

### Windows

```bash
npm run build
cd src-tauri && cargo build --release --features custom-protocol
```

Para gerar o instalador (NSIS/MSI):

```bash
npm run tauri build
```

Os instaladores ficarão em `src-tauri/target/release/bundle/` (subpastas `nsis/` e `msi/`).

### Linux

```bash
npm run build
cd src-tauri && cargo build --release --features custom-protocol
```

Para gerar os pacotes (`.deb`, `.rpm`, `.AppImage`):

```bash
npm run tauri build
```

Os pacotes ficarão em `src-tauri/target/release/bundle/` (subpastas `deb/`, `rpm/` e `appimage/`).

### Instalação local (Linux, com atalho na área de trabalho)

O script `tools/install.sh` compila, guarda um backup do binário anterior em
`~/.local/bin`, instala a versão nova e (re)cria o atalho da área de trabalho e
o item de menu:

```bash
./tools/install.sh               # build completo + instalação
./tools/install.sh --skip-build  # reaproveita o binário já compilado
./tools/install.sh --no-shortcut # só instala o binário
```

O atalho executa `~/.local/bin/canvas-terminal`, então nas próximas atualizações
basta rodar o script de novo — o caminho não muda. Feche o aplicativo antes de
instalar: o Linux não deixa sobrescrever um binário em execução.

---

## Interface

A interface é organizada por um **cabeçalho de janela** e um **painel lateral
esquerdo**:

- O cabeçalho mostra o **nome da área de trabalho ativa** ao centro e, à
  direita, o resumo de **uso de tokens** (quando o plugin está ligado), o
  **zoom**, o **seletor de temas** (ícone de paleta), as **configurações**
  (engrenagem) e os controles **minimizar / maximizar / fechar**. A janela usa
  moldura própria (`decorations: false`), com alças invisíveis nas bordas para
  redimensionar.
- O **ícone de grade** no canto superior esquerdo do cabeçalho abre o **menu do
  aplicativo**, que reúne as categorias **Arquivo**, **Exibir** e **Janela** — apenas ações
  (novo/fechar terminal, salvar, sair, áreas de trabalho, zoom, tela cheia) —
  além do botão de tela cheia e da contagem de terminais. As **preferências**
  ficam em **Configurações** (ícone de engrenagem no cabeçalho ou `Ctrl+,`).
- Abaixo ficam as **áreas de trabalho** (uma bolinha por área, com cor, ícone ou
  imagem) e o botão **+**. No rodapé estão, de cima para baixo, **Uso de
  tokens**, **ClickUp** e **Git**.
- O painel tem 46 px e pode ser **recolhido/expandido** pela alça discreta na
  borda (uma seta no meio da tela). No modo maximizado ele recolhe sozinho e a
  alça some, deixando o terminal usar toda a largura.

Use **Exibir → Tela cheia** (`F11`) para esconder o cabeçalho, a barra de status
e a barra de tarefas do sistema. O painel lateral continua disponível. Para sair
da tela cheia use **F11**, o botão **⛶** no menu ou o item
**Exibir → Sair da tela cheia**; `Esc` não sai do fullscreen.

O zoom é **por área de trabalho**: cada área guarda o seu próprio nível e ele é
restaurado ao trocar de área. Janelas, barra de título, controles e o texto dos
terminais escalam juntos, sem reflow do conteúdo. No **modo maximizado** cada
terminal (aba) tem o **seu próprio zoom**: use `Ctrl + roda do mouse`,
`Ctrl+=` / `Ctrl+-` ou `Ctrl+0` para ajustar só o terminal que está na tela — o
nível fica salvo no perfil e volta na próxima vez que ele for maximizado. Ao
restaurar, a área volta ao zoom que tinha. Vá de 25% a 300%.

Para navegar sem o mouse, clique em uma área vazia do canvas e use **WASD** ou
as **setas** (segure para pan contínuo). Ainda nesse modo, **Q** e **E** trocam
para a área de trabalho anterior/seguinte. Clicar em um terminal devolve o foco
ao shell.

---

## Áreas de trabalho (painel lateral)

Cada item do painel lateral é uma **área de trabalho independente**: cada uma
tem seus próprios terminais e posição no canvas. O zoom é compartilhado por
todas. As sessões continuam vivas ao trocar de área.

- **+** cria uma nova área com um terminal no centro.
- Clique em um item para trocar de área.
- **Arraste um item para cima ou para baixo** para mudar a ordem das áreas no
  painel; a ordem fica salva no perfil e vale ao reabrir o app. O arrasto não
  abre a área: só o clique (sem mover) troca de área.
- **Duplo clique** no item (ou **botão direito → Editar área de trabalho**)
  abre o editor com **nome, cor, ícone, imagem e pasta**. A imagem e o ícone
  substituem a inicial da área no painel; a pasta vale para os novos terminais
  desta área (o painel do Git tem uma pasta própria, escolhida nele).
- **Botão direito → Fechar área de trabalho** encerra a área (com confirmação
  se houver terminais).
- `Ctrl+Shift+T` cria uma área; `Ctrl+Tab` e `Ctrl+Shift+Tab` alternam.
- O menu **Janela** traz essas ações, incluindo **Editar área atual...**.

Ao trocar de área pelo painel, por `Ctrl+Tab` ou por **Q/E** enquanto você
está no modo normal (sem terminal maximizado), a área escolhida abre **sempre
no modo normal**: se ela tinha um terminal maximizado salvo, ele é restaurado
para o tamanho normal. O modo maximizado só é acionado quando você clica em uma
aba de terminal dentro da faixa maximizada.

No modo maximizado, **arraste os nomes dos terminais** para reordená-los dentro
do grupo, ou **arraste o nome da área** para mover o grupo inteiro para a
esquerda/direita. A ordem fica salva no perfil e afeta apenas a faixa de abas
maximizada — as janelas do canvas e a ordem dos itens do painel lateral não
mudam.

Quando um terminal está **maximizado**, o cabeçalho dele vira uma barra de abas
**agrupada por área de trabalho**. Cada grupo mostra os terminais daquela área;
clique em qualquer nome para trocar de área e maximizar aquele terminal, mesmo
que ele esteja em outra área (inclusive uma que ainda não tinha sido aberta nesta
sessão). Fora do modo maximizado, a visão normal do canvas é mantida.

No modo maximizado, o primeiro item antes das abas é o botão **☰**, que
abre/fecha o menu do aplicativo por cima do terminal. `Esc` ou um clique fora
também fecham o menu.

Ao fechar o aplicativo, o perfil completo é salvo automaticamente: áreas,
nomes, cores, ícones, imagens, pastas, posição, tamanho, estado
minimizado/maximizado, zoom, pan, terminal em foco e qual área estava ativa. Ao
abrir novamente, tudo volta como estava.

---

## Terminais remotos (SSH)

Clique com o **botão direito no canvas** → **Novo terminal remoto (SSH)...**,
escolha uma conexão salva ou preencha servidor, porta, usuário e, se quiser,
**senha** (ou frase-senha da chave) e o **caminho da chave privada**. O terminal
abre já conectado.

- **Ao abrir o app**, terminais remotos restaurados **não conectam sozinhos**:
  exibem um botão grande **Conectar** no centro, que mostra **Conectando…** até
  o servidor responder. Enter no terminal também conecta.
- Quando a conexão cai ou o `exit` é digitado, o botão **Conectar** volta na
  mesma janela, com o motivo do encerramento.
- Botão direito no título do terminal remoto → **Editar conexão SSH...** e
  **Reconectar** (aplica a conexão editada).
- **Configurações → Conexões SSH** lista, adiciona, edita e remove conexões.

O app usa o cliente `ssh` do sistema (OpenSSH; no Windows, o OpenSSH nativo),
então `~/.ssh/config`, `known_hosts` e o agente continuam valendo. Sem senha, o
`ssh` pergunta no próprio terminal. Com senha salva, o app a entrega como
`SSH_ASKPASS` (requer OpenSSH 8.4+), aceita automaticamente a chave de um host
**novo** e continua recusando chave de host alterada. A senha fica no
`localStorage` deste computador, como os tokens das integrações.

---

## Comando automático por terminal

Cada terminal pode ter um comando de inicialização. Para configurar:

- clique com o **botão direito no título do terminal** → **Comando de
  inicialização...**; ou
- use **Janela → Comando de inicialização...** com o terminal em foco.

O diálogo tem a opção **Executar automaticamente ao abrir o terminal**:

- **marcada** (padrão): o comando roda cerca de meio segundo depois que o shell
  sobe, tanto ao iniciar o aplicativo quanto ao reiniciar o terminal;
- **desmarcada**: nada roda sozinho. O terminal mostra o mesmo overlay do botão
  **Conectar** — fundo esmaecido, o comando como label e um botão grande
  **Executar**. Ao clicar, o comando é enviado ao shell com Enter e o overlay
  desaparece. Nos terminais SSH ele só aparece depois de conectar.

Deixe o campo vazio para desativar. Terminais de áreas que ainda não foram
abertas seguem essa configuração quando a área é restaurada, e o modo manual
também é preservado nos layouts salvos.

---

## Comandos rápidos

O painel translúcido no canto inferior esquerdo guarda seus comandos favoritos.
Ele fica **oculto** atrás de uma alça discreta na borda esquerda (ícone `>_`) e
abre/fecha ao clicar nela (sem hover). Clique em **+**, dê um nome (opcional) e
informe o comando. Marque **Executar depois de colar** se quiser que o `Enter`
seja enviado automaticamente; sem a marca, o comando é apenas colado no terminal
em foco para você confirmar.

- O painel pode ser recolhido pelo botão `▾` (o estado é lembrado).
- Comandos marcados para executar exibem um `↵` na lista.
- Clique no lápis **✎** para editar: o formulário abre preenchido e o botão
  passa a ser **Atualizar**.
- Para remover um comando, clique em `×`.
- Os comandos ficam salvos em `localStorage["canvas-terminal.quick-commands.v1"]`.
- Em tela cheia o painel continua disponível no mesmo canto.

---

## Busca, links, sessão, broadcast e layouts

### Busca no terminal

`Ctrl+Shift+F` (ou **Janela → Buscar no terminal**) abre uma barra sobre o
terminal em foco. Digite para destacar as ocorrências (contador `n/total`);
`Enter` vai para a próxima, `Shift+Enter` para a anterior, `Esc` fecha. Os
botões **Aa** e **.\*** alternam maiúsculas/minúsculas e expressão regular. Se
houver texto selecionado, ele vira o termo inicial. A busca varre o histórico
inteiro do terminal, não só a parte visível.

### Links clicáveis

`Ctrl`+clique (ou `Cmd`+clique) abre:

- **URLs** (`http://`, `https://`) no navegador padrão;
- **caminhos de arquivo** exibidos na saída (`src/main.ts:42:7`, `./README.md`,
  `~/projeto`) no aplicativo padrão do sistema. Só viram link os caminhos que
  existem; os relativos são resolvidos a partir da pasta atual do terminal. O
  número da linha é ignorado ao abrir.

### Persistir e restaurar a sessão

Ao reabrir o app, cada terminal volta **na pasta em que estava** e mostra o
**histórico da sessão anterior** (até 1000 linhas por terminal), separado da
nova saída por `── sessão anterior ──`. Os processos em execução não são
retomados: cada terminal abre um shell novo.
- Terminais com **comando de inicialização** (ex.: `claude --continue`) não
  restauram histórico — só a pasta —, porque o comando já os reconstrói.

- A pasta atual vem de `/proc/<pid>/cwd` no Linux e do OSC 7 (`file://`)
  enviado pelo shell nas demais plataformas.
- O histórico é gravado a cada 20 s, ao salvar (`Ctrl+S`), ao sair e ao ocultar
  a janela, em `localStorage["canvas-terminal.scrollback.v1"]`. TUIs (tela
  alternativa) não são gravadas.
- Como o histórico pode conter dados sensíveis, dá para desligar em
  **Configurações → Terminal → Restaurar histórico dos terminais** (desligar
  apaga o que estava salvo).

### Broadcast de entrada

`Ctrl+Shift+B` (ou **Janela → Transmitir entrada**) liga a transmissão na área
atual (precisa de ao menos dois terminais). Tudo que você digitar ou colar num
terminal participante vai também aos demais, inclusive os comandos rápidos.
Participantes ficam com borda tracejada e um ícone de antena na barra de título,
que inclui/exclui o terminal; a barra de status mostra quantos recebem. Trocar
de área desliga a transmissão.

### Layouts

`Ctrl+Shift+Y` (ou **Janela → Layouts...**) abre os arranjos de terminais:

- **Modelos**: lado a lado, empilhado, três colunas, principal + 2 e grade 2×2.
- **Meus layouts**: **Salvar o arranjo atual** guarda posição e tamanho
  (proporcionais) de todas as janelas da área e, opcionalmente, shell, pasta e
  comando de inicialização de cada uma. Salvos em
  `localStorage["canvas-terminal.layouts.v1"]`.

Aplicar um layout reposiciona os terminais abertos (na ordem em que existem) e
abre os que faltarem. Nenhum terminal é fechado.

---

## Alinhamento em grade

Ao **arrastar** ou **redimensionar** um terminal, o app calcula encaixes com os
outros terminais visíveis e desenha linhas-guia azuis no canvas:

- bordas esquerdas, direitas, superiores e inferiores;
- centros horizontais e verticais;
- larguras/alturas iguais (no redimensionamento);
- na falta de um vizinho nas proximidades, encaixe discreto na grade de 32 px.

Os encaixes valem para as bordas e para o centro, então dá para alinhar dois
terminais lado a lado com a mesma altura, empilhar colunas com a mesma largura
ou centralizar uma janela em relação à outra. As guias somem ao soltar o mouse.

---

## Alterações do Git

O botão de **branch** no rodapé do painel lateral abre a aba de source control
do app. Na **primeira abertura** ele pede a pasta que deve ser acompanhada:
escolha navegando pelas pastas (repositórios aparecem com o selo **git**) e
clique em **Usar esta pasta**. A escolha fica gravada em
`localStorage["canvas-terminal.git-folder.v1"]` e é usada em todas as aberturas
seguintes, independentemente da área de trabalho ativa.

- O ícone de pasta no cabeçalho do modal permite **trocar a pasta** a qualquer
  momento; se a pasta salva sumir ou não for um repositório, o erro oferece
  **Escolher outra pasta...**.
- O modal mostra o repositório, a branch atual, o total de arquivos e o saldo
  de linhas (`+`/`−`).
- À esquerda ficam os arquivos alterados com o status do `git status`
  (**M** modificado, **A** adicionado, **D** removido, **R** renomeado, **U**
  não rastreado).
- Ao clicar em um arquivo, o diff aparece à direita com números de linha,
  trechos verdes/vermelhos e os cabeçalhos de hunk.
- O botão `⟳` recarrega o status (ou a lista de pastas, enquanto o seletor está
  aberto); `Esc` fecha primeiro o seletor e depois o modal; o **×** ou um clique
  fora fecham direto.
- A leitura é somente local, feita pelo backend (`git status`/`git diff`), sem
  enviar nada para a rede. Arquivos novos recebem um diff sintético; diffs muito
  grandes são truncados.

---

## Plugins

A aba **Configurações → Plugins** lista os plugins disponíveis, cada um com um
interruptor. O estado fica em `localStorage["canvas-terminal.plugins.v1"]` e é
lembrado entre execuções.

### Uso de tokens

Primeiro plugin do app. O botão fica no rodapé do painel lateral, **acima do
ClickUp e do Git**, e abre um **modal** com o consumo de tokens dos agentes
instalados na máquina. Um resumo compacto também aparece no cabeçalho da janela
(`Claude 5h … 7d … | OpenCode …`). Quando o plugin está desligado, o botão fica
esmaecido; o primeiro clique ativa o plugin e abre o modal.

- **Claude Code** — lê os transcripts em `~/.claude/projects/**/*.jsonl`
  (`message.usage` de cada resposta do assistente).
- **OpenCode** — lê o banco `~/.local/share/opencode/opencode.db`
  (tabelas `session_message`/`message`) e, em versões antigas, os JSON em
  `~/.local/share/opencode/storage/message/**`.
- Dois recortes por agente: **janela de 5 h** (a sessão do Claude Code) e
  **semana**, com a previsão de quando cada janela se libera.
  - No Claude Code a janela de 5 h é um **bloco fixo** que começa na primeira
    mensagem depois do bloco anterior (mesma lógica do servidor), em vez de um
    recorte móvel — assim o horário de reset bate com o `/usage`.
  - A semana usa o **reset oficial da conta** gravado em `~/.claude.json`
    (`cachedUsageUtilization`), rolado em passos de 7 dias. Sem esse dado, cai
    no recorte móvel de 7 dias.
- O número grande conta **tokens novos** (entrada + saída + cache escrito +
  raciocínio). O **cache lido** aparece no rodapé: ele é a releitura do mesmo
  contexto e costuma dominar o volume bruto (>95%), mas não acompanha o
  consumo real da janela.
- A barra fina mostra a composição do total: entrada, saída, cache escrito e
  raciocínio.
- O modal fecha com `Esc`, pelo **×** ou com um clique fora; abrir o ClickUp
  fecha o uso de tokens e vice-versa.
- Atualiza a cada 20 s, ao abrir o modal e ao voltar para a janela.

Nada é enviado para fora da máquina: a leitura é somente dos arquivos locais
dos próprios agentes. O botão `⟳` força uma atualização imediata.

### ClickUp

Lista as tarefas de uma lista do ClickUp em uma **modal grande** (semelhante à
de alterações do Git), com o botão de acesso no **rodapé do painel lateral**,
entre o uso de tokens e o Git.

1. Ative o plugin em **Configurações → Plugins → ClickUp** ou clique no botão
   do ClickUp. A modal abre pedindo o **token pessoal da API** (ClickUp →
   Configurações → Apps → API Token).
2. Escolha **workspace → espaço → pasta (opcional) → lista** e clique em
   **Usar esta lista**. A engrenagem `⚙` reabre essa seleção a qualquer momento.
3. A coluna da esquerda traz os **filtros** (atribuídas a mim, status) e a
   lista com **ID**, **nome** e **status**. A coluna da direita mostra o
   detalhe completo do ticket: nome, código com **Copiar código**, status,
   lista, responsáveis, entrega, tags, descrição, **imagens anexadas**,
   **comentários** e o botão **Abrir no ClickUp**.
4. O botão `⟳` atualiza a lista (as tarefas ficam em cache por 30 s). `Esc`, o
   **×** ou um clique fora fecham a modal.

O token é guardado no `localStorage` do app (`canvas-terminal.clickup.v1`) e só
é enviado para `api.clickup.com`. O backend (`src-tauri/src/clickup.rs`) usa
`reqwest` com TLS embutido e expõe apenas os endpoints de leitura
(`team`, `space`, `folder`, `list`, `task`).

---

## Atalhos

| Atalho | Ação |
|--------|------|
| `Ctrl+T` (ou `Cmd+T`) | Novo terminal no centro do viewport |
| `Ctrl+S` (ou `Cmd+S`) | Salvar o perfil completo imediatamente |
| `Ctrl+Shift+T` | Nova área de trabalho |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Próxima / área de trabalho anterior |
| `Ctrl+Q` (ou `Cmd+Q`) | Sair do aplicativo |
| `Ctrl+Shift+W` (ou `Cmd+Shift+W`) | Fechar terminal em foco (funciona com o terminal focado) |
| `Ctrl+W` com o terminal em foco | Vai para o shell (apaga a palavra anterior); fora dele, fecha o terminal |
| `Ctrl+PageDown` / `Ctrl+PageUp` | Ciclar foco entre terminais |
| `Ctrl+0` (ou `Cmd+0`) | Resetar zoom do terminal maximizado ou, fora dele, da área (100%, ancorado no centro) |
| `Ctrl+=` / `Ctrl+-` | Aumentar / diminuir o zoom do terminal maximizado ou da área |
| `F11` | Alternar tela cheia (só sai por aqui ou pelo menu) |
| `Ctrl+Shift+F` | Buscar no terminal em foco |
| `Ctrl+Shift+B` | Ligar/desligar a transmissão de entrada (broadcast) |
| `Ctrl+Shift+Y` | Abrir os layouts |
| `Esc` | Fechar menu, modal ou diálogo |
| `Ctrl+,` (ou `Cmd+,`) | Abrir as configurações |
| `Ctrl+Shift+L` (ou `Cmd+Shift+L`) | Abrir o seletor de temas |
| `Ctrl+Shift+V` / `Ctrl+V` (ou `Cmd+Shift+V` / `Cmd+V`) | Colar no terminal |
| `Ctrl+C` (ou `Cmd+C`) com seleção | Copiar do terminal |
| `F2` | Renomear título do terminal |
| `Espaço + arrastar` | Pan do canvas |
| `Botão do meio` / `botão direito` | Pan do canvas |
| `WASD` / setas | Navegar no canvas (clique antes em uma área vazia) |
| `Q` / `E` | Trocar para a área de trabalho anterior/seguinte (modo navegação) |
| `Ctrl + roda do mouse` | Zoom no cursor (maximizado: zoom do terminal em foco) |
| `Shift + roda do mouse` | Pan horizontal |

---

## Temas

O app tem **oito temas completos**, agrupados no seletor do cabeçalho:

- **Catppuccin**: Latte, Frappé, Macchiato e Mocha;
- **One**: One Light e One Dark;
- **Apple**: Apple Light e Apple Dark.

Clique no **ícone de paleta** no canto superior direito (ou use
`Ctrl+Shift+L`) para abrir o menu, ou abra **Configurações → Aparência** para ver
as amostras lado a lado. A troca é imediata e muda **interface + paleta ANSI do
xterm.js** (a paleta é reaplicada nos terminais já abertos).

Sem escolha explícita, o app **segue o tema do sistema operacional**
(`prefers-color-scheme`); a escolha manual é lembrada em:

```
localStorage["canvas-terminal.theme.v1"]
```

As cores da interface ficam em variáveis CSS em `src/styles.css`, uma por
`data-theme`; as paletas do terminal estão em `src/theme.ts`. Os valores antigos
`dark`/`light` são migrados para `one-dark`/`one-light`. A janela usa moldura
própria (`decorations: false`), então o cabeçalho também desenha os controles de
minimizar, maximizar e fechar.

O terminal também **responde às consultas de paleta** (OSC 4/10/11/12), à
consulta de esquema claro/escuro (`CSI ? 996 n`) e **avisa mudanças de esquema
de cores** (modo 2031) em `src/osc-colors.ts`. Assim TUIs que derivam as cores
do terminal — como o OpenCode com `theme.name: "system"` — acompanham o tema
escolhido no app, inclusive ao trocá-lo com o terminal aberto, em vez de usar um
tema próprio fixo.

**Limitação no Windows**: o ConPTY não entrega ao TUI (em modo *raw*) as
respostas que o emulador escreve de volta no terminal. Com isso um programa que
pergunta "qual é a cor de fundo?" nunca recebe a resposta e cai no próprio
padrão. No Linux o PTY é real, a resposta chega e o tema `system` funciona.
Por isso a recomendação é `theme.name: "system"` no Linux e um tema embutido
(`kanagawa`, `opencode`…) com `mode: "system"` no Windows. O tema escolhido
também fica gravado em `~/.local/state/opencode/kv.json`, que sobrepõe o
`cli.json` — ao trocar de tema, ajuste os dois.

## Inicialização automática

Em **Configurações → Geral** há a opção **Abrir o Canvas Terminal ao iniciar a
sessão**. No app instalado ela usa o plugin oficial `tauri-plugin-autostart`
(Windows: entrada de inicialização; Linux: `~/.config/autostart/`; macOS:
LaunchAgent). No modo navegador a preferência é apenas simulada em
`localStorage`, para a tela continuar navegável.

## Configurações

O modal é aberto pelo ícone de engrenagem do cabeçalho, por **Exibir →
Configurações...** ou com `Ctrl+,`. As abas reúnem as preferências que antes
ficavam espalhadas pelo menu:

- **Geral** — inicialização automática.
- **Aparência** — os oito temas, com prévia de cores.
- **Terminal** — **shell padrão** dos novos terminais (antes no rodapé do menu).
  A escolha é lembrada em `localStorage["canvas-terminal.shell.v1"]`.
- **Plugins** — ativação do uso de tokens e do ClickUp (antes no menu Plugins).
- **Atalhos** — a tabela de atalhos (antes em Ajuda).
- **Sobre** — versão, licença e informações de persistência (antes em Ajuda).

O menu do aplicativo ficou apenas com as **ações**: Arquivo (novo/fechar
terminal, salvar, sair), Exibir (configurações, zoom, centralizar, tela cheia) e
Janela (áreas de trabalho, organização, maximizar/minimizar, comando de
inicialização).

---

## Preferências

O perfil de todas as áreas de trabalho (nomes, cores, ícones, imagens, pastas,
terminais, posição, tamanho, estado minimizado/maximizado, zoom, pan, foco e
área ativa) é salvo automaticamente em:

```
localStorage["canvas-terminal.workspaces.v1"]
```

Use **Arquivo → Salvar** ou `Ctrl+S` para gravar imediatamente; ao concluir,
aparece um aviso verde no canto superior direito. A ordem das abas maximizadas
também faz parte do perfil.

O zoom é salvo por área dentro de `view.zoom`. No modo maximizado o app exibe
100% sem sobrescrever esse valor: ao restaurar, a área volta ao zoom normal.

Preferências independentes do perfil:

- `localStorage["canvas-terminal.rail-collapsed.v1"]` — painel lateral
  recolhido (`1`) ou expandido (`0`); o modo maximizado recolhe sempre.
- `localStorage["canvas-terminal.git-folder.v1"]` — pasta rastreada pelo painel
  do Git.
- `localStorage["canvas-terminal.theme.v1"]` — tema escolhido no cabeçalho.
- `localStorage["canvas-terminal.scrollback.v1"]` — histórico dos terminais por
  sessão; `canvas-terminal.restore-history.v1` liga/desliga a restauração.
- `localStorage["canvas-terminal.layouts.v1"]` — layouts salvos pelo usuário.
- `localStorage["canvas-terminal.plugins.v1"]` — plugins ligados/desligados.
- `localStorage["canvas-terminal.shell.v1"]` — shell padrão dos novos terminais.
- Inicialização automática — estado do sistema operacional
  (`~/.config/autostart/` no Linux); no navegador, simulado em
  `localStorage["canvas-terminal.autostart.v1"]`.

O layout antigo de área única (`canvas-terminal.layout.v1`) é migrado
automaticamente para a primeira área na primeira execução desta versão.

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

Escolha o shell padrão em **Configurações → Terminal**; a escolha fica em
`localStorage["canvas-terminal.shell.v1"]`. Sem escolha explícita, o backend
usa `$SHELL` (se válido) → `bash` → `zsh` → `sh`.

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
- `src/osc-colors.ts` — respostas às consultas de cor do terminal (OSC 4/10/11/12) e aviso de troca de tema (modo 2031)
- `src/shortcuts.ts` — atalhos editáveis e persistência das combinações
- `src/pty.ts` — wrapper do backend Tauri
- `src/persistence.ts` — salvamento de layout
- `src/workspace-icons.ts` — ícones e cores das áreas de trabalho
- `src/snapping.ts` — encaixes e linhas-guia de alinhamento
- `src/git-panel.ts` — modal de alterações do Git e seletor de pasta
- `src/token-usage.ts` — modal e resumo de uso de tokens
- `src/clickup.ts` — modal e configuração do ClickUp
- `src/theme.ts` — registro dos temas, paletas do xterm.js e persistência
- `src/autostart.ts` — ponte para o plugin de inicialização automática
- `src/styles.css` — variáveis dos oito temas e cromo da interface
- `src-tauri/src/shells.rs` — descoberta de shells por plataforma (`#[cfg(windows)]` / `#[cfg(unix)]`)
- `src-tauri/src/pty.rs` — backend PTY com `portable-pty`
- `src-tauri/src/git.rs` — status e diffs do Git para o painel lateral
- `src-tauri/src/folders.rs` — navegação de pastas do seletor do Git
- `src-tauri/tests/pty_test.rs` — teste de integração headless
- `tools/limpar-conhosts-orfaos.ps1` — limpeza de hospedeiros ConPTY órfãos (Windows)
- `tools/install.sh` — build + instalação local com atalho (Linux)

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

