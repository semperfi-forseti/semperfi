# Conectores de APIs Externas

Todas as conexoes externas sao server-side. O frontend nunca recebe chaves, tokens ou segredos.

## Conectores existentes

- `brasilapi`: CNPJ, CEP, DDD, bancos e feriados via BrasilAPI.
- `transparency`: Portal da Transparencia, exige `TRANSPARENCY_API_KEY`.
- `datajud`: DataJud/CNJ, exige `DATAJUD_API_KEY`.
- `rdap_dns`: RDAP/DNS defensivo com guarda SSRF.

## Endpoint de execucao

```text
POST /v1/osint/runs
```

Em desenvolvimento/teste, pode usar:

```text
POST /v1/osint/runs?wait=true
```

## Variaveis de ambiente

Configure em `.env`:

```env
TRANSPARENCY_API_KEY=
DATAJUD_API_KEY=
DATAJUD_BASE_URL=https://api-publica.datajud.cnj.jus.br
BRASIL_API_BASE_URL=https://brasilapi.com.br/api
```

## Regras

- Nunca chamar APIs externas diretamente do navegador.
- Registrar finalidade, base legal e autorizacao.
- Registrar hash da requisicao e da resposta.
- Tratar resultados como indícios ate revisao humana.
- Bloquear RDAP/DNS sem escopo `digital_defensive`.
