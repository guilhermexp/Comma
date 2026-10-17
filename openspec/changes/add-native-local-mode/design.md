# Design

## Context

Veja `proposal.md` (Why). O que já existe e que este desenho reaproveita:

- O backend já roda nativo no macOS arm64 em desenvolvimento: `.local/native/run.py` sobe Postgres 16 (`initdb`/`postgres`), Redis, MinIO e `mix run` com `COMMA_SUBSYSTEMS=salix,comma_product`. Nada do backend local exige Linux, Docker ou VM. Os Workers (Claude Code, Codex) rodam no Mac pelo `salix-connect`, que o app já empacota; o sandbox em VM (`agent_vmm`) é só da versão hospedada.
- `systems/mix.exs` já define a release `comma` (`include_executables_for: [:unix]`), com as aplicações dos subsistemas.
- `Comma.FreshInstall.run/0` (`systems/apps/comma_core/lib/comma/fresh_install.ex`) prepara um banco vazio (ClickHouse desligado vira no-op, migrações, cutover, configuração dos agentes, compute do grupo, dono) e só roda com `COMMA_ENVIRONMENT=local` ou `selfhost`. `systems/devcontainer/bootstrap.exs` é o ponto de entrada usado hoje.
- `Comma.Admin.create_session/2` aceita `"local_dev" => true` com `ttl_seconds` para uma sessão completa; `POST /v1/comma/admin/users` e `POST /v1/comma/admin/users/:id/sessions` são o caminho que `systems/scripts/comma-local-dev-seed.mjs` usa, autenticado pelo token de administração da configuração.
- `clients/apps/electron/src/main/startup-session.ts` já sabe colocar um token de sessão no armazenamento seguro do Main, mas recusa em app empacotado (`if (isPackaged) return undefined`).
- O release (`.github/workflows/desktop-release.yml`, `scripts/release-velopack.ts`) empacota, assina ad hoc e publica no GitHub Releases. A URL da API é fixada no build (`COMMA_DEFINED_API_BASE_URL` em `vite.main.config.ts`).

Restrições medidas nesta máquina: os binários do Homebrew não são relocáveis. O `crypto.so` do Erlang aponta para `/opt/homebrew/opt/openssl@4/lib/libcrypto.4.dylib`; o `postgres` aponta para gettext, zstd, lz4, openssl@3, krb5 e icu4c em `/opt/homebrew`; o `redis-server` aponta para openssl@3. As NIFs `salix_signal` e `salix_signal_proto` linkam libopus e libsodium do Homebrew.

## Goals / Non-Goals

**Goals:**

- Um único `.app` arm64 que roda o backend sem nada instalado na máquina.
- Reaproveitar o backend como ele é: nenhuma mudança de comportamento de domínio, só configuração e pontos de entrada.
- Um gate de build que impede publicar um pacote que só funciona no Mac de quem gerou.

**Non-Goals:**

- Modo cloud, tela de escolha de modo, troca de backend em tempo de execução pela interface.
- Remover o Redis ou o MinIO do backend (dá para fazer depois; aqui eles vão empacotados).
- Intel/x86_64, notarização, Developer ID.
- Mudar o fluxo de desenvolvimento (`pnpm dev:electron` continua apontando para o backend externo).

## Decisions

### D1. Processos nativos supervisionados pelo Main, sem VM

O Main do Electron sobe quatro processos filhos: `postgres`, `redis-server`, `minio` e a release `comma` (`bin/comma start`). Alternativas: VM local com Virtualization.framework (o `Agent VMM Host` existente só sabe ser nó de compute de um backend remoto, depende de um repositório privado e exigiria imagem Linux, disco de 15 a 30 GB e RAM reservada) e reescrever o backend em Rust (cerca de 1,2 milhão de linhas de Elixir mais o kernel em Lean). Processo nativo é o que já funciona hoje e custa só empacotamento.

### D2. Origem dos binários e relocação

- **Backend**: `MIX_ENV=prod mix release comma` no runner macOS arm64, com as etapas nativas espelhadas do `systems/Dockerfile` (verified kernel via Lean/lake, NIFs C via `elixir_make`, `mdex` precompilado, `spinfoam` fixado, `mix assets.deploy`). A ERTS vai dentro da release.
- **OpenSSL, libsodium, libopus**: compilados no CI a partir do fonte com versão e sha256 fixados, instalados num prefixo do build, e linkados pela ERTS (via `kerl`/`asdf` com `--with-ssl=<prefixo>`, ou Erlang compilado no CI) e pelas NIFs. Alternativa descartada: copiar as dylibs do Homebrew e reescrever com `install_name_tool`, porque cada atualização do Homebrew no runner muda versões e caminhos sem aviso.
- **Postgres 16**: binários relocáveis já prontos e versionados (os `embedded-postgres-binaries` darwin arm64 do projeto zonky), com sha256 fixado. Eles trazem só o que o servidor precisa e já usam `@loader_path`. As extensões usadas (`citext`, `pgcrypto`, `btree_gin`, `pg_trgm`) fazem parte do contrib e precisam estar no pacote; o build confere isso.
- **Redis**: compilado do fonte no CI com `BUILD_TLS=no` (só loopback, sem TLS), sem dependências externas.
- **MinIO**: binário oficial darwin-arm64 (Go estático) com versão e sha256 fixados.
- Tudo fica em `Contents/Resources/local-backend/` e é assinado ad hoc no mesmo passo do resto do app.
- **Gate**: um script percorre todos os Mach-O do pacote com `otool -L` e falha se alguma dependência não começar por `@rpath`, `@loader_path`, `@executable_path`, `/usr/lib/` ou `/System/`. Roda no build local e no CI antes de empacotar com o Velopack.

### D3. Dados, segredos e portas

- Pasta: `~/Library/Application Support/Comma/local/` com `postgres/`, `minio/`, `redis/`, `logs/`, `backups/`, `secrets.json` e `state.json`. É separada de `.local/native` do dono e do perfil `@comma-dev`.
- `secrets.json` (modo 0600) é gerado na primeira abertura com valores aleatórios: senha do Postgres, senha do Redis, chave de acesso e segredo do MinIO, cookie da release, `secret_key_base`, token de administração e a chave de armazenamento de assinaturas (`SALIX_SUBSCRIPTION_STORAGE_KEY`). Alternativa considerada: Keychain pelo `safeStorage`. Descartada nesta etapa porque, com assinatura ad hoc, cada atualização muda a identidade do código e o macOS volta a pedir acesso ao Keychain; os dados já ficam no disco do mesmo usuário, então o arquivo 0600 não reduz a proteção real. A chave de assinaturas não pode mudar depois de criada (os dados de conta selados dependem dela).
- Portas: o app escolhe portas livres em `127.0.0.1` na primeira abertura, guarda em `state.json` e reusa enquanto estiverem livres. Se alguma estiver ocupada, escolhe outra. Todos os serviços escutam só em `127.0.0.1`. Postgres usa senha (`scram-sha-256`) e socket desabilitado; Redis usa senha e `bind 127.0.0.1`; MinIO usa as chaves geradas.
- A configuração do backend (`SALIX_CONFIG_PATH`) é gerada pelo Main a partir de `secrets.json` e `state.json`, no mesmo formato de `.local/native/config.json`, a cada abertura.

### D4. Inicialização e ciclo de vida

Ordem na abertura: matar processos que ficaram de uma sessão anterior (PIDs registrados em `state.json`, conferindo o executável antes de sinalizar), subir Postgres (na primeira vez, `initdb` e criação do banco), Redis e MinIO (criando o bucket na primeira vez), preparar o banco e então subir o backend. O app espera `/health` em 4000 e 4200 antes de abrir a interface conectada.

- **Preparação do banco**: um comando único da release (`bin/comma eval` chamando `Comma.FreshInstall.run/0`, com `COMMA_ENVIRONMENT=local`) roda antes do backend servir. Ele já é idempotente: na primeira vez cria tudo, nas seguintes só aplica migrações pendentes.
- **Backup**: quando a versão do app em `state.json` difere da atual, o app roda `pg_dump` para `backups/` antes da preparação e mantém os 3 mais recentes.
- **Supervisão**: cada filho tem reinício com espera crescente (1 s, 2 s, 4 s até 30 s). Cinco falhas em 2 minutos param a supervisão daquele processo e mostram a tela de erro.
- **Encerramento**: no `before-quit`, o app pede encerramento ao backend, depois Postgres em modo `fast` (sem perda de dados confirmados), Redis e MinIO, com tempo limite; quem não encerrar recebe `SIGKILL`.
- **Tela de inicialização e erro**: tela própria no renderer, mostrada antes da interface normal. Segue o padrão visual do app (skill `impeccable`). O erro mostra causa resumida, botão "Tentar de novo", "Mostrar logs" e onde ficam os backups.

### D5. Entrada automática do dono

- Depois do `/health`, o Main garante o dono: na primeira vez, `POST /v1/comma/admin/users` com um e-mail local fixo da instalação (por exemplo `owner@local.comma`), guardando o id em `state.json`; em seguida `POST /v1/comma/admin/users/:id/sessions` com `local_dev: true` e TTL longo. O token vai direto para o armazenamento seguro de sessão do Main pelo mesmo caminho do `startup-session.ts`, que passa a aceitar sessão em app empacotado quando ela vem do backend local.
- Se o backend recusar a sessão guardada (401), o Main cria outra. "Sair" revoga a sessão atual e repete a criação.
- O token de administração fica só no Main e em `secrets.json`; vai ao backend pelo arquivo de configuração, nunca por argumento de linha de comando ou variável visível ao renderer.
- O backend local aceita o token de administração só de conexões de loopback. Como tudo escuta em `127.0.0.1`, isso já vale; o backend ganha uma checagem explícita do IP de origem nas rotas de administração quando `COMMA_ENVIRONMENT=local`, para não depender só do bind.
- A interface de login não aparece: o Main só abre a interface depois da sessão criada; se a sessão some, ele recria antes de mostrar qualquer tela de login.

### D6. URL da API em tempo de execução

O build de release passa a gerar o flavor `prod` com o modo local ligado (`COMMA_DEFINED_BACKEND_MODE=local`) e sem URL de API fixa. Com o modo local, o Main define a URL da API a partir da porta escolhida (`http://127.0.0.1:<porta>`) antes de criar janelas; o renderer recebe essa URL pelo canal que já usa para a configuração do release. O flavor `dev` continua com `COMMA_API_BASE_URL` como hoje. A variável de repositório `COMMA_API_BASE_URL` sai do workflow.

## Risks / Trade-offs

- [Compilar Erlang e OpenSSL no CI deixa o build longo] → cachear o prefixo de dependências nativas pela chave das versões fixadas; o build sem cache roda só quando uma versão muda.
- [Os binários do zonky deixam de ser publicados ou mudam] → sha256 fixado no repositório; se um dia faltar, o fallback é compilar o Postgres do fonte no mesmo prefixo de D2.
- [O verified kernel em Lean pode não compilar no runner `macos-26`] → validar cedo (tarefa 1.x); o kernel precisa estar no pacote, então essa é a primeira prova.
- [O DMG cresce para 350 a 450 MB e as atualizações completas também] → os deltas do Velopack cobrem as atualizações normais; só a primeira instalação baixa tudo.
- [Ad hoc: o Gatekeeper bloqueia a primeira abertura] → já documentado (`xattr` ou botão direito → Abrir); notarização fica para quando houver Developer ID.
- [Atualização no meio do uso troca os binários enquanto os processos rodam] → o Velopack só aplica ao fechar e reabrir, e o encerramento de D4 para tudo antes.
- [Migração destrutiva numa versão nova] → backup de D4 antes de migrar e erro claro se a migração falhar.
- [Outro usuário do mesmo Mac] → cada usuário macOS tem a própria pasta e as próprias portas; os serviços exigem senha mesmo em loopback.

## Migration Plan

- Quem tem a 0.0.2 instalada recebe a versão nova pela atualização automática. O app passa a usar o backend local e ignora o backend `127.0.0.1:4200` do ambiente de desenvolvimento; o dono continua usando esse ambiente pelo `pnpm dev:electron`.
- A primeira abertura cria uma instalação local vazia. Os dados do ambiente de desenvolvimento do dono não são importados (fora do escopo).
- Reverter: publicar uma versão nova sem o modo local. Os dados em `Application Support/Comma/local` ficam intactos.

## Open Questions

- Versões exatas a fixar (Erlang/OTP, OpenSSL, Postgres 16.x, Redis, MinIO): escolhidas na implementação, alinhadas com as que o backend usa hoje no `systems/Dockerfile` e no `.tool-versions`, se existir.
