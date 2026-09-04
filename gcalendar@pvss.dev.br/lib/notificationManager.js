/**
 * notificationManager.js — avisos de eventos próximos.
 *
 * Usa MessageTray, a API de notificações do próprio Shell.  A versão anterior
 * criava um `Gio.Application` falso com o id 'org.gnome.shell' e chamava
 * `send_notification()` nele — a aplicação nunca era registrada no D-Bus, e a
 * linha `imports.gi.GLib` (objeto `imports` que não existe em extensões ESM
 * desde o GNOME 45) lançava ReferenceError em todo evento com link.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Log from './log.js';
import {TimerPool} from './async.js';
import {truncate, formatTime, MS_PER_DAY} from './utils.js';
import {selectDueNotifications, pruneNotified} from './notificationRules.js';

const CHECK_INTERVAL_SECONDS = 60;
const NOTIFIED_TTL_MS = MS_PER_DAY;

export class NotificationManager {
    constructor({store, settings}) {
        this._store = store;
        this._settings = settings;
        this._timers = new TimerPool();
        this._notified = new Map();   // chave do evento → quando foi avisado
        this._source = null;
        this._sourceDestroyId = 0;
        this._storeId = 0;
    }

    start() {
        this._storeId = this._store.connect('changed', () => this._check());
        this._timers.addSeconds(CHECK_INTERVAL_SECONDS, () => {
            this._check();
            return GLib.SOURCE_CONTINUE;
        });
        this._check();
    }

    destroy() {
        this._timers.destroy();
        if (this._storeId) {
            this._store.disconnect(this._storeId);
            this._storeId = 0;
        }
        this._destroySource();
        this._notified.clear();
    }

    /* ══════════════════════ Interno ══════════════════════ */

    _check() {
        if (!this._settings.get_boolean('notifications-enabled'))
            return;

        const leadMinutes = this._settings.get_int('notification-minutes-before');
        const now = Date.now();
        pruneNotified(this._notified, now, NOTIFIED_TTL_MS);

        const due = selectDueNotifications({
            events: this._store.getImminentEvents(leadMinutes),
            leadMinutes,
            now,
            notified: this._notified,
        });

        for (const {event, key, minutesLeft} of due) {
            this._notify(event, minutesLeft);
            this._notified.set(key, now);
        }
    }

    _ensureSource() {
        if (this._source)
            return this._source;

        this._source = new MessageTray.Source({
            title: 'Google Agenda',
            iconName: 'x-office-calendar-symbolic',
        });
        // O Shell destrói a fonte quando ela fica sem notificações; sem soltar
        // a referência aqui, a próxima notificação iria para um objeto morto.
        this._sourceDestroyId = this._source.connect('destroy', () => {
            this._source = null;
            this._sourceDestroyId = 0;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _destroySource() {
        if (!this._source)
            return;
        if (this._sourceDestroyId) {
            this._source.disconnect(this._sourceDestroyId);
            this._sourceDestroyId = 0;
        }
        this._source.destroy();
        this._source = null;
    }

    _notify(event, minutesLeft) {
        try {
            const when = minutesLeft <= 0
                ? 'Começando agora'
                : `Começa em ${minutesLeft} min · ${formatTime(event.start)}`;

            const lines = [when];
            if (event.location)
                lines.push(truncate(event.location, 60));

            const notification = new MessageTray.Notification({
                source: this._ensureSource(),
                title: truncate(event.title, 80),
                body: lines.join('\n'),
                gicon: new Gio.ThemedIcon({name: 'x-office-calendar-symbolic'}),
                urgency: MessageTray.Urgency.HIGH,
            });

            if (event.htmlLink) {
                notification.addAction('Abrir no navegador', () => {
                    try {
                        Gio.AppInfo.launch_default_for_uri(event.htmlLink, null);
                    } catch (err) {
                        Log.warn('não foi possível abrir o link do evento:', err.message);
                    }
                });
            }

            this._ensureSource().addNotification(notification);
            Log.debug(`notificação enviada: "${event.title}" ` +
                `(faltam ${minutesLeft} min)`);
        } catch (err) {
            Log.error(err, 'notificação');
        }
    }
}
