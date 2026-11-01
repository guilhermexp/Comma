# Design

## Contexto

Ver proposal.md para a motivação. Estado atual que molda a solução:

- O `CallActor` (`systems/apps/salix_voice/lib/salix_voice/call_actor.ex`) é o dono único de cada chamada e não guarda estado durável. A telemetria de voz (`SalixVoice.Telemetry`) só emite três durações agregadas, sem IDs.
- O carrier Electron guarda até 200 eventos ou 512 KiB e os descarta 60 s depois do fim.
- O agente padrão tem dois mecanismos distintos, e esta change reutiliza os dois:
  1. **Trace de sessão**: registros legíveis, servidos por `GET /v1/runtime/agents/:id/sessions/:sid/trace` e pelo dashboard (`/dash/agents/:id/sessions/:sid/trace`). Runtimes externos gravam esses registros em `ExternalSessionRecords`, um `SalixStore.SegmentLog` (JSONL em S3) sob o prefixo do agente.
  2. **Arquivo criptografado de eventos** (`SalixAgent.EventArchive.Emit` → adapter `SalixAnalytics.EventArchive` → tabela ClickHouse `agent_event_archive`): seis fronteiras seladas com age no processo do chamador, buffer ETS limitado, sem leitura em runtime; abertura offline por `mix salix.archive.open`. O stream de cada item segue o dono (`stream_for/1` em `event_archive.ex`): a fronteira `delivery` vai para o stream do agente; as demais, com `session_id`, para o stream da sessão. `Sequence`, `Completeness`, o adapter e `--session` não exigem o prefixo `ses1_`.
- Arquivar o agente (`AgentControl.delete/1`, inclusive o arquivamento permanente) só marca o registro e pausa agendas. Nenhum caminho apaga o prefixo do agente no storage; as sessões do Router ficam guardadas.
- O ACK do Router para voz é `{:ok, :queued}`. A sessão do Router que processa o pedido é lida no consumo (`ConversationSource.binding/2`), não no enfileiramento, então um `/new` entre os dois troca a sessão. As operações `voice.say`, `voice.note` e `voice.hang_up` rodam na rodada do Router que processou o pedido, com contexto de ferramenta que traz `agent_id` e `session_id` (`provider_tool_context/1` em `im_router.ex`).
- `DOMAIN_CONCEPTS.md` afirma que a Voice Call não guarda estado durável e que o contexto push-to-talk não é entidade.

## Objetivos / Não objetivos

**Objetivos:**
- Um trace legível por chamada, gravado pelo `CallActor` e servido por duas rotas de leitura, sem mudar o fluxo da chamada.
- As passagens observáveis no arquivo criptografado, no padrão das fronteiras do agente.
- Cada resposta do Router no trace traz a sessão do Router que a produziu.

**Não objetivos:**
- Tela de trace no app, índice ou listagem de chamadas, busca.
- Telemetria tipada nova no ClickHouse para voz: as durações por etapa saem do próprio trace.
- Observar o tráfego do modelo GPT Live, que roda fora do nó.

## Decisões

### D1. Trace como `SegmentLog` sob o agente Router

O trace é um `SalixStore.SegmentLog` por chamada, sob `agents/<router_agent_id>/voice_calls/<hex(call_id)>/segments/`, com chave construída em `SalixStore.Keys`. O ID de cada registro é um ULID de largura fixa, como em `ExternalSessionRecords`.

- **Por quê:** é o mesmo store e o mesmo formato do trace de sessão externa. Fica sob o prefixo do agente Router, que já recebe as delegações da chamada, e segue a retenção dos dados de sessão dele: fica guardado como as sessões do Router, inclusive depois de arquivar o agente. A change não cria remoção.
- **Escritor único:** o `CallActor`. Cada chamada tem um único `CallActor` e prefixo próprio, e a chamada não é retomada após perda do nó. A exclusividade por Group é eventual sob admissões concorrentes, mas chamadas distintas têm IDs e prefixos distintos, então o invariante de escritor único do `SegmentLog` se mantém.
- **Alternativas descartadas:**
  - Tabela no ClickHouse: dependeria de um serviço que pode estar fora, e não existe leitura em runtime desse store.
  - Postgres: seria um store novo para dados de sessão.
  - Um único log por Group: quebraria o escritor único.

### D2. Resumo da chamada

O primeiro registro (`call_started`) guarda a identidade da chamada:

- modo, carrier e transporte;
- tenant, Group, agente Router;
- tipo e valor do chamador;
- hora de início.

O último registro (`call_ended`) guarda motivo, duração e uso do modelo. A leitura monta o resumo a partir desses registros e indica `ended: false` quando o último ainda não chegou. Não há objeto de resumo separado nem manifesto.

### D3. Registros

Cada registro tem: `id` (ULID), `at` (hora UTC), `t_ms` (monotônico desde o início da chamada), `type` e campos do tipo. Os tipos são:

- `call_started`, `model_started` e `attached`;
- `caller_turn`: fala final do chamador, com turno e offset;
- `agent_turn`: fala final do agente;
- `ptt_context`: `pending`, `complete` com texto e anexos `{name, path, mime, bytes}`, ou `failed`/`cancelled` com motivo;
- `delegation_requested`: ID, pedido, contexto vinculado e turno nativo;
- `delegation_sent`: ID da mensagem de origem, número de anexos, tamanho do texto enviado;
- `delegation_acked`: status do ACK (`queued` ou erro) e ID da mensagem de origem;
- `router_reply`: operação `say`, `note` ou `hang_up`, com o texto, o ID da delegação quando houver, e o agente e a sessão do Router que a chamaram;
- `progress`: 20 s ou 90 s;
- `delegation_finished`: resultado e duração;
- `error`: código e classe do erro, nunca a mensagem bruta;
- `trace_truncated`;
- `call_ended`.

Legendas parciais não entram. Os bytes da imagem nunca entram: só nome, caminho, tipo e tamanho. Cada registro vem de um ponto já existente do `CallActor`, sem novo estado de controle.

### D4. Escrita assíncrona e limitada

O `CallActor` acumula registros no próprio estado e grava em lote por uma única tarefa em voo, a cada 2 s ou quando o lote chega a 50 registros. A falha detectada de um lote faz uma nova tentativa no próximo ciclo; na segunda falha, descarta o lote e emite `[:salix, :voice, :trace, :dropped]` com o rótulo finito `reason`.

- **Limites por chamada:** 2.000 registros ou 4 MiB. Depois disso, um único `trace_truncated` e nenhum registro novo.
- **Fim da chamada:** a última gravação roda depois do handoff, dentro do orçamento de encerramento já existente, sem aumentá-lo. O que não couber é descartado e contado.
- **Queda do processo ou do nó:** os registros ainda em memória e o lote em voo se perdem sem contagem, porque não sobra processo para contar, como no buffer ETS do arquivo de eventos. A perda só aparece como ausência de `call_ended`.
- **Por quê:** mesmo contrato de perda e isolamento do arquivo de eventos. A gravação nunca bloqueia a mailbox da chamada nem muda prazos.
- **Alternativa descartada:** gravar síncrono a cada evento, que traria latência de S3 para dentro da chamada.

### D5. Leitura

**Rota do chamador:** `GET /v1/comma/workspaces/:workspace_id/voice/calls/:call_id/trace` em `comma_web`. Segue o caminho de `with_voice_call`: usuário com sessão completa e Workspace autorizado, com escopo resolvido para `{tenant, group}` e agente Router do Group. A leitura aceita o trace só se o registro `call_started` tiver o mesmo tenant e Group e o chamador for esse usuário Comma. Qualquer divergência, ID inválido ou trace ausente responde 404 `call_not_found`.

**Rota do admin:** `GET /dash/agents/:agent_id/voice_calls/:call_id/trace`, no mesmo controller e com a mesma autenticação de admin do trace de sessão.

**Resposta das duas rotas:**
- `call_id`, `mode`, `carrier`, `router_agent_id`, `started_at`, `ended`, `end_reason`, `duration_ms`;
- `event_count`, `has_more`, `next_before`, `events`.

`limit` tem padrão 100 e máximo 500; `before` é o cursor. A resposta usa `no-store`. Chamadas Twilio e WebSocket não têm usuário Comma e só ficam legíveis pelo admin.

### D6. Sessão do Router pela resposta

A ligação com o trace do Router vem de quem processou o pedido, não do ACK. `SalixIM.Provider.Voice` acrescenta ao pedido enviado ao `CallActor` o `agent_id` e o `session_id` do contexto de ferramenta da rodada do Router; o `CallActor` grava esses valores em `router_reply`. O ACK continua `{:ok, :queued}`, sem mudança de contrato nem de chamadores.

- **Por quê:** a sessão do Router é relida no consumo, então qualquer valor calculado no enfileiramento pode apontar para outra sessão depois de um `/new`. A rodada que chama `voice.say`/`voice.note`/`voice.hang_up` é a que processou o pedido.
- **Limite:** delegação que termina sem nenhuma operação de voz do Router não tem sessão atribuída no trace; o registro mostra a delegação e o ID da mensagem de origem.
- **Alternativa descartada:** devolver a sessão no ACK, que registraria a sessão do enfileiramento, não a do processamento.

### D7. Arquivo criptografado com as fronteiras existentes

O `CallActor` grava pelo `Emit`, com identidade explícita:
- `tenant_id`: o tenant da chamada;
- `agent_id`: o Router;
- `session_id`: o ID da chamada.

A gravação reutiliza as fronteiras já aceitas pelo adapter:

| Fronteira existente | Passagem da chamada |
|---|---|
| `delivery` | entrada: fala final e contexto de tela |
| `tool_call` | pedido ao Router |
| `tool_result` | resposta do Router |
| `egress` | saída falada final |

Não há fronteira nova. `llm_request`/`llm_response` ficam ausentes e são documentados como não observáveis, como nos runtimes externos.

- **Streams:** a roteação existente de `stream_for/1` não muda. Os itens `delivery` (entrada do chamador) entram no stream do agente Router, ao lado das entregas do próprio Router; `tool_call`, `tool_result` e `egress` entram no stream `session:<vc_…>:loop`. Cada item consome `seq` no seu stream; `reserve/1` é usado onde o processo pode morrer antes de emitir.
- **Completude e ordem:** `Completeness` do stream da chamada cobre só `tool_call`, `tool_result` e `egress`; a entrada do chamador fica coberta pelo stream do agente. Não há sequência única da chamada: a ordem entre entrada e as demais passagens vem de `ts` e do trace legível.
- **Leitura:** `mix salix.archive.open --session vc_…` traz todas as linhas com esse `session_id`, ordenadas por `stream, writer, seq`, então a entrada do chamador vem agrupada à parte.
- **Por quê:** "não inventar moda". É a mesma API, o mesmo selo e a mesma tabela do agente.

### D8. ID da chamada no app

O controlador push-to-talk e a chamada manual do Electron registram no log do Main (`electron-log`) a linha `voice call opened call_id=<id>`. É só identificador, sem conteúdo.

### D9. Domínio e documentação

- **`DOMAIN_CONCEPTS.md`, Voice Call:** troca "não guarda estado durável" por "deixa um Voice Call Trace: log de registros sob o agente Router, de escritor único, sem ciclo de vida próprio, guardado como as sessões do Router". Não é Session, Conversation nem Message.
- **`docs/messaging-voice.md`:** a rota de leitura e os limites.
- **`docs/observability.md`:** a voz nas fronteiras do arquivo.

O orçamento de documentação (20 KB por arquivo) é respeitado.

### D10. ClickHouse no dev (orquestrador)

O launcher nativo (`~/.comma-dev/runtime/.local/native/run.py`, fora do repositório) ganha o serviço ClickHouse instalado pelo Homebrew, em porta local. O `config.json` local ganha a URL e um destinatário age gerado localmente; a identidade privada fica em `~/.comma-dev/archive-identity.txt` para leitura offline. As migrações seguem o caminho canônico que o `compose.yaml` usa no serviço `migrate`.

Não é código do produto: fica com o orquestrador, depois da entrega do worker.

### D11. Identidade do Router antes da primeira emissão

Aprovado pelo dono em 2026-10-30: a admissão reutiliza o Group/Router da leitura que já faz para autorizar metering. Quando essa identidade não estiver disponível, faz uma consulta adicional com prazo finito antes de iniciar as emissões. Isso pode acrescentar latência à admissão apenas nesse caso; a escrita do trace continua assíncrona e os prazos de execução e encerramento da chamada não mudam.

O Router deve pertencer ao tenant e ao Group da chamada. A identidade acompanha a chamada desde `call_started`, a reserva de sequência e o selo; não se guarda plaintext esperando resolução nem se inventa um agente. Falha ou timeout dessa consulta adicional desabilita a observação sem falhar a chamada e gera sinal agregado de rótulo finito. As falhas de autorização ou billing preexistentes continuam com o mesmo efeito.

- **Verificação:** admissão com metering não repete a consulta; admissão sem identidade resolve antes da primeira passagem, inclusive em outros carriers; consulta lenta respeita o prazo; falha não muda o resultado da chamada nem emite dados com identidade errada.


## Riscos / Trade-offs

- [Conteúdo da conversa passa a ser durável] → Mesma proteção do transcript de sessão do Router, nunca em log ou métrica. A spec exige leitura só pelo chamador ou admin.
- [Retenção sem TTL e sem remoção, como as sessões] → Arquivar o agente não apaga o trace, como já não apaga as sessões do Router. Remoção ou retenção própria ficam para uma change futura, se o dono pedir.
- [Lote final perdido em queda do nó] → Perda sem contagem, visível só pela falta de `call_ended`; o trace não afirma completude.
- [Sessão do Router muda no meio da chamada] → Cada resposta grava a sessão que a produziu (D6); delegação sem resposta fica sem sessão.
- [Entrada do chamador fora do stream da chamada] → Documentado em D7; a ordem da chamada vem do trace legível.
- [Carga extra no S3 por chamada] → Lotes a cada 2 s ou 50 registros, limite de 4 MiB, uma tarefa em voo.
- [Router ausente na admissão sem metering] → Uma leitura adicional com prazo finito é autorizada (D11); pode aumentar a latência inicial. Falha impede só a observação, nunca a chamada.

## Plano de migração

Sem migração de dados: as chamadas anteriores não têm trace. Deploy único do backend; o Electron só ganha uma linha de log. Reverter o deploy desliga a gravação. Traces já gravados permanecem sob o agente, como as sessões do Router.
