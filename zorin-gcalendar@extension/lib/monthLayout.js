/**
 * monthLayout.js — quais datas ocupam cada célula da grade do mês.
 *
 * Isolado da UI para poder ser testado sem GNOME Shell, e porque é aqui que
 * mora a garantia de altura estável: a grade tem SEMPRE 6×7 células, mesmo
 * quando o mês cabe em 5 semanas (aí a última linha mostra dias do mês
 * seguinte, em vez de a grade encolher).
 */

export const GRID_ROWS = 6;
export const GRID_COLS = 7;
export const GRID_CELLS = GRID_ROWS * GRID_COLS;

/**
 * @param {Date} viewDate qualquer data do mês exibido
 * @param {number} weekStart 0 = domingo, 1 = segunda…
 * @returns {Date[]} exatamente 42 datas, em ordem, começando no primeiro dia
 *   da semana que contém o dia 1
 */
export function monthGridDates(viewDate, weekStart = 0) {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();

    const firstWeekday = new Date(year, month, 1).getDay();
    const leading = (7 + firstWeekday - weekStart) % 7;

    return Array.from({length: GRID_CELLS},
        (_, index) => new Date(year, month, index - leading + 1));
}

/** A célula pertence ao mês exibido, ou é preenchimento de outro mês? */
export function isInDisplayedMonth(date, viewDate) {
    return date.getMonth() === viewDate.getMonth() &&
           date.getFullYear() === viewDate.getFullYear();
}
