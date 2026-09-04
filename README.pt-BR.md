# GCalendar Widget

*[Read in English](README.md)*

Widget de calendário na área de trabalho do GNOME, integrado ao Google Agenda.

Mostra o mês, marca os dias com evento, lista os eventos do dia selecionado e
permite criar, editar e excluir eventos sem sair da área de trabalho.

> **Não pede credenciais.** Usa a conta que você já tem em
> *Configurações → Contas Online*. Sem client id, sem client secret, sem tela
> de login, sem token guardado pela extensão.

![Captura de tela](docs/screenshot.png)

## Requisitos

| | |
|---|---|
| GNOME Shell | 46 ou 47 |
| Contas Online | uma conta Google com **Calendário** habilitado |

Testado em Zorin OS 18.1 (GNOME Shell 46, GJS 1.80), sessão X11.

## Instalação

### Pela loja de extensões

[<img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg" height="100" alt="Instale pelo GNOME Extensions">](https://extensions.gnome.org/extension/10866/gcalendar-widget/)

### A partir do código

```bash
git clone https://github.com/pvss-dev/gcalendar.git
cd gcalendar
./install.sh
```

O script roda a suíte de testes antes de instalar e aborta se algo falhar.
Depois, recarregue o GNOME Shell:

* **X11:** `Alt+F2` → `r` → `Enter`
* **Wayland:** faça logout e login

E ative:

```bash
gnome-extensions enable gcalendar@pvss.dev.br
```

## Conectando sua conta

1. **Configurações → Contas Online → Google** e entre com sua conta
2. Deixe **Calendário** ligado
3. Pronto — o widget detecta sozinho e sincroniza

Se você já usa o Google no GNOME, não há passo nenhum: o widget simplesmente
funciona.

## Recursos

* Navegação por mês, com o dia selecionado acompanhando a troca
* Marcadores coloridos nos dias com evento, na cor da agenda
* Lista dos eventos do dia, com horário, local e eventos de vários dias
* Criar, editar e excluir eventos
* Sincronização automática com intervalo configurável
* Notificações de eventos próximos
* Cache em disco: o widget não fica vazio sem rede
* Múltiplas contas Google exibidas juntas
* Arrastar pelo cabeçalho, com a posição salva
* Menu de contexto no botão direito

## Como funciona a autenticação

A extensão obtém o token de acesso do **GNOME Online Accounts**, pela interface
D-Bus `org.gnome.OnlineAccounts.OAuth2Based`. O cliente OAuth é o do próprio
GNOME — já registrado e verificado junto ao Google.

Isso evita três problemas de embutir credenciais próprias numa extensão:

* os escopos do Google Agenda são **sensíveis**: sem passar pela verificação do
  Google, um app fica limitado a 100 usuários e mostra a tela de "app não
  verificado";
* a cota da API seria compartilhada entre todos os usuários da extensão;
* num projeto de código aberto, as credenciais ficariam públicas de qualquer
  forma.

Consequência prática: a extensão **não guarda segredo algum**. Removê-la não
deixa credencial para trás, e revogar o acesso do GNOME na sua conta Google
revoga o desta extensão junto.

## Configurações

```bash
gnome-extensions prefs gcalendar@pvss.dev.br
```

| Configuração | Padrão | O que faz |
|---|---|---|
| Camada | Atrás das janelas | Na área de trabalho, ou sempre visível acima das janelas |
| Posição X / Y | 40, 60 | Também ajustável arrastando o widget |
| Opacidade do fundo | 92% | Afeta só o fundo; texto e ícones ficam opacos |
| Altura da lista de eventos | 150px | Fixa, para o widget não mudar de tamanho conforme o dia |
| Intervalo de sincronização | 5 min | |
| Dias à frente | 30 | Meses visitados são carregados sob demanda |
| Notificações | ligadas, 10 min antes | Só para eventos com horário |
| Agendas exibidas | as visíveis no Google | |

A camada também é alternável pelo botão direito no widget, ou por
`./install.sh --layer desktop|top`.

## Desenvolvimento

```bash
./install.sh --test        # 120 testes, sem precisar do GNOME Shell
./install.sh --status      # o Shell já carregou a versão instalada?
./install.sh --diagnose    # relatório de sessão, layout e sincronização
./install.sh --debug on    # liga o diagnóstico no journal
./install.sh --zip         # empacota para a loja
./install.sh --forget      # apaga o cache local de eventos
```

Os testes rodam em `gjs` puro, sem sessão gráfica e sem dependências externas.
Cobrem fusos horários, eventos de dia inteiro e de vários dias, o `EventStore`
inteiro contra dublês, resolução de conta no multi-conta, geometria da grade e
as regras de notificação.

O código está separado em três camadas, e a fronteira é dura:

```
extension.js     ciclo de vida e montagem das dependências
lib/             domínio e infraestrutura — nunca importa St ou Clutter
ui/              apresentação — nunca fala HTTP
```

`lib/calendarService.js` é a camada de abstração: acima dela ninguém conhece o
formato JSON do Google. Trocar por CalDAV significaria reescrever só esse
arquivo.

Notas de arquitetura, decisões e armadilhas do St/Clutter encontradas no
caminho estão em [`gcalendar@pvss.dev.br/context.md`](gcalendar@pvss.dev.br/context.md).

## Limitações conhecidas

* **Wayland não foi testado.** O código trata a diferença (a região de entrada
  do X11 não existe lá), mas a validação prática está pendente.
* **Interface em português.** As strings ainda não passaram por gettext.
* **Eventos recorrentes:** editar ou excluir afeta apenas aquela ocorrência,
  não a série inteira. O diálogo avisa.
* No modo *Atrás das janelas*, em X11, o widget não recebe cliques enquanto
  uma janela o estiver cobrindo — senão roubaria o clique dela.

## Licença

[GPL-2.0-or-later](LICENSE) — a mesma licença do próprio GNOME Shell.

## Autor

Paulo Vitor S. Soares
