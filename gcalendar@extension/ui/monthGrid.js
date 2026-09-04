/**
 * monthGrid.js — grade do mês.
 *
 * Usa `Clutter.GridLayout` com `column_homogeneous`, como o próprio calendário
 * do GNOME Shell. É a diferença entre colunas de largura garantida e colunas
 * que seguem o conteúdo: num `St.BoxLayout` cada filho recebe primeiro a
 * largura *natural* dele e só depois a sobra é repartida, então "31" ocupa
 * mais que "1" e a grade muda de largura conforme os números do mês.
 *
 * As 42 células são criadas uma vez e reaproveitadas; mudar de mês só atualiza
 * rótulo e estilo.
 */
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Log from '../lib/log.js';
import {dayKey, sameDay, weekdayAbbreviations, safeColour} from '../lib/utils.js';
import {
    GRID_ROWS, GRID_COLS, monthGridDates, isInDisplayedMonth,
} from '../lib/monthLayout.js';

// Alturas lógicas (px do CSS, multiplicadas pelo fator de escala em HiDPI).
const HEADER_HEIGHT = 22;
const CELL_HEIGHT = 38;
const ROW_SPACING = 2;
const COLUMN_SPACING = 1;
const MAX_DOTS = 3;

export const MonthGrid = GObject.registerClass({
    Signals: {
        /** param: chave "YYYY-MM-DD" do dia clicado */
        'day-activated': {param_types: [GObject.TYPE_STRING]},
    },
}, class MonthGrid extends St.Widget {
    _init() {
        super._init({
            style_class: 'gcal-grid',
            layout_manager: new Clutter.GridLayout({
                // A garantia de largura: todas as colunas medem igual,
                // independente de o dia ter um ou dois dígitos.
                column_homogeneous: true,
                column_spacing: COLUMN_SPACING,
                row_spacing: ROW_SPACING,
            }),
            x_expand: true,
        });

        // Primeiro dia da semana conforme o locale (domingo no pt-BR, segunda
        // na maior parte da Europa) — mesma fonte usada pelo Shell.
        this._weekStart = Shell.util_get_week_start();
        this._cells = [];
        this._cellDates = [];

        this._buildHeader();
        this._buildCells();

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleId = this._themeContext.connect('notify::scale-factor',
            () => this._applyFixedHeight());
        this.connect('destroy', () => {
            if (this._scaleId) {
                this._themeContext.disconnect(this._scaleId);
                this._scaleId = 0;
            }
        });
        this._applyFixedHeight();

        this.connect('notify::allocation', () => this._logGeometry());
    }

    _buildHeader() {
        const layout = this.layout_manager;
        this._headerLabels = weekdayAbbreviations(this._weekStart).map((abbr, column) => {
            const label = new St.Label({
                text: abbr,
                style_class: 'gcal-grid-weekday',
                x_expand: true,
            });
            layout.attach(label, column, 0, 1, 1);
            return label;
        });
    }

    _buildCells() {
        const layout = this.layout_manager;

        for (let index = 0; index < GRID_ROWS * GRID_COLS; index++) {
            const column = index % GRID_COLS;
            const row = Math.floor(index / GRID_COLS);

            const label = new St.Label({
                style_class: 'gcal-grid-day-number',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            // A faixa de marcadores está SEMPRE presente, com altura fixa no
            // CSS: vazia nos dias sem evento. Assim o número fica na mesma
            // posição em toda célula.
            const dots = new St.BoxLayout({
                style_class: 'gcal-grid-dots',
                x_align: Clutter.ActorAlign.CENTER,
            });

            // Empilhar os pontos abaixo do número voltou a ser seguro: a
            // altura da célula é fixada em _applyFixedHeight() e a largura da
            // coluna vem do GridLayout homogêneo sobre a largura do widget.
            // Nenhum dos dois depende mais do conteúdo.
            const content = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
            });
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
            layout.attach(cell, column, row + 1, 1, 1);
        }
    }

    /**
     * Altura idêntica em todo mês, fixada no ator.
     *
     * `height` no CSS do St é apenas uma preferência — o conteúdo consegue
     * superá-la. `set_height()` é um pedido de tamanho fixo, respeitado pelo
     * Clutter. Como o valor vai em pixels, acompanha o fator de escala.
     */
    _applyFixedHeight() {
        const scale = this._themeContext.scale_factor;

        for (const label of this._headerLabels)
            label.set_height(HEADER_HEIGHT * scale);
        for (const cell of this._cells)
            cell.set_height(CELL_HEIGHT * scale);

        const rows = HEADER_HEIGHT + GRID_ROWS * CELL_HEIGHT;
        const spacing = GRID_ROWS * ROW_SPACING;
        this.set_height((rows + spacing) * scale);
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

            this._cellDates[index] = date;
            cell._label.set_text(String(date.getDate()));

            const classes = ['gcal-grid-day'];
            if (!isInDisplayedMonth(date, viewDate))
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
     * Bolinhas coloridas sob o número, uma por evento (até MAX_DOTS).
     *
     * A cor vem da agenda ou do evento, as mesmas da lista abaixo. A faixa
     * nunca é ocultada — só esvaziada — para que a posição do número não mude
     * entre dias com e sem evento.
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

    /**
     * Registra a geometria real da grade, medida na tela.
     *
     * Ler a altura ou a largura que o próprio código impôs seria circular; as
     * posições transformadas são o resultado da alocação. Sai uma linha só —
     * outra linha significa que algo variou, e com quais números.
     */
    _logGeometry() {
        const first = this._cells[0].get_transformed_position();
        const columns = [];
        for (let column = 0; column < GRID_COLS; column++) {
            const [x] = this._cells[column].get_transformed_position();
            columns.push(x);
        }
        const lastCell = this._cells[this._cells.length - 1];
        const [, lastY] = lastCell.get_transformed_position();

        if (![...columns, first[1], lastY].every(Number.isFinite) || lastY === 0)
            return;   // ainda sem alocação

        const widths = columns.slice(1).map((x, i) => Math.round(x - columns[i]));
        const height = Math.round(lastY + lastCell.height -
            this._headerLabels[0].get_transformed_position()[1]);

        const summary = `${height}px alt., colunas ${Math.min(...widths)}–${Math.max(...widths)}px`;
        if (summary === this._loggedGeometry)
            return;

        this._loggedGeometry = summary;
        Log.debug(`área dos dias: ${summary} [${widths.join(', ')}]`);
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
            [Clutter.KEY_Up]: -GRID_COLS,
            [Clutter.KEY_Down]: GRID_COLS,
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
