# Spec Delta

## Purpose

Permitir uma chamada GPT Live pelo atalho global em qualquer app do Mac, sem abrir janela: o modelo de voz escuta enquanto o gesto está ativo, responde e delega ao Router o trabalho do agente, com contexto da tela, sessão de réplica, companheiro, notch, permissões e ajustes.

## ADDED Requirements

### Requirement: Ativação e disponibilidade

A função "Falar com o agente" MUST existir só no app desktop para macOS e MUST vir desligada por padrão. Ela MUST exigir a sidebar ligada; com a sidebar desligada, os Ajustes MUST mostrar a opção indisponível com o motivo. Com a função ligada, o atalho MUST funcionar em qualquer app, inclusive com a janela principal do Comma fechada, enquanto o processo do Comma estiver rodando e houver sessão aberta.

#### Scenario: Padrão desligado

- **WHEN** o usuário instala o app e não mexe nos Ajustes
- **THEN** segurar `⌃⌥` não abre chamada, não capta áudio nem mostra nada na tela

#### Scenario: Janela principal fechada

- **WHEN** a função está ligada, a janela principal está fechada e o usuário segura o atalho em outro app
- **THEN** a chamada começa sem abrir janela, o notch mostra "Conectando" até o microfone conectar e depois "Ouvindo" com o companheiro

#### Scenario: Sidebar desligada

- **WHEN** a sidebar está desligada nos Ajustes
- **THEN** a opção "Falar com o agente" aparece indisponível com a explicação de que depende da sidebar, e o atalho não fica registrado

### Requirement: Atalho de segurar para falar

O atalho MUST ser escolhido pelo usuário entre uma combinação só de modificadores (ao menos dois) ou uma tecla comum com ao menos um modificador; o padrão MUST ser `⌃⌥`. Ele MUST ser distinto do atalho da sidebar e do atalho de abrir o Comma; os Ajustes MUST recusar um atalho que conflite com eles, inclusive ao religar a função. Apertar MUST iniciar ou reutilizar a sessão e habilitar a entrada de áudio quando conectada; soltar qualquer tecla da combinação MUST mutar o microfone imediatamente.

#### Scenario: Atalho padrão

- **WHEN** o usuário segura `⌃⌥` por 4 segundos falando e solta
- **THEN** o microfone transmite somente enquanto o gesto está ativo e a faixa conectada; soltar muta sem esperar o print, e o serviço decide quando responder

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

O app MUST usar microfone real na janela de voz oculta, com a faixa mutada por padrão. MUST desmutar somente com o gesto ativo e a faixa conectada. Um toque menor que 0,3 s MUST mutar, descartar contexto/print e encerrar uma sessão aberta por ele que ainda não teve turno. A captação por aperto MUST parar em 120 s, como na soltura. Soltar ou atingir esse limite MUST NOT esperar captura ou upload.

#### Scenario: Toque acidental

- **WHEN** o usuário aperta e solta o atalho em 0,2 s e a sessão nova ainda não teve turno
- **THEN** o microfone é mutado, a chamada é encerrada e nenhum contexto/print é enviado

#### Scenario: Limite de captação

- **WHEN** o usuário mantém o atalho pressionado por mais de 120 s
- **THEN** o microfone é mutado em 120 s e o serviço pode concluir o turno sem esperar o print

#### Scenario: Soltura durante a conexão

- **WHEN** o usuário solta o atalho antes de o áudio conectar
- **THEN** a conexão tardia não desmuta o microfone

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

#### Scenario: Traço some

- **WHEN** o usuário solta o atalho depois de desenhar
- **THEN** o traço some da tela em poucos segundos

### Requirement: Permissão de Gravação de Tela

O print MUST depender da permissão de Gravação de Tela do próprio Comma. Sem ela, o turno MUST seguir sem print e o notch MUST avisar, com um botão para os Ajustes do Sistema. Com o print ligado e a permissão não concedida, o app MUST pedir a permissão ao macOS em nome do Comma, para que ele apareça na lista de Gravação de Tela. Com o print desligado, o app MUST NOT capturar nem pedir. O texto de uso MUST mencionar o print enviado ao agente.

#### Scenario: Primeira vez

- **WHEN** o print está ligado, o Comma nunca pediu Gravação de Tela e o usuário faz uma pergunta
- **THEN** o macOS mostra o pedido de Gravação de Tela para o Comma e o Comma passa a aparecer na lista dos Ajustes do Sistema

#### Scenario: Permissão negada

- **WHEN** a Gravação de Tela está negada para o Comma e o usuário faz uma pergunta
- **THEN** a pergunta é enviada sem print e o notch avisa que o print não foi incluído

#### Scenario: Print desligado

- **WHEN** o envio do print está desligado e o usuário faz uma pergunta
- **THEN** nenhum print é capturado ou enviado; a fala continua por voz e só o contexto textual do app em primeiro plano e cursor é associado à chamada

### Requirement: Conexão da chamada GPT Live

O aperto MUST abrir ou reutilizar uma chamada GPT Live do workspace ativo, com a mesma voz configurada para "Call Comma", sem saudação e sem esperar perfil para começar. A delegação ao Router MUST estar ativa e o início/fim MUST ser registrados como na chamada manual. O PTT MUST NOT depender da transcrição de reuniões nem gravar WAV para transcrever. A mídia só flui após conexão; o app MUST distinguir "Conectando" de "Ouvindo".

#### Scenario: Primeira conexão

- **WHEN** o usuário aperta o atalho sem sessão quente
- **THEN** a sinalização começa no aperto, em paralelo à captura, sem saudação ou espera de perfil; o notch muda de "Conectando" para "Ouvindo" quando o áudio conecta

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

Soltar MUST apenas mutar a entrada de áudio. O serviço MUST decidir o fim do turno; o app MUST NOT representar a soltura como um commit de áudio não suportado. Uma pausa longa com a tecla presa pode produzir resposta antecipada; esse risco é aceito.

#### Scenario: Soltura

- **WHEN** o usuário solta o atalho após falar
- **THEN** o microfone é mutado imediatamente e a resposta aguarda a decisão do serviço, não o fim do upload

#### Scenario: Pausa com atalho preso

- **WHEN** o usuário faz uma pausa longa sem soltar o atalho
- **THEN** o modelo pode responder antes da soltura, sem promessa de controle manual do VAD

### Requirement: Contexto da chamada e delegação ao agente

O modelo de voz MUST delegar ao Router tudo que envolva a tela ou exija ferramentas do agente. O contexto textual MUST incluir app em primeiro plano, cursor e, com print, tamanho, área marcada e nomes dos arquivos. O app MUST fazer upload do print/recorte e associá-los à chamada; o texto MUST chegar como `session.context.append`. Os anexos MUST acompanhar a próxima delegação ao Router, e somente ela. O modelo de voz não recebe imagem diretamente.

#### Scenario: Pergunta com print

- **WHEN** o print e o recorte são enviados e associados à chamada antes da próxima delegação
- **THEN** o modelo recebe o contexto textual e o Router recebe os dois anexos nessa delegação

#### Scenario: Anexos consumidos

- **WHEN** uma segunda delegação acontece sem novo envio de anexos
- **THEN** ela não recebe os anexos da delegação anterior

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

O modelo GPT Live MUST responder por voz na própria chamada e MUST poder receber a resposta delegada do Router. O balão MUST acompanhar as legendas frase a frase. Não existe ajuste para desligar apenas a voz da resposta nem fallback para voz do sistema; não é uma leitura literal de mensagem do chat.

#### Scenario: Resposta direta

- **WHEN** o modelo de voz consegue responder sem ferramentas
- **THEN** ele responde na chamada e o balão acompanha a fala, sem passar por transcrição e envio de mensagem

#### Scenario: Resposta delegada

- **WHEN** o Router conclui uma delegação com a chamada ativa
- **THEN** a resposta volta ao modelo de voz e pode ser falada com legenda no balão

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
- **THEN** a chamada encerra, mas o Router continua o trabalho na conversa

### Requirement: Só respostas vinculadas à chamada e aviso tardio

Respostas a mensagens digitadas que não pertencem à delegação da chamada MUST NOT ser faladas nem mostradas no balão. Resposta do Router após o teto ou com PTT desligado MUST permanecer na conversa e gerar estado `ready` ("Resposta pronta") com balão na conta original. O app MUST avisar e esperar o clique para abrir a sidebar; MUST NOT iniciar outra chamada automaticamente.

#### Scenario: Mensagem digitada

- **WHEN** uma mensagem digitada na sidebar recebe resposta enquanto o PTT espera uma delegação diferente
- **THEN** essa resposta não é falada nem mostrada como resposta do atalho

#### Scenario: Resposta depois do teto

- **WHEN** o Router responde à delegação depois dos 10 min da chamada
- **THEN** o texto fica na conversa, o notch/companheiro mostra "Resposta pronta" e clicar abre a sidebar, sem religação automática

#### Scenario: Resposta com PTT desligado

- **WHEN** o usuário desliga PTT com delegação pendente e a resposta chega na mesma conta
- **THEN** o app mostra "Resposta pronta" com balão, sem reativar o atalho nem a chamada

### Requirement: Interromper a resposta e voltar a falar

Apertar o atalho durante a fala MUST interromper imediatamente a saída e fechar a legenda anterior, permitindo nova captação. Se a sessão ainda existe, o app MUST reutilizá-la em vez de abrir uma segunda chamada.

#### Scenario: Interromper a resposta

- **WHEN** o modelo está falando e o usuário aperta o atalho
- **THEN** a saída anterior para, o balão anterior fecha e o microfone é habilitado na mesma sessão


### Requirement: Cursor companheiro

Durante o turno, o app MUST mostrar o companheiro junto ao cursor: conexão, nível do microfone enquanto ouve, espera enquanto o modelo/Router pensa e legenda enquanto fala. Após a resposta, ele MUST sumir; a sessão quente fica invisível. Resposta tardia MUST mostrar o aviso "Resposta pronta" e seu balão. O companheiro e o traço MUST NOT tirar o foco nem bloquear cliques fora do gesto ou do balão.

#### Scenario: Ciclo normal

- **WHEN** o usuário segura, fala e solta o atalho e o agente responde
- **THEN** o companheiro mostra o nível da voz, depois a espera, depois o balão, e some ao fim

#### Scenario: Fora de um turno

- **WHEN** nenhum turno está em andamento
- **THEN** nenhum elemento do gesto fica na tela e cliques chegam normalmente aos outros apps

### Requirement: Estado no notch

Com o notch ligado, o app MUST mostrar "Conectando" até a faixa conectar, "Ouvindo" com nível, "Pensando" após soltar e durante delegação, "Falando" com a resposta e "Resposta pronta" para resposta tardia. Erros MUST aparecer com a ação correspondente. Em `idle`, o notch MUST restaurar a cena anterior mesmo com a sessão quente. Com o notch desligado, o companheiro MUST mostrar os avisos.

#### Scenario: Estados em sequência

- **WHEN** o usuário segura, fala, solta e o agente responde
- **THEN** o notch mostra "Conectando", se necessário, "Ouvindo", "Pensando", "Falando" e volta ao normal com a sessão quente

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
