# Proposta

## Por quê

O agente só enxerga o calendário interno do Comma, pelas ferramentas `calendar.*`. O Google Calendar que o dono conectou só chega ao agente se a conta for liberada para ele na Composio. O Calendário do Mac não chega de jeito nenhum, porque mora dentro do app desktop. O dono quer uma ferramenta nativa com que o agente acesse tudo: o calendário interno sempre e, quando estiverem conectados, o Google e o Calendário do Mac, sem configuração extra.

## O que muda

- A família de ferramentas `calendar.*` do agente passa a cobrir três fontes juntas:
  - o calendário interno do Comma;
  - todas as contas Google Calendar conectadas pelo dono;
  - o Calendário do Mac, quando o app desktop está aberto e tem acesso ao Calendário.
- As ferramentas novas são:
  - `calendar.calendars`: lista os calendários das três fontes, com a situação de cada fonte;
  - `calendar.events`: lista os eventos de um período, juntos, com a origem de cada um;
  - `calendar.event`: lê um evento;
  - `calendar.create`, `calendar.update` e `calendar.delete`: escrevem no calendário de origem.
- **BREAKING:** `calendar.list_items`, `calendar.get_item` e `calendar.create_event` são substituídas pelas ferramentas novas. `calendar.update_context` e `calendar.issue_feed_link` continuam.
- **Leitura:** o agente lê em qualquer execução dos agentes do dono, inclusive em rotinas e tarefas agendadas.
- **Escrita:** criar, alterar e apagar só acontecem quando o dono pediu na conversa (remetente humano, a própria mensagem, sem agendamento). Rotinas e conteúdo de eventos não conseguem disparar escrita.
- **Google:** o acesso ao Google não depende de liberar a conta para o agente na Composio. Vale qualquer conta `googlecalendar` ativa do dono no workspace, com a mesma verificação de dono que a Agenda já faz.
- **Mac:** o acesso ao Calendário do Mac passa pelo conector que o app desktop já mantém com o backend. O agente nunca dispara o pedido de permissão do macOS. Com o app fechado ou sem acesso, a fonte aparece como indisponível, com o motivo, e as outras continuam.
- **Privacidade:** o conteúdo dos eventos é tratado como dado não confiável e privado do dono. Ele não pode ser enviado a uma audiência de grupo nem a terceiros.

Fora do escopo:
- mostrar o calendário interno na tela Agenda;
- convidados e respostas a convites;
- alertas e lembretes;
- criação de videoconferência;
- calendários iCloud fora do Mac;
- acesso de agentes de outros usuários.

## Capacidades

### Novas capacidades

- `agent-calendar-access`: ferramentas nativas do agente para ler e escrever nos calendários do dono (interno, Google e Mac), com regra de leitura e escrita, indisponibilidade por fonte, limites e privacidade.

### Capacidades modificadas

- `agenda-mac-calendar`: o requisito "Dados locais" passa a permitir que os eventos do Mac sejam enviados ao backend para as ferramentas do agente do dono, mantendo a proibição em logs e telemetria.

## Impacto

- **`systems/apps/salix_agent`:**
  - `tools/calendar.ex` e `tools/schemas.ex` com as ferramentas novas;
  - porta nova para as fontes externas;
  - regra de identidade do dono, classificação IFC e remoção das ferramentas antigas.
- **`systems/apps/salix_calendar`:** adaptação do `AgentAPI` ao formato unificado.
- **`systems/apps/comma_web`:** implementação da porta. O Google reaproveita as operações de `GoogleCalendarAgenda` com autorização de dono sem liberação por agente; o Mac usa `EnvDispatch`.
- **`systems/apps/salix_env` e `systems/connector/salix-connect`:** método `calendar` no conector e capacidade `calendar` anunciada pelo dispositivo.
- **`clients/apps/electron`:** módulo `calendar` na API de client-control, sobre o `CalendarService` (EventKit) existente.
- **Documentação:** `DOMAIN_CONCEPTS.md` e a ajuda das ferramentas.
