# CI e entrega

Os workflows ficam em `../../.github/workflows/`, na raiz do repositório, para que o GitHub os reconheça.

- `ci.yml`: valida frontend, sincronização dos assets, testes, lint Python e build das imagens.
- `docker-deploy.yml`: build/publicação da imagem conforme os eventos e permissões definidos no próprio workflow.

## Preparar artefatos

```powershell
cd front-end
npm run sync:backend
npm run check
npm test
cd ..\back-end
uv run ruff check app tests
uv run pytest -q
```

O Dockerfile backend precisa de `app/` antes de instalar o pacote Python. O contexto exclui `.env`, bancos, ambiente virtual e arquivos temporários. A imagem frontend copia apenas arquivos web e configura proxy da API em Nginx.

Para Compose local, configure `.env` conforme o [README](../README.md). A entrega real requer TLS, credenciais legítimas, migrations, provedor institucional, backups e testes de recuperação. Nenhuma publicação remota foi executada durante a revisão do projeto.
