# Execução de demonstração

Este projeto é um estudo com dados fictícios. A API não tem autenticação ou autorização e não deve ser publicada na internet, nem exposta por túneis. As orientações anteriores de publicação direta foram retiradas por esse motivo.

## Web pública

A demonstração do GitHub Pages usa dados demonstrativos versionados e não exige publicar a API local. Visitantes podem criar, editar, mudar o status, comentar e excluir tarefas; alterações e eventos são salvos apenas no armazenamento local do navegador e sobrevivem a recarregamentos. Cada navegador possui uma cópia independente: não existe sincronização entre usuários ou persistência em servidor. O botão **Restaurar demo** descarta as alterações locais e repõe os dados fictícios iniciais. Limpar os dados do site também elimina a cópia local. Não insira informações reais ou confidenciais na demonstração pública.

## API local

```bash
npm ci
npm run dev
```

A web usa a porta 5173 e a API usa `http://127.0.0.1:3333`. A API escuta somente no próprio computador por padrão. Requisições de navegador com origem diferente de `http://localhost:5173` ou `http://127.0.0.1:5173` são rejeitadas antes das operações.

Isso não autentica usuários: processos locais e clientes sem cabeçalho Origin continuam acessando a API. Não use dados reais ou credenciais.

## Docker local

```bash
docker build -f Dockerfile.api -t opsflow-api .
docker run --rm -p 127.0.0.1:3333:3333 -v opsflow-data:/data opsflow-api
```

O container usa `OPSFLOW_HOST=0.0.0.0` internamente para permitir o encaminhamento de portas. A publicação da porta deve permanecer em `127.0.0.1` no computador anfitrião. Não use `-p 3333:3333`, pois isso pode expor a porta na rede.

Variáveis: `PORT`, `OPSFLOW_HOST`, `OPSFLOW_DB_PATH` e `OPSFLOW_SEED_PATH`. Alterar o host para uma interface pública remove a proteção de isolamento local. O volume mantém os dados entre reinícios, mas não substitui backup.

## Limites

Controle de acesso, identidade confiável no histórico e consistência entre alterações e eventos ainda precisam de revisão antes de qualquer uso operacional. Os testes locais não certificam segurança de produção.
