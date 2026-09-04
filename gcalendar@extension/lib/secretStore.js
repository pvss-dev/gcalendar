/**
 * secretStore.js — segredos no GNOME Keyring (libsecret).
 *
 * A versão anterior guardava client-secret, access-token e refresh-token em
 * GSettings.  O dconf grava em ~/.config/dconf/user em texto claro, legível
 * por qualquer processo do usuário e capturado por backups de dotfiles.
 * Aqui nada de secreto passa pelo GSettings.
 *
 * O access token NÃO é persistido: vive só em memória e é renovado a partir do
 * refresh token quando o Shell reinicia.
 */
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

import * as Log from './log.js';

// libsecret não é auto-promisificada pelo GJS: chamar password_store() sem o
// callback lança "At least 7 arguments required".  Era esse o motivo de todo
// login OAuth falhar logo depois de gravar os tokens.
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.zorin-gcalendar',
    Secret.SchemaFlags.NONE,
    {key: Secret.SchemaAttributeType.STRING}
);

export const SecretKey = {
    CLIENT_SECRET: 'client-secret',
    REFRESH_TOKEN: 'refresh-token',
};

const LABELS = {
    [SecretKey.CLIENT_SECRET]: 'Zorin GCalendar — Client Secret do Google',
    [SecretKey.REFRESH_TOKEN]: 'Zorin GCalendar — Refresh Token do Google',
};

export class SecretStore {
    constructor(cancellable = null) {
        this._cancellable = cancellable;
    }

    /** @returns {Promise<string|null>} */
    async get(key) {
        try {
            return await Secret.password_lookup(SCHEMA, {key}, this._cancellable);
        } catch (err) {
            Log.error(err, `keyring: lendo ${key}`);
            return null;
        }
    }

    /** Grava, ou remove quando `value` é vazio. @returns {Promise<boolean>} */
    async set(key, value) {
        if (!value)
            return this.clear(key);
        try {
            await Secret.password_store(SCHEMA, {key}, Secret.COLLECTION_DEFAULT,
                LABELS[key] ?? key, value, this._cancellable);
            return true;
        } catch (err) {
            Log.error(err, `keyring: gravando ${key}`);
            return false;
        }
    }

    /** @returns {Promise<boolean>} */
    async clear(key) {
        try {
            await Secret.password_clear(SCHEMA, {key}, this._cancellable);
            return true;
        } catch (err) {
            Log.error(err, `keyring: apagando ${key}`);
            return false;
        }
    }

    async clearAll() {
        await Promise.all(Object.values(SecretKey).map(k => this.clear(k)));
    }
}

/**
 * Migração única das versões que guardavam segredos no GSettings.
 * Move o que existir para o keyring e zera as chaves antigas.
 */
export async function migrateFromSettings(settings, store) {
    const moves = [
        ['client-secret', SecretKey.CLIENT_SECRET],
        ['refresh-token', SecretKey.REFRESH_TOKEN],
    ];
    let migrated = false;

    for (const [settingsKey, secretKey] of moves) {
        const value = settings.get_string(settingsKey);
        if (!value)
            continue;
        if (await store.set(secretKey, value)) {
            settings.set_string(settingsKey, '');
            migrated = true;
        }
    }

    // Access token nunca mais é persistido; só limpamos o resíduo.
    if (settings.get_string('access-token')) {
        settings.set_string('access-token', '');
        settings.set_int64('token-expiry', 0);
        migrated = true;
    }

    if (migrated)
        Log.info('Segredos migrados do GSettings para o GNOME Keyring.');
    return migrated;
}
