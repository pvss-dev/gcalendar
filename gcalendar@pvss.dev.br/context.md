# Zorin GCalendar — documentação do projeto

Widget de calendário na área de trabalho do GNOME Shell, integrado ao Google
Agenda. Alvo verificado: **Zorin OS 18.1 / GNOME Shell 46 / GJS 1.80**.

**UUID:** `gcalendar@pvss.dev.br`
**Instalado em:** `~/.local/share/gnome-shell/extensions/gcalendar@pvss.dev.br/`
**Versões do Shell suportadas:** 46 e 47 (ES Modules + classe `Extension`)

---

## Por que 46/47, e não 43–47

A versão 1 declarava `"shell-version": ["43","44","45","46","47"]`, mas o código
usa `import`/`export` e `export default class extends Extension`, que só existem
a partir do **GNOME 45**. Em 43/44 a extensão nem carregaria.

Duas APIs foram verificadas contra o Shell instalado, não presumidas:

| API | Situação no Shell 46 | Consequência |
|---|---|---|
| `St.BoxLayout` | **não tem** a propriedade `orientation`, só `vertical` | usar `orientation:` quebraria o layout — mantivemos `vertical: true` |
| `St.ScrollView` | usa a propriedade `child:` (introduzida no 46) | é o que impede declarar suporte ao 45 |
| `MessageTray` | `Source`/`Notification` com construtor de propriedades + `addNotification()` | a API antiga (`new Source(title, icon)`) não existe mais |

---

## Arquitetura

Três camadas, sem atalhos entre elas: a UI nunca fala HTTP, e a camada de
transporte nunca sabe o que é "dia selecionado".

```
extension.js                    ciclo de vida + composition root
│
├── lib/                        domínio e infraestrutura (sem St/Clutter)
│   ├── log.js                  logging (GCAL_DEBUG=1 para detalhes)
│   ├── errors.js               tipos de erro + mensagem ao usuário
│   ├── utils.js                datas, fusos, cores — JS puro, sem GI
│   ├── eventFormat.js          textos e validação de formulário — puro
│   ├── async.js                TimerPool: nenhum GLib source sem dono
│   ├── http.js                 libsoup3 + Gio._promisify centralizado
│   ├── secretStore.js          limpa segredos das versões que faziam OAuth
│   ├── goaAuth.js              contas e tokens via GNOME Online Accounts
│   ├── googleCalendarApi.js    REST v3: paginação, retry, 401 → renova token
│   ├── calendarService.js  ←── camada de abstração: JSON do Google → domínio
│   └── eventStore.js           estado, índice por dia, cache, laço de sync
│
└── ui/                         só apresentação
    ├── desktopWidget.js        composição, posicionamento, arraste
    ├── monthGrid.js            grade 6×7 reaproveitada entre renderizações
    ├── eventList.js            eventos do dia + estados (erro, login, vazio)
    └── eventDialog.js          criar / editar / excluir
```

**Fluxo de dados:** `EventStore` é a única fonte de verdade da UI. Ele emite os
sinais GObject `changed` e `status-changed`; o widget só reage. Nenhuma view
chama a API diretamente.

**Modelo de evento** (o que a UI enxerga — nunca o JSON do Google):

```js
{id, calendarId, calendarName, etag, title, description, location,
 start: Date, end: Date, allDay, colour, htmlLink,
 recurringEventId, isRecurring, readOnly, dayKeys: ['YYYY-MM-DD', …]}
```

`dayKeys` lista **todos** os dias que o evento ocupa, e é o que faz um evento de
terça a quinta aparecer nos três dias.

---

## Autenticação

**A extensão não tem credenciais próprias.** O token de acesso vem do **GNOME
Online Accounts** (GOA), pela interface D-Bus `org.gnome.OnlineAccounts.OAuth2Based`.

Por que não embutir um client id/secret:

* os escopos de Calendar são **sensíveis** para o Google — enquanto o projeto
  não passa pela verificação (política de privacidade, domínio verificado,
  vídeo de demonstração, análise), fica limitado a **100 usuários** e mostra a
  tela de "app não verificado";
* a cota da API seria compartilhada por todos os usuários da extensão: abuso de
  um afeta todos;
* num projeto open-source as credenciais ficam públicas de qualquer forma. Num
  cliente "Desktop app" o secret não é confidencial (RFC 8252 §8.5), mas ainda
  identifica o *seu* projeto.

Com o GOA nada disso se aplica: o cliente OAuth é o do próprio GNOME, já
verificado, e o usuário concede o acesso uma vez para o sistema inteiro.

```js
const [token] = await oauth2.call_get_access_token(null);   // renovado pelo GOA
```

O escopo concedido pelo GOA quando o Calendário está habilitado é
`https://www.googleapis.com/auth/calendar` — leitura **e** escrita, então todo
o CRUD funciona.

**Multi-conta.** Cada agenda pertence a uma conta, e é ela quem fornece o
token: `CalendarService` guarda `accountId` em cada agenda e resolve a conta
certa antes de cada chamada. Pedir a agenda de uma conta com o token de outra
daria 404 silencioso — há teste cobrindo exatamente isso.

**O que a extensão faz quando não há conta:** mostra um botão que abre
Configurações → Contas Online (`gnome-online-accounts-panel.desktop`).
Distingue dois casos, porque a ação no painel é diferente: não há conta Google,
ou há conta mas com o Calendário desligado.

**401.** Pede ao GOA para revalidar (`call_ensure_credentials`) e tenta de
novo, uma vez. Persistindo, a conta precisa de atenção no painel do sistema.

## Dados guardados localmente

| Onde | O quê | Some ao desconectar? |
|---|---|---|
| GNOME Online Accounts | conta e tokens | é do sistema — remova em Configurações |
| dconf | `enabled-calendars`, `last-sync` | **sim** (IDs de agenda incluem e-mails) |
| `~/.cache/<uuid>/events.json` | agendas + eventos (título, descrição, local) | **sim** |

A extensão **não guarda segredo nenhum**: sem client secret, sem refresh token,
sem entrada própria no chaveiro. Quem cuida disso é o GOA.

O cache existe para o widget não ficar vazio offline, mas guarda conteúdo
pessoal, então:

* é gravado com modo **0600** (a umask padrão deixaria 0644/0664) dentro de um
  diretório 0700;
* é **apagado assim que a sessão se perde** — tanto na desconexão explícita
  quanto quando o Google revoga o token. Só limpar a memória, como era antes,
  deixava tudo em disco depois do logout.

Para apagar à mão o que pertence à conta, mantendo a extensão instalada:

```bash
./install.sh --forget                      # cache + agendas + refresh token
GCAL_FORGET_ALL=1 ./install.sh --forget    # inclui client id e client secret
```

`--forget` fala com o keyring pela mesma API da extensão (`gjs` + libsecret),
sem depender do `secret-tool`, que vem no pacote `libsecret-tools` e costuma
não estar instalado.

## Como conectar a conta

1. **Configurações → Contas Online → Google** e entre com sua conta.
2. Deixe **Calendário** ligado para essa conta.
3. Pronto — o widget detecta pelo sinal do GOA e sincroniza sozinho.

Não há client id, client secret nem tela de login na extensão.

## Camada do widget (`widget-layer`)

| Valor | Como funciona |
|---|---|
| `desktop` (padrão) | dentro de `global.window_group`, acima do papel de parede **e das janelas de tipo DESKTOP**, atrás das janelas comuns |
| `top` | em `uiGroup`, acima de `global.window_group` — sempre visível |

Houve um terceiro modo, `auto`, que ficava na camada de chrome e se ocultava
quando uma janela o sobrepunha. Foi removido: na prática era
indistinguível de `desktop` fora do caso de sobreposição parcial, e existia
como rede de segurança de quando ainda não se sabia se `desktop` receberia
cliques no X11. O `install.sh` migra quem tinha esse valor gravado.

**Duas armadilhas de empilhamento**, ambas já custaram sessões de depuração:

1. **O papel de parede está dentro de `window_group`**, rebaixado ao fundo
   (`layout.js`: `set_child_below_sibling(this._backgroundGroup, null)`).
   Descer o widget para baixo de `window_group` inteiro o esconde atrás do
   papel de parede, não o coloca na área de trabalho.
2. **O Zorin mantém uma janela "Desktop Icons" de tela inteira**
   (`_NET_WM_WINDOW_TYPE_DESKTOP`, 1920x1080) no fundo da pilha de janelas.
   Ela é transparente — o widget aparece normalmente — mas fica empilhada
   *acima* de um ator colocado logo sobre o papel de parede, e aí fica com os
   cliques daquela área. Por isso `_restack()` sobe o widget acima da janela
   DESKTOP mais alta, não apenas acima do `_backgroundGroup`.

O mutter reordena os atores de janela a cada `restacked` e não conhece o nosso,
então a posição é reafirmada nesse sinal (além de `grab-op-end`, troca de área
de trabalho e mudanças de tamanho).

**X11 × Wayland.** A região de entrada do stage só existe no X11 —
`_updateRegions()` a monta sob `!Meta.is_wayland_compositor()`. No X11 ela é o
que decide se o clique chega ao Shell ou atravessa para a janela de baixo; no
Wayland quem decide é a ordem dos atores. Isso torna o modo `desktop`
estruturalmente mais frágil no X11: um ator abaixo da pilha de janelas disputa
espaço com janelas X reais. O modo `auto` existe justamente para isso — parece
um widget de área de trabalho sem depender dessa disputa.

Para saber por que um clique não chegou:

```bash
./install.sh --diagnose     # sessão, build em execução, janelas, decisões de input
./install.sh --status       # o Shell já carregou a versão instalada?
```

A extensão registra no journal cada mudança de região de entrada, com a janela
que a bloqueou.

**Trocar de camada** (efeito imediato, sem relogar): botão direito no widget, ou
`./install.sh --layer desktop|auto|top`, ou a página *Aparência*.

## Altura estável do widget

Duas áreas precisam de altura fixa, e nenhuma das duas se resolve pelo CSS.

**Regra geral:** no St, `height`/`max-height` no CSS são *preferências* — o
conteúdo do filho ainda consegue superá-las. Quando a altura precisa ser
garantida, use `set_height()` no ator (respeitado pelo Clutter) e multiplique
pelo `scale_factor` do `St.ThemeContext`, recalculando em
`notify::scale-factor`.

**Lista de eventos** (`DesktopWidget._applyListHeight()`, chave
`event-list-height`, padrão 150px). Sem isso o widget inteiro mudava de
tamanho conforme o dia selecionado tivesse mais ou menos eventos — medido no
journal: 434px num dia vazio, 477px com um evento. Como só há eventos quando
existe conta conectada, o efeito aparecia **apenas com o usuário logado**, o
que por um bom tempo fez parecer problema da grade.

## Altura estável da grade

A área dos dias mede o mesmo em qualquer mês, e isso é mantido por três
decisões que se apoiam umas nas outras:

1. **Sempre 6×7 células** (`lib/monthLayout.js`). Meses que cabem em 4 ou 5
   semanas ganham linhas de preenchimento com dias dos meses vizinhos, em vez
   de a grade encolher. Testado para todos os meses de 2024–2027, com semana
   começando no domingo e na segunda.
2. **Altura fixada no ator**, em `MonthGrid._applyFixedHeight()`:
   `set_height((HEADER_HEIGHT + 6 * ROW_HEIGHT) * scaleFactor)`.

   > **`height` no CSS do St não fixa a altura.** É uma *preferência*, e o
   > conteúdo da célula consegue superá-la — foi por isso que `.gcal-grid-row
   > { height: 40px }` sozinho não resolveu o problema. `set_height()` é um
   > pedido de tamanho fixo, esse sim respeitado pelo Clutter. Como o valor vai
   > em pixels, é multiplicado pelo `scale_factor` do `St.ThemeContext` e
   > recalculado em `notify::scale-factor` (HiDPI).

   As 6 linhas têm `y_expand: true` e repartem essa altura igualmente.
3. **Marcadores fora do fluxo vertical.** A faixa de pontos fica *sobreposta*
   ao número, via `Clutter.BinLayout` com `y_align: END`, em vez de empilhada
   abaixo dele. Assim ela não soma altura ao conteúdo. É o mesmo princípio do
   calendário do próprio Shell, que marca "dia com eventos" com
   `background-image` — um marcador que, por definição, não participa do
   layout.
4. **Geometria constante da célula.** Todas têm `border: 1px solid
   transparent`, e o dia de hoje só troca `border-color`. Aplicar a borda
   apenas em "hoje" deixava aquela linha mais alta que as outras — e "hoje"
   muda de linha a cada mês.

## Arrastar

O arraste é armado na **fase de captura** (`captured-event` no widget), não com
um handler comum no cabeçalho: os `St.Button` do cabeçalho consomem
`button-press-event`, e o `_monthButton` tem `x_expand: true`, então um handler
comum só receberia a pressão nos poucos pixels de padding entre os botões.

Duas armadilhas do Clutter 14 que já custaram caro aqui:

* **`event.get_source()` devolve `null`** — os eventos viraram imutáveis no
  mutter 46 e o campo saiu (o JS do Shell 46 não usa mais essa chamada). Passar
  esse `null` para `header.contains()` lança *"Argument descendant may not be
  null"* a cada pressão. Para saber onde o ponteiro caiu, use geometria
  (`get_transformed_position`/`get_transformed_size`) e, para descobrir o ator,
  `global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)`.
* **Sem `global.stage.grab()`** os eventos de movimento somem assim que o
  ponteiro sai do ator.

O arraste só começa depois do limiar do sistema
(`St.Settings.get().drag_threshold`), então clique continua sendo clique; o
release final é engolido e o botão pressionado recebe `fake_release()`.

## Ciclo de vida

`enable()` monta o grafo e chama `_initAsync()`; `disable()` cancela e destrói na
ordem inversa.

* Um único `Gio.Cancellable` percorre HTTP, GOA e esperas de retentativa.
  `disable()` o cancela: nada assíncrono sobrevive.
* Um contador de geração descarta a inicialização assíncrona se o `disable()`
  acontecer no meio dela.
* Todo GLib source passa por `TimerPool`, destruído junto.
* Todo `connect()` é registrado e desconectado no `destroy()`.

---

## Testes

```bash
./install.sh --test          # ou:  cd gcalendar@pvss.dev.br && ./tests/run.sh
```

Roda em `gjs` puro, sem GNOME Shell e sem npm:

* **90 testes unitários** — fusos e eventos de dia inteiro, eventos de vários
  dias, classificação de erros, resolução de conta por agenda no multi-conta, e
  o `EventStore` inteiro contra dublês (sync, falha parcial, offline, escrita,
  ciclo de vida).
* **Smoke test das preferências** — monta as quatro páginas com GTK4/libadwaita
  de verdade, sem abrir janela.

O que **não** dá para cobrir sem uma sessão do Shell: os módulos de `ui/`
(precisam de St/Clutter) e o fluxo OAuth ponta a ponta (precisa do navegador e
de credenciais reais).

---

## Diagnóstico

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep GCalendar
```

Detalhes extras: inicie a sessão com `GCAL_DEBUG=1` no ambiente.

| Sintoma | Causa provável |
|---|---|
| "Conecte sua conta do Google" | nenhuma conta Google em Configurações → Contas Online |
| "Calendário desligado" | a conta existe, mas com o Calendário desativado nas Contas Online |
| "O Google recusou o acesso desta conta" | credencial expirada — reconecte a conta no painel do sistema |
| "Contas Online do GNOME indisponível" | serviço `org.gnome.OnlineAccounts` não respondeu |
| Widget não aparece | Shell fora do 46/47, ou extensão desabilitada |
