# SEMPER-FI · Backend

API de gestão jurídica, investigação estruturada e evidências digitais. FastAPI, SQLAlchemy assíncrono, Alembic e Celery, com rotas sob `/v1`. A interface fica em [../front-end](../front-end/README.md).

## Estado atual

- Núcleo de clientes, processos, andamentos, prazos, agenda, intimações e financeiro com persistência.
- Cadastro e login PF/PJ com senha e código por e-mail, sessão opaca em cookie HttpOnly e alternativa de provedor OIDC. Acesso técnico restrito a desenvolvimento/testes explícitos.
- Isolamento por `tenant_id`, políticas, auditoria encadeada, conectores e motores TACER/SIERA.
- Ingestão, cofre e relatórios dependem de serviços externos. Agentes supervisionados têm implementação parcial.
- Inicialização cria tabelas em desenvolvimento/teste, **sem popular registros fictícios**. Em produção, o operador aplica migrations.
- Nenhum banco existente é apagado ou automaticamente limpo pela aplicação.

## Requisitos

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

Contas, organizações e vínculos inativos são revalidados ao consultar a sessão. Senhas e códigos não são refletidos nos erros de validação. Recuperação automática de senha e envio por SMS ainda não estão implementados.

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
| RF-B02 | Cadastrar PF/PJ, autenticar, encerrar sessão e consultar identidade | `/auth/register`, `/auth/login`, `/auth/verify`, `/auth/resend`, `/auth/cancel`, `/auth/session`, `/auth/logout`, `/me` |
| RF-B03 | Confirmar segunda etapa de autenticação | Código por e-mail no modo senha; MFA delegado ao provedor no modo OIDC |
| RF-B04 | Separar organizações | Filtros `tenant_id`, contexto do banco e migration RLS |
| RF-B05 | Gerir clientes/processos | CRUD, consulta e soft delete |
| RF-B06 | Gerir andamentos, prazos, agenda, intimações e financeiro | Rotas em `legal.py` e `legal_extra.py` |
| RF-B07 | Carregar estado inicial da interface | `/frontend/bootstrap`, dados da organização |
| RF-B08 | Importar clientes e processos | `/imports/frontend-demo`; execução explícita, sem seed automático |
| RF-B09 | Gerir investigações, entidades, relações e achados | Políticas e auditoria em `investigations.py` |
| RF-B10 | Executar conectores | BrasilAPI, DataJud, Transparência e RDAP; depende da fonte/configuração |
| RF-B11 | Planejar/analisar investigações | Catálogo e motores TACER/SIERA; resultados determinísticos |
| RF-B12 | Processar tarefas | Celery, Redis, outbox e beat |
| RF-B13 | Ingerir/preservar evidências | Upload, hash, metadados, finalização e S3/Object Lock |
| RF-B14 | Solicitar/confirmar legal hold | Segundo usuário e autorização |
| RF-B15 | Gerar, aprovar e baixar relatórios | Versionamento, PDF e cofre; depende da infraestrutura |
| RF-B16 | Registrar/verificar auditoria | Cadeia de eventos e `/audit-events/verify-chain` |
| RF-B17 | Assistência supervisionada | Estrutura parcial; integração de modelos/conclusão dos jobs pendente |
| RF-B18 | Saúde e contrato | Health checks e OpenAPI |
| RF-B19 | Servir a interface | Artefato gerado com apresentação pública, catálogo e painel autenticado; sem servidor Node embarcado |
| RF-B20 | Cobrança comercial | Não implementada; a UI oferece catálogo e resumos, sem efetuar compras ou alterar saldos |

O contrato exato de métodos, payloads e respostas é `/v1/openapi.json`. Implementação não equivale a homologação com serviços reais.

### Integração com a interface

As capacidades da API e as ações disponíveis na UI têm escopos diferentes:

- O cadastro principal de clientes/processos e as operações individuais de andamentos, prazos, agenda, intimações e financeiro usam persistência na API. O lançamento conjunto de intimação está bloqueado na UI; não há transação integrada para criar os três registros juntos.
- Alterações de biografia, histórico político, patrimônio, vínculos empresariais, notícias e documentos do perfil 360° estão bloqueadas na UI. Elas não simulam gravação; a consulta ao perfil e o cadastro principal continuam disponíveis.
- A tela Metadados e Arquivos faz apenas inspeção temporária no navegador. Não envia o arquivo ao backend nem grava vínculo com processo. O fluxo de envio de evidências existe no workspace de investigação, em `/v1/evidences/uploads`, com finalização posterior.
- O frontend gera evidências de texto/JSON, mas `ALLOWED_MIME_TYPES` padrão autoriza PDF, imagens e vídeos. Esses envios são rejeitados até que a configuração seja alinhada aos formatos autorizados para o ambiente. Cofre e pipeline também precisam estar disponíveis.
- Os motores TACER/SIERA da API são distintos dos checklists TACER e da matriz ACH locais, que desaparecem ao recarregar a página. A seção Agentes IA também exibe resultados temporários e não registra achados na investigação.
- A tela de auditoria combina eventos persistidos do bootstrap com eventos locais da sessão. `/audit-events/verify-chain` verifica somente a cadeia mantida pelo backend.

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
4. Implementar persistência e reabilitar os subfluxos bloqueados, como documentos do perfil 360° e lançamento conjunto de intimações; alinhar os tipos MIME antes dos testes de evidências textuais/JSON.
5. Homologar segurança, backup/restauração e comportamento de falhas antes de produção.
