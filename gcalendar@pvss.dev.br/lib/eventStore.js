/**
 * eventStore.js — estado do calendário: cache, índice por dia, laço de sync.
 *
 * É a única fonte de verdade que a UI consulta.  Expõe sinais GObject em vez
 * de callbacks soltos, para que cada view conecte e desconecte no seu próprio
 * ciclo de vida.
 *
 * Diferenças relevantes em relação à versão anterior:
 *   • busca pelo intervalo realmente visível (navegar para outro mês carrega
 *     aquele mês), não só "de agora até +N dias";
 *   • índice por dia cobre todos os dias que o evento ocupa;
 *   • o sinal `changed::sync-interval` é conectado uma única vez (antes era
 *     reconectado dentro do próprio handler, multiplicando as conexões);
 *   • cache em disco para o widget não ficar vazio offline;
 *   • erros viram estado observável, em vez de sumirem num console.warn.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Log from './log.js';
import {AuthError, ConfigError, isCancelled} from './errors.js';
import {TimerPool} from './async.js';
import {compareEvents} from './calendarService.js';
import {
    dayKey, startOfDay, addDays, startOfMonth, endOfMonth, MS_PER_DAY,
} from './utils.js';

export const SyncState = {
    IDLE: 'idle',
    SYNCING: 'syncing',
    ERROR: 'error',
    UNAUTHENTICATED: 'unauthenticated',
    UNCONFIGURED: 'unconfigured',
};

const CACHE_MAX_AGE_MS = 7 * MS_PER_DAY;
const CACHE_FILE = 'events.json';
const MONTH_PADDING_DAYS = 7;   // cobre as células vizinhas mostradas na grade

export const EventStore = GObject.registerClass({
    Signals: {
        'changed': {},          // eventos ou agendas mudaram
        'status-changed': {},   // estado de sincronização mudou
    },
}, class EventStore extends GObject.Object {
    constructor({service, auth, settings, cancellable, cacheDir}) {
        super();
        this._service = service;
        this._auth = auth;
        this._settings = settings;
        this._cancellable = cancellable;
        this._cacheDir = cacheDir;

        this._timers = new TimerPool();
        this._settingsIds = [];
        this._authId = 0;

        this._events = new Map();       // "calendarId:eventId" → evento
        this._index = new Map();        // "YYYY-MM-DD" → evento[]
        this._calendars = [];
        this._loadedRanges = [];        // [{from: ms, to: ms}] mesclados

        this._state = SyncState.IDLE;
        this._error = null;
        this._lastSync = 0;
        this._syncPromise = null;
        this._queuedRange = null;
        this._syncTimerId = 0;
        this._visibleRange = null;
        this._destroyed = false;
    }

    /* ══════════════════════ Ciclo de vida ══════════════════════ */

    start() {
        this._loadCache();

        this._authId = this._auth.connect('state-changed', () => {
            this._updateState();
            if (this._auth.isAuthenticated)
                this.sync().catch(err => Log.debug('sync pós-login:', err.message));
            else
                this._clearEvents();
        });

        for (const key of ['sync-interval', 'enabled-calendars', 'days-ahead']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                if (key === 'sync-interval')
                    this._armSyncTimer();
                else
                    this.sync().catch(() => {});
            }));
        }

        this._armSyncTimer();
        this._updateState();

        if (this._auth.isAuthenticated)
            this.sync().catch(err => Log.debug('sync inicial:', err.message));
    }

    destroy() {
        this._destroyed = true;
        this._timers.destroy();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._authId) {
            this._auth.disconnect(this._authId);
            this._authId = 0;
        }
        this._syncPromise = null;
        this._queuedRange = null;
        this._events.clear();
        this._index.clear();
    }

    /* ══════════════════════ Consultas (usadas pela UI) ══════════════════════ */

    get state() {
        return this._state;
    }

    get error() {
        return this._error;
    }

    get lastSync() {
        return this._lastSync;
    }

    get isSyncing() {
        return this._state === SyncState.SYNCING;
    }

    getCalendars() {
        return this._calendars;
    }

    getWritableCalendars() {
        return this._calendars.filter(c => c.canWrite);
    }

    /** Agenda padrão para novos eventos. */
    getDefaultCalendar() {
        const writable = this.getWritableCalendars();
        return writable.find(c => c.primary) ?? writable[0] ?? null;
    }

    getEventsForDay(date) {
        return [...(this._index.get(dayKey(date)) ?? [])];
    }

    /** Set de "YYYY-MM-DD" com pelo menos um evento — marcadores da grade. */
    getDayKeysWithEvents() {
        return new Set(this._index.keys());
    }

    /**
     * Cores dos eventos por dia num intervalo — é o que a grade usa para os
     * marcadores, sem copiar as listas de eventos inteiras a cada render.
     * @returns {Map<string, string[]>}
     */
    getColoursByDay(from, to) {
        const colours = new Map();
        for (let day = startOfDay(from); day <= to; day = addDays(day, 1)) {
            const key = dayKey(day);
            const events = this._index.get(key);
            if (events?.length)
                colours.set(key, events.map(e => e.colour));
        }
        return colours;
    }

    /** Eventos que começam nos próximos `minutes`, para notificações. */
    getImminentEvents(minutes) {
        const now = Date.now();
        const limit = now + minutes * 60_000;
        const result = [];
        for (const event of this._events.values()) {
            if (event.allDay)
                continue;
            const t = event.start.getTime();
            if (t >= now && t <= limit)
                result.push(event);
        }
        return result.sort(compareEvents);
    }

    /* ══════════════════════ Sincronização ══════════════════════ */

    /** Informa qual mês está visível para que ele seja carregado. */
    setVisibleMonth(date) {
        const from = addDays(startOfMonth(date), -MONTH_PADDING_DAYS);
        const to = addDays(endOfMonth(date), MONTH_PADDING_DAYS);
        this._visibleRange = {from, to};

        if (this._auth.isAuthenticated && !this._isRangeLoaded(from, to))
            this.sync({range: {from, to}, keepExisting: true}).catch(() => {});
    }

    /**
     * Busca no Google e atualiza o estado.
     *
     * Chamadas concorrentes sem intervalo próprio compartilham a mesma
     * promessa.  Um pedido de intervalo específico (navegar para outro mês)
     * que chegue durante um sync fica na fila em vez de ser descartado —
     * caso contrário o mês recém-aberto ficaria vazio até o próximo ciclo.
     */
    sync({range = null, keepExisting = false} = {}) {
        if (this._syncPromise) {
            if (range)
                this._queuedRange = {range, keepExisting};
            return this._syncPromise;
        }

        this._syncPromise = this._doSync(range, keepExisting)
            .finally(() => {
                this._syncPromise = null;
                const queued = this._queuedRange;
                this._queuedRange = null;
                if (queued && !this._destroyed)
                    this.sync(queued).catch(() => {});
            });
        return this._syncPromise;
    }

    async _doSync(range, keepExisting) {
        if (this._destroyed)
            return;
        if (!this._auth.isConfigured) {
            this._setState(SyncState.UNCONFIGURED, new ConfigError('Client ID não configurado.'));
            return;
        }
        if (!this._auth.isAuthenticated) {
            this._setState(SyncState.UNAUTHENTICATED, null);
            return;
        }

        this._setState(SyncState.SYNCING, null);
        const window = range ?? this._activeWindow();

        try {
            this._calendars = await this._service.listCalendars();
            if (this._destroyed)
                return;

            const ids = this._selectedCalendarIds();
            if (ids.length === 0) {
                this._replaceEvents([], window, keepExisting);
                this._finishSync(null);
                return;
            }

            const {events, errors} = await this._service.listEvents(ids, window.from, window.to);
            if (this._destroyed)
                return;

            this._replaceEvents(events, window, keepExisting);
            this._finishSync(errors.length ? errors[0].error : null, errors);
        } catch (err) {
            if (isCancelled(err))
                return;
            this._handleSyncError(err);
        }
    }

    _finishSync(partialError, errors = []) {
        this._lastSync = Date.now();
        this._settings.set_int64('last-sync', Math.floor(this._lastSync / 1000));
        this._saveCache();

        for (const {calendarId, error} of errors)
            Log.warn(`Agenda ${calendarId} falhou:`, error.message);

        // Falha parcial ainda mostra os eventos que vieram, mas não esconde
        // que algo deu errado.
        this._setState(partialError ? SyncState.ERROR : SyncState.IDLE, partialError);
        this.emit('changed');
    }

    _handleSyncError(err) {
        Log.error(err, 'sync');
        if (err instanceof AuthError && err.needsReauth) {
            this._setState(SyncState.UNAUTHENTICATED, err);
            return;
        }
        if (err instanceof ConfigError) {
            this._setState(SyncState.UNCONFIGURED, err);
            return;
        }
        this._setState(SyncState.ERROR, err);
    }

    /** Janela sempre mantida atualizada: próximos N dias ∪ mês visível. */
    _activeWindow() {
        const days = Math.max(1, this._settings.get_int('days-ahead'));
        let from = startOfDay(new Date());
        let to = addDays(from, days);

        if (this._visibleRange) {
            if (this._visibleRange.from < from)
                from = this._visibleRange.from;
            if (this._visibleRange.to > to)
                to = this._visibleRange.to;
        }
        return {from, to};
    }

    _selectedCalendarIds() {
        const enabled = this._settings.get_strv('enabled-calendars');
        if (enabled.length === 0)
            return this._calendars.filter(c => c.selected).map(c => c.id);
        const known = new Set(this._calendars.map(c => c.id));
        return enabled.filter(id => known.has(id));
    }

    /* ══════════════════════ Escrita ══════════════════════ */

    async createEvent(calendarId, draft) {
        const event = await this._service.createEvent(calendarId, draft);
        this._upsert(event);
        this.emit('changed');
        this.sync({keepExisting: true}).catch(() => {});
        return event;
    }

    async updateEvent(calendarId, eventId, draft) {
        const event = await this._service.updateEvent(calendarId, eventId, draft);
        this._events.delete(`${calendarId}:${eventId}`);
        this._upsert(event);
        this._rebuildIndex();
        this.emit('changed');
        this.sync({keepExisting: true}).catch(() => {});
        return event;
    }

    async deleteEvent(calendarId, eventId) {
        await this._service.deleteEvent(calendarId, eventId);
        this._events.delete(`${calendarId}:${eventId}`);
        this._rebuildIndex();
        this._saveCache();
        this.emit('changed');
    }

    /* ══════════════════════ Estado interno ══════════════════════ */

    _replaceEvents(events, window, keepExisting) {
        if (!keepExisting) {
            this._events.clear();
            this._loadedRanges = [];
        } else {
            // Só descarta o que estava dentro da janela recém-buscada, para
            // que meses carregados antes continuem no cache.
            for (const [key, event] of this._events) {
                if (event.start >= window.from && event.start <= window.to)
                    this._events.delete(key);
            }
        }

        for (const event of events)
            this._events.set(`${event.calendarId}:${event.id}`, event);

        this._addLoadedRange(window.from.getTime(), window.to.getTime());
        this._rebuildIndex();
    }

    _upsert(event) {
        this._events.set(`${event.calendarId}:${event.id}`, event);
        for (const key of event.dayKeys) {
            const list = this._index.get(key) ?? [];
            list.push(event);
            list.sort(compareEvents);
            this._index.set(key, list);
        }
    }

    _rebuildIndex() {
        this._index.clear();
        for (const event of this._events.values()) {
            for (const key of event.dayKeys) {
                const list = this._index.get(key);
                if (list)
                    list.push(event);
                else
                    this._index.set(key, [event]);
            }
        }
        for (const list of this._index.values())
            list.sort(compareEvents);
    }

    /**
     * Sem sessão, nada de agenda deve continuar em disco: o cache guarda
     * título, descrição e local de cada evento, além dos nomes e IDs das
     * agendas (um deles é o próprio e-mail do usuário).
     */
    _clearEvents() {
        this._events.clear();
        this._index.clear();
        this._calendars = [];
        this._loadedRanges = [];
        this._lastSync = 0;
        this.clearCache();
        this.emit('changed');
    }

    /** Remove o cache em disco. */
    clearCache() {
        try {
            this._cacheFile().delete(null);
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                Log.warn('não foi possível apagar o cache:', err.message);
        }
    }

    /**
     * Desconexão explícita: além do cache, apaga também o que sobra em
     * GSettings e identifica o usuário — a lista de agendas escolhidas (IDs
     * que incluem endereços de e-mail) e o horário da última sincronização.
     * O Client ID é preservado: é a credencial do aplicativo, não da conta.
     */
    forgetLocalData() {
        this._clearEvents();
        this._settings.reset('enabled-calendars');
        this._settings.reset('last-sync');
        Log.debug('dados locais da conta removidos');
    }

    _addLoadedRange(from, to) {
        const ranges = [...this._loadedRanges, {from, to}]
            .sort((a, b) => a.from - b.from);
        const merged = [];
        for (const range of ranges) {
            const last = merged[merged.length - 1];
            if (last && range.from <= last.to)
                last.to = Math.max(last.to, range.to);
            else
                merged.push({...range});
        }
        this._loadedRanges = merged;
    }

    _isRangeLoaded(from, to) {
        const a = from.getTime();
        const b = to.getTime();
        return this._loadedRanges.some(r => r.from <= a && r.to >= b);
    }

    _setState(state, error) {
        if (this._state === state && this._error === error)
            return;
        this._state = state;
        this._error = error;
        this.emit('status-changed');
    }

    _updateState() {
        if (!this._auth.isConfigured)
            this._setState(SyncState.UNCONFIGURED, null);
        else if (!this._auth.isAuthenticated)
            this._setState(SyncState.UNAUTHENTICATED, null);
        else if (this._state !== SyncState.SYNCING)
            this._setState(SyncState.IDLE, null);
    }

    _armSyncTimer() {
        this._timers.remove(this._syncTimerId);
        const minutes = Math.min(60, Math.max(1, this._settings.get_int('sync-interval')));
        this._syncTimerId = this._timers.addSeconds(minutes * 60, () => {
            this.sync().catch(err => Log.debug('sync periódico:', err.message));
            return GLib.SOURCE_CONTINUE;
        }, GLib.PRIORITY_DEFAULT_IDLE);
    }

    /* ══════════════════════ Cache em disco ══════════════════════ */

    _cacheFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, CACHE_FILE]));
    }

    _saveCache() {
        try {
            GLib.mkdir_with_parents(this._cacheDir, 0o700);
            const payload = JSON.stringify({
                version: 1,
                savedAt: Date.now(),
                calendars: this._calendars,
                events: [...this._events.values()].map(serializeEvent),
            });
            const file = this._cacheFile();
            file.replace_contents(
                new TextEncoder().encode(payload), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            // O arquivo herdaria a umask (0644/0664 é o comum) e guarda
            // título, descrição e local dos eventos. Só o dono deve ler.
            file.set_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (err) {
            Log.debug('não foi possível gravar o cache:', err.message);
        }
    }

    /** Preenche o widget imediatamente ao habilitar, mesmo sem rede. */
    _loadCache() {
        try {
            const [ok, contents] = this._cacheFile().load_contents(null);
            if (!ok)
                return;
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (data.version !== 1 || Date.now() - data.savedAt > CACHE_MAX_AGE_MS)
                return;

            this._calendars = data.calendars ?? [];
            for (const raw of data.events ?? []) {
                const event = deserializeEvent(raw);
                this._events.set(`${event.calendarId}:${event.id}`, event);
            }
            this._rebuildIndex();
            this._lastSync = data.savedAt;
            Log.debug(`cache carregado: ${this._events.size} eventos`);
            this.emit('changed');
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                Log.debug('cache ignorado:', err.message);
        }
    }
});

function serializeEvent(event) {
    return {...event, start: event.start.toISOString(), end: event.end.toISOString()};
}

function deserializeEvent(raw) {
    return {...raw, start: new Date(raw.start), end: new Date(raw.end)};
}
