# agent-push-to-talk Specification

## Purpose
Permitir turnos de fala ao agente pelo atalho global em qualquer app do Mac, sem abrir janela nem parecer uma ligação. O GPT Live continua como transporte/modelo de voz e delega ao Router o trabalho do agente, com contexto da tela, sessão de réplica, companheiro, notch, permissões e ajustes.

## Requirements

### Requirement: Ativação e disponibilidade

A função "Falar com o agente" MUST existir só no app desktop para macOS e MUST vir desligada por padrão. Ela MUST exigir a sidebar ligada; com a sidebar desligada, os Ajustes MUST mostrar a opção indisponível com o motivo. Com a função ligada, o atalho MUST funcionar em qualquer app, inclusive com a janela principal do Comma fechada, enquanto o processo do Comma estiver rodando e houver sessão aberta.

#### Scenario: Padrão desligado

- **WHEN** o usuário instala o app e não mexe nos Ajustes
- **THEN** segurar `⌃⌥` não abre chamada, não capta áudio nem mostra nada na tela

#### Scenario: Janela principal fechada

- **WHEN** a função está ligada, a janela principal está fechada e o usuário segura o atalho em outro app
- **THEN** a sessão começa oculta, sem cartão/evento de chamada na conversa; notch e companheiro mostram "Ouvindo" desde o aperto, nunca "Conectando", após a barreira de captura da tela

#### Scenario: Sidebar desligada

- **WHEN** a sidebar está desligada nos Ajustes
- **THEN** a opção "Falar com o agente" aparece indisponível com a explicação de que depende da sidebar, e o atalho não fica registrado

### Requirement: Atalho de segurar para falar

O atalho MUST aceitar só modificadores (ao menos dois) ou tecla com modificador; padrão `⌃⌥`. MUST ser distinto dos atalhos da sidebar e de abrir Comma; Ajustes MUST recusar conflitos, inclusive ao religar. Apertar MUST iniciar/reutilizar a sessão, silenciar a reprodução remota e captar localmente. Soltar qualquer tecla da combinação MUST mutar o microfone e restaurar a reprodução imediatamente, sem esperar legenda.

#### Scenario: Atalho padrão

- **WHEN** o usuário segura `⌃⌥` por 4 segundos falando e solta
- **THEN** a fala é captada desde o aperto; o início anterior à conexão é enviado depois dela, com contexto admitido e gesto confirmado; soltar muta o microfone e restaura a reprodução sem esperar o print, e o serviço decide o fim do turno

#### Scenario: Gravar só modificadores nos Ajustes

- **WHEN** o usuário clica para gravar o atalho, segura `⌃⌥` e solta sem apertar outra tecla
- **THEN** os Ajustes salvam `⌃⌥` como atalho

#### Scenario: Conflito com a sidebar

- **WHEN** o usuário tenta usar como atalho de falar o mesmo atalho da sidebar
- **THEN** os Ajustes recusam e mostram com qual atalho conflita

### Requirement: Atalho só de modificadores não rouba outros atalhos

Com um atalho só de modificadores, o app MUST apenas observar o teclado, sem impedir que as teclas cheguem aos outros apps. Se qualquer outra tecla for apertada durante a combinação, o app MUST cancelar a captação e descartar seu contexto/print. Um gesto MUST começar só com exatamente os modificadores configurados. Cancelar MUST mutar imediatamente e encerrar uma sessão aberta por esse gesto se ela ainda não teve turno; não há garantia de recolher áudio já transmitido.

#### Scenario: Outro atalho com os mesmos modificadores

- **WHEN** o usuário aperta `⌃⌥←` em outro app
- **THEN** o outro app recebe `⌃⌥←`, o microfone é mutado, o contexto/print é descartado e o que tiver aparecido some

#### Scenario: Cancelamento de uma réplica com admissão em voo

- **WHEN** uma chamada quente já respondeu e o usuário cancela ou solta um gesto curto antes do ACK de admissão desse novo contexto
- **THEN** a entrada é mutada, o contexto é invalidado e a apresentação some, sem encerrar a chamada quente
- **AND** a rejeição técnica da admissão cancelada não publica um novo erro de envio nem afeta a réplica seguinte

#### Scenario: Modificador a mais

- **WHEN** o usuário segura `⌃⌥⇧`
- **THEN** nenhum turno começa

### Requirement: Permissão de Monitoramento de Entrada

Um atalho só de modificadores MUST depender da permissão de Monitoramento de Entrada concedida ao Comma; um atalho com tecla comum MUST NOT pedir essa permissão nem a de Acessibilidade. Sem a permissão, os Ajustes MUST mostrar que o atalho não está ativo, com um botão para abrir os Ajustes do Sistema, e o atalho MUST passar a funcionar depois de concedida, sem reiniciar o Comma.

#### Scenario: Permissão ausente

- **WHEN** o atalho é `⌃⌥` e o Comma não tem Monitoramento de Entrada
- **THEN** os Ajustes mostram que o atalho está inativo por falta da permissão, com o botão para os Ajustes do Sistema

#### Scenario: Permissão concedida depois

- **WHEN** o usuário concede a permissão nos Ajustes do Sistema
- **THEN** segurar `⌃⌥` passa a iniciar um turno sem reiniciar o Comma

#### Scenario: Tecla comum

- **WHEN** o atalho escolhido é `⌃⌥Espaço`
- **THEN** o atalho funciona sem pedir Monitoramento de Entrada

### Requirement: Captação durante o gesto

O microfone real da janela oculta MUST captar desde o aperto e mutar na soltura. O buffer local MUST preservar a fala anterior à conexão/ACK; o envio MUST aguardar ambos e gesto ≥0,3 s, em ordem antes da fala ao vivo. Gesto menor MUST descartar tudo sem envio. Captação/buffer MUST ter limite de 120 s. Soltura MUST NOT esperar captura/upload/ACK; ACK tardio MUST NOT reabrir captação. Admissão e captura MUST ocorrer em paralelo.

#### Scenario: Toque acidental

- **WHEN** o usuário aperta e solta o atalho em 0,2 s e a sessão nova ainda não teve turno
- **THEN** o microfone é mutado, todo o buffer é descartado sem enviar áudio ao serviço, a sessão nova é encerrada e nenhum contexto/print é enviado

#### Scenario: Limite de captação

- **WHEN** o usuário mantém o atalho pressionado por mais de 120 s
- **THEN** o microfone é mutado em 120 s e o serviço pode concluir o turno sem esperar o print

#### Scenario: Soltura durante a conexão

- **WHEN** o usuário solta o atalho antes de o áudio conectar
- **THEN** a conexão tardia não desmuta o microfone; se o gesto durou ao menos 0,3 s e não foi cancelado, envia somente a fala já captada, após o ACK do contexto

#### Scenario: Entrada invalidada

- **WHEN** cancelamento, falha, troca de conta ou contexto novo invalida a entrada retida
- **THEN** o buffer e as fontes de entrada ainda não enviadas são descartados, sem contaminar o próximo gesto

### Requirement: Um gesto por vez e cancelamento

Só uma captação MUST estar ativa por vez. Repetição de aperto durante o mesmo gesto MUST NOT abrir outra chamada. Bloqueio, suspensão ou reinício do helper que impeça garantir a soltura MUST mutar o microfone, invalidar o gesto e encerrar a chamada. Trocar de conta MUST encerrar a chamada e impedir que áudio, contexto ou aviso da conta anterior sejam publicados na nova conta.

#### Scenario: Aperto repetido

- **WHEN** o helper repete o aperto enquanto a combinação continua pressionada
- **THEN** não começa outra captação nem outra chamada

#### Scenario: Mac bloqueado durante a fala

- **WHEN** a tela é bloqueada com o atalho pressionado
- **THEN** a captação e a chamada terminam, o contexto pendente é descartado e o próximo gesto pode iniciar uma nova chamada

#### Scenario: Troca de conta

- **WHEN** a conta muda durante conexão, captação, upload ou delegação
- **THEN** a chamada antiga termina e suas continuações não enviam dados nem exibem resposta na nova conta

#### Scenario: Microfone negado

- **WHEN** o macOS nega o acesso ao microfone
- **THEN** o notch mostra a falta de permissão com ação para os Ajustes do Sistema e não começa a captação

#### Scenario: Permissão por papel de janela

- **WHEN** a janela de voz oculta pede áudio com a janela principal fechada
- **THEN** ela pode receber permissão, sem conceder vídeo ou ampliar mídia às outras janelas antes não autorizadas

### Requirement: Contexto da tela no momento do gesto

Com o envio do print ligado, o app MUST capturar o monitor onde está o cursor no instante em que o atalho é apertado, antes de mostrar qualquer elemento próprio sobre a tela. O app MUST registrar a posição do cursor e o nome do app em primeiro plano nesse instante. O print MUST refletir a tela do momento do aperto e MUST NOT incluir o cursor companheiro.

#### Scenario: Apontar sem desenhar

- **WHEN** o usuário segura o atalho com o cursor sobre um botão e fala "o que esse botão faz?"
- **THEN** a pergunta enviada leva o print do monitor do cursor, o recorte em volta do cursor e a posição do cursor

#### Scenario: Tela muda depois do aperto

- **WHEN** o usuário aperta o atalho, a janela do app de fundo muda enquanto ele fala
- **THEN** o print enviado é o da tela no momento do aperto

#### Scenario: Vários monitores

- **WHEN** o cursor está no monitor secundário ao apertar o atalho
- **THEN** o print e as coordenadas são desse monitor

### Requirement: Traço livre sobre a tela

Enquanto o atalho estiver pressionado, o usuário MUST poder arrastar o mouse para desenhar um traço livre sobre o monitor capturado. O traço MUST aparecer na tela enquanto é desenhado e sumir pouco depois de soltar o atalho; um novo arrasto MUST substituir o traço anterior. O print enviado MUST levar o traço desenhado por cima, e o recorte MUST cobrir a área do traço.

#### Scenario: Circular um gráfico

- **WHEN** o usuário, com o atalho pressionado, circula um gráfico com o mouse
- **THEN** a pergunta enviada leva o print com o círculo desenhado, o recorte da área do círculo e os limites dessa área

#### Scenario: Serviço responde antes da soltura

- **WHEN** o VAD inicia uma resposta enquanto o usuário ainda mantém o atalho pressionado
- **THEN** a resposta fica inaudível enquanto o gesto está ativo; a legenda pode chegar e o desenho no monitor capturado continua disponível até a soltura

#### Scenario: Traço some

- **WHEN** o usuário solta o atalho depois de desenhar
- **THEN** o traço some da tela em poucos segundos

#### Scenario: Cursor em outro monitor

- **WHEN** o cursor passa a um monitor que não é o capturado durante o gesto
- **THEN** o companheiro continua visível, mas não pinta traço nem intercepta arrasto; ao voltar ao monitor capturado, o desenho volta a ficar disponível

### Requirement: Permissão de Gravação de Tela

O print MUST depender da permissão de Gravação de Tela do próprio Comma. Sem ela, o contexto solicitado MUST falhar explicitamente, sem envio automático do pedido sem print; o notch MUST avisar e oferecer os Ajustes do Sistema. Com print ligado e permissão não concedida, o app MUST pedir a permissão em nome do Comma. Com print desligado, MUST NOT capturar nem pedir. O texto de uso MUST mencionar o print enviado ao agente.

#### Scenario: Primeira vez

- **WHEN** o print está ligado, o Comma nunca pediu Gravação de Tela e o usuário faz uma pergunta
- **THEN** o macOS mostra o pedido de Gravação de Tela para o Comma e o Comma passa a aparecer na lista dos Ajustes do Sistema

#### Scenario: Permissão negada

- **WHEN** a Gravação de Tela está negada para o Comma e o usuário faz uma pergunta
- **THEN** o contexto falha e o notch pede a permissão, sem afirmar que enviou o pedido; desligar “Enviar print” permite um novo gesto só com voz e texto

#### Scenario: Print desligado

- **WHEN** o envio do print está desligado e o usuário faz uma pergunta
- **THEN** nenhum print é capturado ou enviado; a fala continua por voz e só o contexto textual do app em primeiro plano e cursor é associado à chamada

### Requirement: Conexão da chamada GPT Live

O aperto MUST abrir/reutilizar GPT Live oculto no Workspace Chat da Sidebar, com a voz do Call Comma, sem saudação/perfil bloqueante e com Router ativo. PTT MUST NOT registrar início/fim como evento/cartão de chamada na conversa; manual MUST continuar registrando. Uso/minutos, ingresso, handoff e resposta tardia MUST ser preservados. PTT MUST NOT depender de transcrição de reuniões nem gravar WAV. A UI MUST NOT mostrar "Conectando".

#### Scenario: Primeira conexão

- **WHEN** o usuário aperta o atalho sem sessão quente
- **THEN** sinalização, captação local, admissão e captura começam em paralelo, sem saudação ou espera de perfil; notch/companheiro mostram "Ouvindo", e a fala retida é enviada após conexão/admissão e confirmação de 0,3 s

#### Scenario: Encerrar sem trabalho pendente aceito

- **WHEN** a sessão PTT termina sem delegações pendentes aceitas pelo Router
- **THEN** não registra evento de início ou fim de chamada na conversa nem cria ingresso terminal

#### Scenario: Handoff de trabalho pendente sem cartão de chamada

- **WHEN** a sessão PTT termina com delegações pendentes com ACK conhecido
- **THEN** o ingresso durável canônico preserva os IDs em `voice.delegation_handoff`, interno e invisível na timeline humana, sem `voice.call_started` ou `voice.call_ended` PTT
- **AND** a resposta tardia segue autorizada e idempotente na conversa; a chamada manual conserva seus eventos de início/fim

#### Scenario: Reunião não configurada

- **WHEN** há voz GPT Live disponível, mas a transcrição de reuniões não está configurada
- **THEN** o PTT pode iniciar normalmente

#### Scenario: Chamada manual em andamento

- **WHEN** uma chamada manual ocupa o workspace e o início do PTT retorna `busy` (409)
- **THEN** o notch informa "ligação em andamento", sem iniciar captação nem usar voz alternativa

#### Scenario: Limite do plano

- **WHEN** o serviço retorna `plan_limit` (429)
- **THEN** o notch informa o limite do plano, sem ASR ou TTS alternativo

### Requirement: Fim de turno pelo serviço

Soltar MUST mutar a captação e restaurar a reprodução remota. O serviço MUST decidir o fim do turno pelo silêncio; o app MUST NOT enviar `input_audio_buffer.commit`, `turn_detection` ou outro controle não suportado. Uma resposta iniciada com a tecla presa MUST permanecer inaudível no renderer. Fala seguinte pode interrompê-la pelo barge-in do serviço. Áudio consumido enquanto o gesto estava ativo MUST NOT ser guardado para replay na soltura.

#### Scenario: Soltura

- **WHEN** o usuário solta o atalho após falar
- **THEN** o microfone é mutado imediatamente e a reprodução remota é restaurada sem esperar legenda; a decisão de responder pertence ao serviço, não ao fim do upload

#### Scenario: Pausa com atalho preso

- **WHEN** o usuário faz uma pausa longa sem soltar o atalho
- **THEN** o modelo pode iniciar uma resposta, mas ela fica inaudível enquanto a tecla está presa; se o usuário voltar a falar, o serviço faz barge-in

#### Scenario: Resposta consumida durante o gesto

- **WHEN** uma resposta começa e termina com a tecla presa e o usuário solta sem voltar a falar
- **THEN** ela fica somente na legenda, sem replay de áudio na soltura

### Requirement: Contexto da chamada e delegação ao agente

O modelo de voz MUST delegar ao Router pedidos sobre a tela ou ferramentas. O app MUST enviar app e cursor e, com print, tamanho, área e nomes; o texto MUST chegar como contexto silencioso por `session.context.append`. O modelo de voz não recebe imagem.

#### Scenario: Contexto textual silencioso

- **WHEN** o contexto do gesto é concluído com app, cursor e, se houver print, tamanho, área e nomes
- **THEN** o texto chega como contexto silencioso à chamada e, se houver delegação, o Router recebe o texto capturado do mesmo contexto, inclusive com print desligado

### Requirement: Associação do print ao pedido

Cada gesto MUST ter `context_id` crescente por chamada e estado `pending/complete/failed/cancelled`. O CallActor MUST vincular o print ao turno nativo via `user_bidi_turn_id`, `turn.start_ms` e ACK de `pending`. MUST esperar contexto e ACK, entregar anexos VFS uma vez e falhar sem vínculo válido. MUST NOT exigir marcador textual, adivinhar pelo último contexto ou transferir imagens entre pedidos.

#### Scenario: Fronteira nativa do gesto

- **WHEN** o serviço confirma o append de `pending` com `session.context.appended` e delega um turno nativo
- **THEN** o ID `user_bidi_turn_id` corresponde ao `turn.created` congelado no mesmo contexto, e `turn.start_ms` é maior ou igual ao `end_ms` desse ACK; ACK de contexto completo não desloca essa fronteira

#### Scenario: Réplica após gesto silencioso

- **WHEN** um novo gesto substitui um gesto sem fala reconhecida
- **THEN** a sessão quente continua, sem encerramento por falta de turno anterior; fala antiga anterior à nova fronteira falha sem consumir a imagem nova

#### Scenario: Referência do upload

- **WHEN** o app associa um print ou recorte à chamada
- **THEN** envia `attachments: [{ path, name, mime }]` na rota `context`, usando somente o `path` devolvido por `uploadGroupFile`, sem nova identidade de arquivo

#### Scenario: Pergunta com print

- **WHEN** a delegação do gesto chega antes de terminar o upload do print e recorte
- **THEN** não há envio prematuro ao Router; a delegação espera o `complete` e o ACK nativo do `pending` do mesmo `context_id`, dentro do prazo de 150 s, e recebe os dois anexos VFS com os bytes enviados

#### Scenario: Pixels após leitura do anexo

- **WHEN** o Router lê pelo `fs.read_file` o anexo de tela do turno delegado e o modelo aceita imagens
- **THEN** a requisição ao modelo contém os bytes da imagem pelo caminho existente de `ImageRefs`, não somente nome, localizador ou confirmação de upload

#### Scenario: Upload concluído sem ACK nativo

- **WHEN** o upload termina e a delegação chega, mas o serviço não confirma o append nativo do contexto
- **THEN** o pedido não é enviado ao Router; o prazo original de 150 s produz falha explícita, e um `complete` atrasado não reativa o contexto

#### Scenario: Anexos consumidos

- **WHEN** uma segunda delegação acontece sem novo envio de anexos
- **THEN** ela não recebe os anexos da delegação anterior

#### Scenario: Contexto cancelado ou substituído

- **WHEN** cancelamento, novo gesto ou troca de conta invalida um contexto e depois chega sua conclusão atrasada
- **THEN** a conclusão é recusada/descartada, a espera anterior termina sem anexos transferidos e o próximo pedido não recebe imagens do contexto invalidado

#### Scenario: Substituição durante o settle

- **WHEN** um contexto completo tem delegação no settle de 300 ms, mas ainda não enfileirada, e novo gesto ou cancelamento o invalida
- **THEN** o pedido antigo falha explicitamente, sem envio com anexos vazios nem consumo das imagens do novo gesto; trabalho já enfileirado permanece aceito

#### Scenario: Falha ou prazo do contexto

- **WHEN** captura/upload falha, o upload excede 30 s após captura e admissão, ou o contexto atinge 150 s desde `pending`
- **THEN** o contexto falha explicitamente, a espera termina e o app informa o erro sem fallback silencioso, retenção indefinida ou uso de print anterior

#### Scenario: Delegação sem associação válida

- **WHEN** o pedido de delegação não traz correlação válida com o turno nativo do contexto admitido ou referencia turno anterior à fronteira do contexto ou inexistente
- **THEN** a chamada emite falha explícita e limitada para repetir o pedido; não executa silenciosamente um pedido de tela sem os anexos correspondentes nem cancela contextos mais recentes

#### Scenario: Soltura antes do ACK de controle

- **WHEN** o usuário solta enquanto a admissão `pending` ainda não respondeu
- **THEN** a faixa é mutada imediatamente; nem esse ACK nem conclusão de captura/upload pode desmutar depois

#### Scenario: Admissão rejeitada ou sem resposta

- **WHEN** a admissão falha ou excede 30 s, inclusive com `call.ready` pendente ou captura ainda em curso
- **THEN** a faixa fica mutada, o gesto é invalidado e o erro aparece sem aguardar soltura, captura ou confirmação do controle de falha; ACK antigo não reativa o gesto

#### Scenario: Cancelamento antes da admissão

- **WHEN** o servidor recebe `cancelled` antes de um `pending` atrasado do mesmo ID
- **THEN** o cancelamento permanece válido e o contexto não pode ser reativado

#### Scenario: Contexto fora do escopo

- **WHEN** outra conta, tenant ou workspace tenta associar contexto à chamada
- **THEN** a operação é recusada sem alterar o contexto nem os anexos pendentes

### Requirement: Envio sem interferir no uso

Conectar, enviar contexto e delegar MUST NOT usar ou apagar o rascunho da sidebar, abrir janelas ou tirar o foco do app em uso. Falha de upload ou contexto MUST aparecer no notch, sem indicar que a imagem foi entregue.

#### Scenario: Nada abre e o rascunho fica

- **WHEN** o usuário faz uma pergunta por voz com texto não enviado na sidebar
- **THEN** o app em uso mantém o foco, nenhuma janela abre e o rascunho permanece intacto

#### Scenario: Falha de contexto

- **WHEN** o upload ou a associação do contexto falha
- **THEN** o notch mostra a falha sem fingir que o Router recebeu o print

### Requirement: Resposta por voz e legenda

O modelo GPT Live MUST responder por voz na sessão e MUST poder receber a resposta delegada do Router. O balão MUST acompanhar as legendas frase a frase. O renderer MUST silenciar a reprodução enquanto o gesto está ativo e restaurá-la na soltura, sem esperar legendas. Fora do gesto, áudio recebido MUST tocar sem bloqueio por captions. Não existe ajuste para desligar apenas a voz da resposta nem fallback para voz do sistema; não é leitura literal de mensagem do chat.

#### Scenario: Resposta direta

- **WHEN** o modelo de voz consegue responder sem ferramentas
- **THEN** ele responde na chamada e o balão acompanha a fala, sem passar por transcrição e envio de mensagem

#### Scenario: Resposta delegada

- **WHEN** o Router conclui uma delegação com a chamada ativa
- **THEN** a resposta volta ao modelo de voz e pode ser falada com legenda no balão

#### Scenario: Áudio novo não aguarda legenda

- **WHEN** o serviço transmite áudio de resposta depois da soltura, antes da chegada da legenda
- **THEN** o peer reproduz imediatamente, sem esperar legenda

#### Scenario: Fala contínua durante novo gesto

- **WHEN** o usuário aperta e solta novamente durante uma resposta
- **THEN** o aperto silencia a reprodução imediatamente e a soltura restaura a mídia corrente; não há replay da parte consumida enquanto mutada nem espera por caption

#### Scenario: Abrir a conversa pelo balão

- **WHEN** o usuário clica no balão
- **THEN** a sidebar abre na conversa do agente

### Requirement: Sessão quente e réplica

Depois da resposta, a sessão MUST ficar mutada, sem UI, por 90 s. Um novo aperto nesse intervalo MUST reutilizar a sessão e sua memória. Sem réplica ou delegação pendente, a sessão MUST encerrar ao fim desse prazo.

#### Scenario: Réplica em 90 s

- **WHEN** o usuário aperta de novo 60 s depois da resposta
- **THEN** a mesma sessão é desmutada e o modelo mantém o contexto da chamada

#### Scenario: Inatividade sem delegação

- **WHEN** passam 90 s depois da resposta sem réplica ou delegação pendente
- **THEN** a chamada encerra sem abrir janela nem manter o microfone ativo

### Requirement: Delegação pendente e teto da sessão

Uma delegação pendente MUST manter a sessão aberta e o estado "Pensando", com a nota aos 20 s e a desculpa falada aos 90 s da ligação existente. A sessão MUST encerrar no teto absoluto de 10 min, mesmo com delegação pendente. Desligar PTT MUST encerrar a chamada, sem cancelar o trabalho do Router já aceito.

#### Scenario: Delegação além da janela de réplica

- **WHEN** há uma delegação pendente após 90 s
- **THEN** a sessão continua aberta, até a conclusão ou o teto de 10 min

#### Scenario: Teto com trabalho pendente

- **WHEN** a chamada atinge 10 min com uma delegação pendente
- **THEN** a chamada encerra, mas o Router continua o trabalho já aceito

#### Scenario: Encerramento antes do encaminhamento

- **WHEN** a chamada encerra com uma delegação ainda esperando contexto ou no settle
- **THEN** a espera termina sem anunciar esse pedido como aceito pelo Router nem autorizar resposta tardia por esse ID no evento final

#### Scenario: Encerramento durante encaminhamento

- **WHEN** a chamada encerra enquanto o enqueue no Router ainda não respondeu
- **THEN** a mídia fecha imediatamente e a resolução do encaminhamento tem espera limitada
- **AND** somente um ACK real de sucesso permite incluir o pedido entre as delegações aceitas do handoff; erro ou falta de ACK não pode ser substituído por um flag pré-despacho
- **AND** nenhum trabalho que já chegou ao Router é apagado, cancelado ou reenviado por falta de confirmação local

#### Scenario: Ingresso aceito após o prazo de encerramento

- **WHEN** o encaminhamento não tem ACK no fim da espera limitada e o ingresso real aceita o pedido depois
- **THEN** a chamada já terminou sem incluir esse ID entre os confirmados do evento final
- **AND** a resposta pela origem canônica original permanece na conversa; a origem final não autoriza um ID sem confirmação

#### Scenario: Supervisor ou force durante encaminhamento

- **WHEN** o supervisor encerra o Actor ou o drain força seu término enquanto há forwarding sem ACK
- **THEN** a mídia fecha e o mesmo dono conclui o handoff possível antes da finalização, dentro do orçamento forçado existente
- **AND** somente ACKs conhecidos entram no contexto final; trabalho aceito ou desconhecido não é cancelado nem reenviado
- **AND** o encerramento não depende de um timer que exija a mailbox depois do término

#### Scenario: Admissão do handoff não responde

- **WHEN** a admissão do evento final permanece sem resposta durante encerramento forçado
- **THEN** o término continua limitado pelo prazo existente e registra resultado não confirmado, sem inventar aceitação
- **AND** eventual ingresso posterior conserva a autorização pela origem canônica, sem fila durável ou outra autoridade de conclusão

### Requirement: Só respostas vinculadas à chamada e aviso tardio

Respostas a mensagens digitadas que não pertencem à delegação da chamada MUST NOT ser faladas nem mostradas no balão. Resposta do Router após o teto ou com PTT desligado MUST permanecer na conversa e gerar estado `ready` ("Resposta pronta") com balão na conta original. O app MUST avisar e esperar o clique para abrir a sidebar; o clique no balão ou na ação do notch MUST reconhecer o aviso e limpar sua apresentação. MUST NOT iniciar outra chamada automaticamente.

#### Scenario: Mensagem digitada

- **WHEN** uma mensagem digitada na sidebar recebe resposta enquanto o PTT espera uma delegação diferente
- **THEN** essa resposta não é falada nem mostrada como resposta do atalho

#### Scenario: Resposta depois do teto

- **WHEN** o Router responde à delegação depois dos 10 min da chamada
- **THEN** o texto fica na conversa, o notch/companheiro mostra "Resposta pronta" e clicar abre a sidebar e limpa o aviso, sem religação automática

#### Scenario: Resposta com PTT desligado

- **WHEN** o usuário desliga PTT com delegação pendente e a resposta chega na mesma conta
- **THEN** o app mostra "Resposta pronta" com balão, sem reativar o atalho nem a chamada

### Requirement: Reprodução controlada pelo gesto e nova captação

Apertar durante uma resposta MUST limpar a legenda anterior na UI, silenciar imediatamente a reprodução remota no renderer e abrir o microfone para captação local na mesma sessão. O envio da entrada MUST respeitar conexão, admissão e mínimo de 0,3 s. Soltar MUST mutar o microfone e restaurar a reprodução sem depender de legendas. O serviço continua dono do barge-in ao reconhecer fala; o cliente MUST NOT inventar cancelamento remoto.

#### Scenario: Novo aperto durante resposta

- **WHEN** o modelo está falando e o usuário aperta o atalho
- **THEN** a reprodução é silenciada imediatamente, a legenda anterior fecha e a captação começa, mesmo sem nova fala reconhecida pelo serviço

#### Scenario: Soltura sem legenda

- **WHEN** o usuário solta e nenhuma legenda nova chegou
- **THEN** o microfone fica mutado e a reprodução remota é restaurada imediatamente; legenda não autoriza nem bloqueia áudio

### Requirement: Cursor companheiro

O companheiro MUST mostrar "Ouvindo" desde o aperto com nível real, espera pelo modelo/Router e legenda da resposta; MUST NOT mostrar "Conectando". A barreira de captura antes da sobreposição MUST permanecer. Após a resposta, MUST sumir; sessão quente fica invisível. Resposta tardia MUST mostrar "Resposta pronta" e balão. Companheiro/traço MUST NOT tirar foco nem bloquear cliques fora do gesto/balão.

#### Scenario: Ciclo normal

- **WHEN** o usuário segura, fala e solta o atalho e o agente responde
- **THEN** o companheiro mostra o nível da voz, depois a espera, depois o balão, e some ao fim

#### Scenario: Fora de um turno

- **WHEN** nenhum turno está em andamento
- **THEN** nenhum elemento do gesto fica na tela e cliques chegam normalmente aos outros apps

### Requirement: Estado no notch

Com o notch ligado, o app MUST mostrar "Ouvindo" desde o aperto com nível, nunca "Conectando"; depois "Pensando" após soltar e durante delegação, "Falando" com a resposta e "Resposta pronta" para resposta tardia. Erros MUST aparecer com a ação correspondente. Em `idle`, o notch MUST restaurar a cena anterior mesmo com sessão quente. Com o notch desligado, o companheiro MUST mostrar os avisos.

#### Scenario: Estados em sequência

- **WHEN** o usuário segura, fala, solta e o agente responde
- **THEN** o notch mostra "Ouvindo", "Pensando", "Falando" e volta ao normal com a sessão quente, sem estado visível de conexão

#### Scenario: Notch desligado

- **WHEN** o notch está desligado e a permissão de Microfone é negada ou o início retorna `busy`/`plan_limit`
- **THEN** o aviso aparece junto ao cursor companheiro

### Requirement: Ajustes e privacidade

Os Ajustes MUST oferecer ligar/desligar PTT, escolher o atalho e ligar/desligar o envio do print (padrão ligado), sem ajuste de resposta falada ou dependência de Reunião. MUST informar que o áudio vai ao GPT Live da conta ChatGPT e que prints vão ao Router e ao provedor do modelo dele, que precisa aceitar imagem. Mudanças MUST valer sem reiniciar.

#### Scenario: Trocar o atalho

- **WHEN** o usuário troca o atalho nos Ajustes
- **THEN** o atalho antigo para de funcionar e o novo passa a funcionar imediatamente

#### Scenario: Aviso de privacidade

- **WHEN** o usuário abre a seção "Falar com o agente"
- **THEN** vê para onde vão o áudio e o print
