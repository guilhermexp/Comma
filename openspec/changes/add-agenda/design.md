# Design

## Contexto

- **Sidebar e rotas:** a sidebar vem de `clients/packages/app/src/components/sidebar/sidebarNavOrder.ts:1` (`home`, `inbox`, `tasks`, `drive`, `plugins`) e de `SidebarChrome.tsx`.
  - Itens novos entram no fim da ordem salva por `reconcileSidebarNavOrder`.
  - As rotas ficam em `src/index.tsx`, com `createHashHistory`.
  - O Drive é o modelo completo de seção: rota, ícone, atalho, textos e testes.
- **Composio:**
  - A interface fala com a Composio só por ações fechadas em `POST /v1/comma/workspaces/:id/composio/:action` (`comma_web/router.ex:2731`), despachadas em `CommaWeb.ComposioConnect.command/5`. `google_drive` tem cláusula própria (`composio_connect.ex:19`).
  - O modelo de leitura é `CommaWeb.GoogleDriveBrowser`:
    - autorização da conta antes e depois da chamada (`google_drive_browser.ex:21-70`);
    - prazo `Read.within`;
    - limite de bytes;
    - projeção do resultado.
  - O executor é `Salix.Control.ComposioConnect.execute_drive_read` (`composio_connect.ex:417`), com os modos `connect` e `project`.
- **Google Calendar:**
  - `googlecalendar` já está nas listas de toolkits permitidos (`recommendation_composio_transport.ex:8`).
  - Hoje só é lido pelas Rotinas, via `GOOGLECALENDAR_EVENTS_LIST`, só no principal.
  - O `GoogleCalendarSource` do Salix é por grupo e só de leitura (`google_calendar_source.ex:2,37`). Ele não serve para a agenda pessoal.
- **Mac:**
  - Não há EventKit no repositório.
  - O precedente para acesso nativo com permissão do próprio app é o addon `clients/apps/electron/native/macos/NotificationAuthorization`: Node-API, `.mm`, `binding.gyp`, carregado no processo principal.
  - Capacidades nativas são folhas em `clients/packages/native-bridge/src/capability-leaves.ts`, como `meetingPresence` (`:6798-6869`), e são geradas por `pnpm generate:native-bridge`.
- **Bibliotecas:** não há biblioteca de datas nem de arrastar e soltar. Datas usam `Date` e `Intl`.

## Objetivos / Fora do escopo

Objetivos: as specs `agenda`, `agenda-google-calendar` e `agenda-mac-calendar`.

Fora: o que a proposta exclui.

## Decisões

### D1 – Leitura transitória, sem cópia no Comma

- Os eventos são lidos das fontes para o período visível e mantidos só na memória da tela, como no Drive online. Não há tabela, cache em S3 nem sincronização em segundo plano.
- A cada 60 s, ao focar e depois de cada escrita, a tela busca de novo.
- Alternativa descartada: usar o `salix_calendar`. Ele guarda cópia por grupo e é só de leitura; exigiria mudar dono, escopo e escrita.
- Nenhuma entidade nova. `DOMAIN_CONCEPTS.md` ganha a entrada "Agenda event projection" (transitória, dono = fonte; sem identidade própria no Comma).

### D2 – Ação fechada `google_calendar` no backend

- Fica em um módulo novo, `CommaWeb.GoogleCalendarAgenda`, com uma cláusula `"google_calendar"` em `CommaWeb.ComposioConnect.command/5` ao lado de `google_drive`.
- Usa a mesma autorização de conta do Drive, com `toolkit == "googlecalendar"`.
- Chama novos executores com slug fixo em `Salix.Control.ComposioConnect`:
  - `execute_calendar_read/7` para `calendars`, `events` e `event`;
  - `execute_calendar_write/7` para `create`, `update` e `delete`.
- Os dois atendem os modos `connect` e `project`, como `execute_drive_read`.
- O cliente nunca envia slug.

| operation | Slug Composio |
|---|---|
| `calendars` | `GOOGLECALENDAR_CALENDAR_LIST_LIST` |
| `events` | `GOOGLECALENDAR_EVENTS_LIST`, uma chamada por calendário, com `singleEvents=true`, `orderBy=startTime`, `showDeleted=false` e paginação até o limite |
| `event` | `GOOGLECALENDAR_EVENTS_GET` |
| `create` | `GOOGLECALENDAR_CREATE_EVENT` |
| `update` | `GOOGLECALENDAR_PATCH_EVENT`; troca de calendário na mesma conta com `GOOGLECALENDAR_EVENTS_MOVE` antes do patch |
| `delete` | `GOOGLECALENDAR_DELETE_EVENT` |

- Os argumentos de cada slug seguem o schema atual da Composio para a ferramenta, conferido com a operação `schema` existente (`composio_connect.ex:300`). Não segue a API do Google diretamente.
- `scope: "series"` age sobre o `series_id` (`recurringEventId`). `scope: "instance"` age sobre o id da ocorrência.
- Escrita com `etag`: o backend lê o evento (`EVENTS_GET`) e compara antes do patch ou delete. Se mudou, responde `calendar_event_conflict`. [Risco: há uma janela curta entre a leitura e a escrita; aceita.]
- `events` com vários calendários roda as chamadas em sequência, todas dentro do prazo de 30 s. Um calendário que falha entra em `failed_calendar_ids` sem derrubar os outros.
- Paginação de `EVENTS_LIST` (lição do `fastrepl/anarlog`, `crates/calendar/src/fetch.rs`):
  - para se um `nextPageToken` se repetir;
  - página vazia com `nextPageToken` não pode virar laço;
  - falha numa página posterior falha o calendário inteiro (vai para `failed_calendar_ids`), sem resultado parcial;
  - ocorrências `cancelled` são descartadas mesmo com `showDeleted=false`.
- Erros: 401 ou 403 numa escrita viram `calendar_write_permission_required`. Fora isso, valem os mesmos erros do Drive.
- O consentimento é a própria ação explícita do usuário na tela. Não há agente no meio, como no Drive ("Member-facing closed read"). A escrita não passa pelo consentimento de leitura das Rotinas.
- O `LocalComposioMock` passa a responder os seis slugs para o desenvolvimento local.

### D3 – EventKit no mesmo processo (`CalendarKit`)

- O addon novo `clients/apps/electron/native/macos/CalendarKit` usa Node-API e `.mm` e liga com `EventKit.framework`. Ele copia a estrutura de `NotificationAuthorization`: loader com fallback `unavailable` e callbacks por `napi_threadsafe_function`.
- No mesmo processo porque a permissão de Calendário do macOS é concedida ao app que chama. Um helper separado teria permissão própria.
- Usa um único `EKEventStore`, guardado. No macOS 14 ou mais novo, o pedido é `requestFullAccessToEventsWithCompletion`. Em versões anteriores, `requestAccessToEntityType:EKEntityTypeEvent`.
- Um observador de `EKEventStoreChangedNotification` agrupa os avisos em janelas de 500 ms e incrementa a `revision`.
- Lições do `fastrepl/anarlog` (`crates/apple-calendar`, `crates/calendar/src/apple_identity.rs`, `plugins/permissions/src/ext.rs`):
  - **Chave:** `eventIdentifier` não serve de chave, porque muda ao editar e varia por store. A ocorrência é `calendarItemIdentifier` + `occurrenceDate`.
  - **Ocorrências destacadas:** o sufixo `/RID=…` é removido para obter a série. A ocorrência movida mantém o `occurrenceDate` original, e `MacEvent.detached` sinaliza isso.
  - **Dia inteiro:** a data é tomada no fuso do evento.
  - **Chamadas ao EventKit:** todas passam por uma fila serial. "0 calendários depois de >0" é tratado como transitório. Exceções Objective-C são capturadas, com 3 tentativas de 100 ms em falha de XPC.
  - **Editável:** `allowsContentModifications && !immutable`.
  - **Ajustes do Sistema:** `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars`, com fallback para `com.apple.preference.security?Privacy_Calendars`.
  - **Precedente:** o anarlog só cria eventos (`EKSpanThisEvent`). Alterar, apagar, `EKSpanFutureEvents` e `EKRecurrenceRule` não têm precedente e são cobertos pela prova real.
- `series` usa `EKSpanFutureEvents` sobre o item buscado por `calendarItemWithIdentifier:`, que representa a série a partir da primeira ocorrência. `instance` usa `EKSpanThisEvent` sobre a ocorrência com o mesmo `calendarItemIdentifier` e `occurrenceDate`, buscada por predicado no dia dessa ocorrência.
- A repetição simples vira um `EKRecurrenceRule` de frequência e intervalo 1. Qualquer outra regra é classificada como `custom`.
- O provedor `calendar` fica no main, em `clients/apps/electron/src/main/modules/calendar/`, e registra as folhas.
- Permissões e empacotamento:
  - `com.apple.security.personal-information.calendars` em `build/entitlements.mac.entitlements` e na variante ad hoc;
  - `NSCalendarsFullAccessUsageDescription` e `NSCalendarsUsageDescription` em `scripts/macos-info-plist-strings.ts`, com textos em i18n;
  - `build-native.ts`, `native-paths.ts`, `dev-native-addons.ts` e o bundle de desenvolvimento (`prepareDevElectronBundle`).

### D4 – Interface: grade própria, sem biblioteca nova

- `components/agenda/` com:
  - `AgendaRoute`;
  - `AgendaToolbar` (título, zoom, painel, visões, navegação);
  - `AgendaCalendarPanel`;
  - `AgendaTimeGrid` (cabeçalhos, Dia inteiro, horas, agora);
  - `AgendaMonthGrid`;
  - `AgendaEventDetails`;
  - e funções puras em `agendaDates.ts` e `agendaLayout.ts`.
- Datas com `Date` e `Intl.DateTimeFormat` no fuso do sistema. Dia inteiro usa datas `YYYY-MM-DD` sem hora.
- Posicionamento dos eventos sobrepostos: agrupa por colisão e divide a largura em colunas, como no Google Calendar.
- Arrastar (criar, mover, redimensionar) com eventos de ponteiro próprios, como em `sidebar/useSidebarNavReorder.ts`, encaixando em 15 min. Precisão de pixel e auto-rolagem perto das bordas.
- Linha do agora com relógio compartilhado que dispara na virada do minuto, pausa com a aba oculta e atualiza ao focar. O "+N" do Mês mede o chip com `ResizeObserver`. As buscas descartam resultados antigos por contador de geração + `AbortSignal`. Calendário que some numa leitura bem-sucedida sai da lista; leitura com falha não remove nada. Padrões vistos em `fastrepl/anarlog` (`apps/desktop/src/calendar`), que não tem grade de horas nem arraste.
- Estado na URL: `#/agenda?view=week&date=2026-10-20`. Zoom e calendários ocultos em `localStorage`, por workspace.
- Estilo: tokens e componentes de `@comma/ui` (`Button`, `ButtonGroup`, `Menu`, `Dialog`, `Tooltip`, `ScrollArea`, `CalendarIcon`).

### D5 – Modelo único de fonte no cliente

```ts
type AgendaSourceKind = "google" | "mac";
type AgendaCalendar = { key: string; source: AgendaSourceKind; accountId: string | null; id: string; name: string; color: string; writable: boolean; primary: boolean; ownerEmail: string | null };
type AgendaEvent = { key: string; source: AgendaSourceKind; accountId: string | null; calendarId: string; id: string; seriesId: string | null; occurrenceDate: string | null; title: string; start: string; end: string; allDay: boolean; location: string | null; description: string | null; url: string | null; color: string | null; editable: boolean; etag: string | null };
type AgendaEventInput = { title: string; start: string; end: string; allDay: boolean; timeZone: string; location?: string | null; description?: string | null; recurrence: "none" | "daily" | "weekly" | "monthly" | "yearly" };
interface AgendaSource {
  calendars(signal: AbortSignal): Promise<AgendaCalendar[]>;
  events(calendarIds: string[], start: string, end: string, signal: AbortSignal): Promise<{ events: AgendaEvent[]; truncated: boolean; failedCalendarIds: string[] }>;
  recurrence(event: AgendaEvent): Promise<"none" | "daily" | "weekly" | "monthly" | "yearly" | "custom">;
  create(calendarId: string, input: AgendaEventInput): Promise<AgendaEvent>;
  update(event: AgendaEvent, scope: "instance" | "series", patch: Partial<AgendaEventInput>, targetCalendarId?: string): Promise<AgendaEvent>;
  remove(event: AgendaEvent, scope: "instance" | "series"): Promise<void>;
  subscribe?(onChange: () => void): () => void;
}
```

- Uma fonte por conta Google (`googleCalendarSource(api, workspace, accountId)`) e uma para o Mac (`macCalendarSource(bridge)`, só quando a capacidade existe).
- A chave do evento é `${source}:${accountId ?? "mac"}:${calendarId}:${id}`.
- Duplicatas: calendários Mac cujo `ownerEmail` (título da conta de origem) é igual ao e-mail de uma conta Google conectada começam ocultos.
- Troca de calendário entre fontes ou contas: `create` no destino e depois `remove` no original.

### D6 – Contratos

**C1 – `google_calendar`** (corpo do `composioCommand`; respostas em snake_case, validadas com zod no cliente):

```
calendars: { account_id, operation:"calendars" }
  -> { account_email, calendars: [{ id, name, color, primary, selected, access_role, writable }] }   (até 250)
events:    { account_id, operation:"events", calendar_ids[≤25], time_min, time_max, time_zone }
  -> { events: [Event], truncated, failed_calendar_ids }
event:     { account_id, operation:"event", calendar_id, event_id } -> { event: Event & { recurrence } }
create:    { account_id, operation:"create", calendar_id, event: Input } -> { event: Event }
update:    { account_id, operation:"update", calendar_id, event_id, scope, etag?, patch: Partial<Input>, target_calendar_id? } -> { event: Event }
delete:    { account_id, operation:"delete", calendar_id, event_id, scope, etag? } -> { deleted: true }

Event = { id, calendar_id, series_id|null, title, start:{date}|{date_time,time_zone}, end:(idem), all_day,
          location|null, description|null, url|null, color|null, editable, etag }
Input = { title, start, end (YYYY-MM-DD se all_day; senão ISO com offset), all_day, time_zone (IANA),
          location?, description?, recurrence: none|daily|weekly|monthly|yearly }
Erros: invalid_composio_request, composio_access_denied, calendar_write_permission_required,
       calendar_event_conflict, provider_unavailable, provider_timeout
```

**C2 – folhas `calendar.*`** em `native-bridge` (`sessionAdmission: "local_only"`, permissões `calendar.read` e `calendar.write`, `webFallback` indisponível):

```
calendar.state (defineNativeState) -> { available, access: notDetermined|denied|restricted|writeOnly|fullAccess|unavailable, revision }
calendar.requestAccess()      -> access
calendar.openPrivacySettings() -> void
calendar.calendars()          -> { calendars: [{ id, title, color, sourceTitle, sourceType, writable, isDefault }] }  (≤500)
calendar.events({ calendarIds[≤500], start, end })
                              -> { events: [MacEvent], truncated }  (≤2500, intervalo ≤62 dias)
calendar.event({ eventId, occurrenceDate|null }) -> MacEvent
calendar.createEvent({ calendarId, event: Input })                         -> MacEvent
calendar.updateEvent({ eventId, occurrenceDate|null, scope, patch, targetCalendarId? }) -> MacEvent
calendar.deleteEvent({ eventId, occurrenceDate|null, scope })              -> void

MacEvent = { occurrenceId, eventId, externalId|null, calendarId, title, start, end, allDay, location|null,
             notes|null, url|null, editable, recurrence: none|daily|weekly|monthly|yearly|custom, occurrenceDate|null, detached }
Erros: calendar_access_denied, calendar_read_only, calendar_event_not_found, calendar_unavailable
```

`Input` em C2 é o mesmo de C1, em camelCase (`allDay`, `timeZone`).

## Riscos / Trade-offs

- **R1 – Escopo de escrita da conta Composio.** Não está confirmado que a autorização atual de `googlecalendar` no modo `connect` inclui escrita. Mitigação: o erro `calendar_write_permission_required` aparece com o botão de reconectar. A prova ao vivo da integração cria e apaga um evento de teste.
- **R2 – Permissão do Mac em builds ad hoc.** O macOS pode pedir de novo depois de cada atualização, e o bundle de desenvolvimento tem permissão separada. Isso fica documentado; não tem mitigação em código.
- **R3 – Duplicatas.** A regra de D5 cobre o caso comum (conta Google também no Mac). Outros casos (Exchange, delegados) ficam a cargo do filtro manual.
- **R4 – Limites de leitura.** 25 calendários Google por chamada e 62 dias por intervalo. O Mês usa no máximo 6 semanas, dentro do limite.
- **R5 – Concorrência com outro trabalho no repositório.** Há worktrees de `add-cloud-meeting-asr` abertos. Esta change não toca nos arquivos deles; conflitos possíveis só em `capability-leaves.ts`, nos arquivos gerados, no `build-native.ts` e nos JSON de i18n.

## Plano de entrega

Três frentes em paralelo, cada uma num worktree a partir de `main`, e depois uma integração:

1. **Backend** (`feat/agenda-backend`): D2 e C1.
2. **Mac** (`feat/agenda-mac-calendar`): D3 e C2.
3. **Interface** (`feat/agenda-ui`): D4 e D5, com a fonte Google ligada a C1. A fonte Mac é implementada contra C2 depois do merge.
4. **Integração** (`feat/agenda`): merge das três, `macCalendarSource` sobre as folhas geradas, inventário de domínio e prova ponta a ponta no app desktop com contas reais.
