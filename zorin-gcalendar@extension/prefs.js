/**
 * prefs.js — janela de preferências (GTK4 + libadwaita).
 *
 * Roda num processo separado do gnome-shell, então não pode importar nada de
 * `resource:///org/gnome/shell/...` nem tocar em St/Clutter.
 *
 * O Client Secret vai para o GNOME Keyring, não para o GSettings — é por isso
 * que este campo não usa `settings.bind()` como os demais.
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SecretStore, SecretKey} from './lib/secretStore.js';

const SECRET_SAVE_DEBOUNCE_MS = 700;
// Mesma ordem das opções mostradas na combo de camada.
const LAYERS = ['desktop', 'auto', 'top'];
const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

export default class ZorinGCalendarPrefs extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const secrets = new SecretStore();

        // Cancela trabalho pendente quando a janela fecha, para não deixar
        // timeouts e chamadas ao keyring rodando sozinhos.
        this._pendingSaveId = 0;
        window.connect('close-request', () => {
            if (this._pendingSaveId) {
                GLib.source_remove(this._pendingSaveId);
                this._pendingSaveId = 0;
            }
            return false;
        });

        window.set_default_size(640, 720);
        window.add(this._accountPage(settings, secrets));
        window.add(this._calendarsPage(settings));
        window.add(this._appearancePage(settings));
        window.add(this._behaviourPage(settings));
    }

    /* ══════════════════════ Conta ══════════════════════ */

    _accountPage(settings, secrets) {
        const page = new Adw.PreferencesPage({
            title: 'Conta',
            icon_name: 'avatar-default-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Credenciais OAuth 2.0',
            description:
                'A extensão usa suas próprias credenciais do Google, criadas em ' +
                'console.cloud.google.com:\n' +
                '1. Crie um projeto e ative a "Google Calendar API".\n' +
                '2. Em Credenciais → Criar → ID do cliente OAuth, escolha o tipo ' +
                '"Aplicativo para computador".\n' +
                '3. Cole abaixo o Client ID e o Client Secret gerados.',
        });

        const clientIdRow = new Adw.EntryRow({title: 'Client ID'});
        settings.bind('client-id', clientIdRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(clientIdRow);

        const secretRow = new Adw.PasswordEntryRow({title: 'Client Secret'});
        this._bindSecret(secretRow, secrets, SecretKey.CLIENT_SECRET);
        group.add(secretRow);

        const consoleRow = new Adw.ActionRow({
            title: 'Google Cloud Console',
            subtitle: 'Abrir a página de credenciais',
        });
        const consoleButton = new Gtk.LinkButton({
            uri: CONSOLE_URL,
            label: 'Abrir',
            valign: Gtk.Align.CENTER,
        });
        consoleRow.add_suffix(consoleButton);
        consoleRow.set_activatable_widget(consoleButton);
        group.add(consoleRow);
        page.add(group);

        const sessionGroup = new Adw.PreferencesGroup({
            title: 'Sessão',
            description: 'O Client Secret e o refresh token ficam no GNOME Keyring, ' +
                         'nunca em texto claro no dconf.',
        });

        const statusRow = new Adw.ActionRow({
            title: 'Conta conectada',
            subtitle: 'Verificando…',
        });
        const signOutButton = new Gtk.Button({
            label: 'Desconectar',
            valign: Gtk.Align.CENTER,
            sensitive: false,
        });
        signOutButton.add_css_class('destructive-action');
        statusRow.add_suffix(signOutButton);
        sessionGroup.add(statusRow);
        page.add(sessionGroup);

        const refreshStatus = async () => {
            const token = await secrets.get(SecretKey.REFRESH_TOKEN);
            statusRow.set_subtitle(token
                ? 'Conectada — o widget está autorizado a acessar sua agenda.'
                : 'Nenhuma conta conectada. Use "Entrar com Google" no widget.');
            signOutButton.set_sensitive(!!token);
        };

        signOutButton.connect('clicked', () => {
            signOutButton.set_sensitive(false);
            // Apagar o keyring daqui deixaria a extensão com o token ainda em
            // memória e sem revogá-lo no Google. Este pedido faz a extensão
            // executar a desconexão completa do lado dela.
            settings.set_int64('sign-out-requested', Math.floor(Date.now() / 1000));
            statusRow.set_subtitle('Desconectando…');
        });

        // A extensão zera a chave quando termina de desconectar; usamos isso
        // como aviso de conclusão, sem ficar consultando o keyring em laço.
        settings.connect('changed::sign-out-requested', () => {
            if (settings.get_int64('sign-out-requested') === 0)
                refreshStatus().catch(() => {});
        });

        refreshStatus().catch(err => statusRow.set_subtitle(`Keyring indisponível: ${err.message}`));
        return page;
    }

    /**
     * Liga uma linha de senha ao keyring: carrega ao abrir e grava com um
     * pequeno atraso, para não escrever a cada tecla digitada.
     */
    _bindSecret(row, secrets, key) {
        let loading = true;

        secrets.get(key)
            .then(value => {
                row.set_text(value ?? '');
                loading = false;
            })
            .catch(() => {
                loading = false;
            });

        row.connect('notify::text', () => {
            if (loading)
                return;
            if (this._pendingSaveId)
                GLib.source_remove(this._pendingSaveId);
            this._pendingSaveId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SECRET_SAVE_DEBOUNCE_MS, () => {
                    this._pendingSaveId = 0;
                    secrets.set(key, row.get_text()).catch(() => {});
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    /* ══════════════════════ Agendas ══════════════════════ */

    _calendarsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Agendas',
            icon_name: 'x-office-calendar-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Agendas exibidas',
            description: 'Sem nenhuma marcada, o widget usa as agendas que estão ' +
                         'visíveis no Google Agenda.',
        });

        const calendars = this._loadCachedCalendars();
        if (calendars.length === 0) {
            group.add(new Adw.ActionRow({
                title: 'Nenhuma agenda conhecida ainda',
                subtitle: 'Conecte sua conta e sincronize uma vez; a lista aparece aqui.',
            }));
        } else {
            const enabled = new Set(settings.get_strv('enabled-calendars'));
            const useDefaults = enabled.size === 0;

            for (const calendar of calendars) {
                const row = new Adw.SwitchRow({
                    title: calendar.name,
                    subtitle: calendar.primary ? 'Agenda principal' : calendar.id,
                    active: useDefaults ? calendar.selected !== false : enabled.has(calendar.id),
                });
                row.connect('notify::active', () => {
                    const current = new Set(settings.get_strv('enabled-calendars'));
                    // Primeira alteração: parte do estado visível na tela.
                    if (current.size === 0) {
                        for (const c of calendars) {
                            if (c.selected !== false)
                                current.add(c.id);
                        }
                    }
                    if (row.active)
                        current.add(calendar.id);
                    else
                        current.delete(calendar.id);
                    settings.set_strv('enabled-calendars', [...current]);
                });
                group.add(row);
            }
        }

        page.add(group);
        return page;
    }

    /** Lê a lista de agendas do cache gravado pela extensão. */
    _loadCachedCalendars() {
        try {
            const path = GLib.build_filenamev([
                GLib.get_user_cache_dir(), this.uuid, 'events.json']);
            const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
            if (!ok)
                return [];
            const data = JSON.parse(new TextDecoder().decode(contents));
            return Array.isArray(data.calendars) ? data.calendars : [];
        } catch {
            return [];
        }
    }

    /* ══════════════════════ Aparência ══════════════════════ */

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Aparência',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const layerGroup = new Adw.PreferencesGroup({title: 'Posicionamento'});

        const layerRow = new Adw.ComboRow({
            title: 'Camada',
            subtitle: 'Onde o widget fica em relação às janelas. ' +
                      '"Some sob as janelas" é o modo que sempre recebe cliques.',
            model: Gtk.StringList.new([
                'Atrás das janelas',
                'Some sob as janelas (mais compatível)',
                'Sempre visível, acima das janelas',
            ]),
            selected: Math.max(0, LAYERS.indexOf(settings.get_string('widget-layer'))),
        });
        layerRow.connect('notify::selected', () =>
            settings.set_string('widget-layer', LAYERS[layerRow.selected] ?? 'desktop'));
        layerGroup.add(layerRow);

        layerGroup.add(this._spinRow(settings, 'widget-x', 'Posição X (px)', 0, 7680, 10));
        layerGroup.add(this._spinRow(settings, 'widget-y', 'Posição Y (px)', 0, 4320, 10));
        layerGroup.add(new Adw.ActionRow({
            title: 'Dica',
            subtitle: 'Arraste o widget pelo cabeçalho; a posição é salva sozinha.',
        }));
        page.add(layerGroup);

        const styleGroup = new Adw.PreferencesGroup({title: 'Estilo'});
        styleGroup.add(this._spinRow(settings, 'widget-opacity',
            'Opacidade do fundo (%)', 20, 100, 5));
        page.add(styleGroup);

        return page;
    }

    /* ══════════════════════ Comportamento ══════════════════════ */

    _behaviourPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Sincronização',
            icon_name: 'emblem-synchronizing-symbolic',
        });

        const syncGroup = new Adw.PreferencesGroup({title: 'Atualização'});
        syncGroup.add(this._spinRow(settings, 'sync-interval',
            'Intervalo de sincronização (min)', 1, 60, 1));
        syncGroup.add(this._spinRow(settings, 'days-ahead',
            'Dias à frente sempre atualizados', 1, 365, 1));
        page.add(syncGroup);

        const notifyGroup = new Adw.PreferencesGroup({title: 'Notificações'});
        const enabledRow = new Adw.SwitchRow({title: 'Avisar sobre eventos próximos'});
        settings.bind('notifications-enabled', enabledRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        notifyGroup.add(enabledRow);

        const minutesRow = this._spinRow(settings, 'notification-minutes-before',
            'Antecedência (min)', 1, 120, 1);
        settings.bind('notifications-enabled', minutesRow, 'sensitive',
            Gio.SettingsBindFlags.GET);
        notifyGroup.add(minutesRow);
        page.add(notifyGroup);

        return page;
    }

    _spinRow(settings, key, title, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({
                lower, upper,
                step_increment: step,
                page_increment: step * 10,
                value: settings.get_int(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
