/**
 * calendarService.js — camada de abstração sobre o Google Calendar.
 *
 * É a fronteira do domínio: acima daqui (store, widget, notificações) ninguém
 * conhece o formato JSON do Google, nem `start.dateTime` vs `start.date`, nem
 * `colorId`.  Trocar o provedor por CalDAV significaria reimplementar só este
 * arquivo.
 *
 * Modelo interno de evento:
 *   {id, calendarId, calendarName, etag, title, description, location,
 *    start: Date, end: Date, allDay, colour, htmlLink, recurringEventId,
 *    isRecurring, readOnly, dayKeys: string[]}
 */
import * as Log from './log.js';
import {
    dayKey, addDays, startOfDay, parseGoogleDate, isValidDate,
    toRfc3339, systemTimeZone, eventColour, safeColour, MS_PER_DAY,
} from './utils.js';

// Trava para não gerar milhares de chaves com um evento de anos de duração.
const MAX_SPAN_DAYS = 400;

export class CalendarService {
    constructor(api) {
        this._api = api;
        this._calendarsById = new Map();
    }

    /* ══════════════════════ Leitura ══════════════════════ */

    async listCalendars() {
        const raw = await this._api.listCalendars();
        const calendars = raw.map(normalizeCalendar);
        this._calendarsById = new Map(calendars.map(c => [c.id, c]));
        return calendars;
    }

    /**
     * Eventos de várias agendas num intervalo.
     *
     * Falha de uma agenda isolada não derruba a busca inteira (uma agenda
     * compartilhada pode ter sido removida), mas é registrada e devolvida em
     * `errors` — a versão anterior fazia `.catch(() => [])` e o usuário via
     * "nenhum evento" sem nunca saber que algo falhou.
     *
     * @returns {Promise<{events: object[], errors: {calendarId: string, error: Error}[]}>}
     */
    async listEvents(calendarIds, from, to) {
        const timeMin = toRfc3339(from);
        const timeMax = toRfc3339(to);

        const results = await Promise.allSettled(calendarIds.map(async id => {
            const items = await this._api.listEvents(id, {timeMin, timeMax});
            const calendar = this._calendarsById.get(id);
            return items
                .filter(item => item.status !== 'cancelled')
                .map(item => normalizeEvent(item, calendar ?? {id}));
        }));

        const events = [];
        const errors = [];
        results.forEach((result, index) => {
            if (result.status === 'fulfilled')
                events.push(...result.value);
            else
                errors.push({calendarId: calendarIds[index], error: result.reason});
        });

        events.sort(compareEvents);
        return {events, errors};
    }

    /* ══════════════════════ Escrita ══════════════════════ */

    async createEvent(calendarId, draft) {
        const raw = await this._api.insertEvent(calendarId, draftToGoogle(draft));
        return normalizeEvent(raw, this._calendarsById.get(calendarId) ?? {id: calendarId});
    }

    /**
     * PATCH parcial: só os campos presentes em `draft` são enviados, o que
     * preserva convidados, anexos e recorrência que a extensão não edita.
     */
    async updateEvent(calendarId, eventId, draft) {
        const raw = await this._api.patchEvent(calendarId, eventId, draftToGoogle(draft));
        return normalizeEvent(raw, this._calendarsById.get(calendarId) ?? {id: calendarId});
    }

    async deleteEvent(calendarId, eventId) {
        await this._api.deleteEvent(calendarId, eventId);
    }

    getCalendar(id) {
        return this._calendarsById.get(id) ?? null;
    }
}

/* ══════════════════════ Normalização ══════════════════════ */

export function normalizeCalendar(raw) {
    const accessRole = raw.accessRole ?? 'reader';
    return {
        id: raw.id,
        name: raw.summaryOverride || raw.summary || raw.id,
        colour: safeColour(raw.backgroundColor),
        primary: !!raw.primary,
        selected: raw.selected !== false,
        accessRole,
        canWrite: accessRole === 'owner' || accessRole === 'writer',
        timeZone: raw.timeZone ?? null,
    };
}

export function normalizeEvent(raw, calendar = {}) {
    const allDay = !!raw.start?.date;
    const start = parseGoogleDate(raw.start?.dateTime ?? raw.start?.date);
    const rawEnd = parseGoogleDate(raw.end?.dateTime ?? raw.end?.date);

    // Em eventos de dia inteiro o Google devolve `end.date` exclusivo
    // (um evento de um dia termina no dia seguinte).  Guardamos o fim
    // inclusivo, que é o que a UI precisa mostrar.
    let end = rawEnd;
    if (allDay && isValidDate(rawEnd))
        end = addDays(rawEnd, -1);
    if (!isValidDate(end) || end < start)
        end = start;

    return {
        id: raw.id,
        calendarId: calendar.id ?? 'primary',
        calendarName: calendar.name ?? '',
        etag: raw.etag ?? null,
        title: raw.summary?.trim() || 'Sem título',
        description: raw.description ?? '',
        location: raw.location ?? '',
        start,
        end,
        allDay,
        colour: eventColour(raw.colorId, calendar.colour),
        htmlLink: raw.htmlLink ?? '',
        recurringEventId: raw.recurringEventId ?? null,
        isRecurring: !!raw.recurringEventId,
        readOnly: calendar.canWrite === false,
        dayKeys: spannedDayKeys(start, end, allDay),
    };
}

/**
 * Todos os dias locais que o evento ocupa.
 *
 * Sem isto um evento de terça a quinta só aparecia na terça — a versão
 * anterior indexava apenas o dia de início.
 */
export function spannedDayKeys(start, end, allDay) {
    if (!isValidDate(start))
        return [];

    const firstDay = startOfDay(start);
    let lastDay = startOfDay(isValidDate(end) ? end : start);

    // Evento com hora que termina exatamente à meia-noite pertence ao dia
    // anterior (19:00–00:00 é "hoje", não "hoje e amanhã").
    if (!allDay && end > start &&
        end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0)
        lastDay = addDays(lastDay, -1);

    if (lastDay < firstDay)
        lastDay = firstDay;

    const span = Math.round((lastDay.getTime() - firstDay.getTime()) / MS_PER_DAY);
    if (span > MAX_SPAN_DAYS) {
        Log.debug(`Evento com ${span} dias truncado para ${MAX_SPAN_DAYS} no índice`);
        lastDay = addDays(firstDay, MAX_SPAN_DAYS);
    }

    const keys = [];
    for (let day = firstDay; day <= lastDay; day = addDays(day, 1))
        keys.push(dayKey(day));
    return keys;
}

/** Ordena por horário; dia inteiro primeiro dentro do mesmo dia. */
export function compareEvents(a, b) {
    if (a.allDay !== b.allDay)
        return a.allDay ? -1 : 1;
    const diff = a.start - b.start;
    return diff !== 0 ? diff : a.title.localeCompare(b.title);
}

/* ══════════════════════ Domínio → Google ══════════════════════ */

/**
 * Converte um rascunho da UI no corpo aceito pela API.
 * Datas com hora vão com fuso explícito; sem isso o Google usa o fuso da
 * agenda, que pode não ser o da máquina.
 */
export function draftToGoogle(draft) {
    const body = {};

    if (draft.title !== undefined)
        body.summary = draft.title;
    if (draft.description !== undefined)
        body.description = draft.description;
    if (draft.location !== undefined)
        body.location = draft.location;
    if (draft.colorId !== undefined)
        body.colorId = draft.colorId;

    if (draft.start !== undefined && draft.end !== undefined) {
        if (draft.allDay) {
            body.start = {date: dayKey(draft.start)};
            // `end.date` é exclusivo: soma-se um dia ao último dia do evento.
            body.end = {date: dayKey(addDays(startOfDay(draft.end), 1))};
        } else {
            const timeZone = systemTimeZone();
            body.start = {dateTime: toRfc3339(draft.start), timeZone};
            body.end = {dateTime: toRfc3339(draft.end), timeZone};
        }
    }

    return body;
}
