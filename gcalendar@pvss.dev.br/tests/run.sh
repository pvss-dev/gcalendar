#!/usr/bin/env bash
# Executa toda a verificação possível sem o GNOME Shell rodando.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

status=0

echo "── Compilando schemas GSettings ─────────────────────────────"
glib-compile-schemas schemas/ || status=1

echo
echo "── Testes unitários ─────────────────────────────────────────"
GCAL_QUIET=1 gjs -m tests/run.js || status=1

echo
echo "── Preferências (GTK4/Adwaita, sem abrir janela) ────────────"
# Shew fica num diretório privado do gnome-shell; sem isso o import de
# resource:///org/gnome/Shell/Extensions/... falha fora do processo de prefs.
GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0:/usr/lib/gnome-shell \
GI_TYPELIB_PATH_EXTRA=/usr/lib64/gnome-shell/girepository-1.0 \
LD_LIBRARY_PATH=/usr/lib/gnome-shell \
    gjs -m tests/prefs.smoke.js || status=1

exit $status
