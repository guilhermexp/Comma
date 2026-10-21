# Proposta

## Por quê

O dono quer ver e cuidar da própria agenda sem sair do Comma. Hoje o Google Calendar só é lido nos bastidores: pelas Rotinas, apenas o calendário principal, apenas a próxima semana; e pelo calendário do Salix, que é por grupo e só de leitura. O Calendário do Mac não aparece em lugar nenhum do app. Não existe tela de agenda nem como criar ou editar um evento.

## O que muda

- A sidebar ganha o item **Agenda** (`#/agenda`). Ele abre uma agenda em tela cheia, no estilo da referência "Time boxing" (só a grade de eventos, sem coluna de tarefas):
  - visões **3 dias**, **Semana** e **Mês**, com **anterior**, **Hoje** e **próximo** e o período no título ("Semana 19 – 25 out 2026");
  - cabeçalho de cada dia com o total de horas ocupadas ("2 h 30 min", "—");
  - linha **Dia inteiro**, grade de horas, faixa do dia atual e linha vermelha do "agora";
  - zoom da grade (75% a 200%, botões − e +);
  - painel lateral recolhível com as contas e os calendários, cada um com sua cor e uma caixa para mostrar ou esconder.
- Os eventos vêm de duas fontes, mostradas juntas:
  - **Google Calendar**, por meio das contas `googlecalendar` que o usuário já conectou pela Composio, em todos os calendários dessas contas;
  - **Calendário do Mac**, lido direto no macOS pelo EventKit, só no app desktop do Mac.
- A primeira versão já é completa para editar, nas duas fontes:
  - criar um evento clicando ou arrastando num horário vazio;
  - mover e redimensionar arrastando;
  - abrir o evento para editar título, início, fim, dia inteiro, local, descrição, calendário e repetição simples (nenhuma, diária, semanal, mensal, anual);
  - apagar;
  - em evento que se repete, escolher entre "só este" e "todos".
- Cada evento é gravado na fonte e no calendário de onde veio. Nada é copiado de uma fonte para a outra.
- Calendários do Mac que pertencem a uma conta Google já conectada pela Composio começam escondidos, para o mesmo evento não aparecer duas vezes.
- Calendários só de leitura (feriados, assinaturas, convites de terceiros sem permissão) aparecem, mas não permitem editar.
- No navegador e fora do macOS, a Agenda mostra só o Google.

Fora do escopo:
- tarefas pendentes e time boxing (coluna da esquerda da referência);
- convidados e respostas a convites;
- alertas e lembretes de evento;
- criação de videoconferência;
- regras de repetição personalizadas;
- copiar eventos de uma fonte para a outra;
- calendários iCloud fora do Mac (CalDAV).

## Capacidades

### Novas capacidades

- `agenda`: a seção Agenda do app (navegação, visões, grade, zoom, painel de calendários, criação, edição, movimento e exclusão de eventos, junção das fontes e duplicatas).
- `agenda-google-calendar`: ação fechada do backend que lista os calendários e os eventos de uma conta Google conectada pela Composio, e cria, altera e apaga eventos, sem expor ferramentas Composio arbitrárias.
- `agenda-mac-calendar`: acesso ao Calendário do Mac pelo EventKit no app desktop (permissão, calendários, eventos, gravação e aviso de mudança).

### Capacidades modificadas

Nenhuma (`openspec/specs/` está vazio).

## Impacto

- **Interface** (`clients/packages/app`):
  - nova rota e componentes em `components/agenda/`;
  - item na sidebar (`sidebarNavOrder.ts`, `SidebarChrome.tsx`, `icons.tsx`) e atalho como o do Drive;
  - textos em `en`, `pt-BR` e `zh-CN`.
- **Backend** (`systems/apps`):
  - nova ação `google_calendar` em `POST /v1/comma/workspaces/:id/composio/:action` (`CommaWeb.GoogleCalendarAgenda`, no modelo de `CommaWeb.GoogleDriveBrowser`);
  - executores com slug fixo em `Salix.Control.ComposioConnect`;
  - mock local para desenvolvimento.
- **Desktop** (`clients/apps/electron`):
  - novo addon nativo `native/macos/CalendarKit` (EventKit, no mesmo processo, como `NotificationAuthorization`);
  - provedor `calendar` no main e comandos e estado novos em `clients/packages/native-bridge`;
  - entitlement `com.apple.security.personal-information.calendars` e textos `NSCalendarsFullAccessUsageDescription` e `NSCalendarsUsageDescription`.
- **Domínio:** nenhuma entidade nova. Os eventos são uma leitura transitória das fontes, como o Drive online; o Comma não guarda cópia. O inventário `docs/architecture/DOMAIN_CONCEPTS.md` ganha a entrada da projeção da Agenda.
- **Rede:** chamadas à Composio só quando a Agenda está aberta. Os dados do Mac não saem do computador.
