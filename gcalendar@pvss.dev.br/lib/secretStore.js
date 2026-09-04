/**
 * secretStore.js — limpeza dos segredos das versões anteriores.
 *
 * Até a v2 a extensão fazia o próprio OAuth e guardava client secret e refresh
 * token no GNOME Keyring. Agora o token vem do GNOME Online Accounts e a
 * extensão não guarda segredo algum — então o que ficou para trás precisa
 * sair, em vez de envelhecer no chaveiro do usuário.
 *
 * Este arquivo existe só por causa dessa migração e pode ser removido quando
 * não houver mais instalações vindas da v2.
 */
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

import * as Log from './log.js';

// libsecret não é auto-promisificada pelo GJS: sem isto, chamar sem o callback
// lança "At least N arguments required".
Gio._promisify(Secret, 'password_clear', 'password_clear_finish');

const LEGACY_SCHEMAS = [
    'org.gnome.shell.extensions.gcalendar',
    'org.gnome.shell.extensions.zorin-gcalendar',
];
const LEGACY_KEYS = ['client-secret', 'refresh-token', 'access-token'];

// Chaves do GSettings que só serviam ao OAuth próprio.
const LEGACY_SETTINGS = ['client-id', 'client-secret', 'access-token', 'refresh-token'];

/** Remove segredos e credenciais que a versão com GOA não usa mais. */
export async function clearLegacySecrets(settings) {
    for (const schemaId of LEGACY_SCHEMAS) {
        const schema = new Secret.Schema(schemaId, Secret.SchemaFlags.NONE,
            {key: Secret.SchemaAttributeType.STRING});
        for (const key of LEGACY_KEYS) {
            try {
                await Secret.password_clear(schema, {key}, null);
            } catch (err) {
                Log.debug(`keyring: ${schemaId}/${key}:`, err.message);
            }
        }
    }

    for (const key of LEGACY_SETTINGS) {
        if (settings.get_string(key))
            settings.set_string(key, '');
    }
    if (settings.get_int64('token-expiry'))
        settings.set_int64('token-expiry', 0);

    Log.debug('resíduos de credenciais das versões anteriores removidos');
}
