import {describe, it, assert, assertEqual} from './harness.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    GCalError, ApiError, AuthError, NetworkError, ConfigError, CancelledError,
    isCancelled, userMessage,
} from '../lib/errors.js';

describe('errors · classificação', () => {
    it('erros de rede são sempre repetíveis', () => {
        assert(new NetworkError('offline').retryable);
    });

    it('429 e 5xx são repetíveis; 4xx restantes não', () => {
        assert(new ApiError('cota', {status: 429}).retryable);
        assert(new ApiError('servidor', {status: 503}).retryable);
        assert(!new ApiError('não achou', {status: 404}).retryable);
        assert(!new ApiError('proibido', {status: 403}).retryable);
    });

    it('AuthError pede novo login por padrão', () => {
        assert(new AuthError('expirou').needsReauth);
        assert(!new AuthError('navegador falhou', {needsReauth: false}).needsReauth);
    });

    it('mantém a cadeia de causa', () => {
        const cause = new Error('raiz');
        assertEqual(new GCalError('acima', {cause}).cause, cause);
    });
});

describe('errors · detecção de cancelamento', () => {
    it('reconhece CancelledError', () => {
        assert(isCancelled(new CancelledError('parou')));
    });

    it('reconhece GLib.Error de cancelamento vindo do GIO', () => {
        const err = new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'cancelado');
        assert(isCancelled(err), 'GLib.Error de cancelamento deve ser reconhecido');
    });

    it('não confunde outros erros de IO com cancelamento', () => {
        const err = new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND, 'sumiu');
        assert(!isCancelled(err));
        assert(!isCancelled(new Error('qualquer coisa')));
        assert(!isCancelled(null));
    });
});

describe('errors · mensagem ao usuário', () => {
    it('cada tipo tem uma mensagem própria e legível', () => {
        assert(userMessage(new ConfigError('x')).includes('Client ID'));
        assert(userMessage(new AuthError('x')).includes('novamente'));
        assert(userMessage(new NetworkError('x')).includes('conexão'));
        assert(userMessage(new ApiError('x', {status: 429})).includes('Limite'));
        assertEqual(userMessage(new Error('mensagem crua')), 'mensagem crua');
    });

    it('nunca devolve indefinido', () => {
        assert(typeof userMessage(null) === 'string');
        assert(typeof userMessage(new ApiError('x', {status: 500})) === 'string');
    });
});
