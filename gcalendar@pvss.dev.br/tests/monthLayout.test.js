import {describe, it, assert, assertEqual, assertDeepEqual} from './harness.js';
import {
    monthGridDates, isInDisplayedMonth, GRID_CELLS, GRID_ROWS, GRID_COLS,
    shiftMonth,
} from '../lib/monthLayout.js';
import {dayKey} from '../lib/utils.js';

describe('monthLayout · altura estável da grade', () => {
    it('todo mês produz exatamente 42 células (6 semanas)', () => {
        // É esta invariante que impede o calendário de mudar de tamanho ao
        // navegar: meses de 5 semanas ganham uma linha de preenchimento em vez
        // de a grade encolher.
        for (let year = 2024; year <= 2027; year++) {
            for (let month = 0; month < 12; month++) {
                for (const weekStart of [0, 1]) {
                    const cells = monthGridDates(new Date(year, month, 15), weekStart);
                    assertEqual(cells.length, GRID_CELLS,
                        `${year}-${month + 1} com weekStart=${weekStart}`);
                }
            }
        }
    });

    it('a grade é 6×7', () => {
        assertEqual(GRID_ROWS * GRID_COLS, GRID_CELLS);
        assertEqual(GRID_ROWS, 6);
    });

    it('fevereiro de 28 dias começando no primeiro dia da semana ainda usa 42 células', () => {
        // Fevereiro/2027 tem 28 dias e começa numa segunda: cabe em 4 semanas.
        // Sem as 42 células fixas, este seria o mês mais "curto" da grade.
        const cells = monthGridDates(new Date(2027, 1, 1), 1);
        assertEqual(cells.length, GRID_CELLS);
        assertEqual(dayKey(cells[0]), '2027-02-01');
        assertEqual(dayKey(cells[GRID_CELLS - 1]), '2027-03-14');
    });

    it('mês de 6 semanas cabe sem cortar nenhum dia', () => {
        // Maio/2027 começa num sábado e tem 31 dias: precisa de 6 linhas.
        const cells = monthGridDates(new Date(2027, 4, 10), 0);
        const inMonth = cells.filter(d => isInDisplayedMonth(d, new Date(2027, 4, 10)));
        assertEqual(inMonth.length, 31, 'todos os dias de maio precisam aparecer');
    });

    it('nenhum mês perde dias, em qualquer início de semana', () => {
        for (let year = 2024; year <= 2027; year++) {
            for (let month = 0; month < 12; month++) {
                const viewDate = new Date(year, month, 15);
                const total = new Date(year, month + 1, 0).getDate();
                for (const weekStart of [0, 1]) {
                    const shown = monthGridDates(viewDate, weekStart)
                        .filter(d => isInDisplayedMonth(d, viewDate)).length;
                    assertEqual(shown, total, `${year}-${month + 1} ws=${weekStart}`);
                }
            }
        }
    });

    it('as datas são contíguas, uma por dia', () => {
        const cells = monthGridDates(new Date(2026, 0, 15), 0);
        for (let i = 1; i < cells.length; i++) {
            const diff = (cells[i] - cells[i - 1]) / 86_400_000;
            assert(Math.abs(diff - 1) < 0.05, `salto de ${diff} dias na posição ${i}`);
        }
    });

    it('a primeira célula é o início da semana escolhido', () => {
        assertEqual(monthGridDates(new Date(2026, 0, 15), 0)[0].getDay(), 0, 'domingo');
        assertEqual(monthGridDates(new Date(2026, 0, 15), 1)[0].getDay(), 1, 'segunda');
    });

    it('a primeira célula nunca passa do dia 1 do mês', () => {
        for (let month = 0; month < 12; month++) {
            const viewDate = new Date(2026, month, 15);
            const first = monthGridDates(viewDate, 0)[0];
            assert(first <= new Date(2026, month, 1),
                `mês ${month + 1}: grade começa depois do dia 1`);
        }
    });

    it('isInDisplayedMonth separa preenchimento do mês exibido', () => {
        const viewDate = new Date(2026, 0, 15);
        assert(isInDisplayedMonth(new Date(2026, 0, 31), viewDate));
        assert(!isInDisplayedMonth(new Date(2025, 11, 31), viewDate));
        assert(!isInDisplayedMonth(new Date(2026, 1, 1), viewDate));
        assert(!isInDisplayedMonth(new Date(2027, 0, 15), viewDate), 'ano diferente');
    });
});

describe('monthLayout · navegação leva o dia selecionado junto', () => {
    it('mantém o número do dia ao avançar de mês', () => {
        const {viewDate, selectedDate} = shiftMonth(
            new Date(2026, 8, 1), new Date(2026, 8, 7), 1);
        assertEqual(dayKey(viewDate), '2026-10-01');
        assertEqual(dayKey(selectedDate), '2026-10-07',
            'o dia selecionado precisa estar no mês exibido');
    });

    it('encolhe quando o mês destino é mais curto', () => {
        // Sem o encolhimento, o Date "conserta" 31/02 para 03/03 e o dia
        // selecionado cairia fora do mês exibido.
        const {viewDate, selectedDate} = shiftMonth(
            new Date(2026, 0, 1), new Date(2026, 0, 31), 1);
        assertEqual(dayKey(viewDate), '2026-02-01');
        assertEqual(dayKey(selectedDate), '2026-02-28');
    });

    it('respeita o 29 de fevereiro em ano bissexto', () => {
        const {selectedDate} = shiftMonth(
            new Date(2024, 0, 1), new Date(2024, 0, 31), 1);
        assertEqual(dayKey(selectedDate), '2024-02-29');
    });

    it('atravessa a virada de ano nos dois sentidos', () => {
        assertEqual(dayKey(shiftMonth(new Date(2026, 11, 1), new Date(2026, 11, 15), 1).selectedDate),
            '2027-01-15');
        assertEqual(dayKey(shiftMonth(new Date(2026, 0, 1), new Date(2026, 0, 15), -1).selectedDate),
            '2025-12-15');
    });

    it('o dia selecionado sempre pertence ao mês exibido, em qualquer salto', () => {
        // Varre um ano inteiro partindo do dia 31, que é o caso que mais quebra.
        for (let month = 0; month < 12; month++) {
            for (const delta of [-1, 1]) {
                const view = new Date(2026, month, 1);
                const selected = new Date(2026, month, Math.min(31,
                    new Date(2026, month + 1, 0).getDate()));
                const moved = shiftMonth(view, selected, delta);
                assertEqual(moved.selectedDate.getMonth(), moved.viewDate.getMonth(),
                    `mês ${month + 1} com delta ${delta}`);
                assertEqual(moved.selectedDate.getFullYear(), moved.viewDate.getFullYear());
            }
        }
    });
});
