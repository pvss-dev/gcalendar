import {describe, it, assert, assertEqual} from './harness.js';
import {
    parseGoogleDate, dayKey, addDays, startOfMonth, endOfMonth,
    daysInMonth, sameDay, toRfc3339, buildQueryString, parseQueryString,
    sha256Base64Url, base64UrlEncode, randomBytes, randomToken, truncate,
    eventColour, safeColour, weekdayAbbreviations, minutesUntil,
} from '../lib/utils.js';

describe('utils · datas', () => {
    it('interpreta data sem hora como meia-noite LOCAL, não UTC', () => {
        // Este é o bug clássico: "2026-03-15" via Date() seria 21h de 14/03
        // em UTC-3, jogando eventos de dia inteiro para o dia anterior.
        const date = parseGoogleDate('2026-03-15');
        assertEqual(date.getFullYear(), 2026);
        assertEqual(date.getMonth(), 2);
        assertEqual(date.getDate(), 15, 'dia deve continuar 15 no fuso local');
        assertEqual(date.getHours(), 0);
    });

    it('interpreta timestamp com offset preservando o instante', () => {
        const date = parseGoogleDate('2026-03-15T14:30:00-03:00');
        assertEqual(date.getTime(), Date.UTC(2026, 2, 15, 17, 30));
    });

    it('devolve Date inválida para entrada vazia', () => {
        assert(Number.isNaN(parseGoogleDate('').getTime()));
        assert(Number.isNaN(parseGoogleDate(null).getTime()));
    });

    it('dayKey usa o calendário local com zero à esquerda', () => {
        assertEqual(dayKey(new Date(2026, 0, 5)), '2026-01-05');
        assertEqual(dayKey(new Date(2026, 11, 31)), '2026-12-31');
    });

    it('addDays atravessa a virada de mês e de ano', () => {
        assertEqual(dayKey(addDays(new Date(2026, 0, 31), 1)), '2026-02-01');
        assertEqual(dayKey(addDays(new Date(2026, 11, 31), 1)), '2027-01-01');
        assertEqual(dayKey(addDays(new Date(2026, 0, 1), -1)), '2025-12-31');
    });

    it('addDays preserva a hora do dia mesmo com horário de verão', () => {
        const noon = new Date(2026, 1, 20, 12, 0);
        assertEqual(addDays(noon, 1).getHours(), 12);
        assertEqual(addDays(noon, 90).getHours(), 12);
    });

    it('daysInMonth acerta fevereiro em ano bissexto', () => {
        assertEqual(daysInMonth(2024, 1), 29);
        assertEqual(daysInMonth(2026, 1), 28);
        assertEqual(daysInMonth(2026, 3), 30);
    });

    it('startOfMonth e endOfMonth cobrem o mês inteiro', () => {
        assertEqual(dayKey(startOfMonth(new Date(2026, 8, 17))), '2026-09-01');
        assertEqual(dayKey(endOfMonth(new Date(2026, 8, 17))), '2026-09-30');
    });

    it('sameDay ignora a hora', () => {
        assert(sameDay(new Date(2026, 5, 1, 0, 0), new Date(2026, 5, 1, 23, 59)));
        assert(!sameDay(new Date(2026, 5, 1), new Date(2026, 5, 2)));
    });

    it('toRfc3339 inclui o offset local', () => {
        const text = toRfc3339(new Date(2026, 2, 15, 14, 30, 0));
        assert(/^2026-03-15T14:30:00[+-]\d{2}:\d{2}$/.test(text),
            `formato inesperado: ${text}`);
    });

    it('minutesUntil é negativo no passado', () => {
        assert(minutesUntil(new Date(Date.now() - 600_000)) <= -9);
        assert(minutesUntil(new Date(Date.now() + 600_000)) >= 9);
    });
});

describe('utils · query strings', () => {
    it('codifica valores com caracteres especiais', () => {
        assertEqual(buildQueryString({scope: 'a b', q: 'c&d=e'}),
            'scope=a%20b&q=c%26d%3De');
    });

    it('omite valores vazios, nulos e indefinidos', () => {
        assertEqual(buildQueryString({a: '1', b: '', c: null, d: undefined}), 'a=1');
    });

    it('faz round-trip de valores com & e =', () => {
        const original = {code: '4/0Ab&x=y', state: 'a+b c'};
        const parsed = parseQueryString(buildQueryString(original));
        assertEqual(parsed.code, original.code);
        assertEqual(parsed.state, original.state);
    });

    it('aceita caminho completo com "?" (linha de requisição HTTP)', () => {
        const parsed = parseQueryString('/?code=abc&state=xyz');
        assertEqual(parsed.code, 'abc');
        assertEqual(parsed.state, 'xyz');
    });

    it('ignora pares malformados em vez de estourar', () => {
        const parsed = parseQueryString('/?ok=1&%ZZ=2&sozinho');
        assertEqual(parsed.ok, '1');
    });
});

describe('utils · PKCE', () => {
    it('sha256Base64Url bate com o vetor de teste da RFC 7636', () => {
        // Apêndice B da RFC 7636.
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        assertEqual(sha256Base64Url(verifier),
            'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('base64url não contém +, / nem =', () => {
        const encoded = base64UrlEncode(new Uint8Array([251, 255, 254, 0, 1, 2]));
        assert(!/[+/=]/.test(encoded), `padding vazou: ${encoded}`);
    });

    it('randomBytes devolve o tamanho pedido e varia entre chamadas', () => {
        const a = randomBytes(32);
        const b = randomBytes(32);
        assertEqual(a.length, 32);
        assert(a.some((byte, i) => byte !== b[i]), 'duas leituras idênticas');
    });

    it('randomToken respeita o comprimento mínimo do code_verifier', () => {
        // RFC 7636 §4.1 exige entre 43 e 128 caracteres.
        const token = randomToken(32);
        assert(token.length >= 43 && token.length <= 128, `tamanho ${token.length}`);
        assert(/^[A-Za-z0-9\-._~]+$/.test(token), 'caracteres fora do alfabeto');
    });
});

describe('utils · apresentação', () => {
    it('truncate respeita o limite e adiciona reticências', () => {
        assertEqual(truncate('abcdef', 10), 'abcdef');
        assertEqual(truncate('abcdefghij', 5), 'abcd…');
        assertEqual(truncate('', 5), '');
        assertEqual(truncate(null, 5), '');
    });

    it('eventColour mapeia colorId e cai no padrão', () => {
        assertEqual(eventColour('11'), '#d50000');
        assertEqual(eventColour(undefined, '#123456'), '#123456');
    });

    it('safeColour rejeita CSS injetado', () => {
        assertEqual(safeColour('#ff0000'), '#ff0000');
        assertEqual(safeColour('#f00'), '#f00');
        assertEqual(safeColour('red; border: 10px solid'), '#3584e4');
        assertEqual(safeColour(undefined), '#3584e4');
    });

    it('weekdayAbbreviations rotaciona pelo primeiro dia da semana', () => {
        const sunday = weekdayAbbreviations(0, 'en-US');
        const monday = weekdayAbbreviations(1, 'en-US');
        assertEqual(sunday.length, 7);
        assertEqual(monday[0], sunday[1]);
        assertEqual(monday[6], sunday[0]);
    });
});
