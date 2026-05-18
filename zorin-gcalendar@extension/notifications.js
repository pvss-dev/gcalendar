/**
 * notifications.js — Notificações GNOME para eventos iminentes
 */
import GLib from 'gi://GLib';
import Gio  from 'gi://Gio';
import { truncate, minutesUntil, eventStart } from './utils.js';

export class NotificationManager {
    constructor(mgr, settings) {
        this._mgr      = mgr;
        this._cfg      = settings;
        this._notified = new Set();
        this._timer    = null;
        this._app      = Gio.Application.get_default()
            ?? new Gio.Application({ application_id: 'org.gnome.shell' });
    }

    start() {
        this.stop();
        this._check();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._check(); return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
    }

    _check() {
        const mins     = this._cfg.get_int('notification-minutes-before');
        const upcoming = this._mgr.getImminent(mins + 1);
        for (const ev of upcoming) {
            const { value } = eventStart(ev);
            const key = `${ev.id}-${value}`;
            if (this._notified.has(key)) continue;
            const m = minutesUntil(value);
            if (m < 0 || m > mins) continue;
            this._send(ev, m);
            this._notified.add(key);
        }
    }

    _send(ev, mins) {
        const title   = truncate(ev.summary ?? 'Evento sem título', 80);
        const when    = mins === 0 ? 'agora' : `em ${mins} min`;
        const notif   = new Gio.Notification();
        notif.set_title(title);
        notif.set_body(`⏰ Começa ${when}` + (ev.location ? `\n📍 ${truncate(ev.location, 50)}` : ''));
        notif.set_priority(Gio.NotificationPriority.HIGH);
        if (ev.htmlLink)
            notif.add_button_with_target('Abrir', 'app.open-event',
                new (imports.gi.GLib.Variant)('s', ev.htmlLink));
        this._app.send_notification(`gcal-${ev.id}`, notif);
    }
}
