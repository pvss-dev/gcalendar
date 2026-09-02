/**
 * utils.js — helpers puros.
 *
 * Só depende de GLib/Gio, nunca do Shell: pode ser importado por prefs.js
 * (processo separado) e pelos testes rodando em `gjs` puro.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/* ══════════════════════════ Strings ══════════════════════════ */

export function truncate(str, max = 52) {
    if (!str)
        return '';
    return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

export function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

/* ══════════════════════════ URL / query ══════════════════════════ */

export function buildQueryString(obj) {
    return Object.entries(obj)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

export function parseQueryString(str) {
    const result = {};
    const qs = str.includes('?') ? str.slice(str.indexOf('?') + 1) : str;
    for (const part of qs.split('&')) {
        if (!part)
            continue;
        const idx = part.indexOf('=');
        const rawKey = idx === -1 ? part : part.slice(0, idx);
        const rawVal = idx === -1 ? '' : part.slice(idx + 1);
        // '+' significa espaço em application/x-www-form-urlencoded.
        const dec = s => decodeURIComponent(s.replace(/\+/g, ' '));
        try {
            result[dec(rawKey)] = dec(rawVal);
        } catch {
            // Percent-encoding malformado: ignora o par em vez de derrubar o parse.
        }
    }
    return result;
}

/* ══════════════════════════ Criptografia (PKCE) ══════════════════════════ */

/**
 * Bytes aleatórios de qualidade criptográfica.
 *
 * O GJS não tem WebCrypto e Math.random() não serve para o `code_verifier`
 * nem para o `state` (proteção CSRF), então lemos de /dev/urandom.
 */
export function randomBytes(count) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        const out = new Uint8Array(count);
        let filled = 0;
        while (filled < count) {
            const chunk = stream.read_bytes(count - filled, null).get_data();
            if (!chunk || chunk.length === 0)
                throw new Error('/dev/urandom retornou 0 bytes');
            out.set(chunk, filled);
            filled += chunk.length;
        }
        return out;
    } finally {
        stream.close(null);
    }
}

export function base64UrlEncode(bytes) {
    return GLib.base64_encode(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/** String aleatória segura no alfabeto base64url (RFC 7636 §4.1). */
export function randomToken(byteLength = 32) {
    return base64UrlEncode(randomBytes(byteLength));
}

/** SHA-256 do verifier em base64url — o `code_challenge` do PKCE S256. */
export function sha256Base64Url(str) {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return base64UrlEncode(bytes);
}

/* ══════════════════════════ Datas ══════════════════════════ */

export const MS_PER_DAY = 86_400_000;

/**
 * Converte uma data da API do Google em Date local.
 *
 * "YYYY-MM-DD" (evento de dia inteiro) seria interpretado como meia-noite UTC
 * pelo ECMAScript — em UTC-3 isso vira 21h do dia anterior.  Acrescentar
 * "T00:00:00" força a interpretação como horário local (ECMA-262 §21.4.3.2).
 */
export function parseGoogleDate(value) {
    if (!value)
        return new Date(NaN);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value))
        return new Date(`${value}T00:00:00`);
    return new Date(value);
}

export function isValidDate(d) {
    return d instanceof Date && !Number.isNaN(d.getTime());
}

/** Chave estável "YYYY-MM-DD" no fuso local — usada para indexar por dia. */
export function dayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, days) {
    // Construtor Y/M/D em vez de aritmética de milissegundos: atravessa
    // mudanças de horário de verão sem escorregar uma hora.
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days,
        date.getHours(), date.getMinutes(), date.getSeconds());
}

export function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
}

export function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

/** RFC 3339 com offset local — o formato que a API do Google espera. */
export function toRfc3339(date) {
    const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
    const offMin = -date.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
           `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
           `${sign}${pad(Math.trunc(offMin / 60))}:${pad(offMin % 60)}`;
}

/** Fuso IANA do sistema (ex.: "America/Sao_Paulo"), com fallback para UTC. */
export function systemTimeZone() {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz)
            return tz;
    } catch {
        // Intl indisponível — cai no fallback.
    }
    return 'UTC';
}

export function minutesUntil(date) {
    return Math.round((date.getTime() - Date.now()) / 60_000);
}

/* ══════════════════════════ Formatação ══════════════════════════ */

export function formatTime(date, locale = undefined) {
    if (!isValidDate(date))
        return '';
    return date.toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'});
}

export function formatDateLong(date, locale = undefined) {
    if (!isValidDate(date))
        return '';
    return date.toLocaleDateString(locale, {
        weekday: 'long', day: 'numeric', month: 'long',
    });
}

/** Nomes de mês e abreviações de dia vindos do locale do usuário. */
export function monthNames(locale = undefined) {
    const fmt = new Intl.DateTimeFormat(locale, {month: 'long'});
    return Array.from({length: 12}, (_, m) => capitalize(fmt.format(new Date(2021, m, 1))));
}

/**
 * Abreviações dos dias da semana já rotacionadas para começar em
 * `firstDayOfWeek` (0 = domingo).
 */
export function weekdayAbbreviations(firstDayOfWeek = 0, locale = undefined) {
    const fmt = new Intl.DateTimeFormat(locale, {weekday: 'narrow'});
    // 2021-08-01 foi um domingo, então +i percorre a semana a partir de domingo.
    const all = Array.from({length: 7}, (_, i) =>
        capitalize(fmt.format(new Date(2021, 7, 1 + i))));
    return Array.from({length: 7}, (_, i) => all[(firstDayOfWeek + i) % 7]);
}

/* ══════════════════════════ Cores ══════════════════════════ */

/** Paleta de `colorId` de eventos do Google Calendar (1–11). */
const EVENT_COLOURS = {
    1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73',
    5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161',
    9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};

export const DEFAULT_EVENT_COLOUR = '#3584e4';

export function eventColour(colorId, fallback = DEFAULT_EVENT_COLOUR) {
    return EVENT_COLOURS[colorId] ?? fallback;
}

/** Valida "#rgb"/"#rrggbb" antes de injetar em CSS inline do St. */
export function safeColour(value, fallback = DEFAULT_EVENT_COLOUR) {
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value ?? '') ? value : fallback;
}
