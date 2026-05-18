# Zorin GCalendar — Contexto do Projeto para Claude Code

## Resumo do projeto

Extensão GNOME Shell que exibe um widget flutuante na área de trabalho do Zorin OS 18
com mini-calendário e eventos do Google Calendar. Usa OAuth 2.0 PKCE para autenticação.

**UUID:** `zorin-gcalendar@extension`  
**Caminho instalado:** `~/.local/share/gnome-shell/extensions/zorin-gcalendar@extension/`  
**GNOME Shell alvo:** 43, 44, 45, 46, 47  
**Linguagem:** JavaScript (GJS — SpiderMonkey), ES Modules (import/export)

---

## Estrutura de arquivos

```
zorin-gcalendar@extension/
├── metadata.json          Manifesto da extensão (uuid, shell-version, settings-schema)
├── extension.js           Entry point: instancia todos os módulos, gerencia lifecycle
├── desktopWidget.js       Widget flutuante (St.BoxLayout) — mini-calendário + lista de eventos
├── googleAuth.js          OAuth 2.0 PKCE: abre browser, escuta localhost:9004, troca code por tokens
├── calendarAPI.js         Wrapper REST da Google Calendar API v3 (libsoup3)
├── eventManager.js        Cache local de eventos, loop de sync (GLib.timeout), CRUD facade
├── notifications.js       Gio.Notification para eventos iminentes
├── prefs.js               Janela de preferências GTK4/Adwaita (roda em processo separado)
├── utils.js               Helpers puros: formatação de datas, PKCE crypto, cores do Google
├── stylesheet.css         Estilos do widget (glassmorfismo escuro)
├── icons/
│   └── calendar-symbolic.svg
└── schemas/
    └── org.gnome.shell.extensions.zorin-gcalendar.gschema.xml
```

---

## Estado atual — o que já funciona

- [x] Widget aparece na área de trabalho via `Main.layoutManager.addChrome()`
- [x] Mini-calendário navegável (mês anterior/próximo)
- [x] Clique no dia mostra eventos daquele dia
- [x] Dias com eventos marcados com ponto laranja
- [x] Widget arrastável pelo cabeçalho, posição salva em GSettings
- [x] Tela de "configure credenciais" quando client-id está vazio
- [x] Tela de "Entrar com Google" depois de configurar credenciais nas prefs
- [x] `extension.js` observa mudanças em `client-id`, `client-secret` e `refresh-token`
  para atualizar o widget automaticamente sem reiniciar o Shell
- [x] Login OAuth: abre browser, escuta redirect em `localhost:9004`
- [x] Tokens armazenados no GNOME Keyring (libsecret)
- [x] Sync periódico configurável
- [x] Notificações GNOME para eventos iminentes
- [x] Janela de preferências (prefs.js) com GTK4/Adwaita

---

## BUG ATUAL A CORRIGIR — `btoa is not defined`

### Erro exato
```
Erro: btoa is not defined
```

### Quando ocorre
Ao clicar em "Entrar com Google" no widget. O erro acontece em `utils.js`
na função `sha256Base64Url()`, chamada por `googleAuth.js` durante o
início do fluxo OAuth PKCE.

### Causa raiz
`btoa()` é uma API Web (browser). O GJS (SpiderMonkey embutido no GNOME Shell)
**não implementa `btoa`** — ele fornece apenas as APIs GLib/GIO, não as Web APIs.

### Localização exata do bug

**Arquivo:** `utils.js`, linha ~45

```javascript
// CÓDIGO ATUAL — QUEBRADO (btoa não existe no GJS)
export function sha256Base64Url(str) {
    const { GLib } = imports.gi;
    const hex   = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return btoa(String.fromCharCode(...bytes))   // ← AQUI: btoa não existe no GJS
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

---

## CORREÇÃO NECESSÁRIA

### O que mudar em `utils.js`

Substituir `btoa()` por `GLib.base64_encode()`, que é a API nativa do GLib
disponível em qualquer versão do GJS:

```javascript
// CORREÇÃO — usar GLib.base64_encode() em vez de btoa()
export function sha256Base64Url(str) {
    // GLib.compute_checksum_for_string retorna hex digest do SHA-256
    const hex   = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);

    // Converter hex string → array de bytes
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

    // GLib.base64_encode() aceita Uint8Array e retorna Base64 padrão (com +, /, =)
    const b64 = GLib.base64_encode(bytes);

    // Converter Base64 padrão → Base64-URL (requerido pelo RFC 7636 PKCE)
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

**Também remover o `imports.gi` legado** que está dentro da função — no GJS com
ES Modules (`import GLib from 'gi://GLib'`) o GLib já está importado no topo do
módulo que chamar essa função, mas `utils.js` não importa GLib. Então a função
deve importar GLib diretamente:

```javascript
// Adicionar ao topo de utils.js (junto com os outros exports):
import GLib from 'gi://GLib';
```

E remover a linha `const { GLib } = imports.gi;` de dentro da função.

### Diff completo para `utils.js`

**Linha a adicionar no topo do arquivo** (após o comentário, antes dos `export function`):
```javascript
import GLib from 'gi://GLib';
```

**Função `sha256Base64Url` — substituição completa:**

DE:
```javascript
export function sha256Base64Url(str) {
    const { GLib } = imports.gi;
    const hex   = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

PARA:
```javascript
export function sha256Base64Url(str) {
    const hex   = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    // GLib.base64_encode substitui btoa() que não existe no GJS/SpiderMonkey
    return GLib.base64_encode(bytes)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

---

## Outros problemas conhecidos (para corrigir depois)

### 1. `'use strict'` incompatível com ES Modules
O arquivo `utils.js` tem `'use strict';` no topo. Em ES Modules (`import`/`export`),
o modo strict é implícito — a diretiva não causa erro mas é redundante. Pode remover.

### 2. `TextDecoder` / `TextEncoder` podem não existir em GNOME 43
Em GNOME 43 (Zorin OS 17), `TextDecoder` e `TextEncoder` podem não estar disponíveis.
Alternativa GJS: `new GLib.Bytes(array)` e `ByteArray.toString()`.
Verificar se o usuário está em Zorin OS 17 ou 18 antes de corrigir.

### 3. `Secret.password_store` — API async mudou no GJS 45+
Em GNOME 45+, o `Secret.password_store()` retorna uma Promise diretamente.
Em versões anteriores precisa de callback. O código atual usa `await` diretamente,
o que pode falhar em GNOME 43/44. Considerar wrapper com fallback.

### 4. Widget some durante o Overview do GNOME
`addChrome` com `trackFullscreen: true` some em tela cheia mas continua visível
no Overview (visão de atividades). Pode ser desejável ou não — avaliar com o usuário.

---

## Como testar após a correção

```bash
# 1. Instalar/reinstalar
cd ~/zorin-gcalendar
./install.sh

# 2. Reiniciar o GNOME Shell
#    Wayland: logout + login
#    X11: Alt+F2 → "r" → Enter

# 3. Ativar extensão
gnome-extensions enable zorin-gcalendar@extension

# 4. Configurar credenciais
gnome-extensions prefs zorin-gcalendar@extension
# → colar Client ID e Client Secret do Google Cloud Console

# 5. Clicar "Entrar com Google" no widget
#    Deve abrir o browser sem erro

# 6. Ver logs em tempo real
journalctl -f | grep GCalendar
```

---

## Credenciais OAuth (Google Cloud Console)

O usuário já criou as credenciais. Para referência:
1. Acesse https://console.cloud.google.com
2. Projeto → APIs e Serviços → Google Calendar API (ativada)
3. Credenciais → OAuth 2.0 Client ID → Tipo: **Desktop app**
4. Client ID e Client Secret colados nas Preferências da extensão

**Redirect URI configurada:** `http://localhost:9004` (a extensão escuta nessa porta)

---

## Arquitetura do fluxo OAuth (para entender o contexto da correção)

```
Usuário clica "Entrar com Google"
    ↓
googleAuth.startAuthFlow()
    ↓
utils.randomString(64)          → code_verifier (aleatório)
utils.sha256Base64Url(verifier) → code_challenge  ← AQUI ESTÁ O BUG (btoa)
    ↓
Abre browser: accounts.google.com/o/oauth2/v2/auth?code_challenge=...
    ↓
Gio.SocketService escuta localhost:9004
    ↓
Browser redireciona → localhost:9004/?code=XXX&state=YYY
    ↓
googleAuth._exchangeCode(code)
    ↓
POST https://oauth2.googleapis.com/token
    ↓
Tokens salvos: access_token → GSettings, refresh_token → GNOME Keyring
    ↓
eventManager.start() → primeira sincronização → widget.refresh()
```