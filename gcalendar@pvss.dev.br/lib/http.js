/**
 * http.js — cliente HTTP sobre libsoup3.
 *
 * Centraliza as chamadas a Gio._promisify: promisificar o mesmo método duas
 * vezes em módulos diferentes sobrescreve o wrapper, então isso acontece
 * exatamente uma vez, aqui.
 *
 * Usa `send_and_read_async`, que devolve o corpo inteiro.  A versão anterior
 * usava `send_async` + um único `read_bytes_async(524288)`; leituras em stream
 * de rede podem retornar menos bytes que o pedido, o que truncava respostas
 * grandes de forma intermitente.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {NetworkError, ApiError, CancelledError, isCancelled} from './errors.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const USER_AGENT = 'gcalendar/2 (GNOME Shell extension)';

export class HttpClient {
    /**
     * @param {object} opts
     * @param {number} opts.timeout      segundos até desistir de uma requisição
     * @param {Gio.Cancellable} opts.cancellable  cancelável compartilhado da extensão
     */
    constructor({timeout = 20, cancellable = null} = {}) {
        this._session = new Soup.Session({
            timeout,
            idle_timeout: 30,
            user_agent: USER_AGENT,
        });
        this._cancellable = cancellable;
    }

    /**
     * @returns {Promise<{status: number, body: string, headers: Soup.MessageHeaders}>}
     */
    async request(method, url, {headers = {}, body = null, contentType = null} = {}) {
        if (this._cancellable?.is_cancelled())
            throw new CancelledError('Extensão desabilitada');

        const msg = Soup.Message.new(method, url);
        if (!msg)
            throw new NetworkError(`URL inválida: ${url}`);

        for (const [name, value] of Object.entries(headers))
            msg.request_headers.append(name, value);

        if (body !== null) {
            const bytes = new GLib.Bytes(new TextEncoder().encode(body));
            msg.set_request_body_from_bytes(contentType ?? 'application/octet-stream', bytes);
        }

        let responseBytes;
        try {
            responseBytes = await this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (err) {
            if (isCancelled(err))
                throw new CancelledError('Requisição cancelada', {cause: err});
            throw new NetworkError(`Falha de rede em ${method} ${hostOf(url)}: ${err.message}`,
                {cause: err});
        }

        const data = responseBytes?.get_data();
        return {
            status: msg.get_status(),
            body: data ? new TextDecoder().decode(data) : '',
            headers: msg.response_headers,
        };
    }

    /** Como `request`, mas já valida o status e devolve JSON. */
    async requestJson(method, url, opts = {}) {
        const res = await this.request(method, url, opts);
        const parsed = safeParseJson(res.body);

        if (res.status < 200 || res.status >= 300) {
            const apiErr = parsed?.error;
            const reason = apiErr?.errors?.[0]?.reason ?? apiErr?.status ?? null;
            const detail = apiErr?.message ?? apiErr ?? res.body.slice(0, 200);
            throw new ApiError(`HTTP ${res.status} em ${method} ${hostOf(url)}: ${detail}`,
                {status: res.status, reason});
        }
        // 204 No Content e afins.
        return res.body ? parsed : null;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}

export function safeParseJson(text) {
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Só o host, para não vazar tokens de query string nas mensagens de erro. */
function hostOf(url) {
    const m = /^https?:\/\/([^/?#]+)/.exec(url);
    return m ? m[1] : 'servidor';
}
