import {describe, it, assert, assertEqual, assertDeepEqual} from './harness.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {EventStore, SyncState} from '../lib/eventStore.js';
import {AuthError, NetworkError, ApiError} from '../lib/errors.js';
import {FakeAuth, FakeService, makeSettings, makeTempDir, removeDir} from './fakes.js';
import {dayKey} from '../lib/utils.js';

const SCHEMAS_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace('file://', ''))),
    'schemas',
]);

const WORK = {id: 'work', summary: 'Trabalho', accessRole: 'owner',
    backgroundColor: '#0b8043', selected: true};
const HOME = {id: 'home', summary: 'Pessoal', accessRole: 'reader',
    backgroundColor: '#d50000', selected: true};

/** Data futura fixa para os eventos caírem dentro da janela de sync. */
function futureDay(offsetDays = 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + offsetDays);
    return date;
}

function timedEvent(id, calendarId, day, startHour, endHour) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endHour);
    return {calendarId, raw: {id, summary: id,
        start: {dateTime: start.toISOString()}, end: {dateTime: end.toISOString()}}};
}

function makeStore({service, auth, settings, cacheDir}) {
    return new EventStore({
        service,
        auth,
        settings,
        cancellable: new Gio.Cancellable(),
        cacheDir,
    });
}

describe('eventStore · sincronização', () => {
    it('indexa eventos por dia depois do sync', async () => {
        const day = futureDay(2);
        const service = new FakeService({
            calendars: [WORK],
            events: [timedEvent('reuniao', 'work', day, 14, 15)],
        });
        const settings = makeSettings(SCHEMAS_DIR);
        const store = makeStore({service, auth: new FakeAuth(), settings,
            cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.state, SyncState.IDLE);
        assertEqual(store.getEventsForDay(day).length, 1);
        assertEqual(store.getEventsForDay(day)[0].title, 'reuniao');
        assert(store.getDayKeysWithEvents().has(dayKey(day)));
        store.destroy();
    });

    it('evento de vários dias aparece em cada dia do intervalo', async () => {
        const start = futureDay(2);
        const end = futureDay(4);
        const service = new FakeService({
            calendars: [WORK],
            events: [{calendarId: 'work', raw: {id: 'viagem', summary: 'Viagem',
                start: {date: dayKey(start)}, end: {date: dayKey(futureDay(5))}}}],
        });
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        for (const offset of [2, 3, 4]) {
            assertEqual(store.getEventsForDay(futureDay(offset)).length, 1,
                `dia +${offset} deveria conter o evento`);
        }
        assertEqual(store.getEventsForDay(futureDay(5)).length, 0, 'fim é exclusivo na API');
        store.destroy();
    });

    it('não busca nada sem conta conectada', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth({authenticated: false}),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.state, SyncState.UNAUTHENTICATED);
        assertEqual(service.listCalls, 0, 'não deve chamar a API sem token');
        store.destroy();
    });

    it('sinaliza falta de configuração antes de tentar autenticar', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service,
            auth: new FakeAuth({configured: false, authenticated: false}),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.state, SyncState.UNCONFIGURED);
        store.destroy();
    });

    it('chamadas concorrentes compartilham uma única sincronização', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await Promise.all([store.sync(), store.sync(), store.sync()]);

        assertEqual(service.listCalls, 1, 'três chamadas simultâneas = uma busca');
        store.destroy();
    });
});

describe('eventStore · tratamento de erros', () => {
    it('falha de rede vira estado ERROR sem apagar o erro', async () => {
        const service = new FakeService({calendars: [WORK]});
        service.failNextListWith = new NetworkError('sem rota para o host');
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.state, SyncState.ERROR);
        assert(store.error instanceof NetworkError, 'o erro precisa ficar acessível à UI');
        store.destroy();
    });

    it('token revogado leva de volta ao estado de login', async () => {
        const service = new FakeService({calendars: [WORK]});
        service.failNextListWith = new AuthError('invalid_grant');
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.state, SyncState.UNAUTHENTICATED);
        store.destroy();
    });

    it('falha de uma agenda não esconde os eventos das outras', async () => {
        const day = futureDay(2);
        const service = new FakeService({
            calendars: [WORK, HOME],
            events: [timedEvent('ok', 'work', day, 9, 10)],
            errors: [{calendarId: 'home', error: new ApiError('sumiu', {status: 404})}],
        });
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.getEventsForDay(day).length, 1, 'evento da agenda boa deve aparecer');
        assertEqual(store.state, SyncState.ERROR, 'e a falha parcial não pode ser silenciosa');
        store.destroy();
    });

    it('emite status-changed em cada transição de estado', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        const seen = [];
        store.connect('status-changed', () => seen.push(store.state));
        await store.sync();

        assert(seen.includes(SyncState.SYNCING), 'a UI precisa saber que está sincronizando');
        assertEqual(seen[seen.length - 1], SyncState.IDLE);
        store.destroy();
    });
});

describe('eventStore · seleção de agendas', () => {
    it('sem seleção explícita usa as visíveis no Google', async () => {
        const day = futureDay(2);
        const service = new FakeService({
            calendars: [WORK, {...HOME, selected: false}],
            events: [timedEvent('a', 'work', day, 9, 10), timedEvent('b', 'home', day, 11, 12)],
        });
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.getEventsForDay(day).length, 1, 'agenda oculta no Google fica fora');
        store.destroy();
    });

    it('respeita enabled-calendars quando configurado', async () => {
        const day = futureDay(2);
        const service = new FakeService({
            calendars: [WORK, HOME],
            events: [timedEvent('a', 'work', day, 9, 10), timedEvent('b', 'home', day, 11, 12)],
        });
        const settings = makeSettings(SCHEMAS_DIR);
        settings.set_strv('enabled-calendars', ['home']);
        const store = makeStore({service, auth: new FakeAuth(), settings,
            cacheDir: makeTempDir()});

        await store.sync();

        const events = store.getEventsForDay(day);
        assertEqual(events.length, 1);
        assertEqual(events[0].calendarId, 'home');
        store.destroy();
    });

    it('ignora IDs de agendas que não existem mais', async () => {
        const settings = makeSettings(SCHEMAS_DIR);
        settings.set_strv('enabled-calendars', ['apagada']);
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(), settings,
            cacheDir: makeTempDir()});

        await store.sync();

        assertEqual(store.state, SyncState.IDLE, 'não pode virar erro');
        store.destroy();
    });

    it('getWritableCalendars exclui agendas somente leitura', async () => {
        const service = new FakeService({calendars: [WORK, HOME]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        await store.sync();

        assertDeepEqual(store.getWritableCalendars().map(c => c.id), ['work']);
        assertEqual(store.getDefaultCalendar().id, 'work');
        store.destroy();
    });
});

describe('eventStore · escrita', () => {
    it('criar evento já o insere no índice do dia', async () => {
        const day = futureDay(3);
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});
        await store.sync();

        await store.createEvent('work', {
            title: 'Novo',
            allDay: false,
            start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10),
            end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 11),
        });

        assertEqual(store.getEventsForDay(day).length, 1);
        assertEqual(service.created.length, 1);
        store.destroy();
    });

    it('excluir remove do índice sem esperar o próximo sync', async () => {
        const day = futureDay(2);
        const service = new FakeService({
            calendars: [WORK],
            events: [timedEvent('some', 'work', day, 9, 10)],
        });
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});
        await store.sync();
        assertEqual(store.getEventsForDay(day).length, 1);

        await store.deleteEvent('work', 'some');

        assertEqual(store.getEventsForDay(day).length, 0);
        assertDeepEqual(service.deleted, ['work:some']);
        store.destroy();
    });
});

describe('eventStore · cache offline', () => {
    it('recarrega os eventos do disco quando a extensão reinicia', async () => {
        const day = futureDay(2);
        const cacheDir = makeTempDir();
        const events = [timedEvent('persistido', 'work', day, 14, 15)];

        const first = makeStore({
            service: new FakeService({calendars: [WORK], events}),
            auth: new FakeAuth(), settings: makeSettings(SCHEMAS_DIR), cacheDir,
        });
        await first.sync();
        first.destroy();

        // Segunda instância sem rede: só o cache deve preencher o widget.
        const offlineService = new FakeService({calendars: [WORK]});
        offlineService.failNextListWith = new NetworkError('offline');
        const second = makeStore({service: offlineService, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir});
        await second._loadCache();

        assertEqual(second.getEventsForDay(day).length, 1,
            'o widget não pode ficar vazio offline');
        assertEqual(second.getEventsForDay(day)[0].title, 'persistido');
        second.destroy();
        removeDir(cacheDir);
    });

    it('cache ausente não quebra a inicialização', async () => {
        const store = makeStore({service: new FakeService(), auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR),
            cacheDir: GLib.build_filenamev([makeTempDir(), 'nao-existe'])});
        await store._loadCache();
        assertEqual(store.getDayKeysWithEvents().size, 0);
        store.destroy();
    });
});

describe('eventStore · ciclo de vida', () => {
    it('destroy desconecta os sinais do GSettings', async () => {
        const service = new FakeService({calendars: [WORK]});
        const settings = makeSettings(SCHEMAS_DIR);
        const store = makeStore({service, auth: new FakeAuth(), settings,
            cacheDir: makeTempDir()});
        store.start();
        await store.sync();

        const callsBefore = service.listCalls;
        store.destroy();

        // Depois do destroy, mexer nas configurações não pode disparar nada:
        // era exatamente esse o vazamento da versão anterior, que reconectava
        // changed::sync-interval dentro do próprio handler.
        settings.set_int('sync-interval', 17);
        settings.set_int('days-ahead', 12);
        assertEqual(service.listCalls, callsBefore, 'sync disparado após destroy');
    });

    it('destroy limpa o estado em memória', async () => {
        const day = futureDay(2);
        const store = makeStore({
            service: new FakeService({calendars: [WORK],
                events: [timedEvent('x', 'work', day, 9, 10)]}),
            auth: new FakeAuth(), settings: makeSettings(SCHEMAS_DIR),
            cacheDir: makeTempDir(),
        });
        await store.sync();
        store.destroy();
        assertEqual(store.getDayKeysWithEvents().size, 0);
    });

    it('sync depois do destroy é inofensivo', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});
        store.destroy();
        await store.sync();
        assertEqual(service.listCalls, 0);
    });
});

describe('eventStore · navegação entre meses', () => {
    it('carrega o mês visitado quando ele está fora da janela padrão', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});
        await store.sync();

        const far = new Date();
        far.setMonth(far.getMonth() + 6);
        store.setVisibleMonth(far);
        await store.sync();

        assert(service.lastRange.to >= far, 'a busca precisa alcançar o mês aberto');
        store.destroy();
    });

    it('pedido de mês feito durante um sync não se perde', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});

        const inFlight = store.sync();
        const far = new Date();
        far.setMonth(far.getMonth() + 8);
        store.setVisibleMonth(far);        // chega no meio do sync anterior
        await inFlight;
        await store.sync();

        assert(service.lastRange.to >= far, 'o intervalo enfileirado deve ser buscado');
        store.destroy();
    });

    it('mês já carregado não dispara nova busca', async () => {
        const service = new FakeService({calendars: [WORK]});
        const store = makeStore({service, auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});
        await store.sync();
        const calls = service.listCalls;

        store.setVisibleMonth(new Date());   // mês atual já está na janela

        assertEqual(service.listCalls, calls, 'não deve rebuscar o que já está em cache');
        store.destroy();
    });
});

describe('eventStore · privacidade ao desconectar', () => {
    it('perder a sessão apaga o cache em disco, não só a memória', async () => {
        const day = futureDay(2);
        const cacheDir = makeTempDir();
        const auth = new FakeAuth();
        const store = makeStore({
            service: new FakeService({calendars: [WORK],
                events: [timedEvent('reuniao secreta', 'work', day, 14, 15)]}),
            auth, settings: makeSettings(SCHEMAS_DIR), cacheDir,
        });
        store.start();
        await store.sync();

        const cacheFile = Gio.File.new_for_path(
            GLib.build_filenamev([cacheDir, 'events.json']));
        assert(cacheFile.query_exists(null), 'o cache deveria existir após o sync');

        auth.setAuthenticated(false);
        // A exclusão é disparada sem await pelo handler do sinal; aguardar uma
        // limpeza equivalente torna a asserção determinística.
        await store.clearCache();

        assert(!cacheFile.query_exists(null),
            'título, descrição e local dos eventos não podem ficar em disco sem sessão');
        assertEqual(store.getEventsForDay(day).length, 0);
        store.destroy();
        removeDir(cacheDir);
    });

    it('o cache é gravado apenas com permissão de leitura para o dono', async () => {
        const cacheDir = makeTempDir();
        const store = makeStore({
            service: new FakeService({calendars: [WORK],
                events: [timedEvent('x', 'work', futureDay(2), 9, 10)]}),
            auth: new FakeAuth(), settings: makeSettings(SCHEMAS_DIR), cacheDir,
        });
        await store.sync();
        // A gravação é disparada sem await pelo sync; aguardar aqui evita ler
        // o modo no meio da escrita.
        await store._saveCache();

        const info = Gio.File.new_for_path(GLib.build_filenamev([cacheDir, 'events.json']))
            .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
        const mode = info.get_attribute_uint32('unix::mode') & 0o777;

        assertEqual(mode.toString(8), '600', 'o cache guarda dados pessoais');
        store.destroy();
        removeDir(cacheDir);
    });

    it('apagar um cache inexistente não gera erro', async () => {
        const store = makeStore({service: new FakeService(), auth: new FakeAuth(),
            settings: makeSettings(SCHEMAS_DIR), cacheDir: makeTempDir()});
        await store.clearCache();
        await store.clearCache();
        store.destroy();
    });

    it('a gravação do cache não bloqueia: é assíncrona', async () => {
        // IO síncrono no processo do Shell trava o compositor (EGO-X-004).
        const cacheDir = makeTempDir();
        const store = makeStore({
            service: new FakeService({calendars: [WORK],
                events: [timedEvent('x', 'work', futureDay(2), 9, 10)]}),
            auth: new FakeAuth(), settings: makeSettings(SCHEMAS_DIR), cacheDir,
        });

        const gravando = store._saveCache();
        assert(typeof gravando?.then === 'function', '_saveCache deve devolver Promise');
        await gravando;

        assert(Gio.File.new_for_path(GLib.build_filenamev([cacheDir, 'events.json']))
            .query_exists(null), 'o cache deveria existir após aguardar');
        store.destroy();
        removeDir(cacheDir);
    });
});
