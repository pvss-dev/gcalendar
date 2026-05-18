/**
 * eventManager.js — Cache local, loop de sync, facade CRUD
 */
import GLib from 'gi://GLib';

export class EventManager {
    constructor(api, settings, onChanged) {
        this._api      = api;
        this._settings = settings;
        this._onChange = onChanged;
        this._events     = [];
        this._calendars  = [];
        this._timer      = null;
        this._syncing    = false;
    }

    start() {
        this._arm();
        this.sync().catch(e => console.warn('[GCalendar] sync inicial:', e.message));
    }

    stop() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
    }

    getEvents()    { return this._events;    }
    getCalendars() { return this._calendars; }

    /** Eventos que começam entre agora e +minutes. */
    getImminent(minutes = 15) {
        const now = Date.now(), limit = now + minutes * 60_000;
        return this._events.filter(ev => {
            const t = new Date(ev.start?.dateTime ?? ev.start?.date).getTime();
            return t >= now && t <= limit;
        });
    }

    /** Eventos de um determinado dia (Date). */
    getEventsForDay(date) {
        return this._events.filter(ev => {
            const { value } = eventStart(ev);
            const s = new Date(value);
            return s.getFullYear() === date.getFullYear() &&
                   s.getMonth()    === date.getMonth()    &&
                   s.getDate()     === date.getDate();
        });
    }

    /** Conjunto de dias que têm pelo menos 1 evento (para marcar no calendário). */
    getDaysWithEvents() {
        const set = new Set();
        for (const ev of this._events) {
            const { value } = eventStart(ev);
            const d = new Date(value);
            set.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
        }
        return set;
    }

    async createEvent(calId, body) {
        const r = await this._api.createEvent(calId, body);
        await this.sync(); return r;
    }
    async updateEvent(calId, evId, patch) {
        const r = await this._api.updateEvent(calId, evId, patch);
        await this.sync(); return r;
    }
    async deleteEvent(calId, evId) {
        await this._api.deleteEvent(calId, evId);
        this._events = this._events.filter(
            ev => !(ev.id === evId && ev._calendarId === calId)
        );
        this._onChange();
    }

    async sync() {
        if (this._syncing) return;
        this._syncing = true;
        try {
            this._calendars = await this._api.listCalendars();
            const enabled   = this._settings.get_strv('enabled-calendars');
            const ids        = enabled.length ? enabled : this._calendars.map(c => c.id);
            this._events     = await this._api.listUpcomingEvents(ids, this._settings.get_int('days-ahead'));
            this._settings.set_int64('last-sync', Math.floor(Date.now() / 1000));
            this._onChange();
        } catch (e) {
            console.warn('[GCalendar] sync error:', e.message);
        } finally {
            this._syncing = false;
        }
    }

    _arm() {
        this.stop();
        const ms = Math.max(1, this._settings.get_int('sync-interval')) * 60_000;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, ms, () => {
            this.sync().catch(() => {});
            return GLib.SOURCE_CONTINUE;
        });
        this._settings.connect('changed::sync-interval', () => this._arm());
    }
}

function eventStart(ev) {
    if (ev.start?.dateTime) return { value: ev.start.dateTime };
    if (ev.start?.date)     return { value: ev.start.date     };
    return { value: '' };
}
