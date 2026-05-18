#!/usr/bin/env bash
# ============================================================
# install.sh — Zorin GCalendar Desktop Widget
# ============================================================
set -euo pipefail

UUID="zorin-gcalendar@extension"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()   { echo -e "${G}[✓]${N} $*"; }
warn() { echo -e "${Y}[!]${N} $*"; }
err()  { echo -e "${R}[✗]${N} $*"; exit 1; }

deps() {
    command -v glib-compile-schemas &>/dev/null \
        || err "Instale: sudo apt install libglib2.0-bin"
    command -v gnome-extensions &>/dev/null \
        || err "Instale: sudo apt install gnome-shell"
    ok "Dependências OK"
}

schemas() {
    ok "Compilando schemas GSettings…"
    glib-compile-schemas "$SRC_DIR/schemas/"
}

install() {
    deps; schemas
    ok "Instalando em $EXT_DIR …"
    mkdir -p "$EXT_DIR"
    cp -r "$SRC_DIR/"* "$EXT_DIR/"
    ok "Instalado!"

    echo ""
    warn "═══════════════════════════════════════"
    warn " PRÓXIMOS PASSOS"
    warn "═══════════════════════════════════════"
    echo ""
    echo "  1) Reinicie o GNOME Shell:"
    echo "     • Wayland (Zorin OS 18 padrão):"
    echo "       gnome-session-quit --logout   (faça logout e login)"
    echo "     • X11:  Alt+F2 → 'r' → Enter"
    echo ""
    echo "  2) Ative a extensão:"
    echo "     gnome-extensions enable $UUID"
    echo ""
    echo "  3) Configure as credenciais Google:"
    echo "     gnome-extensions prefs $UUID"
    echo ""
    echo "  4) Clique em 'Entrar com Google' no widget"
    echo ""
    warn "     O widget aparece no canto superior esquerdo."
    warn "     Arraste pelo cabeçalho para reposicionar."
}

remove() {
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$EXT_DIR"
    ok "Extensão removida."
}

zip_pack() {
    deps; schemas
    ZIP="$( dirname "$SRC_DIR" )/${UUID}.shell-extension.zip"
    ok "Criando $ZIP …"
    cd "$SRC_DIR"
    zip -r "$ZIP" . --exclude "*.git*"
    ok "Pronto: $ZIP"
    echo "Envie em: https://extensions.gnome.org/upload/"
}

case "${1:-install}" in
    --remove) remove   ;;
    --zip)    zip_pack ;;
    *)        install  ;;
esac
