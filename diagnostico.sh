#!/usr/bin/env bash
# =============================================================
# diagnostico.sh — Verifica o ambiente antes de instalar
# Execute: bash diagnostico.sh
# =============================================================
echo "======================================================"
echo "  Zorin GCalendar — Diagnóstico do ambiente"
echo "======================================================"
echo ""

# GNOME Shell version
GNOME_VER=$(gnome-shell --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1)
echo "GNOME Shell: $GNOME_VER"
MAJOR=$(echo $GNOME_VER | cut -d. -f1)
if [ "$MAJOR" -lt 43 ]; then
  echo "  ⚠  GNOME $MAJOR não é suportado. Precisa de 43+."
else
  echo "  ✓  Versão suportada"
fi

# Zorin OS
if [ -f /etc/zorin-release ]; then
  echo "Zorin OS: $(cat /etc/zorin-release)"
elif [ -f /etc/os-release ]; then
  echo "Sistema: $(grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"')"
fi

# Display server
echo "Display: $XDG_SESSION_TYPE (${WAYLAND_DISPLAY:-sem wayland} / ${DISPLAY:-sem x11})"

# Extension installed?
UUID="zorin-gcalendar@extension"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
if [ -d "$EXT_DIR" ]; then
  echo "Extensão: instalada em $EXT_DIR"
  echo "  Arquivos: $(ls $EXT_DIR | wc -l)"
  # Check schema compiled
  if [ -f "$EXT_DIR/schemas/gschemas.compiled" ]; then
    echo "  Schemas: ✓ compilados"
  else
    echo "  Schemas: ✗ NÃO compilados — rode: glib-compile-schemas $EXT_DIR/schemas/"
  fi
else
  echo "Extensão: ✗ NÃO instalada em $EXT_DIR"
fi

# Extension enabled?
if gnome-extensions show "$UUID" 2>/dev/null | grep -q "State: ENABLED"; then
  echo "  Status: ✓ ATIVADA"
else
  echo "  Status: ✗ NÃO ativada — rode: gnome-extensions enable $UUID"
fi

echo ""
echo "====== Logs do GCalendar (últimas 20 linhas) ======"
journalctl -b -o cat /usr/bin/gnome-shell 2>/dev/null | grep -i "gcalendar\|GCalendar" | tail -20 || \
  echo "(nenhum log encontrado — tente: journalctl -f | grep GCalendar)"

echo ""
echo "======================================================"
