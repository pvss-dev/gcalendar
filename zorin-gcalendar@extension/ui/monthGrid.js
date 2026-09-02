/**
 * monthGrid.js — grade do mês.
 *
 * As 6×7 células são criadas uma única vez e reaproveitadas: mudar de mês ou
 * receber um sync atualiza rótulo e estilo, sem destruir e recriar 42 atores a
 * cada renderização (o que a versão anterior fazia inclusive a cada clique).
 */
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import {dayKey, sameDay, weekdayAbbreviations, safeColour} from '../lib/utils.js';
import {
    GRID_ROWS as ROWS, GRID_COLS as COLS, monthGridDates, isInDisplayedMonth,
} from '../lib/monthLayout.js';

const MAX_DOTS = 3;

export const MonthGrid = GObject.registerClass({
    Signals: {
        /** param: chave "YYYY-MM-DD" do dia clicado */
        'day-activated': {param_types: [GObject.TYPE_STRING]},
    },
}, class MonthGrid extends St.BoxLayout {
    _init() {
        super._init({vertical: true, style_class: 'gcal-grid'});

        // Primeiro dia da semana conforme o locale (domingo no pt-BR,
        // segunda na maior parte da Europa) — mesma fonte usada pelo Shell.
        this._weekStart = Shell.util_get_week_start();
        this._cells = [];
        this._cellDates = [];

        this._buildHeader();
        this._buildCells();
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'gcal-grid-header'});
        for (const abbr of weekdayAbbreviations(this._weekStart)) {
            header.add_child(new St.Label({
                text: abbr,
                style_class: 'gcal-grid-weekday',
                x_expand: true,
            }));
        }
        this.add_child(header);
    }

    _buildCells() {
        for (let row = 0; row < ROWS; row++) {
            const rowBox = new St.BoxLayout({style_class: 'gcal-grid-row'});
            for (let col = 0; col < COLS; col++) {
                const index = row * COLS + col;

                const label = new St.Label({style_class: 'gcal-grid-day-number'});
                const dots = new St.BoxLayout({style_class: 'gcal-grid-dots'});
                const content = new St.BoxLayout({vertical: true, x_expand: true});
                content.add_child(label);
                content.add_child(dots);

                // St.Button com `label` E `set_child()` perde o número do dia:
                // definir o child substitui o rótulo interno. Só usamos child.
                const cell = new St.Button({
                    style_class: 'gcal-grid-day',
                    can_focus: true,
                    x_expand: true,
                    y_expand: true,
                    child: content,
                });
                cell.connect('clicked', () => {
                    const date = this._cellDates[index];
                    if (date)
                        this.emit('day-activated', dayKey(date));
                });

                cell._label = label;
                cell._dots = dots;
                this._cells.push(cell);
                rowBox.add_child(cell);
            }
            this.add_child(rowBox);
        }
    }

    /**
     * @param {Date} viewDate      qualquer data do mês exibido
     * @param {Date} selectedDate  dia destacado
     * @param {Map<string, string[]>} coloursByDay  "YYYY-MM-DD" → cores dos eventos
     */
    update(viewDate, selectedDate, coloursByDay) {
        const today = new Date();
        const dates = monthGridDates(viewDate, this._weekStart);

        for (let index = 0; index < this._cells.length; index++) {
            const cell = this._cells[index];
            const date = dates[index];
            const inMonth = isInDisplayedMonth(date, viewDate);

            this._cellDates[index] = date;
            cell._label.set_text(String(date.getDate()));

            const classes = ['gcal-grid-day'];
            if (!inMonth)
                classes.push('gcal-grid-day-outside');
            if (sameDay(date, today))
                classes.push('gcal-grid-day-today');
            if (sameDay(date, selectedDate))
                classes.push('gcal-grid-day-selected');
            cell.set_style_class_name(classes.join(' '));

            this._updateDots(cell, coloursByDay.get(dayKey(date)) ?? []);
        }
    }

    /**
     * Os marcadores nunca são ocultados: a faixa tem altura fixa no CSS e só
     * fica vazia quando o dia não tem evento.
     *
     * Ocultá-la (como antes) mudava a altura da célula, portanto da linha,
     * portanto da grade — e como os dias com evento caem em linhas diferentes
     * a cada mês, o calendário mudava de tamanho ao navegar.
     */
    _updateDots(cell, colours) {
        cell._dots.destroy_all_children();
        for (const colour of colours.slice(0, MAX_DOTS)) {
            cell._dots.add_child(new St.Widget({
                style_class: 'gcal-grid-dot',
                style: `background-color: ${safeColour(colour)};`,
            }));
        }
    }

    /** Navegação por teclado entre as células (setas, Home/End). */
    moveFocus(direction) {
        const focused = global.stage.get_key_focus();
        const index = this._cells.indexOf(focused);
        if (index === -1)
            return false;

        const deltas = {
            [Clutter.KEY_Left]: -1,
            [Clutter.KEY_Right]: 1,
            [Clutter.KEY_Up]: -COLS,
            [Clutter.KEY_Down]: COLS,
        };
        const target = index + (deltas[direction] ?? 0);
        if (target < 0 || target >= this._cells.length)
            return false;

        this._cells[target].grab_key_focus();
        return true;
    }

    focusDay(date) {
        const index = this._cellDates.findIndex(d => d && sameDay(d, date));
        if (index !== -1)
            this._cells[index].grab_key_focus();
    }
});
