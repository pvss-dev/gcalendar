/**
 * async.js — utilidades de temporização com limpeza garantida.
 *
 * Todo GLib source criado pela extensão passa por um TimerPool.  Assim o
 * disable() remove tudo de uma vez e nenhum callback continua rodando depois
 * que os objetos foram destruídos — a causa clássica de "extension keeps
 * running after disable" e de crashes por acesso a objeto já finalizado.
 */
import GLib from 'gi://GLib';

import {CancelledError} from './errors.js';

export class TimerPool {
    constructor() {
        this._sources = new Set();
    }

    /** @returns {number} id do source, já rastreado */
    addTimeout(intervalMs, callback, priority = GLib.PRIORITY_DEFAULT) {
        const id = GLib.timeout_add(priority, intervalMs, () => {
            const keep = callback();
            if (keep !== GLib.SOURCE_CONTINUE)
                this._sources.delete(id);
            return keep;
        });
        this._sources.add(id);
        return id;
    }

    addSeconds(intervalSeconds, callback, priority = GLib.PRIORITY_DEFAULT) {
        const id = GLib.timeout_add_seconds(priority, intervalSeconds, () => {
            const keep = callback();
            if (keep !== GLib.SOURCE_CONTINUE)
                this._sources.delete(id);
            return keep;
        });
        this._sources.add(id);
        return id;
    }

    addIdle(callback, priority = GLib.PRIORITY_DEFAULT_IDLE) {
        const id = GLib.idle_add(priority, () => {
            const keep = callback();
            if (keep !== GLib.SOURCE_CONTINUE)
                this._sources.delete(id);
            return keep;
        });
        this._sources.add(id);
        return id;
    }

    remove(id) {
        if (id && this._sources.delete(id))
            GLib.source_remove(id);
    }

    destroy() {
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
    }
}

/** Espera que respeita cancelamento e não deixa source órfão. */
export function sleep(ms, cancellable = null) {
    return new Promise((resolve, reject) => {
        let cancelId = 0;
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (cancelId)
                cancellable.disconnect(cancelId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        cancelId = cancellable?.connect(() => {
            GLib.source_remove(timeoutId);
            cancellable.disconnect(cancelId);
            reject(new CancelledError('Espera cancelada'));
        }) ?? 0;
    });
}
