/**
 * eventDialog.js — criar, editar e excluir eventos.
 *
 * A versão anterior não tinha nada disso: o botão "+ Novo evento" abria o
 * Google Calendar no navegador, e não havia edição nem exclusão, apesar de
 * `CalendarAPI` já expor os métodos.
 *
 * Usa ModalDialog do próprio Shell, o que traz de graça foco de teclado,
 * fechar com Esc e o visual padrão dos diálogos do GNOME.
 */
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import * as Log from '../lib/log.js';
import {userMessage} from '../lib/errors.js';
import {dayKey, addDays, startOfDay} from '../lib/utils.js';
import {parseDateInput, parseTimeInput, formatClock} from '../lib/eventFormat.js';

export const EventDialog = GObject.registerClass(
class EventDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} opts
     * @param {import('../lib/eventStore.js').EventStore} opts.store
     * @param {object|null} opts.event  evento existente (edição) ou null (criação)
     * @param {Date} opts.date          dia pré-selecionado ao criar
     */
    _init({store, event = null, date = new Date()}) {
        super._init({styleClass: 'gcal-dialog', destroyOnClose: true});

        this._store = store;
        this._event = event;
        this._isEdit = !!event;
        this._busy = false;

        this._calendars = store.getWritableCalendars();
        this._calendarIndex = Math.max(0, this._calendars.findIndex(c =>
            c.id === (event?.calendarId ?? store.getDefaultCalendar()?.id)));

        this._buildContent(date);
        this._buildButtons();
        this.setInitialKeyFocus(this._titleEntry.clutter_text);
    }

    /* ══════════════════════ Construção ══════════════════════ */

    _buildContent(date) {
        const box = new St.BoxLayout({vertical: true, style_class: 'gcal-dialog-content'});

        box.add_child(new St.Label({
            text: this._isEdit ? 'Editar evento' : 'Novo evento',
            style_class: 'gcal-dialog-title',
        }));

        const start = this._event?.start ?? defaultStart(date);
        const end = this._event?.end ?? new Date(start.getTime() + 3600_000);

        this._titleEntry = this._addEntry(box, 'Título', this._event?.title ?? '',
            'Reunião, consulta, aniversário…');
        this._locationEntry = this._addEntry(box, 'Local', this._event?.location ?? '',
            'Opcional');

        this._allDayButton = new St.Button({
            style_class: 'gcal-dialog-toggle',
            toggle_mode: true,
            checked: this._event?.allDay ?? false,
            label: 'Dia inteiro',
            can_focus: true,
        });
        this._allDayButton.connect('notify::checked', () => this._syncTimeSensitivity());
        box.add_child(this._wrapRow('Duração', this._allDayButton));

        const dateRow = new St.BoxLayout({style_class: 'gcal-dialog-inline'});
        this._startDateEntry = this._makeEntry(dayKey(start), 'AAAA-MM-DD', 110);
        this._startTimeEntry = this._makeEntry(formatClock(start), 'HH:MM', 70);
        this._endTimeEntry = this._makeEntry(formatClock(end), 'HH:MM', 70);
        dateRow.add_child(this._startDateEntry);
        dateRow.add_child(new St.Label({text: 'das', style_class: 'gcal-dialog-inline-label'}));
        dateRow.add_child(this._startTimeEntry);
        dateRow.add_child(new St.Label({text: 'às', style_class: 'gcal-dialog-inline-label'}));
        dateRow.add_child(this._endTimeEntry);
        box.add_child(this._wrapRow('Quando', dateRow));

        if (this._calendars.length > 1) {
            this._calendarButton = new St.Button({
                style_class: 'gcal-dialog-toggle',
                label: this._calendarLabel(),
                can_focus: true,
            });
            this._calendarButton.connect('clicked', () => {
                this._calendarIndex = (this._calendarIndex + 1) % this._calendars.length;
                this._calendarButton.set_label(this._calendarLabel());
            });
            box.add_child(this._wrapRow('Agenda', this._calendarButton));
        }

        if (this._event?.isRecurring) {
            box.add_child(new St.Label({
                text: 'Este é um evento recorrente. As mudanças valem só para esta ocorrência.',
                style_class: 'gcal-dialog-note',
            }));
        }

        this._statusLabel = new St.Label({text: '', style_class: 'gcal-dialog-status'});
        this._statusLabel.clutter_text.line_wrap = true;
        this._statusLabel.hide();
        box.add_child(this._statusLabel);

        this.contentLayout.add_child(box);
        this._syncTimeSensitivity();
    }

    _buildButtons() {
        // addButton() devolve o St.Button criado; guardamos as referências
        // porque o ModalDialog não expõe a lista de botões.
        this._buttons = [];
        this._buttons.push(this.addButton({
            label: 'Cancelar',
            action: () => this.close(global.get_current_time()),
            key: Clutter.KEY_Escape,
        }));
        if (this._isEdit) {
            this._buttons.push(this.addButton({
                label: 'Excluir',
                action: () => this._onDelete(),
            }));
        }
        this._buttons.push(this.addButton({
            label: this._isEdit ? 'Salvar' : 'Criar',
            action: () => this._onSave(),
            default: true,
        }));
    }

    _addEntry(parent, label, value, hint) {
        const entry = this._makeEntry(value, hint, 0);
        entry.x_expand = true;
        parent.add_child(this._wrapRow(label, entry));
        return entry;
    }

    _makeEntry(text, hint, width) {
        const entry = new St.Entry({
            text: text ?? '',
            hint_text: hint,
            style_class: 'gcal-dialog-entry',
            can_focus: true,
        });
        if (width)
            entry.set_width(width);
        return entry;
    }

    _wrapRow(labelText, child) {
        const row = new St.BoxLayout({style_class: 'gcal-dialog-row'});
        row.add_child(new St.Label({
            text: labelText,
            style_class: 'gcal-dialog-label',
        }));
        child.x_expand = true;
        row.add_child(child);
        return row;
    }

    _calendarLabel() {
        return this._calendars[this._calendarIndex]?.name ?? 'Agenda padrão';
    }

    _syncTimeSensitivity() {
        const allDay = this._allDayButton.checked;
        for (const entry of [this._startTimeEntry, this._endTimeEntry]) {
            entry.reactive = !allDay;
            entry.can_focus = !allDay;
            entry.opacity = allDay ? 110 : 255;
        }
    }

    /* ══════════════════════ Ações ══════════════════════ */

    async _onSave() {
        if (this._busy)
            return;

        let draft;
        try {
            draft = this._readDraft();
        } catch (err) {
            this._showStatus(err.message);
            return;
        }

        const calendar = this._calendars[this._calendarIndex];
        if (!calendar) {
            this._showStatus('Nenhuma agenda com permissão de escrita.');
            return;
        }

        this._setBusy(true, this._isEdit ? 'Salvando…' : 'Criando…');
        try {
            if (this._isEdit)
                await this._store.updateEvent(this._event.calendarId, this._event.id, draft);
            else
                await this._store.createEvent(calendar.id, draft);
            this.close(global.get_current_time());
        } catch (err) {
            Log.error(err, 'salvar evento');
            this._setBusy(false);
            this._showStatus(userMessage(err));
        }
    }

    async _onDelete() {
        if (this._busy)
            return;

        // Segundo clique confirma: um diálogo dentro do diálogo seria pior.
        if (!this._confirmingDelete) {
            this._confirmingDelete = true;
            this._showStatus(this._event.isRecurring
                ? 'Clique em Excluir de novo para remover esta ocorrência.'
                : 'Clique em Excluir de novo para confirmar.');
            return;
        }

        this._setBusy(true, 'Excluindo…');
        try {
            await this._store.deleteEvent(this._event.calendarId, this._event.id);
            this.close(global.get_current_time());
        } catch (err) {
            Log.error(err, 'excluir evento');
            this._setBusy(false);
            this._confirmingDelete = false;
            this._showStatus(userMessage(err));
        }
    }

    /** @returns {object} rascunho no modelo de domínio */
    _readDraft() {
        const title = this._titleEntry.get_text().trim();
        if (!title)
            throw new Error('Informe um título para o evento.');

        const day = parseDateInput(this._startDateEntry.get_text().trim());
        const allDay = this._allDayButton.checked;

        if (allDay) {
            return {
                title,
                location: this._locationEntry.get_text().trim(),
                allDay: true,
                start: day,
                end: day,
            };
        }

        const [startHour, startMinute] = parseTimeInput(this._startTimeEntry.get_text().trim());
        const [endHour, endMinute] = parseTimeInput(this._endTimeEntry.get_text().trim());

        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
            startHour, startMinute);
        let end = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
            endHour, endMinute);

        // Fim antes do início significa que o evento atravessa a meia-noite.
        if (end <= start)
            end = addDays(end, 1);

        return {
            title,
            location: this._locationEntry.get_text().trim(),
            allDay: false,
            start,
            end,
        };
    }

    _setBusy(busy, message = '') {
        this._busy = busy;
        for (const button of this._buttons) {
            button.reactive = !busy;
            button.opacity = busy ? 128 : 255;
        }
        if (message)
            this._showStatus(message);
    }

    _showStatus(text) {
        this._statusLabel.set_text(text);
        this._statusLabel.visible = !!text;
    }
});

/* ══════════════════════ Helpers de formulário ══════════════════════ */

function defaultStart(date) {
    const now = new Date();
    const base = startOfDay(date);
    // Ao criar num dia futuro começa às 9h; no dia de hoje, na próxima hora cheia.
    if (base.toDateString() === startOfDay(now).toDateString())
        return new Date(base.getFullYear(), base.getMonth(), base.getDate(), now.getHours() + 1, 0);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0);
}
