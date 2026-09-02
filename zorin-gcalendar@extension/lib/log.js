/**
 * log.js — logging consistente e silenciável.
 *
 * `debug()` só escreve quando GCAL_DEBUG=1 está no ambiente do gnome-shell,
 * para não poluir o journal em uso normal.  `warn()` e `error()` sempre
 * escrevem: erros nunca são engolidos silenciosamente.
 */
import GLib from 'gi://GLib';

const PREFIX = '[GCalendar]';
const DEBUG = GLib.getenv('GCAL_DEBUG') === '1';
// Usado pela suíte de testes, que provoca erros de propósito.
const QUIET = GLib.getenv('GCAL_QUIET') === '1';

export function debug(...args) {
    if (DEBUG)
        console.debug(PREFIX, ...args);
}

export function info(...args) {
    if (!QUIET)
        console.log(PREFIX, ...args);
}

export function warn(...args) {
    if (!QUIET)
        console.warn(PREFIX, ...args);
}

export function error(err, context = '') {
    if (QUIET)
        return;
    const where = context ? ` (${context})` : '';
    if (err instanceof Error)
        console.error(`${PREFIX}${where} ${err.message}\n${err.stack ?? ''}`);
    else
        console.error(`${PREFIX}${where}`, err);
}
