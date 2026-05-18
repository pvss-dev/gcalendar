/**
 * extension.js — Zorin GCalendar Desktop Widget
 *
 * GNOME Shell 45+ (ES Modules).  Zorin OS 18 / Ubuntu 24.04 / GNOME 46.
 *
 * Cria um widget flutuante na área de trabalho (DesktopWidget) sem
 * nenhum ícone no painel — o widget em si é o ponto de interação.
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main      from 'resource:///org/gnome/shell/ui/main.js';

import { GoogleAuth          } from './googleAuth.js';
import { CalendarAPI         } from './calendarAPI.js';
import { EventManager        } from './eventManager.js';
import { NotificationManager } from './notifications.js';
import { DesktopWidget       } from './desktopWidget.js';

export default class ZorinGCalendarExtension extends Extension {

    enable() {
        console.log('[GCalendar] Ativando…');
        try {
            this._settings   = this.getSettings();
            this._signalIds  = [];   // rastreia sinais para desconectar no disable()

            this._auth    = new GoogleAuth(this);
            this._api     = new CalendarAPI(this._auth);
            this._manager = new EventManager(
                this._api, this._settings,
                () => this._onEventsChanged()
            );
            this._notifs  = new NotificationManager(this._manager, this._settings);

            // Cria o widget na área de trabalho
            this._widget  = new DesktopWidget(
                this._auth, this._manager, this._settings, this
            );

            // ── Bug fix #1: Observa quando o usuário salva as credenciais
            //    nas preferências e atualiza o widget imediatamente.
            //    Sem isso, o botão "Entrar com Google" nunca aparecia após
            //    configurar o Client ID sem reiniciar a extensão.
            for (const key of ['client-id', 'client-secret']) {
                const id = this._settings.connect(`changed::${key}`, () => {
                    console.log(`[GCalendar] Credencial atualizada (${key}) — atualizando widget…`);
                    this._widget?.refresh();
                });
                this._signalIds.push(id);
            }

            // ── Bug fix #2: Observa quando o refresh-token é gravado
            //    (após OAuth bem-sucedido) e inicia os serviços automaticamente.
            const rtId = this._settings.connect('changed::refresh-token', () => {
                if (this._auth.isAuthenticated() && !this._manager._timer) {
                    console.log('[GCalendar] Autenticado! Iniciando sync e notificações…');
                    this._manager.start();
                    this._notifs.start();
                    this._widget?.refresh();
                }
            });
            this._signalIds.push(rtId);

            // Inicia serviços em segundo plano se já estava autenticado
            if (this._auth.isAuthenticated()) {
                this._manager.start();
                this._notifs.start();
            }

            console.log('[GCalendar] Widget criado na área de trabalho.');
        } catch (err) {
            console.error('[GCalendar] Falha ao ativar:', err.message, err.stack);
        }
    }

    disable() {
        console.log('[GCalendar] Desativando…');

        // Desconecta todos os sinais do GSettings
        for (const id of (this._signalIds ?? [])) {
            this._settings?.disconnect(id);
        }

        this._notifs?.stop();
        this._manager?.stop();
        this._widget?.destroy();

        this._signalIds = null;
        this._widget    = null;
        this._notifs    = null;
        this._manager   = null;
        this._api       = null;
        this._auth      = null;
        this._settings  = null;

        console.log('[GCalendar] Desativado.');
    }

    _onEventsChanged() {
        this._widget?.refresh();
        if (this._notifs && !this._notifs._timer) {
            this._notifs.start();
        }
    }
}
