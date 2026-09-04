/**
 * goaAuth.js — autenticação via GNOME Online Accounts.
 *
 * A extensão não tem credenciais próprias: o token vem do cliente OAuth que o
 * próprio GNOME já mantém registrado e verificado no Google.
 *
 * Por que não embutir um client id/secret na extensão:
 *   • os escopos de Calendar são "sensíveis" para o Google, então um app não
 *     verificado fica limitado a 100 usuários e mostra a tela de aviso;
 *   • a cota da API seria compartilhada por todos os usuários da extensão;
 *   • num projeto open-source, as credenciais ficariam públicas de qualquer
 *     forma (num cliente "Desktop app" o secret não é confidencial — RFC 8252
 *     §8.5, mas ainda assim é o identificador do *seu* projeto).
 *
 * O GOA também cuida da renovação: `call_get_access_token()` devolve um token
 * válido, renovando quando necessário.
 */
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Goa from 'gi://Goa';

import * as Log from './log.js';
import {AuthError, ConfigError, isCancelled} from './errors.js';

Gio._promisify(Goa.Client, 'new', 'new_finish');
Gio._promisify(Goa.OAuth2Based.prototype,
    'call_get_access_token', 'call_get_access_token_finish');
Gio._promisify(Goa.Account.prototype,
    'call_ensure_credentials', 'call_ensure_credentials_finish');

const SETTINGS_PANEL = 'gnome-online-accounts-panel.desktop';

/**
 * Uma conta Google do GOA com calendário habilitado.
 *
 * Cada agenda pertence a uma conta, e é a conta que fornece o token — por
 * isso o objeto viaja junto com as chamadas à API em vez de haver um único
 * token global.
 */
class GoaAccount {
    constructor(object) {
        this._object = object;
    }

    get id() {
        return this._object.get_account().id;
    }

    get email() {
        return this._object.get_account().presentation_identity;
    }

    /** @returns {Promise<string>} token válido, renovado pelo GOA se preciso */
    async getAccessToken() {
        const oauth2 = this._object.get_oauth2_based();
        if (!oauth2)
            throw new AuthError(`A conta ${this.email} não expõe OAuth2.`);

        try {
            const [token] = await oauth2.call_get_access_token(null);
            return token;
        } catch (err) {
            if (isCancelled(err))
                throw err;
            throw new AuthError(
                `Não foi possível obter o token de ${this.email}: ${err.message}`,
                {cause: err});
        }
    }

    /** Pede ao GOA para revalidar a conta (usado após um 401). */
    async ensureCredentials() {
        try {
            await this._object.get_account().call_ensure_credentials(null);
        } catch (err) {
            if (!isCancelled(err))
                Log.debug(`ensure_credentials falhou para ${this.email}:`, err.message);
        }
    }
}

export const GoaAuth = GObject.registerClass({
    Signals: {
        /** Emitido quando contas são adicionadas, removidas ou alteradas. */
        'state-changed': {},
    },
}, class GoaAuth extends GObject.Object {
    constructor({cancellable} = {}) {
        super();
        this._cancellable = cancellable;
        this._client = null;
        this._signalIds = [];
        this._destroyed = false;
    }

    /** Conecta ao serviço do GOA. Chamar uma vez no enable(). */
    async load() {
        try {
            this._client = await Goa.Client.new(this._cancellable);
        } catch (err) {
            if (isCancelled(err))
                return;
            Log.error(err, 'GNOME Online Accounts');
            this.emit('state-changed');
            return;
        }

        if (this._destroyed) {
            this._client = null;
            return;
        }

        for (const signal of ['account-added', 'account-removed', 'account-changed']) {
            this._signalIds.push(
                this._client.connect(signal, () => this.emit('state-changed')));
        }
        this.emit('state-changed');
    }

    /** O serviço do GOA está disponível? */
    get isConfigured() {
        return this._client !== null;
    }

    /** Existe ao menos uma conta Google com calendário habilitado? */
    get isAuthenticated() {
        return this.getCalendarAccounts().length > 0;
    }

    /** @returns {GoaAccount[]} */
    getCalendarAccounts() {
        if (!this._client)
            return [];

        return this._client.get_accounts()
            .filter(object => {
                const account = object.get_account();
                return account.provider_type === 'google' &&
                       !account.calendar_disabled &&
                       object.get_oauth2_based() !== null;
            })
            .map(object => new GoaAccount(object));
    }

    /** Conta Google presente, porém com o calendário desligado nas Contas Online. */
    hasAccountWithCalendarDisabled() {
        if (!this._client)
            return false;
        return this._client.get_accounts().some(object => {
            const account = object.get_account();
            return account.provider_type === 'google' && account.calendar_disabled;
        });
    }

    /**
     * Abre Configurações → Contas Online.
     *
     * Adicionar ou remover conta é ação do sistema, não da extensão: assim o
     * usuário concede o acesso uma vez e todo o GNOME aproveita.
     */
    openAccountSettings() {
        const app = Gio.DesktopAppInfo.new(SETTINGS_PANEL);
        try {
            if (app) {
                app.launch([], null);
                return;
            }
            Gio.Subprocess.new(['gnome-control-center', 'online-accounts'],
                Gio.SubprocessFlags.NONE);
        } catch (err) {
            Log.error(err, 'abrir Contas Online');
            throw new ConfigError(
                'Não foi possível abrir as Contas Online. Abra Configurações → Contas Online.');
        }
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._signalIds)
            this._client?.disconnect(id);
        this._signalIds = [];
        this._client = null;
    }
});
