# Spec Delta

## Purpose

Permitir que o usuário converse com o agente do workspace a partir de qualquer app do Mac segurando um atalho global: o app grava a fala, captura o contexto da tela no momento do gesto (print, ponto do cursor, traço desenhado e app em primeiro plano), transcreve, envia a pergunta à conversa do agente e responde por voz e por um balão junto ao cursor, com o estado no notch.

## ADDED Requirements

### Requirement: Ativação e disponibilidade

A função "Falar com o agente" MUST existir só no app desktop para macOS e MUST vir desligada por padrão. Ela MUST exigir a sidebar ligada; com a sidebar desligada, os Ajustes MUST mostrar a opção indisponível com o motivo. Com a função ligada, o atalho MUST funcionar em qualquer app, inclusive com a janela principal do Comma fechada, enquanto o processo do Comma estiver rodando e houver sessão aberta.

#### Scenario: Padrão desligado

- **WHEN** o usuário instala o app e não mexe nos Ajustes
- **THEN** segurar `⌃⌥` não grava nada nem mostra nada na tela

#### Scenario: Janela principal fechada

- **WHEN** a função está ligada, a janela principal está fechada e o usuário segura o atalho em outro app
- **THEN** o notch mostra "Ouvindo", o cursor companheiro aparece e a gravação começa

#### Scenario: Sidebar desligada

- **WHEN** a sidebar está desligada nos Ajustes
- **THEN** a opção "Falar com o agente" aparece indisponível com a explicação de que depende da sidebar, e o atalho não fica registrado

### Requirement: Atalho de segurar para falar

O atalho MUST ser escolhido pelo usuário entre uma combinação só de modificadores (ao menos dois) ou uma tecla comum com ao menos um modificador; o padrão MUST ser `⌃⌥`. Ele MUST ser distinto do atalho da sidebar e do atalho de abrir o Comma; os Ajustes MUST recusar um atalho que conflite com eles. Apertar MUST iniciar um turno; soltar qualquer tecla da combinação MUST encerrar a gravação do turno.

#### Scenario: Atalho padrão

- **WHEN** o usuário segura `⌃⌥` por 4 segundos falando e solta
- **THEN** a gravação contém esses 4 segundos e o turno passa para transcrição

#### Scenario: Gravar só modificadores nos Ajustes

- **WHEN** o usuário clica para gravar o atalho, segura `⌃⌥` e solta sem apertar outra tecla
- **THEN** os Ajustes salvam `⌃⌥` como atalho

#### Scenario: Conflito com a sidebar

- **WHEN** o usuário tenta usar como atalho de falar o mesmo atalho da sidebar
- **THEN** os Ajustes recusam e mostram com qual atalho conflita

### Requirement: Atalho só de modificadores não rouba outros atalhos

Com um atalho só de modificadores, o app MUST apenas observar o teclado, sem impedir que as teclas cheguem aos outros apps. Se qualquer outra tecla for apertada enquanto a combinação está pressionada, o turno MUST ser cancelado sem enviar nada. Um turno MUST começar só quando exatamente os modificadores da combinação estiverem pressionados.

#### Scenario: Outro atalho com os mesmos modificadores

- **WHEN** o usuário aperta `⌃⌥←` em outro app
- **THEN** o outro app recebe `⌃⌥←`, nenhum turno é enviado e o que tiver aparecido some

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

### Requirement: Gravação do turno

Enquanto o atalho está pressionado, o app MUST gravar o microfone. Uma gravação menor que 0,3 s MUST ser descartada sem transcrever nem enviar. Uma gravação MUST terminar sozinha ao atingir 120 s e seguir como se o atalho tivesse sido solto.

#### Scenario: Toque acidental

- **WHEN** o usuário aperta e solta o atalho em 0,2 s
- **THEN** nada é transcrito nem enviado e o que tiver aparecido some

#### Scenario: Limite de duração

- **WHEN** o usuário mantém o atalho pressionado por mais de 120 s
- **THEN** a gravação para em 120 s e o turno segue para transcrição

### Requirement: Um turno por vez e cancelamento

Só um turno MUST existir por vez: apertar o atalho enquanto um turno ainda está transcrevendo ou enviando MUST ser ignorado, com o notch indicando que é preciso aguardar. Se o soltar do atalho não puder ser garantido (Mac bloqueado, suspenso ou helper do atalho reiniciado durante a gravação), o turno MUST ser cancelado e a gravação descartada.

#### Scenario: Aperto durante a transcrição

- **WHEN** o usuário aperta o atalho enquanto o turno anterior ainda está transcrevendo
- **THEN** nenhum turno novo começa e o notch pede para aguardar

#### Scenario: Mac bloqueado durante a gravação

- **WHEN** a tela é bloqueada com o atalho pressionado
- **THEN** o turno é cancelado, nada é enviado e o próximo aperto começa um turno novo

#### Scenario: Microfone negado

- **WHEN** o macOS nega o acesso ao microfone
- **THEN** o notch mostra que falta a permissão de Microfone, com um botão para abrir os Ajustes do Sistema, e nada é enviado

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

O print MUST depender da permissão de Gravação de Tela concedida ao próprio Comma. Sem a permissão, o turno MUST seguir só com o texto, a posição do cursor e o app em primeiro plano, e o notch MUST avisar que o print não foi enviado, com um botão para abrir os Ajustes do Sistema. Com o envio do print desligado, o app MUST NOT capturar a tela nem pedir a permissão. O texto de uso da permissão MUST mencionar o print enviado ao agente.

#### Scenario: Permissão negada

- **WHEN** a Gravação de Tela está negada para o Comma e o usuário faz uma pergunta
- **THEN** a pergunta é enviada sem print e o notch avisa que o print não foi incluído

#### Scenario: Print desligado

- **WHEN** o envio do print está desligado e o usuário faz uma pergunta
- **THEN** nenhum print é capturado e a pergunta segue com o texto e o app em primeiro plano

### Requirement: Transcrição

O app MUST transcrever a gravação pelo mecanismo escolhido em Ajustes → Reunião (Local, Groq ou API compatível com OpenAI), com o mesmo fallback para o modelo local definido para reuniões. Se a transcrição não estiver disponível, o notch MUST dizer isso com um botão que abre a seção de Reunião dos Ajustes, e nada MUST ser enviado. Uma transcrição vazia MUST ser tratada como "não entendi", sem envio. O áudio MUST ser apagado do disco ao fim do turno.

#### Scenario: Transcrição indisponível

- **WHEN** o modelo local não está instalado e nenhum provedor de nuvem está configurado
- **THEN** o notch avisa que é preciso configurar a transcrição e nada é enviado ao agente

#### Scenario: Silêncio

- **WHEN** a transcrição volta vazia
- **THEN** o notch mostra "Não entendi" e nada é enviado

#### Scenario: Fallback da nuvem

- **WHEN** a Groq falha e o modelo local está instalado
- **THEN** a pergunta é transcrita pelo modelo local e enviada normalmente

### Requirement: Envio ao agente

O app MUST enviar o turno como uma mensagem do usuário na conversa do agente do workspace ativo, a mesma mostrada na sidebar. A mensagem MUST conter o texto transcrito e um bloco de contexto com o app em primeiro plano e, quando houver print, o tamanho do print em pixels, a posição do cursor e os limites do traço nas coordenadas do print. O print do monitor e o recorte MUST ir como anexos de imagem pelo mecanismo de anexos do chat.

#### Scenario: Pergunta com print

- **WHEN** o usuário solta o atalho depois de falar com o print ligado
- **THEN** a conversa do agente recebe uma mensagem com o texto, o bloco de contexto e dois anexos de imagem

### Requirement: Envio sem interferir no uso

O envio MUST NOT usar nem apagar o rascunho que o usuário tenha digitado na sidebar. O envio MUST NOT abrir a sidebar, a janela principal nem tirar o foco do app em uso. Uma falha de envio MUST aparecer no notch, com a opção de copiar o texto transcrito.

#### Scenario: Nada abre

- **WHEN** a pergunta é enviada enquanto o usuário está num editor de texto
- **THEN** nenhuma janela do Comma abre e o editor continua com o foco do teclado

#### Scenario: Rascunho preservado

- **WHEN** há um texto não enviado no campo da sidebar e o usuário faz uma pergunta pelo atalho
- **THEN** a pergunta é enviada e o rascunho continua intacto no campo

#### Scenario: Falha de envio

- **WHEN** o upload do print ou o envio da mensagem falha
- **THEN** o notch mostra a falha com a opção de copiar o texto transcrito

### Requirement: Resposta falada e no balão

O app MUST mostrar a primeira resposta completa do agente que chegar na conversa depois do envio de um turno num balão junto ao cursor companheiro, sem marcações de formatação. Com a resposta falada ligada (padrão), o app MUST lê-la com a voz do sistema frase por frase, mostrando no balão a frase em leitura. Com ela desligada, o balão MUST mostrar a resposta pelo tempo de leitura.

#### Scenario: Leitura da resposta

- **WHEN** o agente responde ao turno enviado pelo atalho
- **THEN** cada frase aparece no balão enquanto é lida em voz alta, uma única vez

#### Scenario: Voz desligada

- **WHEN** a resposta falada está desligada e o agente responde
- **THEN** o balão mostra a resposta sem voz e some depois do tempo de leitura

#### Scenario: Abrir a conversa pelo balão

- **WHEN** o usuário clica no balão
- **THEN** a sidebar abre na conversa do agente

### Requirement: Só respostas do atalho

Respostas a mensagens que não vieram do atalho MUST NOT aparecer no balão nem ser lidas. Sem resposta em 180 s, o app MUST parar de esperar e o companheiro MUST sumir.

#### Scenario: Mensagem digitada

- **WHEN** o usuário envia uma mensagem digitando na sidebar
- **THEN** a resposta do agente não aparece no balão nem é lida em voz alta

#### Scenario: Agente demora

- **WHEN** o agente não responde em 180 s
- **THEN** o companheiro some e nada é lido quando a resposta chegar depois

### Requirement: Interromper a leitura

Apertar o atalho durante a leitura MUST interromper a voz imediatamente, fechar o balão e iniciar um novo turno.

#### Scenario: Interromper a leitura

- **WHEN** o app está lendo uma resposta e o usuário aperta o atalho
- **THEN** a leitura para na hora e o notch volta a "Ouvindo"

### Requirement: Cursor companheiro

Durante um turno, o app MUST mostrar um indicador junto ao cursor, que o acompanha em qualquer app e espaço: com o nível da voz enquanto ouve, com um indicador de espera enquanto transcreve e enquanto o agente pensa, e com o balão enquanto responde. Ele MUST sumir alguns segundos depois do fim do turno ou do cancelamento. O companheiro e o traço MUST NOT tirar o foco do app em uso nem bloquear cliques fora do gesto.

#### Scenario: Ciclo normal

- **WHEN** o usuário segura, fala e solta o atalho e o agente responde
- **THEN** o companheiro mostra o nível da voz, depois a espera, depois o balão, e some ao fim

#### Scenario: Fora de um turno

- **WHEN** nenhum turno está em andamento
- **THEN** nenhum elemento do gesto fica na tela e cliques chegam normalmente aos outros apps

### Requirement: Estado no notch

Com o notch do Comma ligado, o app MUST mostrar nele o estado do turno: "Ouvindo" com o nível de áudio, "Transcrevendo", "Pensando" até a resposta chegar e "Falando" enquanto lê, cada um com sua cor. Erros MUST aparecer no notch com a ação correspondente por alguns segundos. Ao fim do turno, o notch MUST voltar ao que mostrava antes. Com o notch desligado, o companheiro mostra os erros.

#### Scenario: Estados em sequência

- **WHEN** o usuário segura, fala, solta e o agente responde
- **THEN** o notch mostra "Ouvindo", "Transcrevendo", "Pensando", "Falando" e volta ao normal

#### Scenario: Notch desligado

- **WHEN** o notch está desligado e a transcrição não está disponível
- **THEN** o aviso aparece junto ao cursor companheiro

### Requirement: Ajustes e privacidade

Os Ajustes MUST oferecer: ligar/desligar "Falar com o agente", escolher o atalho, ligar/desligar a resposta falada e ligar/desligar o envio do print (padrão ligado). Os Ajustes MUST informar que o áudio vai para o mecanismo de transcrição escolhido e que o print vai para o agente do workspace e para o provedor do modelo dele. Mudanças MUST valer sem reiniciar o app.

#### Scenario: Trocar o atalho

- **WHEN** o usuário troca o atalho nos Ajustes
- **THEN** o atalho antigo para de funcionar e o novo passa a funcionar imediatamente

#### Scenario: Aviso de privacidade

- **WHEN** o usuário abre a seção "Falar com o agente"
- **THEN** vê para onde vão o áudio e o print
