# SEMPER-FI · Backend

API de gestão jurídica, investigação estruturada e evidências digitais. FastAPI, SQLAlchemy assíncrono, Alembic e Celery, com rotas sob `/v1`. A interface fica em [../front-end](../front-end/README.md).

## Estado atual

- Núcleo de clientes, processos, andamentos, prazos, agenda, intimações e financeiro com persistência.
- Cadastro e login PF/PJ com senha e código por e-mail, sessão opaca em cookie HttpOnly e alternativa de provedor OIDC. Acesso técnico restrito a desenvolvimento/testes explícitos.
- Recuperação de senha por código de e-mail, com expiração, limites, resposta sem revelar existência da conta e revogação das sessões por senha anteriores.
- Isolamento por `tenant_id`, políticas, auditoria encadeada, conectores e motores TACER/SIERA.
- Ingestão, cofre e relatórios dependem de serviços externos. Agentes supervisionados usam provider Ollama desacoplado, com filas e resultados persistidos; execução real depende da instalação/configuração local.
- Checkout Asaas **somente Sandbox** com preço no servidor, idempotência e webhook autenticado. Não libera assinatura, carteira ou créditos de produção.
- Inicialização cria tabelas em desenvolvimento/teste, **sem popular registros fictícios**. Em produção, o operador aplica migrations.
- Nenhum banco existente é apagado ou automaticamente limpo pela aplicação.

## Requisitos

### Configuração de homologação: Asaas e Ollama

As credenciais são lidas exclusivamente de `back-end/.env`, ignorado pelo Git. `.env.example` contém apenas nomes de variáveis e valores sem segredo. Nenhuma chave é enviada ao frontend. O ambiente atual permanece local: frontend `http://127.0.0.1:4173` e API `http://127.0.0.1:8000`.

**Asaas Sandbox**

- `ASAAS_SANDBOX_ENABLED=false`: manter desabilitado até concluir a configuração pública de homologação.
- `ASAAS_SANDBOX_API_KEY`: chave da conta Sandbox, com prefixo de homologação; o adapter não aceita produção.
- `ASAAS_WEBHOOK_TOKEN`: segredo aleatório próprio, de pelo menos 32 caracteres, configurado também no webhook do Asaas.
- `ASAAS_CHECKOUT_RETURN_URL`: URL HTTPS pública do frontend. Deixar em branco enquanto não houver hospedagem/túnel; não usar endereço fictício.
- O webhook deve apontar para a futura origem pública da API mais `/v1/billing/webhooks/asaas`. Essa origem pertence à configuração de hospedagem/Asaas; não é codificada no frontend nem presumida pelo servidor.
- Configurar os eventos `CHECKOUT_CREATED`, `CHECKOUT_PAID`, `CHECKOUT_CANCELED` e `CHECKOUT_EXPIRED`. O header `asaas-access-token` é verificado em tempo constante; repetição de evento é idempotente. O callback serve somente para retornar à interface.
- Aplicar `alembic upgrade head` no banco de homologação após backup, antes de iniciar a nova versão. O head atual é `20260929_0008`: inclui pedidos/webhooks Sandbox, perfis complementares, equipe/convites, planejamentos e documentos vinculados. Os testes SQLite não homologam RLS nem contas reais.
- O fluxo implementado é **assinatura mensal por cartão no Sandbox**. Pagamento confirmado produz somente estado de teste. Créditos, carteiras, adicionais, recorrências posteriores, troca/cancelamento e franquias de produção ainda não estão integrados.

Referências do contrato: [checkout recorrente Asaas](https://docs.asaas.com/docs/checkout-com-assinatura-recorrente) e [eventos do checkout](https://docs.asaas.com/docs/eventos-para-checkout).

**Ollama local**

```dotenv
AI_PROVIDER=disabled
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=
OLLAMA_TIMEOUT_SECONDS=120
```

Manter o modelo vazio até confirmar instalação, memória disponível e GPU/VRAM. A máquina informada possui 16 GB de RAM; esta configuração não presume um modelo adequado. Após instalar um modelo local, configurar seu nome exato e `AI_PROVIDER=ollama`. Em contêiner, configurar a origem privada alcançável pelo worker; loopback dentro do contêiner não é o host.

`AgentProvider` separa a aplicação do fornecedor. O adapter atual chama `/api/chat`, sem streaming, com schema JSON, limite de resposta e timeout. Não há fallback cloud, execução de ferramentas ou publicação automática de conclusões. Referência: [API do Ollama](https://docs.ollama.com/api/chat).

`GET /v1/agents/status` indica a configuração, não a saúde do modelo. `POST /v1/agents/runs` registra o texto e enfileira; `GET /v1/agents/runs` e `GET /v1/agents/runs/{id}` acompanham estados `queued`, `running`, `pending_human_review` ou `failed`. Worker, Redis e modelo precisam estar disponíveis. Falhas ficam registradas sem fabricar resultados. Evidências e investigações fornecidas são validadas por organização; o modelo só pode referenciar IDs presentes na entrada.

### Fluxos revisados nesta entrega

- Formulários jurídicos validam campos, valores e relacionamentos; respostas PATCH são serializadas após atualizar valores gerados pelo banco. Auditor tem leitura, sem permissão para mutações/importação.
- Lançamento de intimação é atômico e idempotente, com testes de concorrência e rollback.
- A importação valida o lote inteiro antes de gravar: dados nulos, IDs duplicados, vínculos ausentes e valores/datas inválidos retornam 422. Nenhum processo ou prazo é descartado silenciosamente.
- Consultas externas são enfileiradas e acompanhadas até um resultado terminal; `queued` não significa sucesso. Retomar acompanhamento não cria nova consulta.
- Radar CNPJ usa a fila e o histórico `GET /osint/runs?connector_id=brasilapi&kind=cnpj`. A lista omite dados brutos e payload de autorização; resultado completo exige leitura autenticada da execução da própria organização.
- Exclusões de cliente/processo com dependências e reassociação incompatível retornam 409. Escritas relacionadas bloqueiam as linhas-pai durante a transação PostgreSQL; histórico não sofre cascata.
- Aprovação de relatórios e downloads exigem referências válidas, tenant e MFA. O hash de preservação usa os bytes do PDF.
- Upload, finalização, histórico, verificação e download de evidências estão ligados à interface. Finalização mantém o original temporário até confirmar a transação; atestação exige preservação.
- A interface distribuída em `app/static/frontend` inclui temas, acessibilidade e os módulos operacionais novos. Alterações devem partir de `front-end`, seguido do script de sincronização.
- `/billing/status` fornece resumo sem links de pagamento ou IDs de pedido para perfis comuns; consulta do pedido completo exige administrador. A restrição independe da apresentação do frontend.

As limitações por aba e o critério de prontidão ficam no [README do frontend](../front-end/README.md#prontidão-para-lançamento).

| Componente | Finalidade |
| --- | --- |
| Python `>=3.12,<3.14` | Contrato de `pyproject.toml`; validado com Python 3.12 |
| uv e `uv.lock` | Instalação reproduzível e ambiente do projeto |
| SQLite + aiosqlite | Teste local do núcleo |
| PostgreSQL 16 | Implantação com RLS e recursos PostgreSQL |
| Redis 7 | Sessões em implantação, broker/resultados de filas |
| Celery worker + beat | Jobs e despacho periódico do outbox |
| S3/MinIO | Cofre versionado com Object Lock configurado |
| `file`, ExifTool, qpdf, ffmpeg, Tesseract, ClamAV | Pipeline de ingestão; ferramentas presentes na imagem Docker |
| Provedor OIDC | Identidade institucional e MFA |
| Node.js 22/24 | Desenvolvimento frontend e sincronização dos assets; dispensável na imagem Python final |
| Docker + Compose, opcional | Infraestrutura local completa |

## Início rápido: núcleo local vazio

Na pasta `back-end`, em PowerShell:

```powershell
uv sync --all-groups --python 3.12
$env:ENVIRONMENT = "development"
$env:AUTH_MODE = "password"
$env:ALLOW_SELF_REGISTRATION = "true"
$env:ALLOW_DEVELOPMENT_IDENTITY_HEADERS = "false"
$env:DATABASE_URL = "sqlite+aiosqlite:///./semperfi-local.db"
$env:REDIS_URL = "redis://127.0.0.1:6379/0"
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Essas variáveis prevalecem sobre `.env`, se existir. Use banco dedicado para separar testes de bases existentes. Sem Redis, a sessão usa memória somente em desenvolvimento/teste e é perdida no reinício. SQLite permite testar o núcleo; filas, anexos e cofre exigem os respectivos serviços.

Antes de cadastrar ou entrar por senha, configure o [envio do código por e-mail](#envio-do-código-por-e-mail). O acesso em duas etapas é obrigatório também no modo de senha local; ausência de SMTP não cria uma sessão nem exibe códigos de teste.

Execute o frontend em outro terminal conforme seu README. Para servir a distribuição pela própria API:

```powershell
cd ..\front-end
npm run sync:backend
```

| Endereço | Finalidade |
| --- | --- |
| `http://127.0.0.1:8000/` | Redireciona para a interface com caminhos corretos |
| `/ui/frontend/login.html` | Tela de entrada |
| `/v1/docs`, `/v1/redoc`, `/v1/openapi.json` | Documentação e contrato |
| `/health/live` | Processo ativo |
| `/health/ready` | Consulta o banco; retorna 503 se indisponível |

Readiness verifica o banco, não certifica filas, Redis, credenciais ou cofre.

### Docker e migrations

Se não houver `.env`, copie `.env.example` e ajuste os valores. **Não sobrescreva uma configuração existente.**

```powershell
Copy-Item .env.example .env
docker compose up --build
```

O Compose inclui PostgreSQL, Redis, MinIO, inicialização do bucket, ClamAV, API, worker e beat. `postgres`, `redis` e `minio` são nomes internos dessa rede; para executar a API no host, configure `127.0.0.1` nos endereços apropriados.

```powershell
docker compose exec api alembic upgrade head
```

`docker compose down` e `make compose-down` preservam volumes. Não use `down -v` para encerrar ambientes cujos dados devam ser mantidos.

### Hospedagem e operação

O Compose fornecido é para desenvolvimento: usa `--reload`, montagem do código local, credenciais de exemplo e portas de infraestrutura publicadas. Para hospedagem, prepare uma configuração própria com `ENVIRONMENT=production`, credenciais reais, migrations aplicadas e serviços persistentes. O registro público é controlado por `ALLOW_SELF_REGISTRATION`; cada nova conta cria uma organização separada.

Sirva a interface e `/v1/*` pela mesma origem HTTPS. A própria API pode entregar `/ui/frontend/`, ou um proxy reverso pode encaminhar a API e servir os assets. O servidor Node do frontend escuta somente em loopback e não é o servidor de implantação. O gateway deve aceitar cookies e o tamanho de requisição necessário a `MAX_UPLOAD_BYTES` mais o envelope multipart.

Redis é necessário para sessões e limitação de tentativas em produção. A indisponibilidade desse serviço bloqueia novos acessos; o fallback em memória existe somente em desenvolvimento/teste e é local ao processo. Cookies `Secure` e HSTS são ativados quando `ENVIRONMENT=production`; o valor `staging` não ativa essas duas proteções automaticamente. Configure endereços de proxy confiáveis para que o limite por IP use o cliente correto.

PostgreSQL/RLS, Redis/filas e S3/Object Lock precisam ser homologados com os serviços da hospedagem. Em PostgreSQL, use uma identidade de aplicação sem privilégio de ignorar RLS. Para evidências, provisione diretório de staging, ferramentas de ingestão e cofre, com backup/restauração do banco e dos objetos. A disponibilidade da rota de saúde não valida esses componentes. Para OIDC com várias réplicas, veja a limitação de estados temporários na seção de autenticação.

## Configuração

Campos em `app/core/config.py`; referência em `.env.example`.

| Grupo | Variáveis |
| --- | --- |
| Aplicação | `ENVIRONMENT`, `APP_NAME`, `API_V1_PREFIX`, `LOG_LEVEL`, `CORS_ORIGINS` |
| Dados | `DATABASE_URL`, `FIELD_ENCRYPTION_KEY`, `EVIDENCE_STAGING_DIR` |
| Filas/sessões | `REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`, `SESSION_COOKIE_NAME`, `SESSION_TTL_SECONDS` |
| Identidade | `AUTH_MODE`, `ALLOW_SELF_REGISTRATION`, `ALLOW_DEVELOPMENT_IDENTITY_HEADERS`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_JWKS_URL`, `MFA_MAX_AGE_SECONDS` |
| Verificação por código | `AUTH_OTP_SIGNING_KEY`, `CHALLENGE_COOKIE_NAME`, `AUTH_OTP_TTL_SECONDS`, `AUTH_OTP_COOLDOWN_SECONDS`, `AUTH_OTP_MAX_ATTEMPTS` |
| E-mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_ADDRESS`, `SMTP_TIMEOUT_SECONDS` |
| Cofre | `S3_ENDPOINT_URL`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_EVIDENCE`, `S3_KMS_KEY_ID`, `S3_OBJECT_LOCK_MODE`, `S3_OBJECT_LOCK_ENABLED`, `S3_RETENTION_DAYS`, `S3_PRESIGN_EXPIRES_SECONDS` |
| Ingestão | `MAX_UPLOAD_BYTES`, `ALLOWED_MIME_TYPES` |
| Conectores | `TRANSPARENCY_API_KEY`, `DATAJUD_API_KEY`, `DATAJUD_BASE_URL`, `BRASIL_API_BASE_URL` |
| Observabilidade | `SENTRY_DSN` é previsto; sua presença não instala toda a instrumentação |

Segredos não são enviados aos assets nem ao endpoint público de autenticação. O frontend/proxy usa `/v1`; alterar `API_V1_PREFIX` exige alinhar o gateway e a interface.

## Autenticação

### Conta com e-mail e senha

O modo padrão é `AUTH_MODE=password`. O cadastro recebe `account_type` (`PF` ou `PJ`), nome da pessoa responsável, e-mail e senha de 12–128 caracteres. PJ também exige `organization_name`; PF usa o nome da pessoa para seu espaço individual. Senhas são armazenadas com hash scrypt e salt individual.

`POST /v1/auth/register` retorna 202 e inicia uma verificação; não cria usuário nem organização ativa. `POST /v1/auth/login` valida a senha e o vínculo compatível com o tipo de conta escolhido, mas também exige código. Ambos retornam `authenticated:false`, `verification_required:true` e `pending_verification`, com destino mascarado e prazos, sem revelar o código.

Somente `POST /v1/auth/verify` com `{ "code": "<seis dígitos recebidos>" }` conclui o cadastro ou login e emite o cookie de sessão. O código confirma a posse do e-mail e registra `mfa_verified_at`; ações que exigem verificação recente continuam sujeitas a `MFA_MAX_AGE_SECONDS`. Sessões antigas de senha sem segunda etapa deixam de ser aceitas.

Os desafios ficam no banco, associados a um cookie opaco HttpOnly. O banco guarda digest do cookie e HMAC do código; a senha pendente já está em hash. Por padrão, o código expira em 600 segundos, admite até cinco tentativas e só pode ser usado uma vez. `/auth/resend` permite reenvio após 60 segundos, invalidando o código anterior; `/auth/cancel` invalida o desafio. `/auth/status` permite retomar a verificação no mesmo navegador.

`AUTH_MODE` seleciona um modo por implantação: `password`, `oidc` ou `development`. Preencher as variáveis OIDC não habilita entrada institucional junto com senha; o modo precisa ser alterado. Sessões de outro modo deixam de ser aceitas após essa alteração.

`ALLOW_SELF_REGISTRATION=false` bloqueia novos cadastros na API e na interface. Informar o nome de uma organização existente não cria vínculo com ela: cada cadastro confirmado cria outro espaço. E-mails de conta permanecem únicos. Convites e gestão de membros ainda não têm fluxo próprio; o login usa o primeiro vínculo ativo compatível com o tipo solicitado. Contas antigas com tipo nulo continuam acessíveis, sem classificá-las automaticamente como PF/PJ. Clientes jurídicos cadastrados em `/clients` são registros operacionais, separados das contas de acesso. O script `provision-user.py` permanece específico para OIDC.

As migrations 0002/0003 acrescentam credenciais, tipo de conta e desafios de verificação sem apagar contas existentes. Em produção, execute `uv run alembic upgrade head` antes de iniciar a nova versão. SQLite em desenvolvimento/teste também possui atualização aditiva. Contas OIDC existentes não recebem senha automaticamente.

Contas, organizações e vínculos inativos são revalidados ao consultar a sessão. Senhas e códigos não são refletidos nos erros de validação dos endpoints de autenticação. Envio por SMS ainda não está implementado.

**Recuperação de senha:** `POST /v1/auth/password/forgot` recebe o e-mail e responde 202 de forma equivalente para contas elegíveis e desconhecidas. O envio usa a configuração SMTP existente, após a resposta HTTP. `POST /v1/auth/password/reset` recebe `code` e `password` (12–128 caracteres), exige o cookie de desafio do mesmo navegador e valida expiração, tentativas e uso único. Reenvio/cancelamento usam os endpoints de desafio existentes. A redefinição invalida sessões por senha mediante versão de credencial verificada no servidor em cada requisição; exige novo login e 2FA. Desafios concorrentes não podem sobrescrever uma alteração de senha posterior. Sessões por senha anteriores a esta versão da aplicação precisarão de novo login uma vez. Nenhuma migration nova é necessária para esse fluxo.

### Envio do código por e-mail

Configure os valores reais do seu provedor em variáveis de ambiente ou no `.env` privado:

| Variável | Configuração |
| --- | --- |
| `SMTP_HOST`, `SMTP_FROM_ADDRESS` | Servidor de envio e remetente autorizado pelo provedor |
| `SMTP_PORT`, `SMTP_SECURITY` | Normalmente 587 com `starttls` ou 465 com `ssl`; conforme o provedor |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Credenciais do provedor; podem ficar vazias apenas para um relay confiável sem autenticação |
| `AUTH_OTP_SIGNING_KEY` | Segredo aleatório com pelo menos 32 caracteres, estável e compartilhado entre réplicas em staging/produção |
| `SMTP_TIMEOUT_SECONDS` | Limite da operação de envio; padrão de 10 segundos |

O transporte verifica TLS e falha explicitamente se a configuração ou o envio não estiverem disponíveis. Não existe envio fictício, código fixo, retorno de código na API ou fallback em console. Os testes substituem o transporte para não enviar mensagens externas. Em desenvolvimento, a chave de assinatura pode ser efêmera; reiniciar o processo nesse caso exige solicitar outro código.

A entrega SMTP aceita pelo provedor não garante recebimento na caixa de entrada: valide remetente, domínio e entrega com sua infraestrutura. Esta etapa comprova acesso ao e-mail, não identidade profissional ou representação da pessoa jurídica. Códigos por e-mail não são resistentes a phishing; a segurança depende também da conta de e-mail. Referências: [OWASP — autenticação multifator](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) e [transporte SMTP do Python](https://docs.python.org/3/library/smtplib.html).

### Desenvolvimento

Exige `ENVIRONMENT=development` ou `test`, `AUTH_MODE=development` e `ALLOW_DEVELOPMENT_IDENTITY_HEADERS=true`. A tela exige ação explícita para criar o cookie. Nesse modo, a API ainda aceita cabeçalhos técnicos e identidade padrão: **não é autenticação de usuário final**.

O acesso técnico não provisiona automaticamente Tenant/User no PostgreSQL. Para testes com suas restrições referenciais, provisione a organização e a conta e use seus IDs nos cabeçalhos técnicos, ou configure OIDC. Os testes SQLite não validam RLS.

### Institucional e provisionamento

Configure issuer, client ID, client secret, `AUTH_MODE=oidc` e callback idêntico ao cadastrado no provedor. No desenvolvimento via proxy, o callback pode ser `http://127.0.0.1:4173/v1/auth/oidc/callback`. Em produção, use HTTPS e desabilite os cabeçalhos técnicos.

O fluxo valida assinatura RS256, issuer, audiência do client ID, nonce e estado associado ao navegador. A audiência segue o [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation). `OIDC_AUDIENCE` é configuração legada; o ID Token é validado contra `OIDC_CLIENT_ID`.

```powershell
uv run python scripts/provision-user.py --help
```

Forneça `--tenant-name`, `--tenant-slug`, `--email`, `--name` e `--subject` com os dados aprovados. `--subject` é o claim `sub` do provedor; `--role` escolhe um perfil permitido. Aplique migrations antes. O comando rejeita e-mail já existente para não alterar vínculos silenciosamente. Não cria clientes ou casos de exemplo.

No modo OIDC, o provedor trata senha/MFA. Estados OIDC pendentes ficam na memória por até dez minutos: homologação com um processo; múltiplos workers/réplicas exigem armazenamento compartilhado desses estados. Sessões autenticadas usam Redis em implantação. O provedor real ainda precisa ser homologado.

## Requisitos funcionais

| ID | Capacidade | Implementação/condição |
| --- | --- | --- |
| RF-B01 | Consultar opções de entrada e sessão | `GET /auth/status`, sem autenticação implícita |
| RF-B02 | Cadastrar PF/PJ, autenticar, recuperar senha, encerrar sessão e consultar identidade | `/auth/register`, `/auth/login`, `/auth/verify`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/resend`, `/auth/cancel`, `/auth/session`, `/auth/logout`, `/me` |
| RF-B03 | Confirmar segunda etapa de autenticação | Código por e-mail no modo senha; MFA delegado ao provedor no modo OIDC |
| RF-B04 | Separar organizações | Filtros `tenant_id`, contexto do banco e migration RLS |
| RF-B05 | Gerir clientes/processos | CRUD, consulta e soft delete |
| RF-B06 | Gerir andamentos, prazos, agenda, intimações e financeiro | Rotas em `legal.py` e `legal_extra.py` |
| RF-B07 | Carregar estado inicial da interface | `/frontend/bootstrap`, dados da organização |
| RF-B08 | Importar clientes e processos | `/imports/frontend-demo`; execução explícita, sem seed automático |
| RF-B09 | Gerir investigações, entidades, relações e achados | Políticas e auditoria em `investigations.py` |
| RF-B10 | Executar conectores | BrasilAPI, DataJud, Transparência e RDAP; depende da fonte/configuração |
| RF-B11 | Planejar/analisar investigações | TACER/SIERA determinísticos, histórico persistido, reenvio idempotente e revisão humana registrada |
| RF-B12 | Processar tarefas | Celery, Redis, outbox e beat |
| RF-B13 | Ingerir/preservar evidências | Upload, hash, metadados, finalização e S3/Object Lock |
| RF-B14 | Solicitar/confirmar legal hold | Segundo usuário e autorização |
| RF-B15 | Gerar, aprovar e baixar relatórios | Versionamento, PDF e cofre; depende da infraestrutura |
| RF-B16 | Registrar/verificar auditoria | Cadeia de eventos e `/audit-events/verify-chain` |
| RF-B17 | Assistência supervisionada | Provider Ollama, JSON validado, resultado persistido, consulta de execução e revisão humana; sem modelo predefinido nem fallback cloud |
| RF-B18 | Saúde e contrato | Health checks e OpenAPI |
| RF-B19 | Servir a interface | Artefato gerado com apresentação pública, catálogo e painel autenticado; sem servidor Node embarcado |
| RF-B20 | Cobrança comercial | Checkout mensal por cartão no Asaas Sandbox; callback não confirma pagamento; carteiras e ciclo comercial de produção pendentes |

O contrato exato de métodos, payloads e respostas é `/v1/openapi.json`. Implementação não equivale a homologação com serviços reais.

### Integração com a interface

As capacidades da API e as ações disponíveis na UI têm escopos diferentes:

- O cadastro principal e o lançamento conjunto de intimação usam a API. `POST /intimations/{id}/launch` cria andamento e, opcionalmente, prazo/compromisso em uma transação. Repetição idêntica retorna os mesmos identificadores; alterações conflitantes retornam 409. Relacionamentos validam organização, existência e compatibilidade cliente/processo. Auditor não pode escrever.
- O perfil complementar possui leitura/gravação autenticada, proteção por versão e criptografia pelo cipher configurado. Documentos relacionam evidências existentes a clientes/processos da mesma organização, preservando o arquivo e a custódia ao desfazer o vínculo.
- A tela Arquivos usa `/evidences`, `/evidences/uploads` e ações de finalização, eventos, verificação e download. Inspeção temporária no navegador permanece separada. Vínculo direto a processo/cliente ainda não foi implementado; a investigação pode fornecer esse contexto.
- TXT/JSON agora fazem parte de `ALLOWED_MIME_TYPES` padrão e `.env.example`. Conteúdo deve ser UTF-8 válido; JSON exige parse válido e rejeita NaN/Infinity. Extensão/MIME incompatíveis e conteúdo binário são rejeitados; bytes originais, BOM e hash não são reescritos. Downloads são anexos; antivírus, limite de tamanho e preservação continuam exigidos. Configurações antigas que definam a lista explicitamente precisam incluir `text/plain,application/json`. Cofre e pipeline também precisam estar disponíveis.
- TACER/SIERA possuem formulários, histórico, detalhe e revisão na interface. Planejam o trabalho com regras fixas, sem consulta externa nem inferência por IA. Checklists e matriz ACH sem persistência foram retirados; o roteiro consultivo foi mantido. A seção Agentes IA permanece desacoplada e exige revisão dos resultados.
- A aba Auditoria consulta eventos persistidos e `/audit-events/verify-chain`. Atividades temporárias do navegador não são apresentadas nessa aba como prova da cadeia do servidor.

## Requisitos não funcionais

| ID | Requisito | Evidência/limite |
| --- | --- | --- |
| RNF-B01 | Isolamento entre organizações | Teste lógico; RLS precisa de PostgreSQL e perfil sem bypass |
| RNF-B02 | Autorização no servidor | Principal, RBAC/ABAC, MFA recente e avaliações de políticas |
| RNF-B03 | Identificadores protegidos | Criptografia configurável; `dev::` somente em desenvolvimento |
| RNF-B04 | Credenciais/sessão protegidas | Hash scrypt, limite de tentativas, HttpOnly, SameSite, Secure em produção, expiração, revogação e revalidação de conta |
| RNF-B05 | Rastreabilidade | Auditoria/eventos por hash; concorrência e retenção exigem homologação |
| RNF-B06 | Requisições externas restritas | Allowlist, validação SSRF, timeouts e políticas |
| RNF-B07 | Preservação de evidências | Hash e objetos versionados; depende do cofre/ferramentas |
| RNF-B08 | Recuperação | Volumes preservados; backup/restauração devem ser configurados e testados |
| RNF-B09 | Reprodutibilidade | Lockfile, migrations, testes e Docker |
| RNF-B10 | Codificação | Fontes UTF-8 e respostas com tipo de conteúdo adequado |
| RNF-B11 | Escalabilidade | Worker separado; bootstrap ainda precisa de paginação e teste de carga |
| RNF-B12 | Observabilidade | Saúde e correlação parcial; métricas/logs/alertas completos pendentes |
| RNF-B13 | Segurança da entrega | Headers HTTP; a UI legada ainda necessita de handlers/styles inline na CSP |
| RNF-B14 | Homologação | Testes locais não substituem infraestrutura e fluxos reais |

## Arquivos e responsabilidades

| Pasta/arquivo | Manter para |
| --- | --- |
| `app/main.py` | Aplicação, routers, lifespan, headers, saúde e entrada estática |
| `app/api/v1/` | `auth_routes`, `legal`, `legal_extra`, `frontend`, `investigations`, `engines`, `evidence`, `reports`, `audit`, `schemas`, `dependencies` |
| `app/core/config.py`, `app/db/session.py` | Configuração, conexões e contexto de organização |
| `app/models/` | `base`, `platform`, `legal`, `investigation`, `evidence`, `reporting`, `audit`: persistência |
| `app/security/` | `auth`, `passwords`, `sessions`, `rate_limit`: identidade, hashing, criptografia, sessões e limites |
| `app/integrations/oidc.py` | Discovery e autenticação institucional |
| `app/policies/engine.py`, `app/audit/ledger.py` | Autorização e cadeia de auditoria |
| `app/connectors/` | `base`, `http`, `registry`, `brasilapi`, `datajud`, `transparency`, `rdap` |
| `app/investigation_engines/` | `tacer`, `siera`, `service` |
| `app/evidence/service.py` | Ingestão, ferramentas, hash e cofre |
| `app/reports/service.py`, `app/agents/service.py` | PDF e estrutura de saída supervisionada |
| `app/services/` | Execução de conectores, outbox e ledger de evidências |
| `app/workers/` | Celery e tarefas |
| `app/static/frontend/` | Distribuição web gerada; não editar manualmente |
| `__init__.py` dos pacotes | Importação e exports; arquivo vazio não é necessariamente lixo |
| `alembic.ini`, `alembic/` | Migrations; preservar histórico já aplicado |
| `infra/docker/`, `infra/sql/` | Inicialização, SQL auxiliar, RLS e observabilidade |
| `tests/` | Unidade, integração e segurança; fixtures isoladas não alimentam a aplicação |
| `scripts/` | Execução, diagnóstico, testes, provisionamento e smoke HTTP |
| `examples/` | Payloads de desenvolvimento; preencher antes de executar |
| `docs/`, `FRONTEND_MIGRATION.md` | Guias especializados e pendências de integração |
| `pyproject.toml`, `uv.lock` | Dependências e ferramentas |
| `.env.example`, `.env` | Contrato de configuração e configuração privada local |
| `Dockerfile`, `docker-compose.yml`, `Makefile` | Infraestrutura e comandos |
| `.gitignore`, `.dockerignore` | Excluir ambientes, bancos, caches e segredos dos artefatos |

Removidos: HTML monolítico antigo, JS/CSS duplicados e arquivos de desenvolvimento/documentação copiados para a pasta pública. Workflows pertencem a `.github/workflows/` na raiz do repositório, fora de `back-end/`.

## Verificação

```powershell
uv run ruff check app tests
uv run pytest -q
uv run python -m compileall -q app tests
```

`scripts/test-backend.ps1` usa uv e interrompe em falhas. Os testes usam SQLite próprio em `var/test`, não `semperfi-local.db`.

Cobertura: isolamento lógico, auditoria, políticas, SSRF, TACER/SIERA, status de autenticação, cookie, logout, expiração, bloqueio do login técnico em produção e assets estáticos, incluindo os módulos público e comercial e seu catálogo. O frontend também tem testes de estado vazio e verificações de sintaxe/UTF-8.

Os testes de conta cobrem cadastro, credenciais inválidas, duplicação de e-mail, isolamento, desativação e tratamento de erros sem exposição da senha. A revogação é testada com falha e recuperação do Redis: a saída informa indisponibilidade e preserva o cookie se não conseguir invalidar a sessão no servidor.

Não homologado: OIDC real, PostgreSQL/RLS real, stack Docker completa, filas/Redis em implantação, S3/KMS/Object Lock, antivírus e credenciais externas. Não há benchmark ou garantia de capacidade declarada.

## Próximos testes reais

1. Configurar base dedicada de homologação e contas/vínculos aprovados.
2. Verificar persistência dos cadastros e isolamento por organização.
3. Configurar Redis, workers e cofre antes de anexos/relatórios.
4. Homologar os perfis complementares, equipe, documentos vinculados, planos de investigação, preservação de TXT/JSON e lançamento conjunto de intimações já integrados.
5. Homologar segurança, backup/restauração e comportamento de falhas antes de produção.

### Resultado da revisão local — 26/09/2026

- **296 testes Python passaram**, executados em ambiente isolado recriado a partir de `uv.lock`, com banco exclusivo e transporte SMTP bloqueado. Um aviso de depreciação vem do TestClient/httpx; a dependência não foi atualizada fora do lockfile.
- Ruff passou em `app` e `tests`. A cadeia Alembic até `20260923_0004` foi aplicada com sucesso em SQLite novo e isolado; o banco operacional não foi migrado por essa verificação.
- O teste `front-end/tests/browser/legal-live.cjs` comprovou fluxos do núcleo com navegador, FastAPI e SQLite reais, sem substituir endpoints jurídicos: cadastro/edição de cliente e processo, cadastro/edição/exclusão de agenda, prazo e financeiro, criação/lançamento de intimação, persistência após recarregar e auditoria.
- Pagamentos, Ollama, armazenamento e fontes externas usam simulações nos testes de contrato. Isso não equivale à homologação desses serviços. A matriz das 21 abas e os critérios de aceite estão no [frontend](../front-end/README.md#prontidão-para-lançamento).

### Correções de continuidade — 29/09/2026

Correções aplicadas aos achados da revisão de 27/09:

- **Vínculos jurídicos:** bloqueio 409 com mensagem acionável antes de excluir registros com dependências ou alterar o cliente de processo com vínculos incompatíveis. Atualização/serialização de novos clientes/processos ocorre antes do commit, preservando o contexto transacional. Regressões incluem agenda, financeiro, prazos, investigações e histórico.
- **Organização nas tarefas:** tenant validado antes de abrir a sessão, contexto RLS definido e filtros explícitos no acesso. Outbox transmite a organização da coluna persistida; eventos inválidos ficam em `connector.run.rejected`, com conteúdo preservado para revisão, e não impedem o despacho dos próximos lotes. Mensagens legadas do broker sem tenant falham sem acesso aos dados. Execuções já concluídas não repetem o provedor. A transação mantém bloqueio durante a consulta externa; PostgreSQL/RLS e broker reais ainda exigem homologação, e SQLite pode bloquear outras gravações nesse intervalo.
- **Evidências e consultas:** erro total/parcial DNS e falha de finalização não anunciam preservação concluída. O frontend retoma o recibo existente; uma resposta de upload perdida exige conferência da lista de arquivos. A promoção de achado reutiliza a evidência vinculada após recarregar a página. TXT/JSON possuem validação de conteúdo e download como anexo.
- **Novos fluxos:** recuperação de senha com revogação de sessões e histórico autenticado de consultas, utilizado pelo Radar CNPJ.
- **Pendências dessa revisão:** perfis/documentos de clientes, equipe e TACER/SIERA foram implementados na continuidade de 30/09 abaixo. Permanecem monitoramento de processos e coleta de publicações; execução persistida de todas as OSINT Tools; demais pesquisas do Radar e importação integral do mapa; ciclo comercial de renovação, troca, cancelamento, adicionais e franquias. A matriz do frontend discrimina as demais condições por aba.

As verificações de API usam bancos descartáveis em `var/test`, transporte de e-mail capturado e provedores simulados. Dados operacionais não participam desses testes. A lista MIME do `.env` local foi ampliada para TXT/JSON; credenciais e demais configurações foram preservadas.

No ambiente local, `/health/ready` respondeu com banco acessível e `/auth/status` confirmou recuperação de senha habilitada. Asaas Sandbox e o provider de IA permanecem desabilitados; faltam retorno HTTPS/webhook homologado e modelo/serviço Ollama. Saúde da API não homologa filas, PostgreSQL/RLS, cofre, retenção ou restauração. Configurações e credenciais continuam restritas ao `.env` privado.

### Resultado da validação — 29/09/2026

- **415 testes Python aprovados**, em banco isolado, com diretório temporário exclusivo, SMTP capturado/bloqueado e sem pagamentos ou chamadas reais a provedores. Incluem recuperação PF/PJ, expiração/reuso de OTP, revogação de sessões, ausência de senha/código nos erros de validação, vínculos jurídicos, isolamento das tarefas, outbox, histórico OSINT e ingestão TXT/JSON.
- Ruff em `app`/`tests`, compilação Python e `git diff --check` aprovados. Permanece um aviso de depreciação do TestClient/httpx; o lockfile Python foi preservado.
- **65 testes Node, 20 cenários funcionais e sete cenários de recuperação no navegador aprovados**, sem erros JavaScript. A API é simulada nessas duas suítes de navegador; acessibilidade automatizada não inclui contraste nem avaliação manual.
- O fluxo jurídico de navegador com FastAPI e SQLite reais foi executado novamente com sucesso: cadastros, edições, exclusões permitidas, lançamento de intimação, persistência após recarga e auditoria. Não utilizou banco operacional nem identidade real.
- **61 arquivos do frontend** passaram pela verificação de UTF-8, mojibake, charset HTML e sintaxe; **44 arquivos de distribuição** estão sincronizados. Playwright/axe-core foram fixados no lockfile e instalados com `npm ci`; a execução dos testes de navegador foi adicionada ao workflow de CI. O workflow remoto não foi disparado nesta entrega.

### Entregas e validação — 30/09/2026

Prazo informado pelo responsável: **17/10/2026**, mantendo as 21 abas no escopo. A matriz de aceite continua no README do frontend.

| Fluxo | Contrato `/v1` | Persistência e regras |
| --- | --- | --- |
| Perfil complementar | `GET/PUT /clients/{id}/profile` | Tabela `client_profiles`; conteúdo pelo cipher da aplicação; versão inicial 0, atualização incrementa e versão desatualizada retorna 409; limite 250 KB e 100 registros por grupo; cliente ativo e tenant conferidos; auditor consulta |
| Documentos jurídicos | `GET/POST /clients/{id}/documents`, equivalentes para `processes`; `DELETE .../documents/{link_id}` | Tabela `legal_document_links`; apenas evidência existente da mesma organização; vínculo único por alvo/arquivo; remoção não apaga original/custódia; exclusão do alvo bloqueada enquanto houver vínculo |
| Equipe | `GET /organization/mine`, `POST /organization/switch`, `GET /organization/members`, `PATCH /organization/members/{id}` | Permissões de administrador, MFA recente, proteção contra autobloqueio e último administrador; suspensão restrita ao vínculo; versão de sessão por membership impede reaproveitar cookie após reativação |
| Convites | `GET/POST /organization/invitations`, `DELETE /organization/invitations/{id}`, `POST /organization/invitations/preview` e `/accept` | Compartilhamento manual, validade sete dias, destinatário autenticado pelo mesmo e-mail e MFA recente; token aleatório, somente hash no banco; uso único, revogação e reenvio invalidam links anteriores; aceite preserva vínculos existentes |
| TACER/SIERA | POSTs anteriores preservados; `GET /investigation-engines/runs`, `GET /runs/{id}`, `PATCH /runs/{id}/review` | Entradas/resultados protegidos pelo cipher; consulta de histórico sem autorização/alvo; detalhe autenticado; escopo aprovado; chave `request_id` idempotente; revisão humana imutável; planejamento determinístico não executa coleta nem cobrança |

As tabelas novas são criadas pelas migrations `0005` a `0008`. Há políticas RLS nas tabelas de domínio em PostgreSQL; a tabela de versões de sessão participa da verificação de identidade antes de estabelecer o tenant. Em desenvolvimento/teste, `init_db` cria as tabelas novas ao carregar o backend. Em implantação, faça backup e execute `alembic upgrade head` antes de iniciar a nova versão. Não aplique downgrade em dados operacionais: ele remove as tabelas desses fluxos.

Validação desta entrega:

- **472 testes Python passaram**, incluindo perfis, autorização entre organizações, documentos, convites, revogação persistente de sessões, idempotência/histórico e revisão dos planejamentos. Ruff e compilação aprovados; permanece o aviso de depreciação TestClient/httpx.
- **69 testes Node e 35 cenários de navegador com respostas controladas** (23 funcionais, sete de recuperação, cinco de perfil), sem erros JavaScript. Acessibilidade estrutural automatizada inclui a equipe; contraste e tecnologias assistivas exigem validação manual.
- **11 grupos de fluxos com navegador → FastAPI → SQLite reais**, em processo/banco isolados, incluindo salvar/reabrir perfil, vincular/desvincular documento e revisar/reabrir plano. Os metadados do arquivo original são uma fixture isolada; nenhum upload ao cofre real é presumido por esse teste.
- **Alembic em SQLite isolado:** upgrade até `20260929_0008`, downgrade até `0004` e novo upgrade aprovados; cadastro anterior preservado e integridade do banco confirmada. Não houve migration no banco operacional.
- **67 arquivos do frontend verificados e 48 sincronizados**. Nenhuma credencial foi incluída nos módulos ou testes; nenhum pagamento, e-mail ou consulta externa foi disparado por essa validação.

Continuam necessários: monitoramento/publicações, demais OSINT Tools e pesquisas do Radar, execução do API Explorer, ciclo comercial completo e homologação HTTPS/Asaas Sandbox, Ollama, Redis/workers, PostgreSQL/RLS, cofre, backup/restauração e acessibilidade manual. Testes locais aprovados não significam aceite integral de lançamento.
