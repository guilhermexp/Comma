# Tarefas

## 1. Backend: ação `google_calendar` (worktree `feat/agenda-backend`)

- [ ] 1.1 Conferir com a operação `schema` existente (`composio_connect.ex:300`), numa conta `googlecalendar` real e no modo `connect`, os argumentos atuais dos seis slugs de D2 (`CALENDAR_LIST_LIST`, `EVENTS_LIST`, `EVENTS_GET`, `CREATE_EVENT`, `PATCH_EVENT`, `DELETE_EVENT`) e de `EVENTS_MOVE`. Registrar o mapeamento C1 → argumentos no `@moduledoc` do módulo novo. Verificar: o mapeamento cobre cada campo de C1.
- [ ] 1.2 `execute_calendar_read/7` e `execute_calendar_write/7` em `Salix.Control.ComposioConnect`, com slug fixo por operação, modos `connect` e `project` e limite de bytes, começando por testes que falham:
  - slug fora da lista é recusado;
  - os modos `connect` e `project` chamam o caminho certo;
  - conta de modo desconhecido é negada.

  Verificar com `mix test` do app `salix_web`.
- [ ] 1.3 `CommaWeb.GoogleCalendarAgenda` com validação de C1 e autorização antes e depois (`toolkit == "googlecalendar"`, conta do próprio usuário), começando por testes que falham:
  - operação desconhecida;
  - `calendar_ids` acima de 25;
  - intervalo acima de 62 dias;
  - fim antes do início;
  - conta de outro membro;
  - conta `googledrive`.

  Verificar com `mix test` do app `comma_web`.
- [ ] 1.4 Projeções:
  - `calendars`, com `writable` por `access_role` e `account_email` do principal;
  - `events`, com paginação, `truncated` em 2.500 eventos ou 1 MB, cancelados fora e `failed_calendar_ids`;
  - `event`, com classificação da repetição: `FREQ` simples vira `daily`, `weekly`, `monthly` ou `yearly`; qualquer outra regra vira `custom`.

  Verificar com testes dos cenários das specs: feriados `reader`, série semanal, `BYDAY=MO,WE,FR` e calendário que falha.
- [ ] 1.5 Escritas:
  - `create`;
  - `update`, com patch parcial, `scope`, `target_calendar_id` via `EVENTS_MOVE` e conferência de `etag`;
  - `delete`, com `scope`;
  - 401 e 403 viram `calendar_write_permission_required`.

  Verificar com testes que conferem os argumentos enviados à Composio e o conflito de `etag`.
- [ ] 1.6 Cláusula `"google_calendar"` em `CommaWeb.ComposioConnect.command/5`, ao lado de `google_drive`. Verificar com um teste de rota em `POST /v1/comma/workspaces/:id/composio/google_calendar` que exige sessão e responde C1.
- [ ] 1.7 `LocalComposioMock` responde os slugs de D2 com dados coerentes (2 calendários, eventos da semana atual, escrita em memória). Verificar: com o backend local, `curl` em `calendars`, `events`, `create`, `update` e `delete` devolve C1.
- [ ] 1.8 Sem tokens, cabeçalhos ou corpo bruto do provedor em respostas e logs. Verificar com um teste que força um erro do provedor e inspeciona a resposta e o log capturado.

## 2. Mac: `CalendarKit` e folhas `calendar.*` (worktree `feat/agenda-mac-calendar`)

- [ ] 2.1 Addon `native/macos/CalendarKit`:
  - `binding.gyp` com `EventKit.framework`, `index.ts` com loader e fallback `unavailable`, e `src/*.mm`;
  - status e pedido de acesso, com `requestFullAccessToEvents` no macOS 14+;
  - `calendars`, `events` e `event`;
  - `create`, `update` e `delete` com `EKSpan`;
  - observador de mudança com janela de 500 ms.

  Verificar: `node-gyp rebuild` compila, e um script descartável no Electron de desenvolvimento lista calendários e eventos reais.
- [ ] 2.2 Build e empacotamento:
  - `build-native.ts` (`buildCalendarKitAddon`, `--calendar-kit-only`, `verifyNativeOutputs`);
  - `native-paths.ts` e `dev-native-addons.ts`;
  - `forge.config.ts`, se precisar.

  Verificar: `build-native.ts --calendar-kit-only` gera o `.node` em `dist/native/macos` e o build completo continua passando.
- [ ] 2.3 Permissões:
  - `com.apple.security.personal-information.calendars` nos dois arquivos de entitlements;
  - `NSCalendarsFullAccessUsageDescription` e `NSCalendarsUsageDescription` em `macos-info-plist-strings.ts`, com textos em `en`, `pt-BR` e `zh-CN`;
  - o bundle de desenvolvimento recebe as chaves.

  Verificar: `plutil -p` do `Info.plist` gerado mostra as chaves e `codesign -d --entitlements -` mostra o entitlement.
- [ ] 2.4 Folhas C2 em `capability-leaves.ts`: zod `.strict()`, `local_only` com justificativa, `webFallback` e `mock` indisponíveis, `defineNativeState` para `calendar.state` e um evento de mudança. Depois, `pnpm generate:native-bridge`. Verificar: geração sem diff pendente e `pnpm typecheck` dos pacotes afetados.
- [ ] 2.5 Provedor `calendar` em `src/main/modules/calendar/`, registrado em `electron-main.module.ts`, com provedor "unavailable" fora do macOS ou sem addon, começando por testes que falham:
  - validação dos limites de C2 (500 calendários, 62 dias, 2.500 eventos);
  - mapeamento de erros;
  - agrupamento dos avisos;
  - logs sem título, local ou observações.

  Verificar com os testes do Electron.
- [ ] 2.6 Prova real no Electron de desenvolvimento:
  - pedir acesso;
  - listar;
  - criar, mover só uma ocorrência e apagar um evento de teste "[Comma teste]" num calendário local;
  - receber o aviso de mudança ao criar um evento no app Calendário.

  Verificar com um registro da saída e uma captura de tela do app Calendário; o evento de teste é apagado no fim.

## 3. Interface: seção Agenda (worktree `feat/agenda-ui`)

- [ ] 3.1 Funções puras `agendaDates.ts` (períodos de 3 dias, Semana e Mês, segunda a domingo, total do dia, fuso e dia inteiro) e `agendaLayout.ts` (colunas de sobreposição, faixas de vários dias, encaixe de 15 min), começando por testes que falham com os cenários das specs: "Semana 19 – 25 out 2026", "2 h 45 min", eventos sobrepostos, dia inteiro quinta a sábado e dia inteiro sem deslocamento de fuso. Verificar com `vitest`.
- [ ] 3.2 Item "Agenda" na sidebar:
  - `sidebarNavOrder.ts`, `SidebarChrome.tsx` e `icons.tsx` (com `CalendarIcon`);
  - rota `#/agenda` em `index.tsx`, com `validateSearch` de `view` e `date`;
  - atalho e menu como os do Drive;
  - textos em `en`, `pt-BR` e `zh-CN`;
  - testes existentes de ordem e caminhos atualizados.

  Verificar: `sidebarNavOrder.test.ts` com ordem salva antiga, `check-i18n` e `pnpm typecheck`.
- [ ] 3.3 `AgendaSource` (D5) e `googleCalendarSource` sobre C1, com zod, contas `googlecalendar` vindas da ação `accounts` e mapeamento dos erros para mensagens. Verificar com testes que usam respostas C1 simuladas, incluindo `calendar_write_permission_required` e `calendar_event_conflict`.
- [ ] 3.4 Estado da Agenda:
  - fontes, calendários ocultos e zoom em `localStorage` por workspace;
  - busca do período com `AbortController`, a cada 60 s, ao focar e depois de cada escrita;
  - erro isolado por fonte;
  - regra de duplicatas por `ownerEmail`.

  Verificar com testes do hook: fonte com erro não esconde as outras, e o calendário Mac da conta conectada começa oculto.
- [ ] 3.5 Barra (título, zoom de 75% a 200%, painel, 3 dias/Semana/Mês, anterior/Hoje/próximo), `AgendaCalendarPanel` e `AgendaTimeGrid` (cabeçalhos com total, Dia inteiro, horas, faixa e linha do agora, rolagem inicial). Verificar com testes de componente para navegação, zoom no limite e linha do agora, e com uma captura no navegador comparada à referência.
- [ ] 3.6 `AgendaMonthGrid` com "+N" e a lista do dia. Verificar com um teste de componente do dia com 7 eventos.
- [ ] 3.7 Criar, mover e redimensionar por arraste (ponteiro, 15 min, auto-rolagem), criar pela linha Dia inteiro e alterações otimistas com reversão. Verificar com testes de componente: mover de quarta 10:00 para sexta 14:00, redimensionar até 13:45 e reversão quando a fonte recusa.
- [ ] 3.8 `AgendaEventDetails`:
  - edição dos campos e de calendário, inclusive o aviso para outra fonte (criar e depois apagar);
  - repetição simples, com "Personalizada" só de leitura;
  - "Só este evento" ou "Todos os eventos";
  - apagar com confirmação e tecla Delete;
  - modo só de leitura.

  Verificar com testes de componente dos cenários das specs.
- [ ] 3.9 E2E (Playwright, web) com a fonte Google simulada: abrir pela sidebar, navegar, criar, mover e apagar. Verificar: o spec novo passa e os specs de sidebar e atalhos continuam passando.

## 4. Integração e prova (worktree `feat/agenda`, depois de 1, 2 e 3)

- [ ] 4.1 Merge de `feat/agenda-backend`, `feat/agenda-mac-calendar` e `feat/agenda-ui` em `feat/agenda` e regeneração dos artefatos gerados. Verificar: `pnpm generate:native-bridge` sem diff e os testes das três frentes passando juntos.
- [ ] 4.2 `macCalendarSource` sobre as folhas C2 (estado, pedido de acesso, Ajustes do Sistema, `subscribe` pela revisão) e a fonte Mac só quando a capacidade existe. Verificar com testes da fonte, usando o `mock` da ponte.
- [ ] 4.3 Entrada "Agenda event projection" em `docs/architecture/DOMAIN_CONCEPTS.md`, mais a lacuna dos eventos locais do Salix apontada no levantamento, se for parte do mesmo texto. Verificar: a entrada tem identidade, dono, ciclo de vida e links.
- [ ] 4.4 Prova ponta a ponta no app desktop com backend local, conta Google real e Calendário do Mac real:
  - abrir pela sidebar;
  - ver eventos das duas fontes sem duplicar;
  - criar, mover só uma ocorrência e apagar um evento "[Comma teste]" em cada fonte;
  - mudança feita no app Calendário aparecendo sozinha;
  - permissão negada mostrando "Abrir Ajustes do Sistema".

  Verificar com capturas e registro. Os eventos de teste são apagados no fim.
- [ ] 4.5 Web: a Agenda abre só com o Google, sem o grupo do Mac. Verificar com uma captura no navegador.

## Workflow follow-up

- PR de `feat/agenda` para `main` só com autorização do dono; depois, `openspec archive add-agenda`.
