# Spec Delta

## Purpose

Permitir que o app desktop do Mac leia e altere os eventos do Calendário do macOS (todas as contas configuradas nele: iCloud, Google, Exchange, locais), com a permissão do sistema concedida ao próprio Comma, sem que esses dados saiam do computador.

## ADDED Requirements

### Requirement: Disponibilidade

O acesso ao Calendário do Mac MUST existir só no app desktop do macOS. No navegador e em outras plataformas, a Agenda MUST não oferecer essa fonte e não mostrar pedido de permissão.

#### Scenario: Navegador

- **WHEN** o usuário abre a Agenda no app web
- **THEN** o painel não mostra o grupo "Calendário do Mac"

### Requirement: Permissão do sistema

O app MUST pedir acesso completo ao Calendário na primeira vez que o usuário ativar a fonte do Mac na Agenda, e nunca antes. O pedido MUST usar um texto que explique o uso, nos idiomas do app. Com acesso negado ou restrito, a Agenda MUST mostrar o motivo e um botão que abre Ajustes do Sistema › Privacidade › Calendários.

#### Scenario: Primeira vez

- **WHEN** o usuário clica em "Ativar Calendário do Mac" pela primeira vez
- **THEN** o macOS mostra o pedido de acesso ao Calendário em nome do Comma

#### Scenario: Acesso negado

- **WHEN** o acesso foi negado
- **THEN** o grupo "Calendário do Mac" mostra "Acesso negado" e o botão "Abrir Ajustes do Sistema"

#### Scenario: Acesso só de escrita

- **WHEN** o macOS concedeu acesso só de escrita
- **THEN** a Agenda trata como sem acesso de leitura e oferece abrir os Ajustes

### Requirement: Calendários do Mac

O app MUST listar os calendários de eventos do Mac com id, nome, cor, nome e tipo da conta de origem, se aceita alterações e se é o padrão para novos eventos.

#### Scenario: Calendário de assinatura

- **WHEN** existe um calendário assinado por URL
- **THEN** ele vem marcado como não editável

#### Scenario: Conta Google no Mac

- **WHEN** a conta `ana@gmail.com` está adicionada no Calendário do Mac
- **THEN** os calendários dela vêm com conta de origem `ana@gmail.com`, que a Agenda usa para evitar duplicatas

### Requirement: Eventos do Mac num período

O app MUST devolver as ocorrências dos calendários pedidos num intervalo de até 62 dias, já expandidas da repetição. Cada ocorrência MUST trazer id estável da ocorrência, id do evento, calendário, título, início, fim, dia inteiro, local, observações, URL, se é editável, se repete e se a repetição é simples (diária, semanal, mensal, anual) ou personalizada. O limite é de 2.500 ocorrências por chamada.

#### Scenario: Evento repetido

- **WHEN** a semana tem três ocorrências de um evento que repete às segundas, quartas e sextas
- **THEN** vêm três ocorrências com repetição "personalizada"

### Requirement: Gravar no Calendário do Mac

O app MUST criar, alterar e apagar eventos em calendários editáveis do Mac, com os mesmos campos da Agenda: título, início, fim, dia inteiro, local, observações, calendário e repetição simples. Ao alterar ou apagar um evento repetido, MUST respeitar a escolha "só este" ou "todos" (este e os seguintes a partir da primeira ocorrência). Em calendário não editável, MUST recusar com erro `calendar_read_only`.

#### Scenario: Mover só uma ocorrência

- **WHEN** a Agenda move a ocorrência de quarta de um evento semanal com "só este"
- **THEN** só essa ocorrência muda no Calendário do Mac

#### Scenario: Calendário não editável

- **WHEN** a Agenda tenta criar um evento num calendário de assinatura
- **THEN** a operação falha com `calendar_read_only` e nada é gravado

### Requirement: Aviso de mudança

Enquanto houver acesso, o app MUST avisar a Agenda quando o banco de dados do Calendário do Mac mudar, inclusive por mudanças feitas em outros apps ou vindas da nuvem. Avisos em sequência MUST ser agrupados, com no máximo um aviso a cada 500 ms.

#### Scenario: Evento criado no app Calendário

- **WHEN** o usuário cria um evento no app Calendário com a Agenda aberta
- **THEN** a Agenda recebe o aviso e mostra o evento em até 2 s

### Requirement: Dados locais

Os eventos do Mac MUST ser usados só na interface do próprio computador. MUST não ir para o backend, para logs ou para telemetria.

#### Scenario: Log

- **WHEN** a leitura do Calendário do Mac falha
- **THEN** o log registra o código do erro, sem título, local ou observações de eventos
