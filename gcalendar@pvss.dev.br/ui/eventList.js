/**
 * eventList.js — eventos do dia selecionado.
 *
 * Além da lista, é aqui que aparecem os estados que a versão anterior não
 * tinha: carregando, erro, offline, sem conta conectada.
 */
import St from 'gi://St';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Log from '../lib/log.js';
import {truncate, safeColour} from '../lib/utils.js';
import {describeTiming} from '../lib/eventFormat.js';

export const EventList = GObject.registerClass(
class EventList extends St.BoxLayout {
    /**
     * @param {(event: object) => void} onActivate  chamado ao clicar num evento
     */
    _init(onActivate) {
        super._init({vertical: true, style_class: 'gcal-events'});
        this._onActivate = onActivate;
    }

    /** @param {object[]} events @param {Date} day */
    setEvents(events, day) {
        this.destroy_all_children();

        if (events.length === 0) {
            this.add_child(new St.Label({
                text: 'Nenhum evento neste dia.',
                style_class: 'gcal-events-empty',
            }));
            return;
        }

        for (const event of events)
            this.add_child(this._buildRow(event, day));
    }

    /** Mensagem no lugar da lista (erro, carregando, precisa de login). */
    setMessage(text, {actionLabel = null, onAction = null, tone = 'info'} = {}) {
        this.destroy_all_children();

        const box = new St.BoxLayout({
            vertical: true,
            style_class: `gcal-notice gcal-notice-${tone}`,
        });

        const label = new St.Label({text, style_class: 'gcal-notice-text'});
        label.clutter_text.line_wrap = true;
        label.clutter_text.set_line_alignment(1);   // centralizado
        box.add_child(label);

        if (actionLabel && onAction) {
            const button = new St.Button({
                label: actionLabel,
                style_class: 'gcal-notice-button',
                can_focus: true,
            });
            button.connect('clicked', () => onAction(button));
            box.add_child(button);
        }

        this.add_child(box);
    }

    _buildRow(event, day) {
        const row = new St.Button({
            style_class: 'gcal-event',
            can_focus: true,
            x_expand: true,
        });

        const content = new St.BoxLayout({style_class: 'gcal-event-content'});

        content.add_child(new St.Widget({
            style_class: 'gcal-event-strip',
            style: `background-color: ${safeColour(event.colour)};`,
        }));

        const info = new St.BoxLayout({vertical: true, x_expand: true});
        info.add_child(new St.Label({
            text: truncate(event.title, 38),
            style_class: 'gcal-event-title',
        }));
        info.add_child(new St.Label({
            text: describeTiming(event, day) +
                  (event.location ? ` · ${truncate(event.location, 20)}` : ''),
            style_class: 'gcal-event-meta',
        }));
        content.add_child(info);

        if (event.htmlLink) {
            const openButton = new St.Button({
                style_class: 'gcal-event-open',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'adw-external-link-symbolic',
                    fallback_icon_name: 'web-browser-symbolic',
                    icon_size: 14,
                }),
            });
            openButton.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(event.htmlLink, null);
                } catch (err) {
                    Log.warn('não foi possível abrir o evento:', err.message);
                }
            });
            content.add_child(openButton);
        }

        row.set_child(content);
        row.connect('clicked', () => this._onActivate?.(event));
        return row;
    }
});
