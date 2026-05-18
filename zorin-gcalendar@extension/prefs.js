/**
 * prefs.js — Janela de preferências (GTK4 / Adwaita)
 * Roda num processo separado do Shell.
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ZorinGCalendarPrefs extends ExtensionPreferences {

    fillPreferencesWindow(win) {
        win.set_default_size(600, 680);
        win.set_title('Zorin GCalendar — Preferências');
        const s = this.getSettings();

        /* ── Página 1: Conta ─────────────────────────────────── */
        const pg1 = new Adw.PreferencesPage({ title: 'Conta', icon_name: 'avatar-default-symbolic' });

        const grp1 = new Adw.PreferencesGroup({
            title:       'Credenciais OAuth 2.0 do Google',
            description: '1. Acesse https://console.cloud.google.com\n' +
                         '2. Crie um projeto → Ativar "Google Calendar API"\n' +
                         '3. Credenciais → Criar → OAuth 2.0 Client ID → Tipo: Desktop app\n' +
                         '4. Cole o Client ID e Client Secret abaixo.',
        });

        const r1 = new Adw.EntryRow({ title: 'Client ID' });
        s.bind('client-id', r1, 'text', Gio.SettingsBindFlags.DEFAULT);

        const r2 = new Adw.PasswordEntryRow({ title: 'Client Secret' });
        s.bind('client-secret', r2, 'text', Gio.SettingsBindFlags.DEFAULT);

        const link = new Gtk.LinkButton({
            uri:   'https://console.cloud.google.com/apis/credentials',
            label: 'Abrir Google Cloud Console →',
        });
        const r3 = new Adw.ActionRow({ title: 'Console' });
        r3.add_suffix(link); r3.set_activatable_widget(link);

        grp1.add(r1); grp1.add(r2); grp1.add(r3);
        pg1.add(grp1);
        win.add(pg1);

        /* ── Página 2: Widget ────────────────────────────────── */
        const pg2 = new Adw.PreferencesPage({ title: 'Widget', icon_name: 'applications-graphics-symbolic' });

        const grp2 = new Adw.PreferencesGroup({ title: 'Posição do widget' });
        const rx = new Adw.SpinRow({
            title: 'Posição X (px)',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 3840, step_increment: 10, value: 40 }),
        });
        s.bind('widget-x', rx, 'value', Gio.SettingsBindFlags.DEFAULT);
        const ry = new Adw.SpinRow({
            title: 'Posição Y (px)',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 2160, step_increment: 10, value: 60 }),
        });
        s.bind('widget-y', ry, 'value', Gio.SettingsBindFlags.DEFAULT);
        const rop = new Adw.SpinRow({
            title: 'Opacidade do fundo (%)',
            adjustment: new Gtk.Adjustment({ lower: 30, upper: 100, step_increment: 5, value: 92 }),
        });
        s.bind('widget-opacity', rop, 'value', Gio.SettingsBindFlags.DEFAULT);

        grp2.add(rx); grp2.add(ry); grp2.add(rop);
        pg2.add(grp2);

        /* ── Página 3: Sync ──────────────────────────────────── */
        const pg3 = new Adw.PreferencesPage({ title: 'Sincronização', icon_name: 'emblem-synchronizing-symbolic' });

        const grp3 = new Adw.PreferencesGroup({ title: 'Opções' });
        const rs = new Adw.SpinRow({
            title:    'Intervalo de sync (min)',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1, value: 5 }),
        });
        s.bind('sync-interval', rs, 'value', Gio.SettingsBindFlags.DEFAULT);
        const rd = new Adw.SpinRow({
            title: 'Dias à frente',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1, value: 30 }),
        });
        s.bind('days-ahead', rd, 'value', Gio.SettingsBindFlags.DEFAULT);
        const rn = new Adw.SpinRow({
            title: 'Notificar antes do evento (min)',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1, value: 10 }),
        });
        s.bind('notification-minutes-before', rn, 'value', Gio.SettingsBindFlags.DEFAULT);

        grp3.add(rs); grp3.add(rd); grp3.add(rn);
        pg3.add(grp3);

        win.add(pg2);
        win.add(pg3);
    }
}
