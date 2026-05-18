/**
 * calendarAPI.js — Wrapper da Google Calendar REST API v3
 */
import GLib from 'gi://GLib';
import Gio  from 'gi://Gio';
import Soup from 'gi://Soup';
import { buildQueryString } from './utils.js';

Gio._promisify(Soup.Session.prototype,    'send_async',       'send_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');

const BASE = 'https://www.googleapis.com/calendar/v3';

export class CalendarAPI {
    constructor(auth) {
        this._auth    = auth;
        this._session = new Soup.Session();
        this._session.timeout = 20;
    }

    async listCalendars() {
        const d = await this._get('/users/me/calendarList', {
            fields: 'items(id,summary,backgroundColor,foregroundColor,selected,primary)',
        });
        return d.items ?? [];
    }

    async listUpcomingEvents(calendarIds = ['primary'], daysAhead = 30) {
        const now    = new Date();
        const timeMin = now.toISOString();
        const timeMax = new Date(now.getTime() + daysAhead * 86_400_000).toISOString();

        const all = await Promise.all(calendarIds.map(id =>
            this._get(`/calendars/${encodeURIComponent(id)}/events`, {
                timeMin, timeMax, singleEvents: 'true',
                orderBy: 'startTime', maxResults: '100',
                fields: 'items(id,summary,description,location,start,end,colorId,htmlLink,status)',
            })
            .then(d => (d.items ?? []).map(ev => ({ ...ev, _calendarId: id })))
            .catch(() => [])
        ));

        return all.flat().sort((a, b) => {
            const ta = new Date(a.start?.dateTime ?? a.start?.date).getTime();
            const tb = new Date(b.start?.dateTime ?? b.start?.date).getTime();
            return ta - tb;
        });
    }

    async createEvent(calId, body)          { return this._post  (`/calendars/${enc(calId)}/events`, body); }
    async updateEvent(calId, evId, patch)   { return this._patch (`/calendars/${enc(calId)}/events/${enc(evId)}`, patch); }
    async deleteEvent(calId, evId)          { return this._delete(`/calendars/${enc(calId)}/events/${enc(evId)}`); }

    /* ── HTTP ── */
    async _get(path, p={}) {
        const qs = buildQueryString(p);
        return this._req('GET', `${BASE}${path}${qs?'?'+qs:''}`);
    }
    async _post(path, body)  { return this._req('POST',  `${BASE}${path}`, body); }
    async _patch(path, body) { return this._req('PATCH', `${BASE}${path}`, body); }
    async _delete(path)      { return this._req('DELETE',`${BASE}${path}`, null, true); }

    async _req(method, url, body=null, empty=false) {
        const token = await this._auth.getAccessToken();
        const msg   = Soup.Message.new(method, url);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        if (body) msg.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));

        const stream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, null);
        const status = msg.get_status();
        if (status === 204 || empty) return null;
        if (status < 200 || status >= 300)
            throw new Error(`API error HTTP ${status} — ${method} ${url}`);
        const bytes = await stream.read_bytes_async(524288, GLib.PRIORITY_DEFAULT, null);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }
}
const enc = encodeURIComponent;
