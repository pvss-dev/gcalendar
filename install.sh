#!/usr/bin/env bash
# ============================================================
#  install.sh — Zorin GCalendar Desktop Widget
#
#  Uso:
#     ./install.sh            instala em ~/.local/share/gnome-shell/extensions
#     ./install.sh --test     só roda a suíte de verificação
#     ./install.sh --zip      empacota para extensions.gnome.org
#     ./install.sh --remove   desinstala
#     ./install.sh --layer desktop|auto|top   troca a camada (efeito imediato)
#     ./install.sh --status   diz se o Shell já carregou a versão instalada
#     ./install.sh --diagnose relatório para depurar cliques que não chegam
#     ./install.sh --forget   apaga cache, agendas e token da conta (mantém o app)
# ============================================================
set -euo pipefail

UUID="zorin-gcalendar@extension"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1m'; N='\033[0m'
ok()   { echo -e "${G}[✓]${N} $*"; }
warn() { echo -e "${Y}[!]${N} $*"; }
err()  { echo -e "${R}[✗]${N} $*" >&2; exit 1; }

check_deps() {
    command -v glib-compile-schemas >/dev/null \
        || err "Faltando glib-compile-schemas — sudo apt install libglib2.0-bin"
    command -v gjs >/dev/null \
        || err "Faltando gjs — sudo apt install gjs"
    command -v gnome-extensions >/dev/null \
        || err "Faltando gnome-extensions — sudo apt install gnome-shell"
    ok "Dependências presentes"
}

# A extensão declara as versões do Shell que realmente suporta; avisar aqui
# evita o clássico "instalei e não aparece" por incompatibilidade de API.
check_shell_version() {
    local running major supported
    running="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -1)"
    major="${running%%.*}"
    supported="$(grep -oE '"shell-version"[^]]*]' "$SRC_DIR/metadata.json" | grep -oE '[0-9]+' | tr '\n' ' ')"

    if [[ -z "$running" ]]; then
        warn "Não foi possível detectar a versão do GNOME Shell"
        return
    fi
    if grep -qw "$major" <<<"$supported"; then
        ok "GNOME Shell $running (suportadas: $supported)"
    else
        warn "GNOME Shell $running não está na lista suportada ($supported)."
        warn "A extensão provavelmente não vai carregar."
    fi
}

# Em X11 dá para reiniciar o Shell na hora; em Wayland só relogando.
restart_hint() {
    if [[ "${XDG_SESSION_TYPE:-}" == x11 ]]; then
        echo "       Alt+F2 → digite \"r\" → Enter   (sessão X11 detectada)"
    else
        echo "       Faça logout e login   (sessão Wayland: não há reinício ao vivo)"
    fi
}

run_tests() {
    echo -e "${B}Rodando verificações…${N}"
    ( cd "$SRC_DIR" && bash tests/run.sh ) || err "Verificações falharam — instalação abortada"
    ok "Verificações passaram"
}

compile_schemas() {
    glib-compile-schemas "$SRC_DIR/schemas/"
    ok "Schemas GSettings compilados"
}

do_install() {
    check_deps
    check_shell_version
    run_tests
    compile_schemas

    # Remove a instalação anterior por inteiro: sobras de versões antigas
    # (arquivos que não existem mais) só confundem na hora de depurar.
    rm -rf "$EXT_DIR"
    mkdir -p "$EXT_DIR"
    cp -r "$SRC_DIR/." "$EXT_DIR/"
    date -u +%Y%m%d-%H%M%S > "$EXT_DIR/BUILD"
    ok "Instalado em $EXT_DIR (build $(cat "$EXT_DIR/BUILD"))"

    cat <<INSTRUCTIONS

$(echo -e "${B}PRÓXIMOS PASSOS${N}")

  1) Recarregue o GNOME Shell (o código só entra em vigor assim —
     habilitar/desabilitar NÃO recarrega, por causa do cache de módulos ESM):
$(restart_hint)

  2) Ative:
       gnome-extensions enable $UUID

  3) Configure suas credenciais OAuth (veja o README para criá-las):
       gnome-extensions prefs $UUID

  4) Clique em "Entrar com Google" no widget.

  Diagnóstico, se algo não funcionar:
       journalctl -f -o cat /usr/bin/gnome-shell | grep GCalendar
       (com detalhes: reinicie a sessão com GCAL_DEBUG=1 no ambiente)

INSTRUCTIONS
}

do_remove() {
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$EXT_DIR"
    ok "Extensão removida de $EXT_DIR"
    warn "Tokens no GNOME Keyring e preferências no dconf continuam lá."
    warn "Para apagar tudo:"
    echo  "    dconf reset -f /org/gnome/shell/extensions/zorin-gcalendar/"
    echo  "    secret-tool clear key refresh-token"
    echo  "    secret-tool clear key client-secret"
}

# A camada tem efeito imediato: a extensão observa changed::widget-layer.
# Ter isto aqui evita ter de lembrar do --schemadir do gsettings.
do_layer() {
    local value="${1:-}"
    case "$value" in
        desktop|auto|top) ;;
        *) err "Use: ./install.sh --layer desktop|auto|top" ;;
    esac
    [[ -d "$EXT_DIR/schemas" ]] || err "Extensão não instalada — rode ./install.sh antes"
    gsettings --schemadir "$EXT_DIR/schemas" \
        set org.gnome.shell.extensions.zorin-gcalendar widget-layer "$value"
    case "$value" in
        desktop) ok "Atrás das janelas (dentro do grupo de janelas)" ;;
        auto)    ok "Some sob as janelas — modo que sempre recebe cliques" ;;
        top)     ok "Sempre visível, acima das janelas" ;;
    esac
}

# Compara o build instalado com o que o Shell realmente carregou (o journal
# registra o build a cada enable). Serve para saber se falta relogar.
do_status() {
    [[ -f "$EXT_DIR/BUILD" ]] || err "Extensão não instalada"
    local installed running
    installed="$(cat "$EXT_DIR/BUILD")"
    # `|| true`: sem correspondência o grep sai com 1, e o `set -e` mataria a
    # função justamente no caso que mais interessa relatar.
    running="$(journalctl --user -b 0 -o cat 2>/dev/null \
        | grep -oE 'habilitada — build [0-9]{8}-[0-9]{6}' \
        | tail -1 | grep -oE '[0-9]{8}-[0-9]{6}' || true)"

    echo "  build instalado : $installed"
    echo "  build em execução: ${running:-<nenhum registro no journal>}"
    if [[ -z "$running" ]]; then
        warn "O Shell ainda não carregou esta versão. Recarregue:"
        restart_hint
    elif [[ "$running" == "$installed" ]]; then
        ok "O Shell está rodando a versão instalada."
    else
        warn "O Shell roda um build antigo. Recarregue:"
        restart_hint
    fi
}

# Reúne, em um lugar só, o que é preciso para entender por que um clique não
# chegou ao widget: build em execução, decisões de região de entrada e erros.
do_diagnose() {
    echo "── sessão ──"
    echo "  tipo         : ${XDG_SESSION_TYPE:-?}"
    echo "  gnome-shell  : $(gnome-shell --version 2>/dev/null)"
    echo
    echo "── build ──"
    do_status || true
    echo
    echo "── janelas X11 (tipo / geometria / título) ──"
    if [[ "${XDG_SESSION_TYPE:-}" == x11 ]] && command -v xprop >/dev/null; then
        for id in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -oE '0x[0-9a-f]+'); do
            local type name geom
            type=$(xprop -id "$id" _NET_WM_WINDOW_TYPE 2>/dev/null | sed 's/.*_NET_WM_WINDOW_TYPE_//')
            name=$(xprop -id "$id" WM_NAME 2>/dev/null | sed 's/.*= //' | cut -c1-45)
            geom=$(xwininfo -id "$id" 2>/dev/null \
                | awk '/Absolute upper-left X/{x=$4} /Absolute upper-left Y/{y=$4} /Width:/{w=$2} /Height:/{h=$2} END{printf "%sx%s+%s+%s", w, h, x, y}')
            echo "  ${type:-?}  $geom  $name"
        done
    else
        echo "  (só disponível no X11)"
    fi
    echo
    echo "── decisões de região de entrada (journal) ──"
    journalctl --user -b 0 -o cat 2>/dev/null \
        | grep -E 'região de entrada|habilitada — build' | tail -15 \
        || echo "  (nenhuma)"
    echo
    echo "── erros da extensão ──"
    journalctl --user -b 0 -o cat 2>/dev/null \
        | grep -E 'desktopWidget\.js|JS ERROR.*zorin-gcalendar' | tail -10 \
        || echo "  (nenhum)"
}

# Remove tudo o que a extensão guardou sobre a CONTA, mantendo a extensão
# instalada e o Client ID (que é credencial do aplicativo, não da conta).
do_forget() {
    local cache="$HOME/.cache/$UUID"
    local schema="org.gnome.shell.extensions.zorin-gcalendar"

    if [[ -d "$cache" ]]; then
        rm -rf "$cache"
        ok "Cache de eventos e agendas removido ($cache)"
    else
        ok "Nenhum cache de eventos em disco"
    fi

    dconf reset "/org/gnome/shell/extensions/zorin-gcalendar/enabled-calendars"
    dconf reset "/org/gnome/shell/extensions/zorin-gcalendar/last-sync"
    ok "IDs de agenda e horário de sincronização apagados do dconf"

    # secret-tool é do pacote libsecret-tools e pode não estar instalado;
    # gjs sempre está (a extensão depende dele), então falamos com o keyring
    # pela mesma API que a extensão usa.
    local script
    script="$(mktemp --suffix=.js)"
    cat > "$script" <<'GJS'
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';

Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.zorin-gcalendar',
    Secret.SchemaFlags.NONE, {key: Secret.SchemaAttributeType.STRING});

// O Client Secret é credencial do aplicativo, não da conta: só sai com --all.
const keys = GLib.getenv('GCAL_FORGET_ALL') === '1'
    ? ['refresh-token', 'client-secret']
    : ['refresh-token'];

const loop = GLib.MainLoop.new(null, false);
let failed = 0;

(async () => {
    for (const key of keys) {
        try {
            const had = await Secret.password_lookup(SCHEMA, {key}, null);
            await Secret.password_clear(SCHEMA, {key}, null);
            print(had ? `      ${key}: removido` : `      ${key}: já não existia`);
        } catch (e) {
            failed++;
            print(`      ${key}: FALHOU — ${e.message}`);
        }
    }
    loop.quit();
})();

loop.run();
imports.system.exit(failed ? 1 : 0);
GJS

    echo "  GNOME Keyring:"
    if gjs -m "$script"; then
        ok "Keyring limpo"
    else
        warn "Alguma entrada não pôde ser removida (chaveiro bloqueado?)"
    fi
    rm -f "$script"

    if [[ "${GCAL_FORGET_ALL:-}" != 1 ]]; then
        warn "Mantidos: Client ID e Client Secret (credenciais do aplicativo)."
        echo  "  Para apagar tudo:  GCAL_FORGET_ALL=1 ./install.sh --forget"
    else
        dconf reset "/org/gnome/shell/extensions/zorin-gcalendar/client-id"
        ok "Client ID também removido"
    fi
}

do_zip() {
    check_deps
    run_tests
    compile_schemas
    local zip="$(dirname "$SRC_DIR")/${UUID}.shell-extension.zip"
    rm -f "$zip"
    ( cd "$SRC_DIR" && zip -qr "$zip" . -x '*.git*' 'tests/*' )
    ok "Pacote criado: $zip"
    echo "Envie em https://extensions.gnome.org/upload/"
}

case "${1:-install}" in
    --remove) do_remove ;;
    --layer)  do_layer "${2:-}" ;;
    --status) do_status ;;
    --diagnose) do_diagnose ;;
    --forget) do_forget ;;
    --zip)    do_zip ;;
    --test)   run_tests ;;
    --help|-h) sed -n '2,16p' "${BASH_SOURCE[0]}" ;;
    *)        do_install ;;
esac
