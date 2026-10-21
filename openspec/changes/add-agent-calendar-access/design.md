# Design

## Contexto

Motivação em `proposal.md` e requisitos em `specs/`. O mapa do código está em `.tmp/agent-calendar/code-map.md`, no checkout principal (ignorado pelo git). Resumo do que existe hoje:

- **Calendário interno:**
  - Ferramentas em `salix_agent/lib/salix_agent/tools/calendar.ex`: `list_items`, `get_item`, `update_context`, `create_event` e `issue_feed_link`.
  - Schemas em `tools/schemas.ex:721-785`.
  - Caminho: porta `SalixAgent.Calendar` → `GroupRuntime` → `Salix.Bindings.AgentCalendar` → `SalixCalendar.AgentAPI`.
  - `create_event` grava só no calendário local "Comma" e exige `trusted_origin.principal_ref` e `creation_request_id`.
  - `calendar` é um namespace de descoberta (`tool_disclosure.ex:651`).
  - A IFC trata `calendar.*` como `{:none, %{}}` (`ifc/destination.ex:532`).
- **Google:**
  - `CommaWeb.GoogleCalendarAgenda.run/4` é uma ação fechada para o membro: valida, chama `Workspaces.authorize` e repete `current/3`, que confere perfil e conta `googlecalendar` ativa, antes e depois da Composio, com prazo de 30 s.
  - Operações: `calendars`, `events` (até 62 dias e 2.500 eventos), `event`, `create`, `update` e `delete`.
  - Os executores `execute_calendar_read/write` recebem `(tenant, group, user, account, …)`.
  - O agente hoje só alcança o Google por `ComposioBroker`, que exige uma liberação por agente (`Access.agent_account_grant`).
- **Mac:**
  - `CalendarService` (EventKit), em `clients/apps/electron/src/main/modules/calendar/index.ts`, existe só no Main.
  - As folhas da ponte são `local_only`.
  - O backend já chama o app desktop pelo conector. O precedente é `Comma.Devices.set_access` → `Connector.Live.request(run, "device_access", …)` → `methodDeviceAccess` no Go → `POST {COMMA_CLIENT_CONTROL_URL}/v1/invoke` com bearer → registro de módulos `createCommaClientControlRegistry`.
  - Do lado do agente, o caminho é `SalixAgent.EnvDispatch.request/4` (precedente: `tools/dependency_installations.ex`).
  - No modo dispositivo, o conector recusa métodos fora de uma lista até o dono clicar em "Permitir operações". `device_access` é despachado antes dessa checagem (`main.go:4035-4053`).
- **Identidade:**
  - `ctx.trusted_origin["principal_ref"]` (`comma_user` + tenant + subject) só existe para mensagens humanas. Rotinas, agendamentos e agentes têm `nil`.
  - `OwnerAuthority.sealed_person/2` é o molde estrito: `comma_user`, mesma mensagem, sem agendamento, mesmo grupo, `authorize_owner`.
  - Um workspace tem um único dono.

## Objetivos / Não objetivos

**Objetivos:**
- Uma única família de ferramentas para as três fontes, com o mesmo formato de evento.
- Leitura sem humano na origem; escrita só pelo dono na conversa.
- Mac pelo canal já existente do conector, sem pedido de permissão.

**Não objetivos:**
- Mostrar o calendário interno na Agenda.
- Sincronizar fontes entre si.
- Guardar cache de eventos no servidor.
- Acesso por agentes de outros workspaces.

## Decisões

### D1. Ferramentas unificadas no namespace `calendar`

As ferramentas `calendar.calendars`, `calendar.events`, `calendar.event`, `calendar.create`, `calendar.update` e `calendar.delete` substituem `list_items`, `get_item` e `create_event`. A troca é limpa: nada de alias, e a ajuda e os testes são migrados.

- **Continuam:** `update_context` (contexto da ocorrência interna) e `issue_feed_link`.
- **Referências:**
  - `calendar_ref = {source: "comma"|"google"|"mac", account_id?, calendar_id}`;
  - `event_ref = {source, account_id?, calendar_id, event_id, occurrence?, etag?}`;
  - para o interno, `occurrence` carrega o `OccurrenceRef` atual, para `update_context` continuar funcionando.
- **Evento normalizado:** `title`, `start`, `end`, `all_day`, `time_zone`, `location`, `description` (cortada em 2.000 caracteres), `calendar_ref`, `event_ref`, `recurring`, `writable`.
- **Limites:** período de até 62 dias e 2.500 eventos por fonte. A resposta diz quando foi cortada.
- **Situação por fonte:** cada resposta traz `sources: [{source, account_id?, status: "ok"|"not_connected"|"unavailable"|"error", reason?}]`.
- **Escrita:** recebe `scope: "instance"|"series"` para eventos recorrentes, como a Agenda.

Alternativa descartada: um namespace novo `agenda.*` ao lado de `calendar.*`. Deixaria duas famílias para o mesmo assunto.

### D2. Regra de identidade

- **Dono:** resolvido a partir do grupo do agente (`agent_oauth_context` → workspace do grupo → dono). Isso vale para leitura em qualquer execução.
- **Escrita:** exige `sealed_person` (mesmos critérios de `OwnerAuthority`), com o `subject_id` igual ao dono. Assim, a mensagem tem de ser do próprio dono no Comma, na mesma execução e sem agendamento.
- **Idempotência:** `creation_request_id` (`source_message_id:tool_call_id`) continua.
- **Escrita recusada:** responde com uma mensagem clara, que o modelo repassa ao dono.

Alternativa descartada: aceitar qualquer `principal_ref`. Permitiria escrita disparada por pessoas de um canal Slack ou Feishu.

### D3. Porta `SalixAgent.CalendarSources` implementada no `comma_web`

- **Por que uma porta:** o `salix_agent` não depende do `comma_web`. A porta é configurada em `CommaWeb.Application`, como `:agent_management_ports`.
- **Callbacks:** `owner(agent_id)`, `google_accounts(scope)`, `google(scope, account_id, operation, args)` e `mac(scope, operation, args)`.
- **Google:**
  - autorização por `Workspaces.authorize_group_owner` + `Access.profile` / `Access.account` (sem `Access.authorize/5`), conferida antes e depois de cada chamada;
  - os executores e o prazo de 30 s são os de `GoogleCalendarAgenda`, extraídos para funções compartilhadas por ela e pela porta, sem duplicar validação nem slugs.

### D4. Mac pelo conector

- **Escolha do dispositivo:** o backend procura o dispositivo do dono no grupo com a capacidade `calendar` anunciada e `connected`, pelos registros do `Control`. Sem dispositivo assim, a fonte fica `unavailable`, com o motivo `desktop_offline`.
- **Chamada:** `EnvDispatch.request(agent_id, target, "calendar", %{op, input})`.
- **Conector Go:**
  - método novo `calendar`, despachado antes da checagem de escopo, como `device_access`, porque a permissão do macOS e a ativação na Agenda já são o consentimento;
  - faz `POST /v1/invoke {module:"calendar", api:op, input}` no client-control, sem redirecionamento e com resposta de até 1 MiB;
  - anuncia `calendar: true` nos metadados quando o Main informa que o serviço existe;
  - o campo entra em `@capability_fields` do `Control`.
- **Electron:**
  - módulo `calendar` no `createCommaClientControlRegistry`;
  - APIs `state`, `calendars`, `events`, `event`, `create-event`, `update-event` e `delete-event`, que chamam o `CalendarService` existente;
  - entradas validadas com os schemas zod do `@comma/native-bridge`;
  - `requestAccess` não é exposto.
- **Mapeamento de erros:**
  - `{:error, :no_environment | :disconnected}` → `desktop_offline`;
  - `calendar_access_denied` → `mac_access_not_granted`;
  - `calendar_unavailable` → `mac_unavailable`.

Alternativa descartada: `env.exec comma call calendar …`. Exige shell e a liberação "Permitir operações".

### D5. IFC e texto não confiável

- **Instruções ao modelo:** as respostas que trazem conteúdo de evento (das três fontes) recebem o mesmo `@untrusted_content` nas descrições.
- **Classificação:** o resultado é classificado como dado privado do dono, com o mesmo rótulo usado para dados pessoais de conectores do dono. Com isso, as regras de saída existentes bloqueiam o envio a uma audiência de grupo.
- **Classes explícitas:** `calendar.*` deixa de ser `{:none, %{}}` em `ifc/destination.ex` para as ferramentas que devolvem conteúdo.

### D6. Logs

O conector, o Main e o backend registram só a operação, a fonte, a duração e o código de erro, nunca título, local ou descrição. Há testes que verificam a ausência desses textos nos logs.

## Contratos

### C1. Método `calendar` do conector

- **Entrada:** `{op: "state"|"calendars"|"events"|"event"|"create-event"|"update-event"|"delete-event", input}`.
- **Saída:** o mesmo JSON do `CalendarService`, ou `{error: code}`.

### C2. Módulo `calendar` do client-control

As mesmas APIs de C1, com os schemas `calendarEventsInputSchema`, `calendarCreateEventInputSchema`, `calendarUpdateEventInputSchema` e `calendarDeleteEventInputSchema`.

### C3. Porta `SalixAgent.CalendarSources`

```
owner(agent_id) :: {:ok, %{tenant, group_id, user_id}} | {:error, reason}
google_accounts(owner) :: {:ok, [%{account_id, name}]} | {:error, reason}
google(owner, account_id, operation, args) :: {:ok, map} | {:error, public_code}
mac(owner, op, input) :: {:ok, map} | {:error, :desktop_offline | :mac_access_not_granted | :mac_unavailable | term}
```

## Riscos / Trade-offs

- **[R1] Rotina lê e o modelo é induzido a vazar a agenda:** → IFC classifica o resultado como privado; a escrita nunca vem de rotina.
- **[R2] Mais de um Mac do dono conectado:** → usar o dispositivo conectado mais recente com a capacidade `calendar`. A situação da fonte informa qual dispositivo respondeu.
- **[R3] Eventos duplicados**, quando a mesma conta Google está no Mac e na Composio: → a resposta marca `duplicate_of` quando o mesmo evento (mesmo iCalUID) aparece nas duas fontes. O agente é instruído a preferir a Composio para escrita. A Agenda já esconde por padrão os calendários do Mac dessas contas.
- **[R4] Latência:** Google até 30 s e Mac pelo conector. → Fontes consultadas em paralelo, com prazo por fonte; a resposta sai com as fontes que terminaram.
- **[R5] Troca limpa quebra prompts ou rotinas que citam `calendar.list_items`:** → buscar e atualizar todas as referências no repositório (prompts, ajuda, testes, docs).

## Plano de migração

- Sem dados a migrar.
- Os agentes passam a ver as ferramentas novas na próxima sessão.
- Para o Mac, o app desktop precisa estar na versão com o módulo `calendar`. Versões antigas não anunciam a capacidade, e a fonte aparece como `unavailable`.
- **Rollback:** reverter o merge.
