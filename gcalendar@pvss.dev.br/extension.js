/**
 * extension.js — ponto de entrada e composition root.
 *
 * GNOME Shell 46/47 (ES Modules, classe Extension).  Aqui só se monta o grafo
 * de dependências e se gerencia o ciclo de vida; nenhuma regra de negócio.
 *
 * Regra do enable()/disable(): tudo que é criado no enable() é destruído no
 * disable(), e nenhuma operação assíncrona sobrevive ao disable() — daí o
 * Gio.Cancellable compartilhado, que aborta requisições HTTP em voo, o
 * servidor de loopback do OAuth e as esperas de retentativa.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Log from './lib/log.js';
import {BUILD} from './lib/build.js';
import {isCancelled} from './lib/errors.js';
import {HttpClient} from './lib/http.js';
import {clearLegacySecrets} from './lib/secretStore.js';
import {GoaAuth} from './lib/goaAuth.js';
import {GoogleCalendarApi} from './lib/googleCalendarApi.js';
import {CalendarService} from './lib/calendarService.js';
import {EventStore} from './lib/eventStore.js';
import {NotificationManager} from './lib/notificationManager.js';
import {DesktopWidget} from './ui/desktopWidget.js';

export default class ZorinGCalendarExtension extends Extension {

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._settings = this.getSettings();
        Log.setDebugEnabled(this._settings.get_boolean('debug-logging'));

        // Toda inicialização assíncrona pertence a esta "geração"; se o
        // disable() acontecer no meio dela, o resultado é descartado.
        this._generation = (this._generation ?? 0) + 1;
        const generation = this._generation;

        try {
            this._http = new HttpClient({timeout: 20, cancellable: this._cancellable});

            // Sem credenciais próprias: o token vem do GNOME Online Accounts.
            this._auth = new GoaAuth({cancellable: this._cancellable});

            const api = new GoogleCalendarApi({
                http: this._http,
                cancellable: this._cancellable,
            });
            const service = new CalendarService({api, auth: this._auth});

            this._store = new EventStore({
                service,
                auth: this._auth,
                settings: this._settings,
                cancellable: this._cancellable,
                cacheDir: GLib.build_filenamev([GLib.get_user_cache_dir(), this.uuid]),
            });

            this._notifications = new NotificationManager({
                store: this._store,
                settings: this._settings,
            });

            this._widget = new DesktopWidget({
                store: this._store,
                auth: this._auth,
                settings: this._settings,
                extension: this,
            });

            // Mudar o Client ID nas preferências deve refletir no widget na hora.
            this._settingsSignals = [
                this._settings.connect('changed::debug-logging', () =>
                    Log.setDebugEnabled(this._settings.get_boolean('debug-logging'))),
            ];

            this._initAsync(generation);
            Log.debug(`habilitada — build ${BUILD}`);
        } catch (err) {
            Log.error(err, 'enable');
            this.disable();
        }
    }

    disable() {
        this._cancellable?.cancel();

        for (const id of this._settingsSignals ?? [])
            this._settings?.disconnect(id);
        this._settingsSignals = [];

        // Ordem inversa da criação: a UI primeiro, para não renderizar em
        // cima de um store já desmontado.
        this._widget?.destroy();
        this._notifications?.destroy();
        this._store?.destroy();
        this._auth?.destroy();
        this._http?.destroy();

        this._widget = null;
        this._notifications = null;
        this._store = null;
        this._auth = null;
        this._http = null;
        this._settings = null;
        this._cancellable = null;

        Log.debug('extensão desabilitada');
    }

    /** Conecta ao GOA e sobe os serviços; roda depois do enable() retornar. */
    async _initAsync(generation) {
        try {
            // Versões anteriores guardavam client secret e refresh token no
            // keyring. Com o GOA nada disso é usado; limpa o resíduo.
            await clearLegacySecrets(this._settings);
            if (this._generation !== generation)
                return;

            await this._auth.load();
            if (this._generation !== generation)
                return;

            this._store.start();
            this._notifications.start();
        } catch (err) {
            if (isCancelled(err) || this._generation !== generation)
                return;
            Log.error(err, 'inicialização');
        }
    }
}
