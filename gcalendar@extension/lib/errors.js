/**
 * errors.js — tipos de erro do domínio.
 *
 * Ter tipos (em vez de comparar strings de mensagem, como a versão anterior
 * fazia na UI) permite que cada camada decida o que fazer: reautenticar,
 * tentar de novo, ou mostrar mensagem ao usuário.
 */
import Gio from 'gi://Gio';

export class GCalError extends Error {
    constructor(message, {code = null, cause = null, retryable = false} = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.cause = cause;
        this.retryable = retryable;
    }
}

/** Credenciais ausentes ou inválidas nas preferências. */
export class ConfigError extends GCalError {}

/** Falha de OAuth: sem refresh token, refresh recusado, consentimento revogado. */
export class AuthError extends GCalError {
    constructor(message, opts = {}) {
        super(message, opts);
        /** true quando só um novo login interativo resolve. */
        this.needsReauth = opts.needsReauth ?? true;
    }
}

/** Sem rede, DNS, timeout — sempre passível de nova tentativa. */
export class NetworkError extends GCalError {
    constructor(message, opts = {}) {
        super(message, {...opts, retryable: true});
    }
}

/** Resposta HTTP de erro vinda da API do Google. */
export class ApiError extends GCalError {
    constructor(message, {status = 0, reason = null, ...rest} = {}) {
        // 429/5xx são transitórios; 4xx restantes não adianta repetir.
        super(message, {...rest, retryable: status === 429 || status >= 500});
        this.status = status;
        this.reason = reason;
    }
}

/** Operação abortada porque a extensão foi desabilitada. */
export class CancelledError extends GCalError {}

/**
 * Reconhece cancelamento vindo tanto do nosso código quanto do GIO
 * (GLib.Error do domínio g-io-error-quark).
 */
export function isCancelled(err) {
    if (err instanceof CancelledError)
        return true;
    return typeof err?.matches === 'function' &&
        err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Mensagem curta e amigável para exibir no widget. */
export function userMessage(err) {
    if (err instanceof ConfigError)
        return 'Configure o Client ID nas preferências.';
    if (err instanceof AuthError)
        return 'Sessão expirada. Entre novamente.';
    if (err instanceof NetworkError)
        return 'Sem conexão com o Google.';
    if (err instanceof ApiError) {
        if (err.status === 403)
            return 'Acesso negado pela API (verifique escopos/cota).';
        if (err.status === 404)
            return 'Evento ou agenda não encontrada.';
        if (err.status === 429)
            return 'Limite de requisições atingido. Tente em instantes.';
        return `Erro do Google (HTTP ${err.status}).`;
    }
    return err?.message ?? 'Erro desconhecido.';
}
