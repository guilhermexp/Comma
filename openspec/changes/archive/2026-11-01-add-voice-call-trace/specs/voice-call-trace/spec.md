# Spec Delta

## Purpose

Registrar cada chamada de voz como um trace durável e legível, consultável pelo chamador e pelo admin, ligado ao trace do Router e às passagens do arquivo criptografado de eventos, para diagnosticar o que a chamada ouviu, delegou, recebeu e quanto cada etapa levou.

## ADDED Requirements

### Requirement: Trace por chamada

Toda chamada de voz, manual ou push-to-talk, MUST gravar um trace próprio, identificado pelo ID da chamada, com registros em ordem. Cada registro MUST trazer a hora, o tempo desde o início da chamada e o tipo do evento. Entram: início, conexão do modelo, falas finais do chamador e do agente, contexto de tela, pedido e ACK de cada delegação, respostas do Router, progresso, resultado, erros e fim. Legendas parciais MUST NOT ser gravadas.

#### Scenario: Push-to-talk com print

- **WHEN** o usuário segura o atalho, fala um pedido sobre a tela, solta e o agente responde
- **THEN** o trace dessa chamada mostra, em ordem e com tempos, o contexto de tela completo com os nomes dos anexos, a fala transcrita, o pedido delegado com os anexos, o ACK do Router, a resposta do Router e a fala do agente

#### Scenario: Falha de contexto

- **WHEN** o contexto de tela de um gesto falha ou expira
- **THEN** o trace registra a falha com o ID do contexto, o motivo e a delegação que ela encerrou

#### Scenario: Chamada manual

- **WHEN** o usuário faz uma chamada pelo Call Comma
- **THEN** o trace dessa chamada é gravado com os mesmos tipos de evento, sem contexto de tela

### Requirement: Conteúdo dos registros

O pedido de delegação MUST trazer o texto enviado ao Router e os anexos; o contexto de tela, status, texto e anexos; o resultado da delegação, a duração; o erro, o código; o fim, motivo, duração e uso. Os bytes das imagens MUST NOT entrar no trace; somente nome, caminho, tipo e tamanho.

#### Scenario: Anexo do print

- **WHEN** um gesto envia o print e o recorte
- **THEN** os registros de contexto e de delegação listam os dois arquivos com nome, caminho, tipo e tamanho, sem os bytes

### Requirement: Ligação com o trace do Router

Cada resposta do Router à chamada (`say`, `note` ou `hang_up`) MUST registrar no trace o agente Router e a sessão do Router que a produziram, tirados da rodada do Router que processou o pedido, de modo que o trace dessa sessão possa ser aberto a partir dele. O ACK do enfileiramento MUST NOT ser usado como atribuição de sessão. Delegação sem resposta do Router MAY ficar sem sessão atribuída.

#### Scenario: Resposta do Router

- **WHEN** o Router responde a uma delegação da chamada com `voice.say`
- **THEN** o registro da resposta traz o ID do agente Router, o ID da sessão que processou o pedido e o ID da delegação

#### Scenario: Sessão trocada entre enfileiramento e processamento

- **WHEN** a sessão do Router muda depois do ACK de uma delegação e antes de o Router processá-la
- **THEN** a resposta registra a sessão nova, que processou o pedido, e não a vigente no ACK

### Requirement: Leitura pelo chamador

O trace MUST poder ser lido por `GET /v1/comma/workspaces/:workspace_id/voice/calls/:call_id/trace`, inclusive depois do fim da chamada. Só o usuário Comma que fez a chamada, com sessão completa no Workspace da chamada, MUST poder lê-lo; qualquer outro pedido MUST responder como chamada inexistente, sem revelar que ela existe. A resposta MUST NOT ser guardada em cache.

#### Scenario: Paginação

- **WHEN** o usuário pede o trace sem `limit` e depois com o cursor devolvido
- **THEN** recebe o resumo da chamada e até 100 registros por página, com `limit` máximo 500, e a página anterior pelo cursor

#### Scenario: Leitura após o fim

- **WHEN** o usuário pede o trace de uma chamada sua que terminou há uma hora
- **THEN** recebe o resumo e os registros mais recentes, com indicação de que há mais

#### Scenario: Outro usuário

- **WHEN** outro membro do mesmo Workspace pede o trace dessa chamada
- **THEN** a resposta é 404, igual à de uma chamada inexistente

### Requirement: Leitura pelo admin

O dashboard do Salix MUST oferecer o mesmo trace em JSON para o admin autenticado, localizado pelo agente Router e pelo ID da chamada, como já oferece o trace de sessão do agente.

#### Scenario: Admin abre o trace

- **WHEN** o admin logado no dashboard pede o trace de uma chamada do Router de um Group
- **THEN** recebe o mesmo resumo e registros que o chamador receberia

### Requirement: Identidade inicial do Router

A admissão MUST reutilizar a identidade confiável do Router já lida. Quando faltar, MAY aguardar uma consulta adicional com prazo finito antes da primeira emissão. Falha dessa consulta MUST NOT falhar a chamada. O Router MUST pertencer ao tenant e Group da chamada; plaintext MUST NOT esperar resolução de identidade em buffer de arquivo.

#### Scenario: Identidade já disponível

- **WHEN** a admissão já leu o Router ao autorizar metering
- **THEN** reutiliza essa identidade sem repetir a consulta

#### Scenario: Identidade ainda ausente

- **WHEN** a admissão não tem o Router e a consulta adicional termina dentro do prazo
- **THEN** as passagens desde o início recebem a identidade correta, sem descarte inicial por resolução assíncrona

#### Scenario: Consulta adicional falha ou expira

- **WHEN** a consulta adicional de identidade falha ou excede seu prazo
- **THEN** a observação fica indisponível, a falha é contada sem conteúdo e a chamada continua conforme suas regras anteriores

### Requirement: Isolamento de falhas e limites

Após a resolução inicial de identidade, gravar o trace MUST NOT bloquear, atrasar ou mudar a chamada, seus prazos, handoff ou respostas do Router. Falha detectada MUST descartar só os registros afetados e contar o descarte em métrica de rótulos finitos. Cada chamada MUST ter limites de registros e bytes; ao atingi-los, MUST gravar um único marcador de truncamento e parar de crescer. O trace MUST NOT afirmar completude.

#### Scenario: Storage indisponível

- **WHEN** o storage recusa a gravação durante a chamada
- **THEN** a chamada segue normalmente, os registros não gravados são descartados e a métrica de descarte aumenta

#### Scenario: Queda do nó

- **WHEN** o nó cai com registros ainda não gravados
- **THEN** esses registros se perdem sem contagem e o trace fica sem `call_ended`, sem afirmar que está completo

#### Scenario: Chamada longa

- **WHEN** uma chamada ultrapassa o limite de registros do trace
- **THEN** o trace termina com um marcador de truncamento e a chamada continua

### Requirement: Arquivo criptografado de eventos

As passagens observáveis de cada chamada MUST entrar no arquivo criptografado de eventos existente, seladas no processo da chamada antes de qualquer buffer: entrada do chamador (fala final e contexto de tela), pedido ao Router, resposta do Router e saída falada, com o tenant, o agente Router e o ID da chamada como identidade e a roteação de streams existente. Arquivo desligado ou indisponível MUST NOT afetar a chamada nem o trace.

#### Scenario: Modelo de voz

- **WHEN** um operador consulta as passagens de uma chamada
- **THEN** a conversa interna do modelo de voz aparece declarada como não observável, sem registro inventado

#### Scenario: Abertura offline

- **WHEN** um operador com a chave abre o arquivo pelo ID de uma chamada
- **THEN** obtém todas as passagens da chamada com a mesma identidade de tenant e agente, cada uma em ordem dentro do seu stream, com a entrada do chamador agrupada no stream do agente Router

#### Scenario: Arquivo desligado

- **WHEN** o arquivo não tem destinatário configurado ou o ClickHouse está fora
- **THEN** a chamada e o trace legível funcionam normalmente

### Requirement: Privacidade e retenção

O trace MUST ter a mesma proteção e retenção dos dados de sessão do agente Router do Group: fica guardado como as sessões do Router, inclusive depois de arquivar o agente, e esta capacidade não cria remoção própria. Conteúdo do trace MUST NOT aparecer em logs, métricas ou atributos de span. IDs de chamada, tenant, usuário ou sessão MUST NOT ser rótulos de métrica.

#### Scenario: Arquivamento do agente Router

- **WHEN** o agente Router do Group é arquivado pelo ciclo de vida existente
- **THEN** os traces das chamadas desse Group continuam guardados, como as sessões do Router, e o admin ainda os lê pelo dashboard

### Requirement: ID da chamada no app

O app desktop MUST registrar no log do app o ID de cada chamada de voz que abre, sem conteúdo da conversa, para localizar o trace a partir de um teste.

#### Scenario: Teste do push-to-talk

- **WHEN** o usuário segura o atalho e a sessão de voz abre
- **THEN** o log do app mostra o ID da chamada
