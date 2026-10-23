# Spec Delta

## Purpose

Permitir que o usuário converse com o agente do workspace a partir de qualquer app do Mac segurando um atalho global: o app grava a fala, captura o contexto da tela no momento do gesto (print, ponto do cursor, área marcada e app em primeiro plano), transcreve, envia a pergunta ao agente pela sidebar e lê a resposta em voz alta.

## ADDED Requirements

### Requirement: Ativação e disponibilidade

A função "Falar com o agente" MUST existir só no app desktop para macOS e MUST vir desligada por padrão. Ela MUST exigir a sidebar ligada; com a sidebar desligada, os Ajustes MUST mostrar a opção indisponível com o motivo. Com a função ligada, o atalho MUST funcionar em qualquer app, inclusive com a janela principal do Comma fechada, enquanto o processo do Comma estiver rodando e houver sessão aberta.

#### Scenario: Padrão desligado

- **WHEN** o usuário instala o app e não mexe nos Ajustes
- **THEN** segurar o atalho padrão não grava nada nem mostra a pílula

#### Scenario: Janela principal fechada

- **WHEN** a função está ligada, a janela principal está fechada e o usuário segura o atalho em outro app
- **THEN** a pílula "Ouvindo" aparece e a gravação começa

#### Scenario: Sidebar desligada

- **WHEN** a sidebar está desligada nos Ajustes
- **THEN** a opção "Falar com o agente" aparece indisponível com a explicação de que depende da sidebar, e o atalho não fica registrado

### Requirement: Atalho de segurar para falar

O atalho MUST ser uma tecla comum com ao menos um modificador, escolhida pelo usuário, com padrão `⌃⌥Espaço`. Ele MUST ser distinto do atalho da sidebar e do atalho de abrir o Comma; os Ajustes MUST recusar um atalho que conflite com eles. Registrar o atalho MUST NOT pedir permissão de Acessibilidade nem de Monitoramento de Entrada. Apertar MUST iniciar um turno; soltar MUST encerrar a gravação do turno.

#### Scenario: Conflito com a sidebar

- **WHEN** o usuário tenta usar como atalho de falar o mesmo atalho da sidebar
- **THEN** os Ajustes recusam e mostram com qual atalho conflita

#### Scenario: Segurar e soltar

- **WHEN** o usuário segura o atalho por 4 segundos falando e solta
- **THEN** a gravação contém esses 4 segundos e o turno passa para transcrição

### Requirement: Gravação do turno

Enquanto o atalho está pressionado, o app MUST gravar o microfone. Uma gravação menor que 0,3 s MUST ser descartada sem transcrever nem enviar. Uma gravação MUST terminar sozinha ao atingir 120 s e seguir como se o atalho tivesse sido solto.

#### Scenario: Toque acidental

- **WHEN** o usuário aperta e solta o atalho em 0,2 s
- **THEN** nada é transcrito nem enviado e a pílula some

#### Scenario: Limite de duração

- **WHEN** o usuário mantém o atalho pressionado por mais de 120 s
- **THEN** a gravação para em 120 s e o turno segue para transcrição

### Requirement: Um turno por vez e cancelamento

Só um turno MUST existir por vez: apertar o atalho enquanto um turno ainda está transcrevendo ou enviando MUST ser ignorado, com a pílula indicando que é preciso aguardar. Se o soltar do atalho não puder ser garantido (Mac bloqueado, suspenso ou helper do atalho reiniciado durante a gravação), o turno MUST ser cancelado e a gravação descartada.

#### Scenario: Aperto durante a transcrição

- **WHEN** o usuário aperta o atalho enquanto o turno anterior ainda está transcrevendo
- **THEN** nenhum turno novo começa e a pílula pede para aguardar

#### Scenario: Mac bloqueado durante a gravação

- **WHEN** a tela é bloqueada com o atalho pressionado
- **THEN** o turno é cancelado, nada é enviado e o próximo aperto começa um turno novo

#### Scenario: Microfone negado

- **WHEN** o macOS nega o acesso ao microfone
- **THEN** a pílula mostra que falta a permissão de Microfone, com um botão para abrir os Ajustes do Sistema, e nada é enviado

### Requirement: Contexto da tela no momento do gesto

Com o envio do print ligado, o app MUST capturar o monitor onde está o cursor no instante em que o atalho é apertado, antes de mostrar qualquer elemento próprio sobre a tela. O app MUST registrar a posição do cursor e o nome do app em primeiro plano nesse instante. O print MUST refletir a tela do momento do aperto e MUST NOT incluir a pílula nem a marcação.

#### Scenario: Apontar sem arrastar

- **WHEN** o usuário segura o atalho com o cursor sobre um botão e fala "o que esse botão faz?"
- **THEN** a pergunta enviada leva o print do monitor do cursor, o recorte em volta do cursor e a posição do cursor

#### Scenario: Tela muda depois do aperto

- **WHEN** o usuário aperta o atalho, a janela do app de fundo muda enquanto ele fala
- **THEN** o print enviado é o da tela no momento do aperto

#### Scenario: Vários monitores

- **WHEN** o cursor está no monitor secundário ao apertar o atalho
- **THEN** o print e as coordenadas são desse monitor

### Requirement: Marcação de área

Enquanto o atalho estiver pressionado, o usuário MUST poder arrastar o mouse para marcar uma área retangular do monitor capturado. A área marcada MUST ficar visível até soltar o atalho, e uma nova marcação MUST substituir a anterior.

#### Scenario: Marcar uma área

- **WHEN** o usuário, com o atalho pressionado, arrasta sobre um gráfico
- **THEN** a pergunta enviada leva o print, o recorte da área marcada e as coordenadas da área

### Requirement: Permissão de Gravação de Tela

O print MUST depender da permissão de Gravação de Tela concedida ao próprio Comma. Sem a permissão, o turno MUST seguir só com o texto, a posição do cursor e o app em primeiro plano, e a pílula MUST avisar que o print não foi enviado, com um botão para abrir os Ajustes do Sistema. Com o envio do print desligado nos Ajustes, o app MUST NOT capturar a tela nem pedir a permissão. O texto de uso da permissão no macOS MUST mencionar o print enviado ao agente.

#### Scenario: Permissão negada

- **WHEN** a Gravação de Tela está negada para o Comma e o usuário faz uma pergunta
- **THEN** a pergunta é enviada sem print e a pílula avisa que o print não foi incluído

#### Scenario: Print desligado

- **WHEN** o envio do print está desligado e o usuário faz uma pergunta
- **THEN** nenhum print é capturado e a pergunta segue com o texto e o app em primeiro plano

### Requirement: Transcrição

O app MUST transcrever a gravação pelo mecanismo escolhido em Ajustes → Reunião (Local, Groq ou API compatível com OpenAI), com o mesmo fallback para o modelo local definido para reuniões. Se a transcrição não estiver disponível, a pílula MUST dizer isso com um botão que abre a seção de Reunião dos Ajustes, e nada MUST ser enviado. Uma transcrição vazia MUST ser tratada como "não entendi", sem envio. O áudio MUST ser apagado do disco ao fim do turno, com sucesso ou não.

#### Scenario: Transcrição indisponível

- **WHEN** o modelo local não está instalado e nenhum provedor de nuvem está configurado
- **THEN** a pílula avisa que é preciso configurar a transcrição e nada é enviado ao agente

#### Scenario: Silêncio

- **WHEN** a transcrição volta vazia
- **THEN** a pílula mostra "Não entendi" e nada é enviado

#### Scenario: Fallback da nuvem

- **WHEN** a Groq falha e o modelo local está instalado
- **THEN** a pergunta é transcrita pelo modelo local e enviada normalmente

### Requirement: Envio ao agente

O app MUST enviar o turno como uma mensagem do usuário na conversa do agente do workspace ativo, a mesma mostrada na sidebar. A mensagem MUST conter o texto transcrito e um bloco de contexto com o app em primeiro plano e, quando houver print, o tamanho do print em pixels, a posição do cursor e a área marcada nas coordenadas do print. O print do monitor e o recorte MUST ir como anexos de imagem pelo mecanismo de anexos do chat.

#### Scenario: Pergunta com print

- **WHEN** o usuário solta o atalho depois de falar com o print ligado
- **THEN** a conversa do agente recebe uma mensagem com o texto, o bloco de contexto e dois anexos de imagem, e a sidebar abre nela

### Requirement: Envio sem interferir no uso

O envio MUST NOT usar nem apagar o rascunho que o usuário tenha digitado na sidebar. Após o envio, a sidebar MUST abrir na conversa sem roubar o foco do app em uso. Uma falha de envio MUST aparecer na pílula, com a opção de copiar o texto transcrito.

#### Scenario: Sidebar abre sem roubar o foco

- **WHEN** a pergunta é enviada enquanto o usuário está num editor de texto
- **THEN** a sidebar mostra a conversa e o editor continua com o foco do teclado

#### Scenario: Rascunho preservado

- **WHEN** há um texto não enviado no campo da sidebar e o usuário faz uma pergunta pelo atalho
- **THEN** a pergunta é enviada e o rascunho continua intacto no campo

#### Scenario: Falha de envio

- **WHEN** o upload do print ou o envio da mensagem falha
- **THEN** a pílula mostra a falha com a opção de copiar o texto transcrito

### Requirement: Resposta falada

Com a resposta falada ligada (padrão ligado), o app MUST ler em voz alta, com a voz do sistema e sem marcações de formatação, a primeira resposta completa do agente que chegar na conversa depois do envio de um turno. Respostas a mensagens que não vieram do atalho MUST NOT ser lidas. Se o agente não responder em 180 s, o app MUST parar de esperar sem avisar por voz. Com a resposta falada desligada, a resposta aparece só na sidebar.

#### Scenario: Leitura da resposta

- **WHEN** o agente responde ao turno enviado pelo atalho
- **THEN** a resposta aparece na sidebar e é lida em voz alta uma única vez

### Requirement: Interromper a leitura

Apertar o atalho durante a leitura MUST interromper a voz imediatamente e iniciar um novo turno.

#### Scenario: Interromper a leitura

- **WHEN** o app está lendo uma resposta e o usuário aperta o atalho
- **THEN** a leitura para na hora e a pílula "Ouvindo" aparece

#### Scenario: Mensagem digitada

- **WHEN** o usuário envia uma mensagem digitando na sidebar
- **THEN** a resposta do agente não é lida em voz alta

### Requirement: Estado visível do turno

O app MUST mostrar uma pílula discreta perto do cursor, sobre todos os apps e espaços, com o estado do turno: "Ouvindo" enquanto o atalho está pressionado, "Transcrevendo" depois de soltar e até o envio. A pílula MUST sumir quando a mensagem é enviada ou ao ser cancelada, e MUST mostrar erros com a ação correspondente por alguns segundos. A pílula e a marcação de área MUST NOT tirar o foco do app em uso nem bloquear cliques fora de um turno.

#### Scenario: Ciclo normal

- **WHEN** o usuário segura, fala e solta o atalho
- **THEN** a pílula mostra "Ouvindo", depois "Transcrevendo" e some quando a sidebar abre com a pergunta

#### Scenario: Fora de um turno

- **WHEN** nenhum turno está em andamento
- **THEN** nenhum elemento do gesto fica na tela e cliques chegam normalmente aos outros apps

### Requirement: Ajustes e privacidade

Os Ajustes MUST oferecer: ligar/desligar "Falar com o agente", escolher o atalho, ligar/desligar a resposta falada e ligar/desligar o envio do print (padrão ligado). Os Ajustes MUST informar que o áudio vai para o mecanismo de transcrição escolhido e que o print vai para o agente do workspace e para o provedor do modelo dele. Mudanças MUST valer sem reiniciar o app.

#### Scenario: Trocar o atalho

- **WHEN** o usuário troca o atalho nos Ajustes
- **THEN** o atalho antigo para de funcionar e o novo passa a funcionar imediatamente

#### Scenario: Aviso de privacidade

- **WHEN** o usuário abre a seção "Falar com o agente"
- **THEN** vê para onde vão o áudio e o print
