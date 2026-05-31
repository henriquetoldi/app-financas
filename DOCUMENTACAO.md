# Documentacao Completa - App Financas

> Gerado em: 31/05/2026

---

## 1. O QUE E O APP

O **App Financas** e uma aplicacao web de gestao financeira pessoal com:

- Login com conta Google (OAuth 2.0)
- Gerenciamento de contas bancarias
- Registro de transacoes (credito/debito)
- Importacao de extratos via CSV do Google Drive
- Categorizacao de transacoes
- Visualizacao de saldo e historico

---

## 2. ONDE O APP ESTA HOSPEDADO

| Componente | Plataforma | URL |
|---|---|---|
| Aplicacao web | Railway | https://app-financas-production.up.railway.app |
| Banco PostgreSQL | Railway | Interno ao projeto Railway |
| Codigo-fonte | GitHub | https://github.com/henriquetoldi/app-financas |
| Autenticacao OAuth | Google Cloud | Projeto app-financas-498001 |

---

## 3. ARQUITETURA

O app e um monolito fullstack: o mesmo servidor Node.js serve a API e o frontend React.

Fluxo:
Usuario -> Railway (Express) -> /auth/google -> Google OAuth
                             -> /api/...    -> PostgreSQL
                             -> /*          -> dist/ (React build)

---

## 4. ESTRUTURA DE ARQUIVOS

- App.jsx                  - Frontend React (componente raiz)
- index.html               - Entry point do Vite
- vite.config.mjs          - Configuracao do Vite (ESM)
- backend-server.js        - Servidor Express (API + serve frontend)
- drive-finance-parser.js  - Parse de CSV do Google Drive
- schema.sql               - Schema do banco PostgreSQL
- package.json             - Dependencias e scripts npm
- .env.example             - Exemplo de variaveis de ambiente
- DOCUMENTACAO.md          - Este arquivo

---

## 5. AUTENTICACAO (Google OAuth 2.0)

Fluxo:
1. Usuario clica "Entrar com Google"
2. Frontend redireciona para /auth/google
3. Backend redireciona para o Google com client_id
4. Usuario autentica no Google
5. Google redireciona para /auth/google/callback
6. Backend troca codigo por access_token
7. Backend cria/atualiza usuario no PostgreSQL
8. Backend gera JWT e devolve ao frontend
9. Frontend armazena JWT no localStorage
10. Chamadas a API usam header: Authorization: Bearer <token>

### Credenciais OAuth:

- Projeto Google Cloud: app-financas-498001
- Client ID: 952680328343-9pth2f7ai8sg9fhiv5plj1gvg2cbutec.apps.googleusercontent.com
- Origem autorizada: https://app-financas-production.up.railway.app
- Callback URL: https://app-financas-production.up.railway.app/auth/google/callback
- Client Secret: configurado como variavel de ambiente no Railway (nao commitar!)

---

## 6. BANCO DE DADOS

PostgreSQL gerenciado pelo Railway.

### Tabelas (schema.sql):

| Tabela | O que armazena |
|---|---|
| usuarios | id, email, nome, foto, google_id, access_token |
| contas | id, usuario_id, nome, banco, tipo |
| transacoes | id, conta_id, valor, tipo, categoria, data, descricao |
| categorias | id, usuario_id, nome, cor |

ATENCAO: O schema ainda nao foi aplicado ao banco! Ver secao 10.

---

## 7. VARIAVEIS DE AMBIENTE (Railway)

| Variavel | Finalidade |
|---|---|
| GOOGLE_CLIENT_ID | Client ID do OAuth Google |
| GOOGLE_CLIENT_SECRET | Client Secret do OAuth Google |
| SESSION_SECRET | Chave para assinar JWTs |
| PORT | Porta do servidor (3000) |
| NODE_ENV | production |
| DATABASE_URL | URL PostgreSQL (referencia interna Railway) |
| VITE_API_URL | URL da API para o frontend (PENDENTE adicionar) |

---

## 8. SCRIPTS DO PACKAGE.JSON

- "dev":   "node backend-server.js"   -> rodar local
- "build": "vite build"               -> buildar React para dist/
- "start": "node backend-server.js"   -> producao (Railway usa esse)

### Como o Railway faz o deploy:
1. Detecta commit no GitHub
2. npm install (instala todas as dependencias)
3. npm run build -> vite build -> gera dist/
4. npm start -> node backend-server.js
5. Express serve dist/ em / e a API em /api/

---

## 9. FLUXO COMPLETO DE USO

1. Usuario acessa https://app-financas-production.up.railway.app
2. Express serve dist/index.html (React buildado)
3. React carrega no navegador
4. Usuario faz login com Google
5. Backend autentica, cria usuario no banco, gera JWT
6. Frontend armazena JWT no localStorage
7. Frontend chama /api/contas, /api/transacoes etc. com Bearer token
8. Backend valida JWT, busca dados no PostgreSQL, retorna JSON
9. Frontend renderiza os dados

---

## 10. PROXIMOS PASSOS PENDENTES

### CRITICO - fazer para o app funcionar:

A) Adicionar axios no package.json
   O App.jsx usa "import axios from 'axios'" mas nao esta no package.json
   Adicionar em devDependencies: "axios": "^1.6.0"

B) Verificar/criar main.jsx
   O Vite precisa de um main.jsx com ReactDOM.createRoot.
   Se App.jsx nao tiver esse codigo no final, criar main.jsx:
   
   import React from 'react';
   import ReactDOM from 'react-dom/client';
   import App from './App.jsx';
   ReactDOM.createRoot(document.getElementById('root')).render(<App />);
   
   E atualizar index.html para apontar para /main.jsx

C) Aplicar o schema do banco
   PostgreSQL online mas sem tabelas.
   Railway -> PostgreSQL -> aba Data -> executar schema.sql

D) Adicionar variavel VITE_API_URL no Railway
   Valor: /api  (ou https://app-financas-production.up.railway.app/api)

### VERIFICAR apos o app subir:
- Testar login com Google
- GET /api/health deve retornar {"status": "ok"}
- Testar importacao de CSV do Google Drive

---

## 11. INFRAESTRUTURA - IDs e Referencias

| Recurso | ID / Valor |
|---|---|
| Projeto Google Cloud | app-financas-498001 |
| OAuth Client ID | 952680328343-9pth2f7ai8sg9fhiv5plj1gvg2cbutec.apps.googleusercontent.com |
| Repositorio GitHub | https://github.com/henriquetoldi/app-financas |
| Projeto Railway | splendid-learning |
| Project ID Railway | 6b42d1c9-94e8-4ff3-9b38-fd46c4c088e1 |
| Service ID (app) | 04e13bb6-1a4c-4db5-b763-fd78639c31b2 |
| Service ID (postgres) | 777ee075-a584-4035-bf61-2d31cfb80a62 |
| Environment ID | a8f58014-8c10-42fd-b19e-4db4135c4d3e |
| URL publica | https://app-financas-production.up.railway.app |

---

## 12. HISTORICO DE DEPLOYS

| Data | Commit | O que fez |
|---|---|---|
| 31/05/2026 | Add files via upload | Upload inicial dos arquivos |
| 31/05/2026 | Update package.json (varios) | Corrigiu versoes de pacotes, removeu type:module |
| 31/05/2026 | Add devDependencies and build script | Adicionou vite/react como devDep e script build |
| 31/05/2026 | Add express.static and SPA fallback | Corrigiu o 404 - servidor agora serve o frontend |
| 31/05/2026 | Rename vite.config.js to .mjs | Compatibilidade ESM |
| 31/05/2026 | Fix package.json double comma | Corrigiu JSON invalido |
| 31/05/2026 | Add index.html entry point | Corrigiu erro "cannot resolve index.html" do Vite |

---

## 13. DEPENDENCIAS DO PROJETO

### Runtime (dependencies):
- express ^4.18.2 - servidor web
- cors ^2.8.5 - Cross-Origin Resource Sharing
- dotenv ^16.3.1 - variaveis de ambiente
- pg ^8.11.2 - cliente PostgreSQL
- jsonwebtoken ^9.0.2 - geracao e validacao de JWT
- googleapis ^118.0.0 - integracao com Google Drive API
- csv-parser ^3.0.0 - parse de arquivos CSV
- uuid ^9.0.0 - geracao de IDs unicos

### Build (devDependencies):
- vite ^5.0.0 - bundler do frontend React
- @vitejs/plugin-react ^4.0.0 - plugin React para o Vite
- react ^18.2.0 - biblioteca de UI
- react-dom ^18.2.0 - renderizacao React no DOM
- axios - PENDENTE adicionar (usado no App.jsx)

---

Documentacao gerada durante sessao de deploy em 31/05/2026.
