#!/usr/bin/env bash
#
# Compila e instala o Canvas Terminal no Linux, atualizando o atalho da área de
# trabalho e o item de menu para a versão recém-compilada.
#
# Uso:
#   ./tools/install.sh                 # build completo + instalação
#   ./tools/install.sh --skip-build    # reaproveita o binário já compilado
#   ./tools/install.sh --no-shortcut   # instala só o binário, sem atalhos
#   ./tools/install.sh --keep-backups  # mantém todos os backups antigos
#
# O build usa a feature `custom-protocol`: sem ela o binário abre em modo dev e
# tenta carregar a UI de http://localhost:1420 (erro "Connection refused").
set -euo pipefail

APP_ID="canvas-terminal"
APP_NAME="Canvas Terminal"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
BIN_TARGET="$BIN_DIR/$APP_ID"
BUILT_BIN="$ROOT/src-tauri/target/release/$APP_ID"

SKIP_BUILD=0
NO_SHORTCUT=0
KEEP_BACKUPS=0

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --no-shortcut) NO_SHORTCUT=1 ;;
    --keep-backups) KEEP_BACKUPS=1 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $arg (use --help)" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

version() {
  sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/src-tauri/tauri.conf.json" | head -n 1
}

# --- 1. Build ---------------------------------------------------------------

if [ "$SKIP_BUILD" -eq 0 ]; then
  command -v npm >/dev/null || die "npm não encontrado no PATH."
  command -v cargo >/dev/null || die "cargo não encontrado no PATH."

  info "Frontend: npm run build"
  (cd "$ROOT" && npm run build)

  info "Backend: cargo build --release --features custom-protocol"
  (cd "$ROOT/src-tauri" && cargo build --release --features custom-protocol)
fi

[ -x "$BUILT_BIN" ] || die "Binário não encontrado em $BUILT_BIN (rode sem --skip-build)."

# --- 2. Instalação do binário ------------------------------------------------

# O kernel recusa sobrescrever um executável em uso (ETXTBSY).
# Compara o binário real de cada processo (readlink /proc/<pid>/exe) para não
# confundir com outra instalação aberta em paralelo.
app_running() {
  local pid exe
  for pid in $(pgrep -x "$APP_ID" || true); do
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    [ "$exe" = "$BIN_TARGET" ] && return 0
  done
  return 1
}

if app_running; then
  die "O Canvas Terminal está aberto. Feche o aplicativo e rode o script de novo."
fi

mkdir -p "$BIN_DIR"

if [ -e "$BIN_TARGET" ]; then
  backup="$BIN_TARGET.bak-$(date +%Y%m%d-%H%M)"
  info "Backup do binário atual: $(basename "$backup")"
  cp -p "$BIN_TARGET" "$backup"

  if [ "$KEEP_BACKUPS" -eq 0 ]; then
    # Mantém apenas os 5 backups mais recentes.
    ls -1t "$BIN_TARGET".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
  fi
fi

info "Instalando em $BIN_TARGET"
install -m 755 "$BUILT_BIN" "$BIN_TARGET"

# --- 3. Atalhos -------------------------------------------------------------

desktop_dir() {
  local dir=""
  if command -v xdg-user-dir >/dev/null 2>&1; then
    dir="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  fi
  if [ -z "$dir" ] || [ "$dir" = "$HOME" ]; then
    for candidate in "$HOME/Desktop" "$HOME/Área de Trabalho"; do
      if [ -d "$candidate" ]; then dir="$candidate"; break; fi
    done
  fi
  [ -n "$dir" ] && [ -d "$dir" ] && printf '%s\n' "$dir"
}

write_desktop_entry() {
  local target="$1"
  cat > "$target" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
Name[pt_BR]=$APP_NAME
GenericName=Infinite Canvas Terminal
Comment=Canvas infinito com terminais reais (bash, zsh, fish, pwsh, sh)
Comment[pt_BR]=Canvas infinito com terminais reais (bash, zsh, fish, pwsh, sh)
Exec=$BIN_TARGET
TryExec=$BIN_TARGET
Path=$HOME
Icon=$APP_ID
Terminal=false
Categories=Development;
Keywords=terminal;shell;canvas;xterm;bash;zsh;console;
StartupNotify=true
StartupWMClass=$APP_ID
EOF
  chmod 755 "$target"
}

refresh_caches() {
  command -v desktop-file-validate >/dev/null 2>&1 && desktop-file-validate "$1" || true
  command -v gio >/dev/null 2>&1 && gio set "$1" metadata::trusted true 2>/dev/null || true
}

if [ "$NO_SHORTCUT" -eq 0 ]; then
  apps_dir="$HOME/.local/share/applications"
  mkdir -p "$apps_dir"
  info "Atualizando item de menu ($apps_dir)"
  write_desktop_entry "$apps_dir/$APP_ID.desktop"
  refresh_caches "$apps_dir/$APP_ID.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true

  if dir="$(desktop_dir)"; then
    info "Atualizando atalho em $dir"
    write_desktop_entry "$dir/$APP_ID.desktop"
    refresh_caches "$dir/$APP_ID.desktop"
  else
    warn "Área de trabalho não encontrada; apenas o item de menu foi criado."
  fi

  # O autostart (Configurações → Geral) usa o mesmo caminho: só realinha o Exec.
  autostart="$HOME/.config/autostart/$APP_NAME.desktop"
  if [ -f "$autostart" ]; then
    sed -i "s|^Exec=.*|Exec=$BIN_TARGET|" "$autostart"
    info "Autostart realinhado para $BIN_TARGET"
  fi
fi

info "Pronto: $APP_NAME $(version) instalado em $BIN_TARGET"
