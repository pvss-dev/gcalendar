/**
 * googleAuth.js — OAuth 2.0 Authorization Code + PKCE (RFC 7636) para apps
 * nativos, com redirecionamento de loopback (RFC 8252 §7.3).
 *
 * Por que este fluxo, e não outro:
 *   • Uma extensão do Shell não tem back-end, então não existe segredo de
 *     verdade — o "client secret" de um cliente tipo *Desktop app* é público
 *     por definição.  PKCE é o que realmente impede a interceptação do code.
 *   • O fluxo implícito está obsoleto e não devolve refresh token.
 *   • O redirect vai para 127.0.0.1 numa **porta efêmera**; a versão anterior
 *     fixava a 9004 e falhava para sempre se algo já a estivesse usando.
 *
 * O que fica guardado: só o refresh token, no GNOME Keyring.  O access token
 * vive em memória e é renovado sob demanda.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Log from './log.js';
import {AuthError, ConfigError, CancelledError, NetworkError, isCancelled} from './errors.js';
import {SecretKey} from './secretStore.js';
import {buildQueryString, parseQueryString, randomToken, sha256Base64Url} from './utils.js';

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * Menor privilégio suficiente:
 *   calendar.events    — criar, editar e excluir eventos
 *   calendar.readonly  — listar as agendas do usuário (calendarList)
 * Deliberadamente não pedimos o escopo `calendar` completo, que também
 * permitiria criar e apagar agendas inteiras e mexer em ACLs.
 */
const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

const AUTH_TIMEOUT_SECONDS = 300;
const TOKEN_EXPIRY_MARGIN_SECONDS = 120;
const MAX_REQUEST_BYTES = 16384;

export const GoogleAuth = GObject.registerClass({
    Signals: {
        /** Emitido quando o estado de "está logado" muda. */
        'state-changed': {},
    },
}, class GoogleAuth extends GObject.Object {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings
     * @param {import('./secretStore.js').SecretStore} deps.secrets
     * @param {import('./http.js').HttpClient} deps.http
     * @param {Gio.Cancellable} deps.cancellable
     */
    constructor({settings, secrets, http, cancellable}) {
        super();
        this._settings = settings;
        this._secrets = secrets;
        this._http = http;
        this._cancellable = cancellable;

        this._refreshToken = null;
        this._accessToken = null;
        this._expiresAt = 0;

        this._refreshPromise = null;
        this._signInPromise = null;
        this._listener = null;
        this._timeoutId = 0;
        this._destroyed = false;
    }

    /** Carrega o refresh token do keyring. Chamar uma vez no enable(). */
    async load() {
        this._refreshToken = await this._secrets.get(SecretKey.REFRESH_TOKEN);
        this.emit('state-changed');
    }

    get isAuthenticated() {
        return !!this._refreshToken;
    }

    get isConfigured() {
        return this._settings.get_string('client-id').trim() !== '';
    }

    /* ══════════════════════ Fluxo interativo ══════════════════════ */

    /**
     * Abre o navegador e espera o redirect.
     *
     * Chamadas simultâneas compartilham o mesmo fluxo: sem isso, um segundo
     * clique derrubava o listener do primeiro, cuja promessa então nunca
     * resolvia nem rejeitava (o timeout dela ia junto).
     */
    signIn() {
        this._signInPromise ??= this._runSignIn()
            .finally(() => (this._signInPromise = null));
        return this._signInPromise;
    }

    async _runSignIn() {
        const clientId = this._settings.get_string('client-id').trim();
        if (!clientId)
            throw new ConfigError('Client ID não configurado nas preferências.');

        this._stopListener();

        const verifier = randomToken(32);
        const state = randomToken(16);
        const challenge = sha256Base64Url(verifier);

        const {port, codePromise} = this._startListener(state);
        const redirectUri = `http://127.0.0.1:${port}`;

        const url = `${AUTH_ENDPOINT}?${buildQueryString({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: SCOPES,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            access_type: 'offline',
            // Sem isto o Google só devolve refresh token no primeiro consentimento;
            // depois de reinstalar a extensão ficaríamos sem como renovar.
            prompt: 'consent',
        })}`;

        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (err) {
            this._stopListener();
            throw new AuthError(`Não foi possível abrir o navegador: ${err.message}`,
                {cause: err, needsReauth: false});
        }

        const code = await codePromise;
        await this._exchangeCode(code, redirectUri, verifier, clientId);
        this.emit('state-changed');
    }

    async signOut() {
        const token = this._accessToken ?? this._refreshToken;
        this._accessToken = null;
        this._expiresAt = 0;
        this._refreshToken = null;
        this._stopListener();

        await this._secrets.clear(SecretKey.REFRESH_TOKEN);

        // Revogar é melhor esforço: se falhar, o token local já não existe mais.
        if (token) {
            try {
                await this._http.request('POST', REVOKE_ENDPOINT, {
                    contentType: 'application/x-www-form-urlencoded',
                    body: buildQueryString({token}),
                });
            } catch (err) {
                if (!isCancelled(err))
                    Log.warn('Revogação do token falhou:', err.message);
            }
        }
        this.emit('state-changed');
    }

    /* ══════════════════════ Tokens ══════════════════════ */

    /**
     * Access token válido, renovando se necessário.
     * Chamadas concorrentes compartilham uma única renovação.
     */
    async getAccessToken() {
        if (this._destroyed)
            throw new CancelledError('Extensão desabilitada');
        if (!this._refreshToken)
            throw new AuthError('Nenhuma conta conectada.');

        const now = Math.floor(Date.now() / 1000);
        if (this._accessToken && now < this._expiresAt - TOKEN_EXPIRY_MARGIN_SECONDS)
            return this._accessToken;

        this._refreshPromise ??= this._refreshAccessToken()
            .finally(() => (this._refreshPromise = null));
        return this._refreshPromise;
    }

    /** Invalida o token em memória para forçar renovação (usado após um 401). */
    invalidateAccessToken() {
        this._accessToken = null;
        this._expiresAt = 0;
    }

    async _refreshAccessToken() {
        const clientId = this._settings.get_string('client-id').trim();
        if (!clientId)
            throw new ConfigError('Client ID não configurado nas preferências.');
        const clientSecret = await this._secrets.get(SecretKey.CLIENT_SECRET);

        const tokens = await this._postToken({
            grant_type: 'refresh_token',
            refresh_token: this._refreshToken,
            client_id: clientId,
            client_secret: clientSecret ?? '',
        });

        this._applyTokens(tokens);
        // O Google normalmente não reemite refresh token na renovação, mas
        // quando reemite o antigo deixa de valer.
        if (tokens.refresh_token && tokens.refresh_token !== this._refreshToken) {
            this._refreshToken = tokens.refresh_token;
            await this._secrets.set(SecretKey.REFRESH_TOKEN, tokens.refresh_token);
        }
        return this._accessToken;
    }

    async _exchangeCode(code, redirectUri, verifier, clientId) {
        const clientSecret = await this._secrets.get(SecretKey.CLIENT_SECRET);

        const tokens = await this._postToken({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret ?? '',
            code_verifier: verifier,
        });

        if (!tokens.refresh_token) {
            throw new AuthError(
                'O Google não devolveu refresh token. Remova o acesso da extensão ' +
                'em myaccount.google.com/permissions e tente novamente.');
        }

        this._applyTokens(tokens);
        this._refreshToken = tokens.refresh_token;
        if (!await this._secrets.set(SecretKey.REFRESH_TOKEN, tokens.refresh_token)) {
            throw new AuthError('Não foi possível gravar o token no GNOME Keyring. ' +
                'Verifique se o chaveiro "Login" está desbloqueado.');
        }
    }

    _applyTokens(tokens) {
        this._accessToken = tokens.access_token;
        this._expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600);
    }

    async _postToken(params) {
        let data;
        try {
            const res = await this._http.request('POST', TOKEN_ENDPOINT, {
                contentType: 'application/x-www-form-urlencoded',
                body: buildQueryString(params),
            });
            try {
                data = JSON.parse(res.body);
            } catch {
                throw new AuthError(`Resposta inesperada do Google (HTTP ${res.status}).`,
                    {needsReauth: false});
            }

            if (res.status < 200 || res.status >= 300 || data.error) {
                const code = data.error ?? `http_${res.status}`;
                const detail = data.error_description ?? '';

                // invalid_grant = refresh token revogado/expirado: só um novo login resolve.
                if (code === 'invalid_grant') {
                    this._refreshToken = null;
                    this._accessToken = null;
                    await this._secrets.clear(SecretKey.REFRESH_TOKEN);
                    this.emit('state-changed');
                    throw new AuthError('Autorização revogada ou expirada. Entre novamente.');
                }
                if (code === 'invalid_client') {
                    throw new ConfigError(
                        'Client ID ou Client Secret inválidos. Confira nas preferências.');
                }
                throw new AuthError(`OAuth ${code}: ${detail}`);
            }
        } catch (err) {
            if (err instanceof NetworkError || isCancelled(err))
                throw err;
            if (err instanceof AuthError || err instanceof ConfigError)
                throw err;
            throw new AuthError(`Falha na troca de tokens: ${err.message}`, {cause: err});
        }
        return data;
    }

    /* ══════════════════════ Servidor de loopback ══════════════════════ */

    /**
     * Sobe um listener numa porta efêmera e resolve com o `code` do redirect.
     * @returns {{port: number, codePromise: Promise<string>}}
     */
    _startListener(expectedState) {
        const service = new Gio.SocketService();
        let port;
        try {
            port = service.add_any_inet_port(null);
        } catch (err) {
            service.close();
            throw new AuthError(
                `Não foi possível abrir uma porta local para o redirecionamento: ${err.message}`,
                {cause: err, needsReauth: false});
        }
        this._listener = service;

        const codePromise = new Promise((resolve, reject) => {
            const settle = (fn, arg) => {
                this._stopListener();
                fn(arg);
            };

            this._timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, AUTH_TIMEOUT_SECONDS, () => {
                    this._timeoutId = 0;
                    settle(reject, new AuthError(
                        'Tempo esgotado esperando a autorização no navegador.',
                        {needsReauth: false}));
                    return GLib.SOURCE_REMOVE;
                });

            // Se a extensão for desabilitada durante o login, aborta.
            this._cancelId = this._cancellable?.connect(() => {
                settle(reject, new CancelledError('Extensão desabilitada durante o login'));
            });

            service.connect('incoming', (_service, connection) => {
                this._handleConnection(connection, expectedState, resolve, reject, settle)
                    .catch(err => settle(reject, err));
                // true = conexão tratada por nós; o serviço continua ouvindo
                // (o navegador costuma pedir /favicon.ico antes do redirect).
                return true;
            });
            service.start();
        });

        return {port, codePromise};
    }

    async _handleConnection(connection, expectedState, resolve, reject, settle) {
        try {
            await this._serveRedirect(connection, expectedState, resolve, reject, settle);
        } finally {
            // Falha antes de responder deixaria o socket aberto e o navegador
            // girando até o timeout dele.
            try {
                if (!connection.is_closed())
                    connection.close(null);
            } catch {
                // Já fechado pelo caminho normal de resposta.
            }
        }
    }

    async _serveRedirect(connection, expectedState, resolve, reject, settle) {
        const request = await this._readRequest(connection.get_input_stream());
        const target = /^[A-Z]+ (\S+)/.exec(request)?.[1] ?? '/';
        const params = parseQueryString(target);

        // O navegador também pede /favicon.ico: responde e continua esperando.
        if (!params.code && !params.error) {
            await this._respond(connection, 404, 'text/plain; charset=utf-8', 'Not found');
            return;
        }

        let failure = null;
        if (params.state !== expectedState)
            failure = new AuthError('Parâmetro "state" divergente — possível CSRF.',
                {needsReauth: false});
        else if (params.error === 'access_denied')
            failure = new AuthError('Autorização negada na tela de consentimento.',
                {needsReauth: false});
        else if (params.error)
            failure = new AuthError(`Erro de autorização: ${params.error}`);

        await this._respond(connection, 200, 'text/html; charset=utf-8',
            resultPage(!failure, failure?.message));

        settle(failure ? reject : resolve, failure ?? params.code);
    }

    /** Lê a requisição até o fim dos cabeçalhos (pode chegar em vários pacotes). */
    async _readRequest(stream) {
        let text = '';
        while (text.length < MAX_REQUEST_BYTES) {
            const bytes = await stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT,
                this._cancellable);
            const data = bytes?.get_data();
            if (!data || data.length === 0)
                break;
            text += new TextDecoder().decode(data);
            if (text.includes('\r\n\r\n'))
                break;
        }
        return text;
    }

    async _respond(connection, status, contentType, body) {
        const reason = status === 200 ? 'OK' : 'Not Found';
        const payload = new TextEncoder().encode(body);
        // Content-Length é em bytes; usar body.length quebrava a página assim
        // que ela continha acentos ou "✓".
        const head = new TextEncoder().encode(
            `HTTP/1.1 ${status} ${reason}\r\n` +
            `Content-Type: ${contentType}\r\n` +
            `Content-Length: ${payload.length}\r\n` +
            'Connection: close\r\n\r\n');

        const out = connection.get_output_stream();
        const full = new Uint8Array(head.length + payload.length);
        full.set(head, 0);
        full.set(payload, head.length);

        try {
            await out.write_bytes_async(new GLib.Bytes(full), GLib.PRIORITY_DEFAULT,
                this._cancellable);
            out.close(null);
            connection.close(null);
        } catch (err) {
            if (!isCancelled(err))
                Log.warn('Falha ao responder ao navegador:', err.message);
        }
    }

    _stopListener() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._cancelId) {
            this._cancellable?.disconnect(this._cancelId);
            this._cancelId = 0;
        }
        if (this._listener) {
            this._listener.stop();
            this._listener.close();
            this._listener = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._stopListener();
        this._accessToken = null;
        this._refreshToken = null;
        this._refreshPromise = null;
        this._signInPromise = null;
    }
});

function resultPage(ok, message) {
    const title = ok ? 'Tudo certo!' : 'Não foi possível autorizar';
    const detail = ok
        ? 'Você já pode fechar esta aba — o widget está sincronizando.'
        : escapeHtml(message ?? 'Tente novamente pelo widget.');
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Zorin GCalendar</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#1c1c24;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif}
.card{text-align:center;padding:3rem;border-radius:16px;background:#242430;
border:1px solid rgba(255,255,255,.1);max-width:26rem}
.icon{font-size:3rem;margin-bottom:1rem}
h1{font-size:1.35rem;margin-bottom:.5rem;color:${ok ? '#57c785' : '#e35f5f'}}
p{opacity:.7;line-height:1.5}</style></head>
<body><div class="card"><div class="icon">${ok ? '✓' : '✕'}</div>
<h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}
