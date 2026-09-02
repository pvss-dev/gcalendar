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
import {isCancelled} from './lib/errors.js';
import {HttpClient} from './lib/http.js';
import {SecretStore, migrateFromSettings} from './lib/secretStore.js';
import {GoogleAuth} from './lib/googleAuth.js';
import {GoogleCalendarApi} from './lib/googleCalendarApi.js';
import {CalendarService} from './lib/calendarService.js';
import {EventStore} from './lib/eventStore.js';
import {NotificationManager} from './lib/notificationManager.js';
import {DesktopWidget} from './ui/desktopWidget.js';

export default class ZorinGCalendarExtension extends Extension {

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._settings = this.getSettings();

        // Toda inicialização assíncrona pertence a esta "geração"; se o
        // disable() acontecer no meio dela, o resultado é descartado.
        this._generation = (this._generation ?? 0) + 1;
        const generation = this._generation;

        try {
            this._http = new HttpClient({timeout: 20, cancellable: this._cancellable});
            this._secrets = new SecretStore(this._cancellable);

            this._auth = new GoogleAuth({
                settings: this._settings,
                secrets: this._secrets,
                http: this._http,
                cancellable: this._cancellable,
            });

            const api = new GoogleCalendarApi({
                auth: this._auth,
                http: this._http,
                cancellable: this._cancellable,
            });
            const service = new CalendarService(api);

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
                this._settings.connect('changed::client-id',
                    () => this._auth?.emit('state-changed')),
                // As preferências rodam em outro processo: é por esta chave
                // que elas pedem a desconexão completa da conta.
                this._settings.connect('changed::sign-out-requested', () => {
                    if (this._settings.get_int64('sign-out-requested') > 0)
                        this._signOut();
                }),
            ];

            this._initAsync(generation);
            Log.info(`habilitada — build ${this._buildStamp()}`);
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
        this._secrets = null;
        this._settings = null;
        this._cancellable = null;

        Log.debug('extensão desabilitada');
    }

    /**
     * Carimbo gravado pelo install.sh.
     *
     * O GNOME cacheia os módulos ESM: re-habilitar a extensão NÃO recarrega o
     * código, só logout/login. Registrar o build no journal é o que permite
     * saber se o Shell já está rodando a versão instalada.
     */
    _buildStamp() {
        try {
            const file = this.dir.get_child('BUILD');
            const [ok, contents] = file.load_contents(null);
            if (ok)
                return new TextDecoder().decode(contents).trim();
        } catch {
            // Instalação sem carimbo (cópia manual, por exemplo).
        }
        return 'desconhecido';
    }

    async _signOut() {
        try {
            await this._auth?.signOut();
            this._settings?.set_int64('sign-out-requested', 0);
        } catch (err) {
            if (!isCancelled(err))
                Log.error(err, 'desconectar');
        }
    }

    /** Carrega segredos e sobe os serviços; roda depois do enable() retornar. */
    async _initAsync(generation) {
        try {
            await migrateFromSettings(this._settings, this._secrets);
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
