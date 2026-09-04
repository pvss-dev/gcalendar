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
    constructor({http, cancellable}) {
        this._http = http;
        this._cancellable = cancellable;
    }

    /* ══════════════════════ Agendas ══════════════════════ */

    async listCalendars(account) {
        const items = await this._getPaginated(account, '/users/me/calendarList', {
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
    async listEvents(account, calendarId, {timeMin, timeMax}) {
        return this._getPaginated(account, `/calendars/${enc(calendarId)}/events`, {
            timeMin,
            timeMax,
            singleEvents: 'true',
            orderBy: 'startTime',
            showDeleted: 'false',
            fields: 'nextPageToken,items(id,status,summary,description,location,start,end,' +
                    'colorId,htmlLink,recurringEventId,originalStartTime,etag,creator,organizer)',
        });
    }

    async getEvent(account, calendarId, eventId) {
        return this._request(account, 'GET',
            `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    }

    async insertEvent(account, calendarId, body) {
        return this._request(account, 'POST',
            `/calendars/${enc(calendarId)}/events`, {body});
    }

    async patchEvent(account, calendarId, eventId, body) {
        return this._request(account, 'PATCH',
            `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {body});
    }

    async deleteEvent(account, calendarId, eventId) {
        return this._request(account, 'DELETE',
            `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    }

    /* ══════════════════════ Interno ══════════════════════ */

    async _getPaginated(account, path, params) {
        const items = [];
        let pageToken;

        for (let page = 0; page < MAX_PAGES; page++) {
            const data = await this._request(account, 'GET', path, {
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

    async _request(account, method, path, {params = null, body = null} = {}) {
        const qs = params ? buildQueryString(params) : '';
        const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
        let retriedAuth = false;

        for (let attempt = 0; ; attempt++) {
            // O token vem do GNOME Online Accounts e já chega renovado.
            const token = await account.getAccessToken();

            try {
                return await this._http.requestJson(method, url, {
                    headers: {Authorization: `Bearer ${token}`},
                    body: body ? JSON.stringify(body) : null,
                    contentType: body ? 'application/json; charset=utf-8' : null,
                });
            } catch (err) {
                if (isCancelled(err))
                    throw err;

                // 401: o token pode ter sido invalidado do outro lado. Pedir
                // ao GOA para revalidar resolve; duas seguidas significam que
                // a conta precisa de atenção nas Contas Online.
                if (err instanceof ApiError && err.status === 401 && !retriedAuth) {
                    retriedAuth = true;
                    await account.ensureCredentials();
                    continue;
                }
                if (err instanceof ApiError && err.status === 401) {
                    throw new AuthError('O Google recusou o acesso desta conta. ' +
                        'Reconecte-a em Configurações → Contas Online.');
                }

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
