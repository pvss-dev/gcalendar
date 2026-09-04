/**
 * notificationRules.js — quem deve ser notificado, e quando.
 *
 * Separado do notificationManager de propósito: aquele importa MessageTray e
 * só roda dentro do Shell, então a regra ficaria sem teste. Aqui é função
 * pura, exercitada pela suíte sem sessão gráfica.
 */

/** Um evento é notificado uma vez por horário de início. */
export function notificationKey(event) {
    return `${event.calendarId}:${event.id}:${event.start.getTime()}`;
}

/**
 * Eventos que devem gerar aviso agora.
 *
 * @param {object} opts
 * @param {object[]} opts.events       eventos conhecidos
 * @param {number} opts.leadMinutes    antecedência configurada
 * @param {number} opts.now            epoch em ms (injetado para poder testar)
 * @param {Map<string, number>} opts.notified  chave → quando já foi avisado
 * @returns {{event: object, key: string, minutesLeft: number}[]}
 */
export function selectDueNotifications({events, leadMinutes, now, notified}) {
    const due = [];

    for (const event of events) {
        // Evento de dia inteiro não tem hora de início: avisar "faltam 10
        // minutos" para ele não significa nada.
        if (event.allDay)
            continue;

        const msLeft = event.start.getTime() - now;
        if (msLeft < 0)
            continue;   // já começou

        const minutesLeft = Math.round(msLeft / 60_000);
        if (minutesLeft > leadMinutes)
            continue;   // ainda cedo

        const key = notificationKey(event);
        if (notified.has(key))
            continue;   // já avisado neste horário

        due.push({event, key, minutesLeft});
    }

    return due.sort((a, b) => a.event.start - b.event.start);
}

/**
 * Descarta chaves antigas do registro de "já avisados".
 *
 * Sem isso o Map cresce enquanto a sessão durar.
 */
export function pruneNotified(notified, now, ttlMs) {
    const cutoff = now - ttlMs;
    for (const [key, when] of notified) {
        if (when < cutoff)
            notified.delete(key);
    }
    return notified;
}
