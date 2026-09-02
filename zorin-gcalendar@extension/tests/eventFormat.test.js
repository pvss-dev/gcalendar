import {describe, it, assert, assertEqual, assertThrows} from './harness.js';
import {
    describeTiming, parseDateInput, parseTimeInput, formatClock,
} from '../lib/eventFormat.js';

describe('eventFormat · texto de horário', () => {
    const day = new Date(2026, 2, 16);

    it('evento de dia inteiro de um dia só', () => {
        assertEqual(describeTiming({
            allDay: true, start: new Date(2026, 2, 16), end: new Date(2026, 2, 16),
        }, day), 'Dia inteiro');
    });

    it('evento de vários dias diz em que parte do intervalo o dia está', () => {
        const event = {allDay: true, start: new Date(2026, 2, 15), end: new Date(2026, 2, 18)};
        assertEqual(describeTiming(event, new Date(2026, 2, 15)), 'Dia inteiro · começa');
        assertEqual(describeTiming(event, new Date(2026, 2, 16)), 'Dia inteiro · em andamento');
        assertEqual(describeTiming(event, new Date(2026, 2, 18)), 'Dia inteiro · termina');
    });

    it('evento com hora no mesmo dia mostra início e fim', () => {
        const text = describeTiming({
            allDay: false,
            start: new Date(2026, 2, 16, 14, 0),
            end: new Date(2026, 2, 16, 15, 30),
        }, day);
        assert(text.includes('–'), `esperava intervalo, veio "${text}"`);
    });

    it('evento que atravessa dias muda o texto conforme o dia exibido', () => {
        const event = {
            allDay: false,
            start: new Date(2026, 2, 15, 22, 0),
            end: new Date(2026, 2, 16, 3, 0),
        };
        assert(describeTiming(event, new Date(2026, 2, 15)).startsWith('A partir de'));
        assert(describeTiming(event, new Date(2026, 2, 16)).startsWith('Até'));
    });
});

describe('eventFormat · validação do formulário', () => {
    it('aceita data no formato AAAA-MM-DD', () => {
        const date = parseDateInput('2026-03-15');
        assertEqual(date.getFullYear(), 2026);
        assertEqual(date.getMonth(), 2);
        assertEqual(date.getDate(), 15);
    });

    it('rejeita formatos diferentes', async () => {
        for (const bad of ['15/03/2026', '2026-3-15', 'amanhã', '', '2026-03-15T10:00'])
            await assertThrows(() => parseDateInput(bad), `deveria rejeitar "${bad}"`);
    });

    it('rejeita datas que não existem no calendário', async () => {
        // Sem validação, o Date "conserta" 31/02 para 03/03 em silêncio.
        await assertThrows(() => parseDateInput('2026-02-31'));
        await assertThrows(() => parseDateInput('2026-13-01'));
        await assertThrows(() => parseDateInput('2026-04-31'));
    });

    it('aceita 29 de fevereiro em ano bissexto', () => {
        assertEqual(parseDateInput('2024-02-29').getDate(), 29);
    });

    it('aceita horário com e sem zero à esquerda', () => {
        assertEqual(parseTimeInput('09:05')[0], 9);
        assertEqual(parseTimeInput('9:05')[0], 9);
        assertEqual(parseTimeInput('23:59')[1], 59);
        assertEqual(parseTimeInput('00:00')[0], 0);
    });

    it('rejeita horário fora do intervalo', async () => {
        for (const bad of ['24:00', '10:60', '25:10', '10h30', '1030', ''])
            await assertThrows(() => parseTimeInput(bad), `deveria rejeitar "${bad}"`);
    });

    it('formatClock é o inverso de parseTimeInput', () => {
        const text = formatClock(new Date(2026, 2, 15, 9, 5));
        assertEqual(text, '09:05');
        const [hour, minute] = parseTimeInput(text);
        assertEqual(hour, 9);
        assertEqual(minute, 5);
    });
});
