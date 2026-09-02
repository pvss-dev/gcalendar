import {describe, it, assert, assertEqual, assertDeepEqual} from './harness.js';
import {
    normalizeEvent, normalizeCalendar, spannedDayKeys, draftToGoogle, compareEvents,
} from '../lib/calendarService.js';
import {dayKey} from '../lib/utils.js';

const CALENDAR = {id: 'work@group.calendar.google.com', name: 'Trabalho',
    colour: '#0b8043', canWrite: true};

describe('calendarService · normalização de eventos', () => {
    it('evento com hora vira Date local com fim correto', () => {
        const event = normalizeEvent({
            id: 'e1',
            summary: 'Reunião',
            start: {dateTime: '2026-03-15T14:00:00-03:00'},
            end: {dateTime: '2026-03-15T15:30:00-03:00'},
        }, CALENDAR);

        assertEqual(event.allDay, false);
        assertEqual(event.title, 'Reunião');
        assertEqual(event.calendarId, CALENDAR.id);
        assertEqual(event.start.getTime(), Date.UTC(2026, 2, 15, 17, 0));
        assertEqual(event.end.getTime(), Date.UTC(2026, 2, 15, 18, 30));
    });

    it('evento de dia inteiro converte o fim exclusivo do Google em inclusivo', () => {
        // A API devolve end.date = dia seguinte; um evento de 1 dia tem
        // start=2026-03-15 e end=2026-03-16.
        const event = normalizeEvent({
            id: 'e2',
            summary: 'Feriado',
            start: {date: '2026-03-15'},
            end: {date: '2026-03-16'},
        }, CALENDAR);

        assertEqual(event.allDay, true);
        assertEqual(dayKey(event.start), '2026-03-15');
        assertEqual(dayKey(event.end), '2026-03-15', 'fim deve ser inclusivo');
        assertDeepEqual(event.dayKeys, ['2026-03-15']);
    });

    it('título vazio recebe rótulo padrão', () => {
        const event = normalizeEvent({id: 'e3', summary: '   ',
            start: {date: '2026-03-15'}, end: {date: '2026-03-16'}}, CALENDAR);
        assertEqual(event.title, 'Sem título');
    });

    it('herda a cor da agenda quando não há colorId', () => {
        const event = normalizeEvent({id: 'e4',
            start: {date: '2026-03-15'}, end: {date: '2026-03-16'}}, CALENDAR);
        assertEqual(event.colour, CALENDAR.colour);
    });

    it('colorId do evento tem prioridade sobre a cor da agenda', () => {
        const event = normalizeEvent({id: 'e5', colorId: '11',
            start: {date: '2026-03-15'}, end: {date: '2026-03-16'}}, CALENDAR);
        assertEqual(event.colour, '#d50000');
    });

    it('marca instância de evento recorrente', () => {
        const event = normalizeEvent({id: 'e6_20260315', recurringEventId: 'e6',
            start: {dateTime: '2026-03-15T09:00:00-03:00'},
            end: {dateTime: '2026-03-15T10:00:00-03:00'}}, CALENDAR);
        assert(event.isRecurring);
        assertEqual(event.recurringEventId, 'e6');
    });

    it('marca somente leitura em agenda sem permissão de escrita', () => {
        const event = normalizeEvent({id: 'e7', start: {date: '2026-03-15'},
            end: {date: '2026-03-16'}}, {...CALENDAR, canWrite: false});
        assert(event.readOnly);
    });

    it('fim ausente ou anterior ao início não gera intervalo negativo', () => {
        const event = normalizeEvent({id: 'e8',
            start: {dateTime: '2026-03-15T14:00:00-03:00'}}, CALENDAR);
        assert(event.end >= event.start);
    });
});

describe('calendarService · dias ocupados pelo evento', () => {
    it('evento de um dia ocupa só aquele dia', () => {
        const keys = spannedDayKeys(new Date(2026, 2, 15, 14), new Date(2026, 2, 15, 15), false);
        assertDeepEqual(keys, ['2026-03-15']);
    });

    it('evento de vários dias aparece em TODOS os dias', () => {
        // A versão anterior indexava só o dia de início: um evento de terça a
        // quinta sumia de quarta e quinta.
        const keys = spannedDayKeys(new Date(2026, 2, 17, 9), new Date(2026, 2, 19, 18), false);
        assertDeepEqual(keys, ['2026-03-17', '2026-03-18', '2026-03-19']);
    });

    it('evento que termina à meia-noite não vaza para o dia seguinte', () => {
        const keys = spannedDayKeys(new Date(2026, 2, 15, 19), new Date(2026, 2, 16, 0, 0), false);
        assertDeepEqual(keys, ['2026-03-15']);
    });

    it('evento que cruza a meia-noite ocupa os dois dias', () => {
        const keys = spannedDayKeys(new Date(2026, 2, 15, 22), new Date(2026, 2, 16, 2), false);
        assertDeepEqual(keys, ['2026-03-15', '2026-03-16']);
    });

    it('dia inteiro de vários dias cobre o intervalo inclusivo', () => {
        const keys = spannedDayKeys(new Date(2026, 2, 15), new Date(2026, 2, 17), true);
        assertDeepEqual(keys, ['2026-03-15', '2026-03-16', '2026-03-17']);
    });

    it('atravessa a virada de mês', () => {
        const keys = spannedDayKeys(new Date(2026, 0, 30), new Date(2026, 1, 2), true);
        assertDeepEqual(keys, ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
    });

    it('trunca eventos absurdamente longos em vez de gerar milhares de chaves', () => {
        const keys = spannedDayKeys(new Date(2020, 0, 1), new Date(2030, 0, 1), true);
        assert(keys.length <= 401, `gerou ${keys.length} chaves`);
    });

    it('data inválida devolve lista vazia', () => {
        assertDeepEqual(spannedDayKeys(new Date(NaN), new Date(NaN), false), []);
    });
});

describe('calendarService · ordenação', () => {
    it('dia inteiro vem antes dos eventos com hora', () => {
        const allDay = {allDay: true, start: new Date(2026, 2, 15), title: 'A'};
        const timed = {allDay: false, start: new Date(2026, 2, 15, 8), title: 'B'};
        assert(compareEvents(allDay, timed) < 0);
        assert(compareEvents(timed, allDay) > 0);
    });

    it('eventos com hora ficam em ordem cronológica', () => {
        const early = {allDay: false, start: new Date(2026, 2, 15, 8), title: 'A'};
        const late = {allDay: false, start: new Date(2026, 2, 15, 18), title: 'B'};
        assert(compareEvents(early, late) < 0);
    });

    it('empate no horário desempata por título', () => {
        const a = {allDay: false, start: new Date(2026, 2, 15, 8), title: 'Alfa'};
        const b = {allDay: false, start: new Date(2026, 2, 15, 8), title: 'Beta'};
        assert(compareEvents(a, b) < 0);
    });
});

describe('calendarService · rascunho → corpo da API', () => {
    it('evento com hora envia dateTime e timeZone explícitos', () => {
        const body = draftToGoogle({
            title: 'Consulta',
            start: new Date(2026, 2, 15, 14, 0),
            end: new Date(2026, 2, 15, 15, 0),
            allDay: false,
        });
        assertEqual(body.summary, 'Consulta');
        assert(body.start.dateTime.startsWith('2026-03-15T14:00:00'));
        assert(!!body.start.timeZone, 'timeZone é obrigatório para não usar o fuso da agenda');
        assertEqual(body.start.date, undefined);
    });

    it('dia inteiro envia end.date exclusivo (dia seguinte)', () => {
        const day = new Date(2026, 2, 15);
        const body = draftToGoogle({title: 'Folga', start: day, end: day, allDay: true});
        assertEqual(body.start.date, '2026-03-15');
        assertEqual(body.end.date, '2026-03-16', 'a API exige fim exclusivo');
        assertEqual(body.start.dateTime, undefined);
    });

    it('dia inteiro de vários dias soma um dia ao fim', () => {
        const body = draftToGoogle({title: 'Viagem', start: new Date(2026, 2, 15),
            end: new Date(2026, 2, 18), allDay: true});
        assertEqual(body.end.date, '2026-03-19');
    });

    it('PATCH parcial não inclui campos ausentes', () => {
        const body = draftToGoogle({title: 'Só o título'});
        assertDeepEqual(Object.keys(body), ['summary']);
    });
});

describe('calendarService · normalização de agendas', () => {
    it('extrai nome, permissão e cor', () => {
        const calendar = normalizeCalendar({
            id: 'a@b', summary: 'Pessoal', backgroundColor: '#0b8043',
            accessRole: 'owner', primary: true,
        });
        assertEqual(calendar.name, 'Pessoal');
        assertEqual(calendar.canWrite, true);
        assertEqual(calendar.primary, true);
        assertEqual(calendar.colour, '#0b8043');
    });

    it('summaryOverride tem prioridade sobre summary', () => {
        const calendar = normalizeCalendar({id: 'a@b', summary: 'Original',
            summaryOverride: 'Meu apelido', accessRole: 'reader'});
        assertEqual(calendar.name, 'Meu apelido');
        assertEqual(calendar.canWrite, false, 'reader não pode escrever');
    });

    it('freeBusyReader e reader não são graváveis', () => {
        for (const role of ['reader', 'freeBusyReader']) {
            assertEqual(normalizeCalendar({id: 'x', accessRole: role}).canWrite, false, role);
        }
        assertEqual(normalizeCalendar({id: 'x', accessRole: 'writer'}).canWrite, true);
    });
});
