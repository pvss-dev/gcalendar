/**
 * log.js — logging consistente e silenciável.
 *
 * `debug()` só escreve quando GCAL_DEBUG=1 está no ambiente do gnome-shell,
 * para não poluir o journal em uso normal.  `warn()` e `error()` sempre
 * escrevem: erros nunca são engolidos silenciosamente.
 */
import GLib from 'gi://GLib';

const PREFIX = '[GCalendar]';
// Usado pela suíte de testes, que provoca erros de propósito.
const QUIET = GLib.getenv('GCAL_QUIET') === '1';

// Silencioso por padrão: extensões que poluem o journal em uso normal são
// reprovadas na revisão do extensions.gnome.org. Liga-se pela variável de
// ambiente ou, em tempo de execução, pela chave `debug-logging`.
let debugEnabled = GLib.getenv('GCAL_DEBUG') === '1';

/** Ligado/desligado pela extensão conforme a configuração. */
export function setDebugEnabled(enabled) {
    debugEnabled = enabled || GLib.getenv('GCAL_DEBUG') === '1';
}

export function isDebugEnabled() {
    return debugEnabled;
}

export function debug(...args) {
    if (!debugEnabled || QUIET)
        return;

    // console.log, não console.debug: o GLib descarta G_LOG_LEVEL_DEBUG a
    // menos que o domínio esteja em G_MESSAGES_DEBUG, então a mensagem nunca
    // chegaria ao journal. Quem filtra aqui é a chave `debug-logging` — que
    // vem desligada, mantendo a extensão silenciosa em uso normal.
    console.log(PREFIX, ...args);
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
