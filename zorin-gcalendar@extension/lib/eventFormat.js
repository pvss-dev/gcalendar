/**
 * eventFormat.js — apresentação e validação puras.
 *
 * Fica separado da UI de propósito: não importa St nem nada do Shell, então
 * dá para testar em `gjs` puro, sem sessão gráfica.
 */
import {formatTime, sameDay} from './utils.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * Texto de horário de um evento no contexto de um dia.
 * Trata dia inteiro e eventos que atravessam vários dias — um evento de
 * terça a quinta mostra "começa", "em andamento" e "termina".
 */
export function describeTiming(event, day) {
    if (event.allDay) {
        if (sameDay(event.start, event.end))
            return 'Dia inteiro';
        if (sameDay(event.start, day))
            return 'Dia inteiro · começa';
        if (sameDay(event.end, day))
            return 'Dia inteiro · termina';
        return 'Dia inteiro · em andamento';
    }

    const startsToday = sameDay(event.start, day);
    const endsToday = sameDay(event.end, day);

    if (startsToday && endsToday)
        return `${formatTime(event.start)} – ${formatTime(event.end)}`;
    if (startsToday)
        return `A partir de ${formatTime(event.start)}`;
    if (endsToday)
        return `Até ${formatTime(event.end)}`;
    return 'Em andamento';
}

/** @throws {Error} com mensagem pronta para o usuário */
export function parseDateInput(text) {
    const m = DATE_RE.exec(text);
    if (!m)
        throw new Error('Data inválida. Use o formato AAAA-MM-DD.');

    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const date = new Date(year, month - 1, day);

    // O construtor de Date "conserta" 31/02 virando 03/03; comparar de volta
    // é o que rejeita datas que não existem.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 ||
        date.getDate() !== day)
        throw new Error('Data inexistente no calendário.');

    return date;
}

/** @returns {[number, number]} hora e minuto @throws {Error} */
export function parseTimeInput(text) {
    const m = TIME_RE.exec(text);
    if (!m)
        throw new Error('Horário inválido. Use o formato HH:MM.');

    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59)
        throw new Error('Horário fora do intervalo (00:00–23:59).');

    return [hour, minute];
}

export function formatClock(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
