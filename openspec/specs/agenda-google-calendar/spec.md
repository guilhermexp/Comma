# agenda-google-calendar Specification

## Purpose
Permitir que a Agenda leia e altere o Google Calendar do próprio usuário pelas contas `googlecalendar` que ele conectou na Composio, por uma ação fechada do backend que não aceita ferramenta, código ou URL vindos do cliente.

## Requirements

### Requirement: Ação fechada google_calendar

O backend MUST aceitar a ação `google_calendar` em `POST /v1/comma/workspaces/:id/composio/:action` com uma `operation` entre `calendars`, `events`, `event`, `create`, `update` e `delete`. Cada operação MUST usar uma ferramenta Composio fixa no servidor. Qualquer outro `operation`, slug, código ou URL vindo do cliente MUST ser recusado com `invalid_composio_request`.

#### Scenario: Operação desconhecida

- **WHEN** o cliente envia `operation: "acl_insert"`
- **THEN** o backend responde `invalid_composio_request` sem chamar a Composio

### Requirement: Conta do próprio usuário

Cada chamada MUST indicar um `account_id`. O backend MUST verificar, antes e depois da chamada à Composio, que é uma conta `googlecalendar` do próprio usuário, ativa e habilitada, no workspace da sessão. Caso contrário, MUST responder `composio_access_denied`.

#### Scenario: Conta de outro membro

- **WHEN** o usuário envia o `account_id` de uma conta de outro membro do workspace
- **THEN** o backend responde `composio_access_denied`

#### Scenario: Conta de outro toolkit

- **WHEN** o `account_id` é de uma conta `googledrive`
- **THEN** o backend responde `composio_access_denied`

### Requirement: Listar calendários

A operação `calendars` MUST devolver os calendários da conta com id, nome, cor, se é o principal, se está selecionado no Google e o nível de acesso. Também MUST indicar se o calendário aceita escrita, o que exige acesso `owner` ou `writer`. Também MUST devolver o e-mail da conta, que é o id do calendário principal.

#### Scenario: Calendário de feriados

- **WHEN** a conta tem o calendário "Feriados no Brasil" com acesso `reader`
- **THEN** ele vem com `writable: false`

### Requirement: Listar eventos de um período

A operação `events` MUST receber `calendar_ids` (até 25), `time_min` e `time_max` (até 62 dias de intervalo) e devolver as ocorrências já expandidas da repetição. Cada ocorrência MUST trazer id, id do calendário, id da série (ou nulo), título, início, fim, se é de dia inteiro, local, descrição, link, cor, se é editável e o `etag`. Eventos cancelados MUST ficar de fora. A resposta MUST ter até 2.500 eventos e 1 MB. Se passar disso, MUST vir marcada como `truncated`.

#### Scenario: Reunião semanal

- **WHEN** a semana pedida contém duas ocorrências de uma reunião semanal
- **THEN** a resposta traz duas ocorrências com o mesmo id de série

#### Scenario: Intervalo grande demais

- **WHEN** o cliente pede 90 dias
- **THEN** o backend responde `invalid_composio_request`

### Requirement: Ler um evento

A operação `event` MUST devolver um evento ou uma série pelo id, no formato da listagem. MUST incluir também a repetição classificada como `none`, `daily`, `weekly`, `monthly`, `yearly` ou `custom`. É qualquer regra com intervalo, contagem, término, dias específicos ou exceções que não seja uma das simples.

#### Scenario: Série semanal simples

- **WHEN** o cliente lê a série de uma reunião `RRULE:FREQ=WEEKLY`
- **THEN** a resposta traz `recurrence: "weekly"`

#### Scenario: Série personalizada

- **WHEN** a série tem `RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR`
- **THEN** a resposta traz `recurrence: "custom"`

### Requirement: Criar evento

A operação `create` MUST criar um evento no calendário indicado. Os campos aceitos são título (até 1.024 caracteres), início e fim (data para dia inteiro, data-hora com fuso nos demais), local, descrição (até 8.192 caracteres) e repetição. A repetição é uma de `none`, `daily`, `weekly`, `monthly` e `yearly`. A operação MUST devolver o evento criado no mesmo formato da listagem.

#### Scenario: Evento com horário

- **WHEN** o cliente cria "Revisão" de 2026-10-22T15:00 a 16:30 em `America/Sao_Paulo`
- **THEN** o Google recebe o evento com esse fuso e a resposta traz o evento criado

#### Scenario: Fim antes do início

- **WHEN** o fim é anterior ou igual ao início
- **THEN** o backend responde `invalid_composio_request`

### Requirement: Alterar evento

A operação `update` MUST alterar só os campos enviados de um evento identificado por calendário e id. Ela MUST permitir trocar para outro calendário da mesma conta. Com `scope: "series"`, MUST alterar a série inteira. Com `scope: "instance"`, MUST alterar só aquela ocorrência. Quando o cliente envia o `etag` e o evento mudou no Google, MUST responder `calendar_event_conflict`.

#### Scenario: Só esta ocorrência

- **WHEN** o cliente move uma ocorrência com `scope: "instance"`
- **THEN** só ela muda, e as outras ocorrências da série continuam iguais

#### Scenario: Conflito

- **WHEN** o evento foi alterado no Google depois que a Agenda o leu
- **THEN** o backend responde `calendar_event_conflict` e não sobrescreve

### Requirement: Apagar evento

A operação `delete` MUST apagar o evento ou, com `scope: "series"`, a série inteira.

#### Scenario: Apagar série

- **WHEN** o cliente apaga com `scope: "series"`
- **THEN** a série deixa de existir no Google

### Requirement: Erros mapeados

Recusas por falta de permissão do Google (401 ou 403) MUST virar `calendar_write_permission_required` nas operações de escrita e `composio_access_denied` nas de leitura. Falha do provedor e prazo esgotado (30 s) MUST virar erros de provedor que o cliente consegue mostrar. Nenhum token, cabeçalho ou corpo bruto do provedor MUST ir para a resposta ou para os logs.

#### Scenario: Escopo só de leitura

- **WHEN** a conta foi autorizada sem escopo de escrita e o cliente tenta `create`
- **THEN** o backend responde `calendar_write_permission_required`
