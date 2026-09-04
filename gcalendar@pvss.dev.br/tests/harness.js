/**
 * harness.js — runner mínimo de testes para GJS.
 *
 * Nada de dependências externas: `gjs -m tests/run.js` roda tudo sem
 * gnome-shell, sem npm e sem sessão gráfica.
 */
const suites = [];
let current = null;

export function describe(name, fn) {
    current = {name, tests: []};
    suites.push(current);
    fn();
    current = null;
}

export function it(name, fn) {
    if (!current)
        throw new Error('it() fora de describe()');
    current.tests.push({name, fn});
}

export function assert(condition, message = 'asserção falhou') {
    if (!condition)
        throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}\n    esperado: ${format(expected)}` +
                        `\n    recebido: ${format(actual)}`);
    }
}

export function assertDeepEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${message}\n    esperado: ${b}\n    recebido: ${a}`);
}

export async function assertThrows(fn, message = 'deveria lançar erro') {
    try {
        await fn();
    } catch {
        return;
    }
    throw new Error(message);
}

export function assertDate(actual, expected, message = '') {
    if (actual?.getTime?.() !== expected.getTime()) {
        throw new Error(`${message}\n    esperado: ${expected.toISOString()}` +
                        `\n    recebido: ${actual?.toISOString?.() ?? actual}`);
    }
}

function format(value) {
    if (value instanceof Date)
        return value.toISOString();
    return typeof value === 'string' ? `"${value}"` : String(value);
}

export async function run() {
    let passed = 0;
    const failures = [];

    for (const suite of suites) {
        print(`\n\x1b[1m${suite.name}\x1b[0m`);
        for (const test of suite.tests) {
            try {
                await test.fn();
                passed++;
                print(`  \x1b[32m✓\x1b[0m ${test.name}`);
            } catch (err) {
                failures.push({suite: suite.name, test: test.name, err});
                print(`  \x1b[31m✗\x1b[0m ${test.name}`);
                print(`      ${err.message.split('\n').join('\n      ')}`);
            }
        }
    }

    print(`\n${passed} passaram, ${failures.length} falharam\n`);
    return failures.length === 0;
}
