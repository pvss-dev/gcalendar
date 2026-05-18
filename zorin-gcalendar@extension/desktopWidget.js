/**
 * desktopWidget.js — Widget flutuante na área de trabalho do GNOME Shell
 *
 * Estrutura visual:
 * ┌─────────────────────────────────────┐
 * │  ◀  Junho 2025  ▶            ⚙  ✕ │  ← Cabeçalho (arrastar aqui)
 * ├─────────────────────────────────────┤
 * │  D   S   T   Q   Q   S   S         │
 * │  1   2   3  [4]  5   6   7         │  ← Mini-calendário
 * │  8   9  10  11  12  13  14         │
 * │ ...                                │
 * ├─────────────────────────────────────┤
 * │  ● Reunião de produto  14:00        │
 * │  ● Daily standup       09:00        │  ← Eventos do dia selecionado
 * │  + Novo evento                      │
 * └─────────────────────────────────────┘
 *
 * Posicionamento: adicionado ao layoutManager.uiGroup abaixo das janelas.
 * Arrastar: captura pointer no cabeçalho e atualiza x/y no GSettings.
 */

import St      from 'gi://St';
import GLib    from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio     from 'gi://Gio';

import * as Main         from 'resource:///org/gnome/shell/ui/main.js';

import {
    formatTime, formatDateLong, sameDay, truncate,
    googleColour, eventStart, MONTH_NAMES, DAY_ABBR,
} from './utils.js';

/* ── Dimensões do widget ──────────────────────────────────────── */
const W          = 340;   // largura total (px)
const CAL_CELL   = 40;    // tamanho de cada célula do calendário
const CORNER     = 16;    // raio de borda

/* ════════════════════════════════════════════════════════════════ */

export const DesktopWidget = GObject.registerClass(
class DesktopWidget extends St.BoxLayout {

    _init(auth, eventManager, settings, extension) {
        super._init({
            name:        'GCalendarWidget',
            vertical:    true,
            width:       W,
            reactive:    true,
            track_hover: true,
            style_class: 'gcal-widget',
        });

        this._auth    = auth;
        this._mgr     = eventManager;
        this._cfg     = settings;
        this._ext     = extension;

        // Data exibida no calendário (não é a "hoje", pode navegar)
        this._viewDate    = new Date();
        // Dia selecionado para mostrar eventos
        this._selectedDay = new Date();

        // Drag state
        this._dragging    = false;
        this._dragOffX    = 0;
        this._dragOffY    = 0;

        this._build();
        this._addToDesktop();   // adiciona ao stage PRIMEIRO
        this._restore();        // depois restaura posição (precisa estar no stage)
        this._render();
    }

    /* ── Construção da UI ───────────────────────────────────────── */

    _build() {
        /* Cabeçalho ------------------------------------------------ */
        this._header = new St.BoxLayout({
            style_class: 'gcal-w-header',
            reactive:    true,
            track_hover: true,
        });

        // Botão mês anterior
        this._btnPrev = this._iconBtn('‹', 'gcal-w-nav-btn');
        this._btnPrev.connect('clicked', () => { this._shiftMonth(-1); });

        // Label do mês/ano (clicável = volta para hoje)
        this._monthLabel = new St.Button({
            style_class: 'gcal-w-month-label',
            x_expand:    true,
        });
        this._monthLabel.connect('clicked', () => {
            this._viewDate    = new Date();
            this._selectedDay = new Date();
            this._render();
        });

        // Botão próximo mês
        this._btnNext = this._iconBtn('›', 'gcal-w-nav-btn');
        this._btnNext.connect('clicked', () => { this._shiftMonth(+1); });

        // Botão de preferências
        const prefBtn = this._iconBtn('⚙', 'gcal-w-ctrl-btn');
        prefBtn.connect('clicked', () => this._ext.openPreferences());

        // Botão sync
        this._syncBtn = this._iconBtn('↻', 'gcal-w-ctrl-btn');
        this._syncBtn.connect('clicked', () => {
            this._syncBtn.set_label('…');
            this._mgr.sync().then(() => {
                this._syncBtn.set_label('↻');
                this._render();
            }).catch(() => this._syncBtn.set_label('↻'));
        });

        this._header.add_child(this._btnPrev);
        this._header.add_child(this._monthLabel);
        this._header.add_child(this._btnNext);
        this._header.add_child(prefBtn);
        this._header.add_child(this._syncBtn);
        this.add_child(this._header);

        // Arrastar pelo cabeçalho
        this._header.connect('button-press-event',   this._onDragStart.bind(this));
        this._header.connect('button-release-event', this._onDragEnd.bind(this));
        this._header.connect('motion-event',         this._onDragMove.bind(this));

        /* Área do calendário --------------------------------------- */
        this._calArea = new St.BoxLayout({
            vertical:    true,
            style_class: 'gcal-w-cal-area',
        });
        this.add_child(this._calArea);

        /* Separador ------------------------------------------------ */
        this.add_child(new St.Widget({ style_class: 'gcal-w-sep' }));

        /* Lista de eventos ----------------------------------------- */
        this._eventScroll = new St.ScrollView({
            style_class:       'gcal-w-event-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._eventList = new St.BoxLayout({
            vertical:    true,
            style_class: 'gcal-w-event-list',
        });
        this._eventScroll.set_child(this._eventList);
        this.add_child(this._eventScroll);

        /* Rodapé --------------------------------------------------- */
        this._footer = new St.BoxLayout({
            style_class: 'gcal-w-footer',
        });
        this._syncLabel = new St.Label({
            text:        '',
            style_class: 'gcal-w-sync-label',
            x_expand:    true,
        });
        const newBtn = new St.Button({
            label:       '+ Novo evento',
            style_class: 'gcal-w-new-btn',
        });
        newBtn.connect('clicked', () => {
            const d = this._selectedDay;
            const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const url = `https://calendar.google.com/calendar/r/eventedit?dates=${iso}/${iso}`;
            Gio.AppInfo.launch_default_for_uri_async(url, null, null, () => {});
        });
        this._footer.add_child(this._syncLabel);
        this._footer.add_child(newBtn);
        this.add_child(this._footer);
    }

    /* ── Renderização ───────────────────────────────────────────── */

    /** Ponto de entrada: re-renderiza todo o widget. */
    _render() {
        // Bug fix #3: Se não há client-id configurado, mostrar tela de setup.
        const hasCredentials = this._cfg.get_string('client-id') !== '';
        if (!hasCredentials) {
            this._renderNeedsSetup();
            return;
        }
        this._renderCalendar();
        this._renderEvents();
        this._renderFooter();
    }

    /** Tela quando client-id não foi configurado ainda. */
    _renderNeedsSetup() {
        this._calArea.destroy_all_children();
        this._eventList.destroy_all_children();
        this._monthLabel.set_label('Google Calendar');
        this._syncLabel.set_text('');

        const box = new St.BoxLayout({ vertical: true, style_class: 'gcal-w-signin' });

        const title = new St.Label({
            text: '🔑  Credenciais não configuradas',
            style_class: 'gcal-w-setup-title',
        });

        const msg = new St.Label({
            text: 'Abra as Preferências e adicione\nseu Client ID e Client Secret.',
            style_class: 'gcal-w-signin-lbl',
        });
        msg.clutter_text.set_line_alignment(1);

        const prefBtn = new St.Button({
            label: '⚙  Abrir Preferências',
            style_class: 'gcal-w-signin-btn',
        });
        prefBtn.connect('clicked', () => this._ext.openPreferences());

        box.add_child(title);
        box.add_child(msg);
        box.add_child(prefBtn);
        this._eventList.add_child(box);
    }

    /* Mini-calendário */
    _renderCalendar() {
        this._calArea.destroy_all_children();

        const y = this._viewDate.getFullYear();
        const m = this._viewDate.getMonth();
        this._monthLabel.set_label(`${MONTH_NAMES[m]}  ${y}`);

        // Linha de cabeçalho com dias da semana
        const headerRow = new St.BoxLayout({ style_class: 'gcal-w-cal-row' });
        for (const abbr of DAY_ABBR) {
            const lbl = new St.Label({ text: abbr, style_class: 'gcal-w-dow' });
            lbl.set_width(CAL_CELL);
            headerRow.add_child(lbl);
        }
        this._calArea.add_child(headerRow);

        // Dias do mês
        const firstDay  = new Date(y, m, 1).getDay();   // 0=Dom
        const daysInMon = new Date(y, m + 1, 0).getDate();
        const today     = new Date();
        const daysWithEvents = this._mgr.getDaysWithEvents();

        let row = new St.BoxLayout({ style_class: 'gcal-w-cal-row' });
        let col = 0;

        // Células vazias antes do dia 1
        for (let i = 0; i < firstDay; i++) {
            const empty = new St.Widget({ width: CAL_CELL, height: CAL_CELL });
            row.add_child(empty);
            col++;
        }

        for (let d = 1; d <= daysInMon; d++) {
            const date     = new Date(y, m, d);
            const isToday  = sameDay(date, today);
            const isSel    = sameDay(date, this._selectedDay);
            const hasEvent = daysWithEvents.has(`${y}-${m}-${d}`);

            const cell = new St.Button({
                width:   CAL_CELL,
                height:  CAL_CELL,
                label:   String(d),
                can_focus: true,
                style_class: 'gcal-w-day-cell'
                    + (isToday  ? ' gcal-w-today'    : '')
                    + (isSel    ? ' gcal-w-selected'  : '')
                    + (hasEvent ? ' gcal-w-has-event' : ''),
            });

            // Ponto indicador de eventos
            if (hasEvent && !isSel) {
                const dot = new St.Widget({ style_class: 'gcal-w-dot' });
                cell.set_child(new St.BoxLayout({ vertical: true }));
                // Note: Adicionaremos via CSS pseudo-element
            }

            const capturedDate = new Date(date);
            cell.connect('clicked', () => {
                this._selectedDay = capturedDate;
                this._render();
            });

            row.add_child(cell);
            col++;

            if (col === 7 || d === daysInMon) {
                // Preenche a última linha
                while (col < 7) {
                    row.add_child(new St.Widget({ width: CAL_CELL, height: CAL_CELL }));
                    col++;
                }
                this._calArea.add_child(row);
                row = new St.BoxLayout({ style_class: 'gcal-w-cal-row' });
                col = 0;
            }
        }
    }

    /* Lista de eventos do dia selecionado */
    _renderEvents() {
        this._eventList.destroy_all_children();

        // Cabeçalho com a data selecionada
        const dateHdr = new St.Label({
            text:        _cap(formatDateLong(this._selectedDay)),
            style_class: 'gcal-w-date-hdr',
        });
        this._eventList.add_child(dateHdr);

        if (!this._auth.isAuthenticated()) {
            this._renderSignIn();
            return;
        }

        const events = this._mgr.getEventsForDay(this._selectedDay);

        if (events.length === 0) {
            const empty = new St.Label({
                text:        'Nenhum evento neste dia.',
                style_class: 'gcal-w-empty',
            });
            this._eventList.add_child(empty);
            return;
        }

        for (const ev of events) {
            this._eventList.add_child(this._buildEventRow(ev));
        }
    }

    _buildEventRow(ev) {
        const { value, isAllDay } = eventStart(ev);
        const colour              = googleColour(ev.colorId);

        const row = new St.BoxLayout({
            style_class: 'gcal-w-ev-row',
            reactive:    true,
            track_hover: true,
        });

        // Barra colorida lateral
        const strip = new St.Widget({
            style_class: 'gcal-w-ev-strip',
            style:       `background: ${colour};`,
        });

        // Conteúdo textual
        const info = new St.BoxLayout({ vertical: true, x_expand: true });

        const title = new St.Label({
            text:        truncate(ev.summary ?? 'Sem título', 36),
            style_class: 'gcal-w-ev-title',
        });

        const timeTxt = isAllDay
            ? 'Dia inteiro'
            : formatTime(value);
        const meta = new St.Label({
            text:        timeTxt + (ev.location ? `  ·  ${truncate(ev.location, 22)}` : ''),
            style_class: 'gcal-w-ev-meta',
        });

        info.add_child(title);
        info.add_child(meta);

        // Botão abrir no Google Calendar
        const openBtn = new St.Button({ label: '↗', style_class: 'gcal-w-ev-open' });
        openBtn.connect('clicked', () => {
            if (ev.htmlLink)
                Gio.AppInfo.launch_default_for_uri_async(ev.htmlLink, null, null, () => {});
        });

        row.add_child(strip);
        row.add_child(info);
        row.add_child(openBtn);

        return row;
    }

    _renderSignIn() {
        const box = new St.BoxLayout({
            vertical:    true,
            style_class: 'gcal-w-signin',
        });
        const lbl = new St.Label({
            text: 'Credenciais configuradas!\nClique abaixo para autorizar\no acesso ao Google Calendar.',
            style_class: 'gcal-w-signin-lbl',
        });
        lbl.clutter_text.set_line_alignment(1);

        const btn = new St.Button({
            label:       '  Entrar com Google',
            style_class: 'gcal-w-signin-btn',
        });

        // Mensagem de status (erros, etc.)
        const status = new St.Label({
            text:        '',
            style_class: 'gcal-w-signin-status',
        });
        status.clutter_text.set_line_alignment(1);

        btn.connect('clicked', () => {
            btn.set_label('Abrindo navegador…');
            btn.reactive = false;
            status.set_text('Aguardando autorização no navegador…');
            this._auth.startAuthFlow()
                .then(() => {
                    status.set_text('Autenticado! Sincronizando…');
                    return this._mgr.start();
                })
                .then(() => this._render())
                .catch(e => {
                    console.error('[GCalendar] Auth error:', e.message);
                    // Mensagem amigável para erros comuns
                    let msg = 'Erro: ' + e.message;
                    if (e.message.includes('client_id') || e.message.includes('invalid_client'))
                        msg = 'Client ID ou Secret inválidos.\nVerifique nas Preferências.';
                    else if (e.message.includes('timeout') || e.message.includes('Timeout'))
                        msg = 'Tempo esgotado. Tente novamente.';
                    else if (e.message.includes('9004') || e.message.includes('porta'))
                        msg = 'Porta 9004 em uso. Reinicie\no GNOME Shell e tente de novo.';
                    status.set_text(msg);
                    btn.set_label('  Tentar novamente');
                    btn.reactive = true;
                });
        });

        box.add_child(lbl);
        box.add_child(btn);
        box.add_child(status);
        this._eventList.add_child(box);
    }

    _renderFooter() {
        const ts = this._cfg.get_int64('last-sync');
        if (ts > 0) {
            const d = new Date(ts * 1000);
            this._syncLabel.set_text(
                `Sync ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
            );
        } else {
            this._syncLabel.set_text('Nunca sincronizado');
        }
    }

    /* ── Posicionamento ─────────────────────────────────────────── */

    _addToDesktop() {
        // addChrome: registra o widget como elemento persistente do Shell.
        // Fica visível na área de trabalho, some no modo tela-cheia.
        // É a API oficial para widgets fixos no GNOME Shell.
        Main.layoutManager.addChrome(this, {
            affectsInputRegion: true,   // recebe cliques do mouse
            trackFullscreen:    true,   // some em tela-cheia (ex: jogos)
        });
        console.log('[GCalendar] Widget adicionado ao desktop via addChrome');
    }

    _restore() {
        const monitor = Main.layoutManager.primaryMonitor;
        let x = this._cfg.get_int('widget-x');
        let y = this._cfg.get_int('widget-y');

        // Garantir que está dentro dos limites do monitor
        if (monitor) {
            x = Math.min(Math.max(x, monitor.x), monitor.x + monitor.width  - W - 10);
            y = Math.min(Math.max(y, monitor.y + 30), monitor.y + monitor.height - 200);
        }

        this.set_position(x, y);
    }

    _savePosition() {
        const [x, y] = this.get_position();
        this._cfg.set_int('widget-x', x);
        this._cfg.set_int('widget-y', y);
    }

    /* ── Arrastar ───────────────────────────────────────────────── */

    _onDragStart(_actor, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
        const [evX, evY] = event.get_coords();
        const [wx, wy]   = this.get_position();
        this._dragOffX = evX - wx;
        this._dragOffY = evY - wy;
        this._dragging = true;
        this._header.grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    _onDragEnd(_actor, _event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        this._dragging = false;
        this._savePosition();
        return Clutter.EVENT_STOP;
    }

    _onDragMove(_actor, event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        const [evX, evY]  = event.get_coords();
        const monitor      = Main.layoutManager.primaryMonitor;

        let nx = evX - this._dragOffX;
        let ny = evY - this._dragOffY;

        if (monitor) {
            nx = Math.min(Math.max(nx, monitor.x), monitor.x + monitor.width  - W - 4);
            ny = Math.min(Math.max(ny, monitor.y + 30), monitor.y + monitor.height - 150);
        }

        this.set_position(nx, ny);
        return Clutter.EVENT_STOP;
    }

    /* ── Helpers ────────────────────────────────────────────────── */

    _shiftMonth(delta) {
        const d = this._viewDate;
        this._viewDate = new Date(d.getFullYear(), d.getMonth() + delta, 1);
        this._render();
    }

    _iconBtn(lbl, cls) {
        const b = new St.Button({ label: lbl, style_class: cls, can_focus: true });
        return b;
    }

    /** Chamado pela extensão após cada sync. */
    refresh() { this._render(); }

    /* ── Destruição ─────────────────────────────────────────────── */

    destroy() {
        this._savePosition();
        // Remover do chrome antes de destruir para evitar referência morta
        try {
            Main.layoutManager.removeChrome(this);
        } catch (_) {}
        super.destroy();
    }
});

function _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
