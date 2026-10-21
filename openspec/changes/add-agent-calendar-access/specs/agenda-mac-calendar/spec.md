# Spec Delta

## MODIFIED Requirements

### Requirement: Dados locais

Os eventos do Mac MUST ser usados só na interface do próprio computador e nas ferramentas de calendário do agente do dono. Para essas ferramentas, eles MAY ir ao backend somente como resposta a uma chamada do agente, sem cópia ou cache no servidor fora do histórico da conversa do agente. Eles MUST NOT ir para logs ou para telemetria.

#### Scenario: Log

- **WHEN** a leitura do Calendário do Mac falha
- **THEN** o log registra o código do erro, sem título, local ou observações de eventos

#### Scenario: Chamada do agente

- **WHEN** o agente do dono lista os eventos do Mac
- **THEN** os eventos chegam ao agente na resposta da ferramenta, e nenhum log do app, do conector ou do backend registra título, local ou observações
