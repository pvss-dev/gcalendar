import {describe, it, assert, assertEqual, assertDeepEqual} from './harness.js';
import {
    selectDueNotifications, pruneNotified, notificationKey,
} from '../lib/notificationRules.js';

const NOW = new Date(2026, 8, 3, 10, 0).getTime();

/** Evento com hora, começando `minutes` a partir de NOW. */
function evento(id, minutes, extra = {}) {
    return {
        id,
        calendarId: 'cal',
        title: id,
        allDay: false,
        start: new Date(NOW + minutes * 60_000),
        ...extra,
    };
}

const selecionar = (events, leadMinutes = 10, notified = new Map()) =>
    selectDueNotifications({events, leadMinutes, now: NOW, notified});

describe('notificationRules · quem é avisado', () => {
    it('avisa evento dentro da antecedência', () => {
        const due = selecionar([evento('reuniao', 5)]);
        assertEqual(due.length, 1);
        assertEqual(due[0].minutesLeft, 5);
    });

    it('não avisa evento ainda distante', () => {
        assertEqual(selecionar([evento('daqui-a-pouco', 30)], 10).length, 0);
    });

    it('avisa exatamente no limite da antecedência', () => {
        assertEqual(selecionar([evento('no-limite', 10)], 10).length, 1);
    });

    it('não avisa evento que já começou', () => {
        assertEqual(selecionar([evento('passou', -1)]).length, 0);
    });

    it('avisa evento começando agora', () => {
        const due = selecionar([evento('agora', 0)]);
        assertEqual(due.length, 1);
        assertEqual(due[0].minutesLeft, 0);
    });

    it('ignora evento de dia inteiro', () => {
        // "Faltam 10 minutos" não significa nada para um evento sem hora.
        const due = selecionar([evento('feriado', 5, {allDay: true})]);
        assertEqual(due.length, 0);
    });

    it('respeita a antecedência configurada pelo usuário', () => {
        const eventos = [evento('em-25-min', 25)];
        assertEqual(selecionar(eventos, 10).length, 0);
        assertEqual(selecionar(eventos, 30).length, 1);
    });

    it('ordena por horário de início', () => {
        const due = selecionar([evento('depois', 8), evento('antes', 2)]);
        assertDeepEqual(due.map(d => d.event.id), ['antes', 'depois']);
    });
});

describe('notificationRules · não repetir aviso', () => {
    it('não avisa duas vezes o mesmo evento', () => {
        const ev = evento('reuniao', 5);
        const notified = new Map([[notificationKey(ev), NOW - 60_000]]);
        assertEqual(selecionar([ev], 10, notified).length, 0);
    });

    it('avisa de novo se o evento foi remarcado', () => {
        // A chave inclui o horário de início: remarcar gera chave diferente.
        const original = evento('reuniao', 5);
        const notified = new Map([[notificationKey(original), NOW]]);
        const remarcado = {...original, start: new Date(NOW + 7 * 60_000)};
        assertEqual(selecionar([remarcado], 10, notified).length, 1);
    });

    it('a chave distingue eventos de agendas diferentes', () => {
        const a = evento('mesmo-id', 5);
        const b = {...a, calendarId: 'outra-agenda'};
        assert(notificationKey(a) !== notificationKey(b));
    });
});

describe('notificationRules · registro de avisados', () => {
    it('descarta entradas mais antigas que o TTL', () => {
        const ttl = 24 * 60 * 60 * 1000;
        const notified = new Map([
            ['velha', NOW - ttl - 1],
            ['recente', NOW - 1000],
        ]);
        pruneNotified(notified, NOW, ttl);
        assertDeepEqual([...notified.keys()], ['recente'],
            'sem a poda, o Map cresce enquanto a sessão durar');
    });

    it('não descarta nada quando tudo é recente', () => {
        const notified = new Map([['a', NOW], ['b', NOW - 500]]);
        pruneNotified(notified, NOW, 60_000);
        assertEqual(notified.size, 2);
    });
});
