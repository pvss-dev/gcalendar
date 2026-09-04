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

import Goa from 'gi://Goa';

// Mesma ordem das opções mostradas na combo de camada.
const LAYERS = ['desktop', 'top'];

export default class ZorinGCalendarPrefs extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(640, 720);
        window.add(this._accountPage());
        window.add(this._calendarsPage(settings));
        window.add(this._appearancePage(settings));
        window.add(this._behaviourPage(settings));
    }

    /* ══════════════════════ Conta ══════════════════════ */

    _accountPage() {
        const page = new Adw.PreferencesPage({
            title: 'Conta',
            icon_name: 'avatar-default-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Conta do Google',
            description: 'A extensão usa a conta configurada em Contas Online do ' +
                         'GNOME. Ela não guarda senhas nem credenciais próprias: ' +
                         'o acesso é o mesmo que o restante do sistema já usa.',
        });

        const statusRow = new Adw.ActionRow({
            title: 'Estado',
            subtitle: 'Verificando…',
        });
        const openButton = new Gtk.Button({
            label: 'Abrir Contas Online',
            valign: Gtk.Align.CENTER,
        });
        openButton.add_css_class('suggested-action');
        openButton.connect('clicked', () => this._openOnlineAccounts(statusRow));
        statusRow.add_suffix(openButton);
        statusRow.set_activatable_widget(openButton);
        group.add(statusRow);
        page.add(group);

        this._refreshAccountStatus(statusRow);
        return page;
    }

    /**
     * Lê as contas direto do GOA.
     *
     * As preferências rodam em outro processo, então não dá para perguntar à
     * extensão — mas o serviço do GOA é do sistema e responde aos dois.
     */
    _refreshAccountStatus(statusRow) {
        Goa.Client.new(null, (client, result) => {
            let accounts = [];
            let disabled = [];
            try {
                const goaClient = Goa.Client.new_finish(result);
                for (const object of goaClient.get_accounts()) {
                    const account = object.get_account();
                    if (account.provider_type !== 'google')
                        continue;
                    if (account.calendar_disabled)
                        disabled.push(account.presentation_identity);
                    else
                        accounts.push(account.presentation_identity);
                }
            } catch (err) {
                statusRow.set_subtitle(`Contas Online indisponível: ${err.message}`);
                return;
            }

            if (accounts.length)
                statusRow.set_subtitle(`Conectada: ${accounts.join(', ')}`);
            else if (disabled.length)
                statusRow.set_subtitle(
                    `${disabled.join(', ')} — ative o Calendário para esta conta`);
            else
                statusRow.set_subtitle('Nenhuma conta Google conectada');
        });
    }

    _openOnlineAccounts(statusRow) {
        const app = Gio.DesktopAppInfo.new('gnome-online-accounts-panel.desktop');
        try {
            if (app)
                app.launch([], null);
            else
                Gio.Subprocess.new(['gnome-control-center', 'online-accounts'],
                    Gio.SubprocessFlags.NONE);
        } catch (err) {
            statusRow.set_subtitle(`Não foi possível abrir: ${err.message}`);
        }
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
            // Rótulos curtos: o popup do ComboRow acompanha a largura da
            // linha e corta o texto com reticências. A explicação cabe no
            // subtítulo, que quebra em várias linhas. São também os mesmos
            // rótulos do menu de botão direito do widget.
            subtitle: 'Atrás das janelas, o widget fica na área de trabalho e ' +
                      'não recebe cliques enquanto alguma janela o cobrir.',
            model: Gtk.StringList.new([
                'Atrás das janelas',
                'Sempre visível',
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

        const styleGroup = new Adw.PreferencesGroup({
            title: 'Estilo',
            description: 'A área de eventos tem altura fixa para o widget não ' +
                         'mudar de tamanho conforme o dia selecionado.',
        });
        styleGroup.add(this._spinRow(settings, 'widget-opacity',
            'Opacidade do fundo (%)', 20, 100, 5));
        styleGroup.add(this._spinRow(settings, 'event-list-height',
            'Altura da lista de eventos (px)', 60, 500, 10));
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
