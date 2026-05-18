/**
 * googleAuth.js — OAuth 2.0 com PKCE para Google Calendar
 * Escuta o redirect em localhost:9004, armazena tokens no GNOME Keyring.
 */

import GLib   from 'gi://GLib';
import Gio    from 'gi://Gio';
import Soup   from 'gi://Soup';
import Secret from 'gi://Secret';
import { randomString, sha256Base64Url } from './utils.js';

const REDIRECT_PORT  = 9004;
const REDIRECT_URI   = `http://localhost:${REDIRECT_PORT}`;
const SCOPES         = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth';

const SECRET_SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.zorin-gcalendar',
    Secret.SchemaFlags.NONE,
    { 'token-type': Secret.SchemaAttributeType.STRING }
);

export class GoogleAuth {
    constructor(extension) {
        this._ext      = extension;
        this._settings = extension.getSettings();
        this._session  = new Soup.Session();
        this._session.timeout = 15;
    }

    isAuthenticated() {
        return this._settings.get_string('refresh-token') !== '';
    }

    async getAccessToken() {
        const expiry = this._settings.get_int64('token-expiry');
        if (Math.floor(Date.now() / 1000) >= expiry - 60)
            await this.refreshAccessToken();
        return this._settings.get_string('access-token');
    }

    async startAuthFlow() {
        const clientId = this._settings.get_string('client-id');
        if (!clientId) throw new Error('client-id não configurado nas preferências');

        this._verifier = randomString(64);
        this._state    = randomString(16);
        const challenge = sha256Base64Url(this._verifier);

        const params = new URLSearchParams({
            client_id: clientId, redirect_uri: REDIRECT_URI,
            response_type: 'code', scope: SCOPES, state: this._state,
            code_challenge: challenge, code_challenge_method: 'S256',
            access_type: 'offline', prompt: 'consent',
        });

        Gio.AppInfo.launch_default_for_uri_async(
            `${AUTH_ENDPOINT}?${params}`, null, null, () => {}
        );

        const code = await this._listenForCode();
        await this._exchangeCode(code);
    }

    async signOut() {
        const token = this._settings.get_string('access-token');
        if (token) {
            try {
                const msg = Soup.Message.new('POST',
                    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`);
                await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, null);
            } catch (_) {}
        }
        this._settings.set_string('access-token',  '');
        this._settings.set_string('refresh-token', '');
        this._settings.set_int64 ('token-expiry',   0);
        await Secret.password_clear(SECRET_SCHEMA, { 'token-type': 'refresh' }, null).catch(() => {});
    }

    async refreshAccessToken() {
        const rt = this._settings.get_string('refresh-token')
            || await Secret.password_lookup(SECRET_SCHEMA, { 'token-type': 'refresh' }, null).catch(() => null);
        if (!rt) throw new Error('Sem refresh token — faça login novamente');

        const clientId     = this._settings.get_string('client-id');
        const clientSecret = this._settings.get_string('client-secret');

        const tokens = await this._postToken(new URLSearchParams({
            refresh_token: rt, client_id: clientId,
            client_secret: clientSecret, grant_type: 'refresh_token',
        }).toString());
        await this._storeTokens(tokens);
    }

    /* ── internos ── */

    _listenForCode() {
        return new Promise((resolve, reject) => {
            const svc = new Gio.SocketService();
            try { svc.add_inet_port(REDIRECT_PORT, null); }
            catch (e) { return reject(new Error(`Porta ${REDIRECT_PORT} em uso: ${e.message}`)); }

            const tid = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
                svc.stop(); svc.close();
                reject(new Error('Timeout OAuth (5 min)'));
                return GLib.SOURCE_REMOVE;
            });

            svc.connect('incoming', (_s, conn) => {
                GLib.source_remove(tid);
                const buf = new Uint8Array(4096);
                conn.get_input_stream().read_async(buf, GLib.PRIORITY_DEFAULT, null, (_st, res) => {
                    try {
                        const n   = conn.get_input_stream().read_finish(res);
                        const req = new TextDecoder().decode(buf.subarray(0, n));
                        const m   = req.match(/^GET \/?([^ ]*)/);
                        if (!m) throw new Error('Requisição HTTP inválida');
                        const qs = new URLSearchParams(m[1].replace(/^\?/, ''));
                        if (qs.get('state') !== this._state) throw new Error('State inválido (CSRF)');
                        const code = qs.get('code');
                        if (!code) throw new Error('Sem código na resposta');

                        const body = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;
justify-content:center;background:#0d1117;font-family:-apple-system,sans-serif;color:#e6edf3}
.card{text-align:center;padding:3rem;border-radius:16px;background:#161b22;border:1px solid #30363d;
max-width:420px}.icon{font-size:3rem;margin-bottom:1rem}.title{font-size:1.5rem;font-weight:700;
color:#58a6ff;margin-bottom:.5rem}.sub{opacity:.6;font-size:.95rem}</style></head>
<body><div class="card"><div class="icon">✓</div>
<div class="title">Autenticado com sucesso!</div>
<div class="sub">Pode fechar esta aba.<br>O widget já está sincronizando.</div>
</div></body></html>`;
                        const resp = `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n` +
                            `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
                        const out = conn.get_output_stream();
                        const enc = new TextEncoder().encode(resp);
                        out.write_async(enc, GLib.PRIORITY_DEFAULT, null, (_o, wr) => {
                            out.write_finish(wr); out.close(null);
                            conn.close(null); svc.stop(); svc.close();
                            resolve(code);
                        });
                    } catch (e) { svc.stop(); svc.close(); reject(e); }
                });
            });
            svc.start();
        });
    }

    async _exchangeCode(code) {
        const tokens = await this._postToken(new URLSearchParams({
            code, client_id: this._settings.get_string('client-id'),
            client_secret:   this._settings.get_string('client-secret'),
            redirect_uri:    REDIRECT_URI,
            grant_type:      'authorization_code',
            code_verifier:   this._verifier,
        }).toString());
        await this._storeTokens(tokens);
    }

    async _storeTokens(t) {
        this._settings.set_string('access-token', t.access_token);
        this._settings.set_int64 ('token-expiry',  Math.floor(Date.now() / 1000) + t.expires_in);
        if (t.refresh_token) {
            this._settings.set_string('refresh-token', t.refresh_token);
            await Secret.password_store(
                SECRET_SCHEMA, { 'token-type': 'refresh' },
                Secret.COLLECTION_DEFAULT, 'Zorin GCalendar', t.refresh_token, null
            ).catch(() => {});
        }
    }

    async _postToken(body) {
        const msg = Soup.Message.new('POST', TOKEN_ENDPOINT);
        msg.set_request_body_from_bytes('application/x-www-form-urlencoded',
            new GLib.Bytes(new TextEncoder().encode(body)));
        const stream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, null);
        if (msg.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${msg.get_status()} no endpoint de token`);
        const bytes = await stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null);
        const data  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (data.error) throw new Error(`${data.error}: ${data.error_description}`);
        return data;
    }
}
