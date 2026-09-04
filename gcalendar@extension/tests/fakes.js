/**
 * fakes.js — dublês para testar o EventStore sem rede nem GNOME Shell.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {normalizeEvent, normalizeCalendar} from '../lib/calendarService.js';

/** Gio.Settings a partir do schema compilado do repositório. */
export function makeSettings(schemasDir) {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemasDir, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup('org.gnome.shell.extensions.zorin-gcalendar', true);
    if (!schema)
        throw new Error(`schema não encontrado em ${schemasDir} — rode glib-compile-schemas`);

    // Backend em memória: os testes não tocam no dconf do usuário.
    return new Gio.Settings({
        settings_schema: schema,
        backend: Gio.memory_settings_backend_new(),
    });
}

export const FakeAuth = GObject.registerClass({
    Signals: {'state-changed': {}},
}, class FakeAuth extends GObject.Object {
    constructor({authenticated = true, configured = true} = {}) {
        super();
        this._authenticated = authenticated;
        this._configured = configured;
    }

    get isAuthenticated() {
        return this._authenticated;
    }

    get isConfigured() {
        return this._configured;
    }

    setAuthenticated(value) {
        this._authenticated = value;
        this.emit('state-changed');
    }
});

/** Implementa a mesma interface de CalendarService, com respostas roteirizadas. */
export class FakeService {
    constructor({calendars = [], events = [], errors = []} = {}) {
        this.calendars = calendars.map(normalizeCalendar);
        this.rawEvents = events;
        this.errors = errors;
        this.listCalls = 0;
        this.calendarCalls = 0;
        this.failNextListWith = null;
        this.deleted = [];
        this.created = [];
    }

    async listCalendars() {
        this.calendarCalls++;
        if (this.failNextListWith) {
            const err = this.failNextListWith;
            this.failNextListWith = null;
            throw err;
        }
        return this.calendars;
    }

    async listEvents(calendarIds, from, to) {
        this.listCalls++;
        this.lastRange = {from, to};
        if (this.failNextListWith) {
            const err = this.failNextListWith;
            this.failNextListWith = null;
            throw err;
        }
        const byId = new Map(this.calendars.map(c => [c.id, c]));
        const events = this.rawEvents
            .filter(({calendarId}) => calendarIds.includes(calendarId))
            .map(({calendarId, raw}) => normalizeEvent(raw, byId.get(calendarId) ?? {id: calendarId}));
        return {events, errors: this.errors};
    }

    async createEvent(calendarId, draft) {
        this.created.push({calendarId, draft});
        return normalizeEvent({
            id: `new-${this.created.length}`,
            summary: draft.title,
            start: draft.allDay ? {date: isoDay(draft.start)} : {dateTime: draft.start.toISOString()},
            end: draft.allDay ? {date: isoDay(nextDay(draft.end))} : {dateTime: draft.end.toISOString()},
        }, this.calendars.find(c => c.id === calendarId) ?? {id: calendarId});
    }

    async updateEvent(calendarId, eventId, draft) {
        return normalizeEvent({
            id: eventId,
            summary: draft.title,
            start: {dateTime: draft.start.toISOString()},
            end: {dateTime: draft.end.toISOString()},
        }, this.calendars.find(c => c.id === calendarId) ?? {id: calendarId});
    }

    async deleteEvent(calendarId, eventId) {
        this.deleted.push(`${calendarId}:${eventId}`);
    }

    getCalendar(id) {
        return this.calendars.find(c => c.id === id) ?? null;
    }
}

export function makeTempDir(prefix = 'gcal-test') {
    return GLib.dir_make_tmp(`${prefix}-XXXXXX`);
}

export function removeDir(path) {
    const dir = Gio.File.new_for_path(path);
    try {
        const children = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null)) !== null)
            dir.get_child(info.get_name()).delete(null);
        dir.delete(null);
    } catch {
        // Diretório temporário some com o /tmp; falha aqui não invalida teste.
    }
}

function isoDay(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function nextDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}
