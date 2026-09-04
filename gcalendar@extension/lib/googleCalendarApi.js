/**
 * googleCalendarApi.js — camada de transporte da Google Calendar API v3.
 *
 * Fala JSON cru com o Google e nada mais: sem modelo de domínio, sem cache,
 * sem UI.  Responsabilidades daqui: autorização das requisições, paginação,
 * nova tentativa em 401 (token renovado) e em erros transitórios.
 */
import * as Log from './log.js';
import {ApiError, AuthError, isCancelled} from './errors.js';
import {buildQueryString} from './utils.js';
import {sleep} from './async.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
const MAX_PAGES = 20;              // trava de segurança contra paginação infinita
const MAX_RETRIES = 3;
const PAGE_SIZE = 250;

export class GoogleCalendarApi {
    constructor({auth, http, cancellable}) {
        this._auth = auth;
        this._http = http;
        this._cancellable = cancellable;
    }

    /* ══════════════════════ Agendas ══════════════════════ */

    async listCalendars() {
        const items = await this._getPaginated('/users/me/calendarList', {
            fields: 'nextPageToken,items(id,summary,summaryOverride,backgroundColor,' +
                    'foregroundColor,selected,primary,accessRole,timeZone,deleted)',
            minAccessRole: 'reader',
            showDeleted: 'false',
        });
        return items.filter(c => !c.deleted);
    }

    /* ══════════════════════ Eventos ══════════════════════ */

    /**
     * Instâncias de eventos entre duas datas.
     * `singleEvents=true` faz o Google expandir as recorrências, então cada
     * ocorrência chega como um evento próprio já com data resolvida.
     */
    async listEvents(calendarId, {timeMin, timeMax}) {
        return this._getPaginated(`/calendars/${enc(calendarId)}/events`, {
            timeMin,
            timeMax,
            singleEvents: 'true',
            orderBy: 'startTime',
            showDeleted: 'false',
            fields: 'nextPageToken,items(id,status,summary,description,location,start,end,' +
                    'colorId,htmlLink,recurringEventId,originalStartTime,etag,creator,organizer)',
        });
    }

    async getEvent(calendarId, eventId) {
        return this._request('GET', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    }

    async insertEvent(calendarId, body) {
        return this._request('POST', `/calendars/${enc(calendarId)}/events`, {body});
    }

    async patchEvent(calendarId, eventId, body) {
        return this._request('PATCH',
            `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {body});
    }

    async deleteEvent(calendarId, eventId) {
        return this._request('DELETE',
            `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    }

    /* ══════════════════════ Interno ══════════════════════ */

    async _getPaginated(path, params) {
        const items = [];
        let pageToken;

        for (let page = 0; page < MAX_PAGES; page++) {
            const data = await this._request('GET', path, {
                params: {...params, maxResults: String(PAGE_SIZE), pageToken},
            });
            if (data?.items?.length)
                items.push(...data.items);

            pageToken = data?.nextPageToken;
            if (!pageToken)
                return items;
        }

        Log.warn(`Paginação interrompida em ${MAX_PAGES} páginas para ${path}`);
        return items;
    }

    async _request(method, path, {params = null, body = null} = {}) {
        const qs = params ? buildQueryString(params) : '';
        const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
        let retriedAuth = false;

        for (let attempt = 0; ; attempt++) {
            const token = await this._auth.getAccessToken();

            try {
                return await this._http.requestJson(method, url, {
                    headers: {Authorization: `Bearer ${token}`},
                    body: body ? JSON.stringify(body) : null,
                    contentType: body ? 'application/json; charset=utf-8' : null,
                });
            } catch (err) {
                if (isCancelled(err))
                    throw err;

                // 401: o access token pode ter sido invalidado do outro lado.
                // Uma renovação forçada resolve; duas seguidas significam que
                // a autorização caiu de vez.
                if (err instanceof ApiError && err.status === 401 && !retriedAuth) {
                    retriedAuth = true;
                    this._auth.invalidateAccessToken();
                    continue;
                }
                if (err instanceof ApiError && err.status === 401)
                    throw new AuthError('Autorização recusada pelo Google. Entre novamente.');

                if (err.retryable && attempt < MAX_RETRIES) {
                    const delay = 500 * 2 ** attempt;
                    Log.debug(`Tentando de novo em ${delay}ms (${method} ${path}): ${err.message}`);
                    await sleep(delay, this._cancellable);
                    continue;
                }
                throw err;
            }
        }
    }
}

const enc = encodeURIComponent;
