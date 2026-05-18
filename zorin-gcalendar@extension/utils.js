/**
 * utils.js — Helpers compartilhados (sem imports do Shell, seguro em prefs.js também)
 */
import GLib from 'gi://GLib';

export function formatTime(dateTimeStr) {
    if (!dateTimeStr) return '';
    const d = new Date(dateTimeStr);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateLong(date) {
    return date.toLocaleDateString('pt-BR', {
        weekday: 'long', day: 'numeric', month: 'long',
    });
}

export function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth()    === b.getMonth()    &&
           a.getDate()     === b.getDate();
}

export function minutesUntil(dateTimeStr) {
    return Math.round((new Date(dateTimeStr).getTime() - Date.now()) / 60_000);
}

export function truncate(str, max = 52) {
    if (!str) return '';
    return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

export function randomString(len = 64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function sha256Base64Url(str) {
    const hex   = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2)
        bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return GLib.base64_encode(bytes)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function buildQueryString(obj) {
    return Object.entries(obj)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

export function parseQueryString(str) {
    const result = {};
    for (const part of str.replace(/^\?/, '').split('&')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        result[decodeURIComponent(part.slice(0, idx))] = decodeURIComponent(part.slice(idx + 1));
    }
    return result;
}

/**
 * Converte string de data da Google Calendar API em Date local.
 * Strings date-only ("YYYY-MM-DD") são UTC midnight sem isso — erradas em UTC-3.
 * Appending T00:00:00 força parse como hora local (ECMAScript §20.4.1.15).
 */
export function parseDateLocal(value) {
    if (!value) return new Date(NaN);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value))
        return new Date(value + 'T00:00:00');
    return new Date(value);
}

export function eventStart(ev) {
    if (ev.start?.dateTime) return { value: ev.start.dateTime, isAllDay: false };
    if (ev.start?.date)     return { value: ev.start.date,     isAllDay: true  };
    return { value: '', isAllDay: false };
}

/** Google Calendar colour palette (colourId 1–11). */
export function googleColour(id) {
    const map = {
        '1':'#a4bdfc','2':'#7ae7bf','3':'#dbadff','4':'#ff887c',
        '5':'#fbd75b','6':'#ffb878','7':'#46d6db','8':'#e1e1e1',
        '9':'#5484ed','10':'#51b749','11':'#dc2127',
    };
    return map[id] ?? '#3584e4';
}

export const MONTH_NAMES = [
    'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
];
export const DAY_ABBR = ['D','S','T','Q','Q','S','S'];
