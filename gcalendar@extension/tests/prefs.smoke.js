#!/usr/bin/env -S gjs -m
/**
 * prefs.smoke.js — constrói toda a UI de preferências de verdade (GTK4/Adw)
 * sem abrir janela, para pegar erros de widget que a checagem de sintaxe não vê.
 *
 * Precisa de uma sessão gráfica; sem DISPLAY/WAYLAND_DISPLAY, pula.
 * Uso: gjs -m tests/prefs.smoke.js
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {makeSettings} from './fakes.js';
import {SecretStore} from '../lib/secretStore.js';

if (!GLib.getenv('WAYLAND_DISPLAY') && !GLib.getenv('DISPLAY')) {
    print('sem sessão gráfica — smoke test de prefs pulado');
    imports.system.exit(0);
}

const here = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const root = GLib.path_get_dirname(here);

Gtk.init();
Adw.init();

// prefs.js importa resource:///org/gnome/Shell/Extensions/js/... — fora do
// processo de preferências do Shell esse gresource precisa ser registrado.
for (const path of [
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource',
    '/usr/share/gnome-shell/org.gnome.Extensions.src.gresource',
]) {
    try {
        Gio.resource_load(path)._register();
    } catch {
        // Caminho ausente nesta distribuição; o import abaixo dirá se faltou.
    }
}

const {default: ZorinGCalendarPrefs} = await import(`file://${root}/prefs.js`);

// A janela real de preferências instancia isto via ExtensionBase; aqui só
// precisamos dos construtores de página, então montamos o objeto direto.
const prefs = Object.create(ZorinGCalendarPrefs.prototype);
prefs.metadata = {uuid: 'gcalendar@extension'};   // `uuid` é getter em ExtensionBase

const settings = makeSettings(GLib.build_filenamev([root, 'schemas']));
const secrets = new SecretStore();

const pages = [
    ['Conta', () => prefs._accountPage(settings, secrets)],
    ['Agendas', () => prefs._calendarsPage(settings)],
    ['Aparência', () => prefs._appearancePage(settings)],
    ['Sincronização', () => prefs._behaviourPage(settings)],
];

let failed = 0;
const window = new Adw.PreferencesWindow();
for (const [name, build] of pages) {
    try {
        const page = build();
        window.add(page);
        print(`  \x1b[32m✓\x1b[0m página "${name}" construída e adicionada`);
    } catch (err) {
        failed++;
        print(`  \x1b[31m✗\x1b[0m página "${name}": ${err.message}`);
    }
}

// Exercita os binds: mudar a configuração não pode explodir na UI.
try {
    settings.set_int('widget-opacity', 55);
    settings.set_string('widget-layer', 'desktop');
    settings.set_boolean('notifications-enabled', false);
    settings.set_int('sync-interval', 12);
    print('  \x1b[32m✓\x1b[0m binds GSettings ↔ widgets reagem sem erro');
} catch (err) {
    failed++;
    print(`  \x1b[31m✗\x1b[0m binds: ${err.message}`);
}

window.destroy();
print(failed === 0 ? '\nprefs.js OK\n' : `\n${failed} falha(s)\n`);
imports.system.exit(failed === 0 ? 0 : 1);
