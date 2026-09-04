/**
 * desktopWidget.js — o widget em si.
 *
 * Só compõe e apresenta: nada de HTTP, nada de OAuth.  Lê o EventStore e
 * reage aos sinais dele.
 *
 * Camadas (chave `widget-layer`):
 *   'top'     — chrome padrão do Shell: fica acima das janelas normais e é
 *               sempre clicável.  É o comportamento confiável no Wayland.
 *   'desktop' — abaixo das janelas, como um widget de área de trabalho.  Nesse
 *               modo a região de entrada é liberada enquanto alguma janela
 *               cobre o widget; sem isso o Shell interceptaria cliques
 *               destinados à janela que está por cima.
 */
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Log from '../lib/log.js';
import {SyncState} from '../lib/eventStore.js';
import {userMessage} from '../lib/errors.js';
import {MonthGrid} from './monthGrid.js';
import {EventList} from './eventList.js';
import {EventDialog} from './eventDialog.js';
import {
    startOfDay, monthNames, formatTime, capitalize, formatDateLong, addDays,
} from '../lib/utils.js';
import {shiftMonth} from '../lib/monthLayout.js';

const WIDGET_WIDTH = 340;

export const DesktopWidget = GObject.registerClass(
class DesktopWidget extends St.Widget {
    _init({store, auth, settings, extension}) {
        super._init({
            name: 'gcalendar-widget',
            layout_manager: new Clutter.BinLayout(),
            width: WIDGET_WIDTH,
            reactive: true,
            track_hover: true,
            style_class: 'gcal-widget',
        });

        this._store = store;
        this._auth = auth;
        this._settings = settings;
        this._extension = extension;

        this._viewDate = startOfDay(new Date());
        this._selectedDate = startOfDay(new Date());
        this._monthNames = monthNames();

        this._signals = [];        // [{object, id}] — desconectados no destroy()
        this._dragGrab = null;
        this._press = null;
        this._dialog = null;
        this._destroyed = false;

        this._build();
        this._addToStage();
        this._connectSignals();
        this._restorePosition();

        this._store.setVisibleMonth(this._viewDate);
        this._refresh();

        // A primeira checagem de cobertura roda antes de o ator ter posição e
        // tamanho definitivos; refazemos depois de restaurar a posição.
        this._updateInputTracking();
    }

    /* ══════════════════════ Construção ══════════════════════ */

    _build() {
        // Fundo em ator próprio: a opacidade configurável afeta só ele,
        // deixando texto e ícones sempre legíveis.
        this._background = new St.Widget({
            style_class: 'gcal-widget-background',
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._background);

        // x_expand é obrigatório: a raiz usa Clutter.BinLayout e, sem ele, o
        // filho recebe a largura NATURAL em vez dos 340px do widget. A largura
        // natural de uma coluna vertical é a do filho mais largo — o cabeçalho
        // — então a grade acabava dimensionada pelo comprimento do nome do mês
        // ("August" × "September"), mudando de largura a cada navegação.
        const content = new St.BoxLayout({
            vertical: true,
            style_class: 'gcal-widget-content',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.add_child(content);

        content.add_child(this._buildHeader());
        this._grid = new MonthGrid();
        this._grid.connect('day-activated', (_grid, key) => this._onDaySelected(key));
        content.add_child(this._grid);

        this._dayHeader = new St.Label({style_class: 'gcal-day-header'});
        content.add_child(this._dayHeader);

        this._list = new EventList(event => this._openDialog({event}));
        this._scroll = new St.ScrollView({
            style_class: 'gcal-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            // Propriedade `child` do St.ScrollView (GNOME 46+).
            child: this._list,
        });
        content.add_child(this._scroll);
        this._applyListHeight();

        content.add_child(this._buildFooter());
        this._buildMenu();
    }

    /**
     * Menu de contexto (botão direito em qualquer ponto do widget).
     *
     * Existe sobretudo para alternar a camada sem abrir as preferências —
     * é a ação que mais se quer testar e a que menos compensa ir procurar
     * numa janela separada.
     */
    _buildMenu() {
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
        Main.layoutManager.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuManager.addMenu(this._menu);

        this._layerItems = new Map();
        for (const [layer, label] of [
            ['desktop', 'Atrás das janelas'],
            ['top', 'Sempre visível'],
        ]) {
            const item = this._addMenuAction(label,
                () => this._settings.set_string('widget-layer', layer));
            this._layerItems.set(layer, item);
        }
        this._updateMenuOrnaments();

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addMenuAction('Sincronizar agora', () => this._syncNow());
        this._addMenuAction('Novo evento', () => this._openDialog({date: this._selectedDate}));
        this._addMenuAction('Preferências', () => this._extension.openPreferences());
    }

    /** Marca com um ponto a camada ativa, como um grupo de opções. */
    _updateMenuOrnaments() {
        const current = this._settings.get_string('widget-layer');
        for (const [layer, item] of this._layerItems ?? []) {
            item.setOrnament(layer === current
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NO_DOT);
        }
    }

    _addMenuAction(label, callback) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => callback());
        this._menu.addMenuItem(item);
        return item;
    }

    _buildHeader() {
        this._header = new St.BoxLayout({
            style_class: 'gcal-header',
            reactive: true,
            track_hover: true,
        });

        this._prevButton = this._iconButton('go-previous-symbolic', 'Mês anterior',
            () => this._shiftMonth(-1));
        this._nextButton = this._iconButton('go-next-symbolic', 'Próximo mês',
            () => this._shiftMonth(1));

        this._monthButton = new St.Button({
            style_class: 'gcal-month-button',
            x_expand: true,
            can_focus: true,
        });
        this._monthButton.connect('clicked', () => this._goToToday());

        this._syncButton = this._iconButton('view-refresh-symbolic', 'Sincronizar agora',
            () => this._syncNow());
        this._prefsButton = this._iconButton('emblem-system-symbolic', 'Preferências',
            () => this._extension.openPreferences());

        this._header.add_child(this._prevButton);
        this._header.add_child(this._monthButton);
        this._header.add_child(this._nextButton);
        this._header.add_child(this._syncButton);
        this._header.add_child(this._prefsButton);

        // O arraste é tratado na fase de captura, em _connectSignals(): os
        // St.Button deste cabeçalho consomem 'button-press-event', então um
        // handler comum aqui só receberia a pressão nos poucos pixels de
        // padding entre os botões.
        this._connect(this._header, 'notify::hover', () => this._updateCursor());

        return this._header;
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'gcal-footer'});

        this._statusLabel = new St.Label({
            style_class: 'gcal-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._newButton = new St.Button({
            style_class: 'gcal-new-button',
            label: 'Novo evento',
            can_focus: true,
        });
        this._newButton.connect('clicked', () => this._openDialog({date: this._selectedDate}));

        footer.add_child(this._statusLabel);
        footer.add_child(this._newButton);
        return footer;
    }

    _iconButton(iconName, tooltip, onClick) {
        const button = new St.Button({
            style_class: 'gcal-icon-button',
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.set_accessible_name(tooltip);
        button.connect('clicked', onClick);
        return button;
    }

    /* ══════════════════════ Sinais ══════════════════════ */

    _connect(object, signal, handler) {
        const id = object.connect(signal, handler);
        this._signals.push({object, id});
        return id;
    }

    _connectSignals() {
        this._connect(this._store, 'changed', () => this._refresh());
        this._connect(this._store, 'status-changed', () => this._refresh());
        this._connect(this._auth, 'state-changed', () => this._refresh());

        for (const key of ['widget-opacity', 'widget-layer']) {
            this._connect(this._settings, `changed::${key}`, () => {
                this._applyOpacity();
                this._applyLayer();
            });
        }

        this._connect(this._settings, 'changed::event-list-height',
            () => this._applyListHeight());
        this._connect(St.ThemeContext.get_for_stage(global.stage),
            'notify::scale-factor', () => this._applyListHeight());

        this._connect(Main.layoutManager, 'monitors-changed', () => this._restorePosition());

        // Não escondemos o widget na visão geral à mão de propósito: em
        // 'desktop' ele está dentro de window_group, que o LayoutManager já
        // oculta lá, e em 'top' o overviewGroup fica acima dele na uiGroup.
        // Chamar hide()/show() aqui só brigaria com _updateActorVisibility().

        // Empilhamento e geometria mudaram: reafirma a posição do widget e
        // recalcula quem deve receber os cliques.
        const onStackChanged = () => {
            this._restack();
            this._updateInputTracking();
        };
        for (const signal of ['restacked', 'grab-op-end'])
            this._connect(global.display, signal, onStackChanged);
        for (const signal of ['switch-workspace', 'size-changed', 'map', 'destroy',
            'minimize', 'unminimize'])
            this._connect(global.window_manager, signal, onStackChanged);

        this._connect(this, 'notify::height', () => {
            const height = Math.round(this.height);
            if (height !== this._loggedHeight) {
                this._loggedHeight = height;
                Log.debug(`altura do widget: ${height}px`);
            }
        });

        this._connect(this, 'key-press-event', this._onKeyPress.bind(this));
        this._connect(this, 'captured-event', this._onCapturedEvent.bind(this));
    }

    /* ══════════════════════ Renderização ══════════════════════ */

    _refresh() {
        if (this._destroyed)
            return;

        this._monthButton.set_label(
            `${this._monthNames[this._viewDate.getMonth()]} ${this._viewDate.getFullYear()}`);
        this._grid.update(this._viewDate, this._selectedDate, this._colourMap());
        this._dayHeader.set_text(capitalize(formatDateLong(this._selectedDate)));

        this._renderBody();
        this._renderStatus();
        this._applyOpacity();
    }

    _renderBody() {
        const state = this._store.state;

        if (state === SyncState.UNCONFIGURED) {
            this._list.setMessage(
                'Contas Online do GNOME indisponível. A extensão precisa dele ' +
                'para acessar sua agenda.',
                {tone: 'error'});
            this._newButton.reactive = false;
            return;
        }

        if (state === SyncState.UNAUTHENTICATED) {
            // Distingue "não há conta" de "há conta, mas sem calendário": são
            // ações diferentes no mesmo painel, e dizer qual poupa a procura.
            const calendarOff = this._auth.hasAccountWithCalendarDisabled();
            this._list.setMessage(
                calendarOff
                    ? 'Sua conta Google está conectada, mas com o Calendário desligado.'
                    : 'Conecte sua conta do Google para ver os eventos.',
                {
                    actionLabel: calendarOff ? 'Ativar Calendário' : 'Conectar conta',
                    onAction: () => this._openAccountSettings(),
                });
            this._newButton.reactive = false;
            return;
        }

        this._newButton.reactive = this._store.getWritableCalendars().length > 0;

        // Erro sem nenhum dado em cache: a mensagem substitui a lista.
        // Havendo cache, mostramos os eventos e o erro vai para o rodapé.
        if (state === SyncState.ERROR && this._store.getDayKeysWithEvents().size === 0) {
            this._list.setMessage(userMessage(this._store.error), {
                tone: 'error',
                actionLabel: 'Tentar de novo',
                onAction: () => this._syncNow(),
            });
            return;
        }

        this._list.setEvents(this._store.getEventsForDay(this._selectedDate), this._selectedDate);
    }

    _renderStatus() {
        const state = this._store.state;

        if (state === SyncState.SYNCING) {
            this._statusLabel.set_text('Sincronizando…');
            this._syncButton.reactive = false;
            this._syncButton.opacity = 128;
            return;
        }

        this._syncButton.reactive = true;
        this._syncButton.opacity = 255;

        if (state === SyncState.ERROR) {
            this._statusLabel.set_text(userMessage(this._store.error));
            this._statusLabel.add_style_class_name('gcal-status-error');
            return;
        }

        this._statusLabel.remove_style_class_name('gcal-status-error');
        const last = this._store.lastSync;
        this._statusLabel.set_text(
            last ? `Atualizado ${formatTime(new Date(last))}` : 'Nunca sincronizado');
    }

    /** "YYYY-MM-DD" → cores dos eventos, para os pontinhos da grade. */
    _colourMap() {
        // Duas semanas de folga de cada lado cobrem as células de meses
        // vizinhos que a grade de 6×7 também mostra.
        const first = new Date(this._viewDate.getFullYear(), this._viewDate.getMonth(), 1);
        return this._store.getColoursByDay(addDays(first, -14), addDays(first, 60));
    }

    /* ══════════════════════ Ações ══════════════════════ */

    _onDaySelected(key) {
        const [year, month, day] = key.split('-').map(Number);
        this._selectedDate = new Date(year, month - 1, day);

        // Clicar numa célula de outro mês navega para ele.
        if (this._selectedDate.getMonth() !== this._viewDate.getMonth() ||
            this._selectedDate.getFullYear() !== this._viewDate.getFullYear()) {
            this._viewDate = startOfDay(this._selectedDate);
            this._store.setVisibleMonth(this._viewDate);
        }
        this._refresh();
    }

    /**
     * Navega de mês levando o dia selecionado junto.
     *
     * Sem isso a lista de baixo continuava mostrando um dia que já não está na
     * grade — você via "7 de setembro" embaixo de outubro. É o comportamento
     * do calendário do próprio Shell: mantém o número do dia e encolhe quando
     * o mês destino é mais curto (31/01 → 28/02).
     */
    _shiftMonth(delta) {
        const moved = shiftMonth(this._viewDate, this._selectedDate, delta);
        this._viewDate = moved.viewDate;
        this._selectedDate = moved.selectedDate;

        this._store.setVisibleMonth(this._viewDate);
        this._refresh();
    }

    _goToToday() {
        const today = startOfDay(new Date());
        this._viewDate = today;
        this._selectedDate = today;
        this._store.setVisibleMonth(today);
        this._refresh();
    }

    _syncNow() {
        this._store.sync().catch(err => Log.debug('sync manual:', err.message));
    }

    /**
     * Abre Configurações → Contas Online.
     *
     * A extensão não faz login: quem cuida disso é o GNOME, com o cliente
     * OAuth dele. Conectada a conta, o sinal do GOA chega e o widget se
     * atualiza sozinho.
     */
    _openAccountSettings() {
        try {
            this._auth.openAccountSettings();
        } catch (err) {
            Log.error(err, 'abrir Contas Online');
            this._list.setMessage(userMessage(err), {tone: 'error'});
        }
    }

    _openDialog({event = null, date = null} = {}) {
        if (this._dialog)
            return;
        if (!event && this._store.getWritableCalendars().length === 0) {
            Log.warn('nenhuma agenda com permissão de escrita');
            return;
        }

        this._dialog = new EventDialog({
            store: this._store,
            event,
            date: date ?? this._selectedDate,
        });
        this._dialog.connect('destroy', () => (this._dialog = null));
        this._dialog.open(global.get_current_time());
    }

    _onKeyPress(_actor, event) {
        const symbol = event.get_key_symbol();
        switch (symbol) {
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
        case Clutter.KEY_Up:
        case Clutter.KEY_Down:
            return this._grid.moveFocus(symbol) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_Page_Up:
            this._shiftMonth(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._shiftMonth(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Home:
            this._goToToday();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /* ══════════════════════ Posicionamento e camada ══════════════════════ */

    _addToStage() {
        this._parentGroup = null;
        this._tracked = false;
        this._applyLayer();
    }

    /**
     * 'top'     → uiGroup, logo acima das janelas normais; sempre clicável.
     * 'desktop' → dentro de window_group, logo acima do papel de parede.
     *
     * O papel de parede é filho de `global.window_group` e é rebaixado para o
     * fundo dele (layout.js: `set_child_below_sibling(_backgroundGroup, null)`).
     * Por isso descer o widget para baixo de window_group inteiro não o coloca
     * na área de trabalho: o esconde atrás do papel de parede.
     */
    _applyLayer() {
        // Valor desconhecido (por exemplo o modo 'auto', removido) cai na
        // área de trabalho, que é o padrão.
        const parent = this._settings.get_string('widget-layer') === 'top'
            ? Main.layoutManager.uiGroup
            : global.window_group;

        if (this._parentGroup !== parent) {
            this._parentGroup?.remove_child(this);
            parent.add_child(this);
            this._parentGroup = parent;
        }

        // Os parâmetros de rastreamento mudam com a camada, e trackChrome()
        // não os atualiza em um ator já rastreado: é preciso soltar e refazer.
        this._setTracked(false);
        this._restack();
        this._updateInputTracking();
        this._updateMenuOrnaments();
    }

    /**
     * Reafirma a posição do widget dentro do pai.
     *
     * O mutter reordena os atores de janela a cada 'restacked' e não conhece o
     * nosso ator, que acabaria em qualquer lugar da pilha; por isso isto roda
     * também a cada restack, e não só na troca de camada.
     */
    _restack() {
        if (this._destroyed || !this._parentGroup)
            return;

        if (this._parentGroup !== global.window_group) {
            Main.layoutManager.uiGroup.set_child_above_sibling(this, global.window_group);
            return;
        }

        // Precisa ficar acima do papel de parede E das janelas de tipo DESKTOP.
        // O Zorin mantém uma janela "Desktop Icons" de tela inteira (X11:
        // _NET_WM_WINDOW_TYPE_DESKTOP, 1920x1080) no fundo da pilha: ela é
        // transparente, então o widget aparecia normalmente, mas por estar
        // empilhada acima dele ficava com todos os cliques da área.
        const background = Main.layoutManager._backgroundGroup;
        let anchor = background?.get_parent() === global.window_group ? background : null;

        for (const child of global.window_group.get_children()) {
            if (child === this)
                continue;
            if (child.meta_window?.get_window_type() === Meta.WindowType.DESKTOP)
                anchor = child;   // filhos vêm de baixo para cima: fica o mais alto
        }

        if (anchor)
            global.window_group.set_child_above_sibling(this, anchor);
    }

    /**
     * O Shell só deve reivindicar os cliques sobre o widget quando ele estiver
     * realmente visível.  No modo 'desktop' a região de entrada é liberada
     * enquanto alguma janela cobre o widget: sem isso, no X11 o Shell
     * interceptaria cliques destinados à janela que está por cima.  No Wayland
     * a própria ordem dos atores já resolve, e liberar a região é inofensivo.
     */
    _updateInputTracking() {
        if (this._destroyed)
            return;

        const layer = this._settings.get_string('widget-layer');
        if (layer === 'top') {
            this.show();
            this._setTracked(true);
            return;
        }

        // 'desktop': o widget está de fato atrás das janelas.
        const blocker = this._findCoveringWindow();
        this.show();

        // No Wayland o hit-testing vem da ordem dos atores e
        // `_updateRegions()` nem monta a região de entrada
        // (`!Meta.is_wayland_compositor()`): soltar o rastreamento não
        // devolveria clique algum à janela de cima, só desligaria o
        // tratamento de tela cheia. Já no X11 a região é global, e mantê-la
        // sob uma janela roubaria o clique dela.
        this._setTracked(Meta.is_wayland_compositor() || !blocker, blocker);
    }

    _setTracked(shouldTrack, blocker = null) {
        if (this._tracked === shouldTrack)
            return;
        this._tracked = shouldTrack;

        // Registrado sempre (não só em depuração): é o que permite descobrir,
        // pelo journal, por que um clique não chegou ao widget.
        const [x, y] = this.get_position();
        const [w, h] = this.get_size();
        Log.debug(`região de entrada ${shouldTrack ? 'ativada' : 'liberada'} — ` +
            `camada ${this._settings.get_string('widget-layer')}, ` +
            `widget ${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}` +
            (blocker ? `, coberto por "${blocker}"` : ''));
        if (shouldTrack) {
            Main.layoutManager.trackChrome(this, {
                affectsInputRegion: true,
                affectsStruts: false,
                trackFullscreen: true,
            });
        } else {
            Main.layoutManager.untrackChrome(this);
        }
    }

    /**
     * Alguma janela visível se sobrepõe ao widget?
     *
     * Só interessa no X11, onde a região de entrada do stage decide se o
     * clique chega ao Shell ou atravessa para a janela de baixo (no Wayland
     * `_updateRegions()` nem monta a região: `!Meta.is_wayland_compositor()`).
     */
    _findCoveringWindow() {
        const [x, y] = this.get_position();
        let [width, height] = this.get_size();
        // Antes da primeira alocação o tamanho é 0; usar o preferido evita
        // concluir "nada cobre o widget" só porque ele ainda não tem área.
        if (width <= 0 || height <= 0) {
            [, width] = this.get_preferred_width(-1);
            [, height] = this.get_preferred_height(width);
        }

        const workspace = global.workspace_manager.get_active_workspace();

        const covering = global.get_window_actors().find(actor => {
            const window = actor.meta_window;
            if (!window || !actor.visible)
                return false;

            // showing_on_its_workspace() cobre minimizada E o modo "mostrar
            // área de trabalho". Testar só `window.minimized`, como antes,
            // deixava o widget sem região de entrada mesmo com as janelas
            // recolhidas — ou seja, nenhum clique funcionava nunca.
            if (!window.showing_on_its_workspace() ||
                !window.located_on_workspace(workspace))
                return false;

            // A janela de ícones da área de trabalho ocupa a tela inteira e
            // está sempre presente; tratá-la como "cobrindo" desligaria o
            // widget permanentemente.
            if (window.get_window_type() === Meta.WindowType.DESKTOP ||
                window.is_override_redirect())
                return false;

            const rect = window.get_frame_rect();
            return rect.x < x + width && rect.x + rect.width > x &&
                   rect.y < y + height && rect.y + rect.height > y;
        });

        return covering ? covering.meta_window.get_title() ?? '(sem título)' : null;
    }

    /**
     * Altura fixa da lista de eventos.
     *
     * Sem isto o widget mudava de tamanho conforme o dia selecionado tivesse
     * mais ou menos eventos — medido no journal: 434px num dia vazio, 477px
     * num dia com um evento. Como a área de eventos só tem conteúdo quando há
     * uma conta conectada, o efeito aparecia apenas com o usuário logado.
     *
     * Fixado no ator, e não via `max-height` no CSS, pelo mesmo motivo da
     * grade: no St o CSS é preferência, não trava.
     */
    _applyListHeight() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = this._settings.get_int('event-list-height');
        this._scroll.set_height(height * scale);
    }

    _applyOpacity() {
        const percent = Math.min(100, Math.max(20, this._settings.get_int('widget-opacity')));
        this._background.opacity = Math.round(255 * percent / 100);
    }

    _restorePosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        let x = this._settings.get_int('widget-x');
        let y = this._settings.get_int('widget-y');

        if (monitor) {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            [x, y] = this._clampToWorkArea(x, y, workArea);
        }
        this.set_position(x, y);
    }

    _clampToWorkArea(x, y, workArea) {
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
        const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);
        return [
            Math.round(Math.min(Math.max(x, workArea.x), maxX)),
            Math.round(Math.min(Math.max(y, workArea.y), maxY)),
        ];
    }

    /* ══════════════════════ Arrastar ══════════════════════ */

    /**
     * Arrastar começa em qualquer ponto do cabeçalho — inclusive em cima dos
     * botões — e só depois que o ponteiro passa do limiar de arraste do
     * sistema.  Um clique continua sendo clique.
     *
     * Precisa da fase de captura porque St.Button consome
     * 'button-press-event': com um handler comum no cabeçalho, a única área
     * arrastável eram os poucos pixels de padding em volta dos botões.
     */
    _onCapturedEvent(_actor, event) {
        switch (event.type()) {
        case Clutter.EventType.BUTTON_PRESS:
            return this._onPress(event);
        case Clutter.EventType.MOTION:
            return this._onMotion(event);
        case Clutter.EventType.BUTTON_RELEASE:
            return this._onRelease();
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _onPress(event) {
        const [pointerX, pointerY] = event.get_coords();

        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        }

        if (event.get_button() !== Clutter.BUTTON_PRIMARY ||
            !this._isInsideHeader(pointerX, pointerY))
            return Clutter.EVENT_PROPAGATE;

        const [widgetX, widgetY] = this.get_position();
        this._press = {
            pointerX,
            pointerY,
            offsetX: pointerX - widgetX,
            offsetY: pointerY - widgetY,
        };

        // Propaga: sem arraste, o botão sob o cursor ainda tem de funcionar.
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Teste geométrico contra a área do cabeçalho.
     *
     * Não dá para perguntar ao evento quem é o ator alvo: no Clutter 14 os
     * eventos são imutáveis e `get_source()` devolve null — chamar
     * `header.contains(null)` lançava "Argument descendant may not be null"
     * em toda pressão, o que matava o arraste inteiro.
     */
    _isInsideHeader(x, y) {
        const [headerX, headerY] = this._header.get_transformed_position();
        const [width, height] = this._header.get_transformed_size();
        return x >= headerX && x < headerX + width &&
               y >= headerY && y < headerY + height;
    }

    _onMotion(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;

        const [pointerX, pointerY] = event.get_coords();

        if (!this._dragGrab) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const threshold = St.Settings.get().drag_threshold * scale;
            if (Math.hypot(pointerX - this._press.pointerX,
                pointerY - this._press.pointerY) < threshold)
                return Clutter.EVENT_PROPAGATE;
            this._beginDrag();
        }

        this._moveTo(pointerX - this._press.offsetX, pointerY - this._press.offsetY);
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;

        const wasDragging = !!this._dragGrab;
        this._press = null;

        if (!wasDragging)
            return Clutter.EVENT_PROPAGATE;

        this._releaseDragGrab();
        this._savePosition();
        this._updateInputTracking();

        // Engole o release para o botão sob o cursor não disparar 'clicked'
        // ao fim de um arraste.
        return Clutter.EVENT_STOP;
    }

    _beginDrag() {
        // Sem isto o botão que recebeu a pressão fica travado no visual
        // "apertado", já que o release será engolido.
        this._fakeReleasePressedButton();

        // Sem um grab explícito os eventos de movimento param de chegar assim
        // que o ponteiro sai do cabeçalho.
        this._dragGrab = global.stage.grab(this);
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
    }

    _fakeReleasePressedButton() {
        if (!this._press)
            return;
        const picked = global.stage.get_actor_at_pos(
            Clutter.PickMode.REACTIVE, this._press.pointerX, this._press.pointerY);

        for (let actor = picked; actor && actor !== this; actor = actor.get_parent()) {
            if (typeof actor.fake_release === 'function') {
                actor.fake_release();
                return;
            }
        }
    }

    _moveTo(x, y) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            [x, y] = this._clampToWorkArea(x, y, workArea);
        }
        this.set_position(x, y);
    }

    _releaseDragGrab() {
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        this._updateCursor();
    }

    /** Cursor de mover enquanto o ponteiro está sobre a área de arraste. */
    _updateCursor() {
        if (this._destroyed)
            return;
        global.display.set_cursor(this._header.hover && !this._dragGrab
            ? Meta.Cursor.MOVE_OR_RESIZE_WINDOW
            : Meta.Cursor.DEFAULT);
    }

    _savePosition() {
        const [x, y] = this.get_position();
        // set_int só grava se o valor mudou, então isso não gera escrita à toa.
        this._settings.set_int('widget-x', x);
        this._settings.set_int('widget-y', y);
    }

    /* ══════════════════════ Destruição ══════════════════════ */

    destroy() {
        if (this._destroyed) {
            super.destroy();
            return;
        }
        this._destroyed = true;

        this._press = null;
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._savePosition();

        for (const {object, id} of this._signals) {
            try {
                object.disconnect(id);
            } catch (err) {
                Log.debug('sinal já desconectado:', err.message);
            }
        }
        this._signals = [];

        this._dialog?.destroy();
        this._dialog = null;

        this._menu?.close();
        this._menu?.destroy();
        this._menu = null;
        this._menuManager = null;

        // O widget pode estar em uiGroup ou em window_group conforme a camada;
        // soltar o rastreamento e deixar o Clutter desfazer o parentesco cobre
        // os dois casos.
        this._setTracked(false);
        this._parentGroup = null;
        super.destroy();
    }
});
