# Proposta

## Por quê

Hoje, para pedir algo ao agente sobre o que está na tela, o dono precisa abrir o Comma, escrever ou colar um print e explicar onde olhar. O Comma já tem agente, sidebar sobre outros apps, transcrição (Parakeet local, Groq ou API compatível) e upload de imagem no chat. Falta o gesto que junta tudo: segurar um atalho em qualquer app, falar e o agente já saber o que é "isso aqui", como no Clicky/OpenClicky.

## O que muda

- **Falar com o agente segurando um atalho**, em qualquer app e com a janela principal fechada:
  - um atalho global próprio, padrão **`⌃⌥` sozinhos** (só modificadores), separado do atalho que abre a sidebar; também aceita tecla + modificador;
  - enquanto o atalho está pressionado, o microfone grava; ao soltar, a gravação termina;
  - com atalho só de modificadores, apertar qualquer outra tecla durante o gesto (ex.: `⌃⌥←`) cancela o turno, porque era outro atalho;
  - gravações curtas demais (abaixo de 0,3 s) são descartadas sem enviar nada.
- **"Isso aqui" vira imagem**: ao apertar o atalho, o Comma tira um print do monitor onde está o cursor e guarda a posição do cursor. Com o atalho pressionado, arrastar o mouse **desenha um traço livre** sobre a tela para marcar o que importa. Seguem junto com a pergunta o print do monitor com o traço desenhado por cima, um recorte ampliado da área do traço (ou da vizinhança do cursor), as coordenadas e o nome do app que estava em primeiro plano.
- **Transcrição pelo mecanismo já escolhido** em Ajustes → Reunião (Local, Groq ou API compatível com OpenAI), com o mesmo fallback para o modelo local.
- **A pergunta vai para o agente sem abrir janela**: texto transcrito + prints anexados (pelo upload de arquivos do chat que já existe) + descrição do ponto ou do traço vão para a conversa do agente do workspace, a mesma da sidebar. A sidebar não abre sozinha; a conversa fica registrada lá.
- **Cursor companheiro**: durante o turno, um indicador ao lado do cursor mostra o nível da voz enquanto ouve, um indicador de espera enquanto o agente pensa e um balão com a frase que está sendo falada na resposta. Ele some alguns segundos depois do fim.
- **Resposta falada**: quando o agente responde, a resposta é lida em voz alta com a voz do sistema, frase por frase, acompanhando o balão. Apertar o atalho de novo interrompe a leitura. Com a voz desligada, o balão fica na tela pelo tempo de leitura, e clicar nele abre a sidebar.
- **Estado no notch**: o notch mostra "Ouvindo", "Transcrevendo", "Pensando" e "Falando", com nível de áudio e cor por estado; erros (sem permissão, transcrição indisponível, nada entendido) aparecem lá com a ação correspondente.
- **Ajustes**: ligar/desligar a função, escolher o atalho (inclusive só modificadores), ligar/desligar a resposta falada, enviar ou não o print.
- **Permissões**: Gravação de Tela pedida para o próprio Comma, só quando o envio do print está ligado; sem ela, a pergunta segue só com o texto e o app avisa. Monitoramento de Entrada pedido só quando o atalho escolhido é só de modificadores; sem ela, o atalho não funciona e o notch avisa com um botão para os Ajustes do Sistema.

Fora do escopo: chamada de voz contínua (`VoiceCallControl`) com fim de fala e interrupção — depende do protocolo da assinatura ChatGPT, que não está documentado; o agente apontar ou desenhar na tela por conta própria; bolinhas de tarefas no canto da tela (o Comma já mostra tarefas no notch); caminho de resposta rápida sem o Router; voz de resposta por provedor pago; Windows e Linux. A função usa o agente do workspace ativo, em modo local ou remoto, sem tratamento especial para cada um além da transcrição.

## Capacidades

### Novas capacidades

- `agent-push-to-talk`: conversa com o agente segurando um atalho global — gravação, captura do contexto da tela (print, ponto, traço), transcrição, envio à conversa do agente, cursor companheiro, estados no notch, resposta falada, permissões e ajustes.

### Capacidades modificadas

Nenhuma. A transcrição reutiliza `meeting-transcription-providers` (change `add-cloud-meeting-asr`, ainda aberta) sem mudar seus requisitos.

## Impacto

- **Helper da sidebar** (`clients/apps/electron/native/macos/SideChatHost`): segundo atalho global com eventos de apertar e soltar e o app em primeiro plano; combinação só de modificadores por event tap de leitura, com estado da permissão de Monitoramento de Entrada; novos frames no contrato (`clients/packages/chat-contract`, Swift gerado).
- **Notch** (`clients/apps/electron/native/macos/NotchHost`, `NotchKit`, `main/notch.ts`): cena de voz com estado, nível e cor, controlada pelo Main.
- **Electron main**: orquestração do turno (gravação com o `MicCaptureHost`, captura com `desktopCapturer`, transcrição pelo helper local ou pela rota do backend, envio pelo coordenador de chat), janela transparente com o cursor companheiro e o traço, leitura em voz alta com `say` frase por frase, ajustes persistidos, textos de uso de Gravação de Tela e Monitoramento de Entrada.
- **Interface** (`clients/packages/app`, `clients/packages/ui`): tela da sobreposição (companheiro, balão e traço), gravador de atalho que aceita só modificadores, seção de ajustes, textos em `en`, `pt-BR` e `zh-CN`.
- **Backend**: nenhuma mudança; usa o upload `POST /v1/comma/groups/:group_id/files` e o chat existentes. O modelo do agente precisa aceitar imagem (ou ter um descritor de imagem configurado) para usar o print; sem isso o agente recebe o texto e a referência ao arquivo.
- **Privacidade**: o print vai para o workspace do agente e, a partir dele, para o provedor do modelo do agente; o áudio vai para o mecanismo de transcrição escolhido. Os Ajustes deixam isso explícito.
