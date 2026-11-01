# Proposta

## Por quê

Uma chamada de voz (Call Comma ou push-to-talk) hoje não deixa registro consultável: os eventos ficam na memória do carrier e somem 60 s depois do fim, e a telemetria só agrega durações sem identificar a chamada. Para diagnosticar o push-to-talk foi preciso instrumentar backend e Electron à mão. O agente padrão já tem trace por sessão e arquivo criptografado de eventos; a voz precisa do mesmo padrão para mostrar o que o modelo ouviu, o que delegou, o que o Router respondeu, quanto cada etapa levou e onde falhou.

## O que muda

- **Trace por chamada**, no mesmo padrão do trace de sessão do agente: cada chamada de voz grava uma sequência ordenada de registros legíveis com hora e tempo desde o início. Entram início e fim da chamada, conexão do modelo, falas finais do usuário e do agente, contexto de tela do push-to-talk (texto e anexos, sem os bytes da imagem), pedidos delegados ao Router com o que foi enviado e o ACK, respostas do Router (`voice.say`, `note`, `hang_up`) com a sessão do Router que as produziu, avisos de progresso, erros e o resultado de cada delegação.
- **Leitura do trace**: `GET /v1/comma/workspaces/:workspace_id/voice/calls/:call_id/trace`, só para o usuário Comma que fez a chamada, paginado como o trace de sessão; e a mesma resposta em JSON no dashboard do Salix para o admin, ao lado do trace de sessão do agente.
- **Ligação com o Router**: cada resposta do Router registra o agente e a sessão que a produziram, tirados da rodada que processou o pedido, para abrir o trace dessa sessão.
- **Arquivo criptografado de eventos** também para a voz, como o agente: as passagens observáveis da chamada (entrada do usuário, pedido ao Router, resposta do Router e saída falada) entram no arquivo existente, selado no processo da chamada, com a roteação de streams atual. A conversa interna do GPT Live roda fora do nó e não é observável, como nos runtimes externos.
- **Identificação no app**: o Electron registra no log do app o ID de cada chamada, para chegar ao trace a partir de um teste.
- **Ambiente de dev**: o ClickHouse passa a subir no launcher nativo do orquestrador, para que o arquivo criptografado e a telemetria do agente funcionem localmente.

Fora do escopo: tela de trace no app Comma; listar chamadas antigas; observar o raciocínio interno do GPT Live; mudar a execução ou as respostas das chamadas. Exceção aprovada na admissão: quando faltar identidade do Router, uma consulta adicional com prazo finito pode acrescentar latência inicial, mas sua falha não impede a chamada.

## Capacidades

### Novas capacidades

- `voice-call-trace`: registro durável e legível de cada chamada de voz, sua leitura com escopo do chamador e do admin, a ligação com o trace do Router e a entrada das passagens da chamada no arquivo criptografado de eventos.

### Capacidades modificadas

Nenhuma nas specs publicadas. A change `add-push-to-talk-agent` em andamento não muda de requisito.

## Impacto

- **Backend** (`systems/apps/salix_voice`): o CallActor grava o trace e emite as passagens ao arquivo; consulta inicial limitada do Router quando não houver identidade (D11), sem mudar a execução, os prazos ou as garantias de handoff.
- **Storage** (`systems/apps/salix_store`): novo prefixo de log de segmentos sob o agente Router do Group, guardado como as sessões do Router; arquivar o agente não apaga.
- **Arquivo de eventos** (`systems/apps/salix_agent`, `systems/apps/salix_analytics`): emissores de voz que reutilizam as fronteiras e a roteação de streams existentes; leitura offline com `mix salix.archive.open` por ID de chamada.
- **Router** (`systems/apps/salix_im`): o provider de voz passa ao `CallActor` a sessão da rodada do Router que responde; o ACK do enfileiramento não muda.
- **APIs**: rota nova em `comma_web` e rota JSON nova no dashboard do Salix.
- **Electron** (`clients/apps/electron`): o ID da chamada no log do app.
- **Domínio e docs**: a chamada deixa de "não guardar estado durável"; o trace entra no inventário de conceitos e em `docs/messaging-voice.md` e `docs/observability.md`.
- **Privacidade**: o trace contém conteúdo da conversa (falas, pedidos, texto do contexto de tela) com a mesma proteção e retenção do transcript de sessão do Router, inclusive depois de arquivar o agente; nunca em log ou métrica.
- **Ambiente local**: ClickHouse no launcher nativo (`~/.comma-dev/runtime/.local/native/run.py`, fora do repositório), a cargo do orquestrador.
