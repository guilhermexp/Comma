# Tarefas

## 1. Ferramentas do agente (salix_agent + salix_calendar)

- [x] 1.1 Porta `SalixAgent.CalendarSources` (C3) com implementação nula e falsa para testes. As ferramentas `calendar.calendars`, `calendar.events` e `calendar.event` (D1) reúnem o interno (via `SalixCalendar.AgentAPI`) com Google e Mac pela porta, em paralelo e com prazo por fonte, devolvendo a situação por fonte. Começar por testes que falham:
  - três fontes juntas;
  - fonte indisponível sem derrubar as outras;
  - período acima de 62 dias recusado;
  - corte em 2.500 eventos;
  - descrição cortada;
  - `duplicate_of` por iCalUID.

  Verificar com `mix test` dos testes novos em `salix_agent`.
- [x] 1.2 Escrita `calendar.create`, `calendar.update` e `calendar.delete` (D1/D2), com a regra `sealed_person` do dono e `creation_request_id`. Começar por testes que falham:
  - pedido do dono escreve;
  - rotina e agendamento recusados;
  - remetente Slack/Feishu recusado;
  - calendário só de leitura recusado;
  - `scope` de série.
- [x] 1.3 Remover `calendar.list_items`, `calendar.get_item` e `calendar.create_event`, e migrar todas as referências (ajuda, prompts, schemas, testes, `DOMAIN_CONCEPTS.md`). `calendar.update_context` passa a aceitar o `event_ref` interno. Verificar: `grep` sem ocorrências das ferramentas antigas e `mix test apps/salix_agent/test/tool_policy_extras_test.exs`.
- [x] 1.4 IFC (D5): classificar as ferramentas que devolvem conteúdo como dado privado do dono em `ifc/destination.ex` e aplicar `@untrusted_content`. Começar por teste que falha: um resultado de `calendar.events` não pode ser enviado a uma audiência de grupo.

## 2. Google pela porta (comma_web)

- [x] 2.1 Extrair de `GoogleCalendarAgenda` as funções compartilhadas de autorização de conta e de execução, sem mudar o comportamento da Agenda. Verificar com `mix test apps/comma_web/test/google_calendar_agenda_test.exs` sem mudanças nos testes.
- [x] 2.2 Implementar `owner/1`, `google_accounts/1` e `google/4` em `comma_web`, configurados em `CommaWeb.Application` (D3), sem `Access.authorize/5`. Começar por testes que falham:
  - conta ativa sem liberação lida;
  - conta desativada ignorada;
  - conta de outro usuário recusada;
  - verificação repetida depois da chamada;
  - erros públicos mapeados.

## 3. Mac pelo conector

- [x] 3.1 Electron: módulo `calendar` no `createCommaClientControlRegistry` (C2) sobre o `CalendarService`, sem `requestAccess`. Testes em `client-control-api.test.ts`:
  - cada API;
  - entrada inválida recusada;
  - sem acesso devolve `calendar_access_denied`;
  - logs sem texto de evento.
- [x] 3.2 Conector Go: método `calendar` (C1) despachado antes da checagem de escopo, POST ao client-control sem redirecionamento, e capacidade `calendar` nos metadados. Testes no padrão de `device_access_test.go`, com `httptest`; verificar com `go test ./...` em `systems/connector/salix-connect`.
- [x] 3.3 Backend: `calendar` em `@capability_fields` do `Control`, escolha do dispositivo do dono com a capacidade, e `mac/3` da porta via `SalixWeb.ConnectorRecovery.request` com o mapeamento de erros (D4). Testes com `Dispatch` falso: offline, sem acesso, sucesso, mais de um dispositivo.

## 4. Integração

- [ ] 4.1 Prova real com o backend local e o app desktop de dev, com a conta Google conectada e o Calendário do Mac liberado:
  - uma conversa pede "o que tenho esta semana" e o agente responde com eventos das três fontes;
  - o dono pede para criar um evento no Google e outro no Mac, e ambos aparecem na Agenda;
  - uma rotina agendada lê, mas a tentativa de escrita é recusada;
  - com o app fechado, a fonte Mac aparece como indisponível.

  Registrar a conversa e capturas.
- [ ] 4.2 Busca nos logs do backend, do conector e do app durante 4.1 pelos títulos usados: nada encontrado.
- [ ] 4.3 Documentação: `DOMAIN_CONCEPTS.md` (Agenda/agente), a ajuda das ferramentas e o RELEASE.md, se mudar algo para o usuário do app. Verificar com `pnpm docs:check`.

## Acompanhamento do fluxo

- Revisão de segurança com `/requesting-code-review`: autorização sem liberação, escrita por agente, dados do Mac indo ao backend.
- Publicar a release seguinte depois do aceite.
- Arquivar com `/openspec-archive-change`, rodar `/sync` e `/cleanup`.
