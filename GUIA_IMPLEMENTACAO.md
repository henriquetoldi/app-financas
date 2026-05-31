# 🚀 GUIA COMPLETO DE IMPLEMENTAÇÃO

## Índice
1. [Preparação Inicial](#preparação-inicial)
2. [Configurar Google OAuth](#configurar-google-oauth)
3. [Setup do Banco de Dados](#setup-do-banco-de-dados)
4. [Configurar Drive API](#configurar-drive-api)
5. [Backend](#backend)
6. [Frontend](#frontend)
7. [Testes](#testes)
8. [Deploy](#deploy)

---

## 1️⃣ Preparação Inicial

### 1.1 Criar estrutura de pastas

```bash
# Criar pastas no seu Google Drive manualmente:
mkdir -p FINANÇAS_PESSOAIS
  ├── CONTAS/
  │   ├── Nubank_Cartão/
  │   │   ├── 2025/
  │   │   │   ├── Janeiro/
  │   │   │   ├── Fevereiro/
  │   │   │   └── Março/
  │   │   └── 2026/
  │   │       ├── Janeiro/
  │   │       └── ...
  │   ├── BB_Conta/
  │   ├── Bradesco/
  │   └── B3_Investimentos/
  ├── IMPORTAÇÕES_PROCESSADAS/
  ├── BACKUPS/
  └── METADADOS/
```

### 1.2 Criar projeto no Google Cloud

```bash
1. Ir para https://console.cloud.google.com
2. Criar novo projeto: "App Finanças Pessoais"
3. Habilitar APIs:
   - Google Drive API
   - Google Sheets API (opcional, pra relatorios)
4. Criar credenciais:
   - OAuth 2.0 (Web Application)
   - Salvar Client ID e Client Secret
```

### 1.3 Clonar repositório e instalar dependências

```bash
git clone seu_repo finance-app
cd finance-app

# Backend
npm install express dotenv pg googleapis @google-cloud/storage jsonwebtoken cors

# Parser
npm install csv-parser papaparse

# Utilities
npm install node-cron uuid

# Frontend (React)
cd frontend
npm install react-query react-hook-form tailwindcss axios
```

---

## 2️⃣ Configurar Google OAuth

### 2.1 Criar aplicação OAuth

```
1. Google Cloud Console → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID
   - Application type: Web application
   - Authorized redirect URIs:
     * http://localhost:3000/api/auth/google/callback (dev)
     * https://seu-dominio.com/api/auth/google/callback (prod)
3. Copiar Client ID e Secret
```

### 2.2 Arquivo `.env`

```env
# OAuth Google
GOOGLE_CLIENT_ID=seu_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=seu_client_secret_aqui
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback

# Drive
DRIVE_FINANÇAS_FOLDER_ID=seu_folder_id (copiar da URL)
DRIVE_IMPORTAÇÕES_FOLDER_ID=seu_folder_id
DRIVE_BACKUPS_FOLDER_ID=seu_folder_id

# Database
DATABASE_URL=postgresql://usuario:senha@localhost:5432/financas

# JWT
JWT_SECRET=sua_chave_secreta_super_longa_aqui

# Ambiente
NODE_ENV=development
PORT=3000
```

### 2.3 Obter folder IDs do Drive

```
1. Abrir cada pasta no Google Drive
2. URL será: drive.google.com/drive/folders/{FOLDER_ID}
3. Copiar o FOLDER_ID e adicionar ao .env
```

---

## 3️⃣ Setup do Banco de Dados

### 3.1 Instalar PostgreSQL

```bash
# macOS
brew install postgresql
brew services start postgresql

# Linux
sudo apt-get install postgresql postgresql-contrib
sudo systemctl start postgresql

# Windows
# Fazer download em https://www.postgresql.org/download/windows/
```

### 3.2 Criar database

```bash
# Conectar
psql -U postgres

# No prompt:
CREATE DATABASE financas_pessoais;
CREATE USER seu_usuario WITH PASSWORD 'sua_senha';
GRANT ALL PRIVILEGES ON DATABASE financas_pessoais TO seu_usuario;

# Sair
\q
```

### 3.3 Executar schema

```bash
# Navegar para pasta do projeto
cd backend

# Executar schema.sql
psql -U seu_usuario -d financas_pessoais -f schema.sql

# Ou conectar e copiar/colar:
psql -U seu_usuario -d financas_pessoais
\i schema.sql
\q
```

### 3.4 Verificar criação

```bash
psql -U seu_usuario -d financas_pessoais

# Ver tabelas
\dt

# Ver views
\dv

# Sair
\q
```

---

## 4️⃣ Configurar Drive API

### 4.1 Baixar credenciais

```bash
1. Google Cloud Console → APIs & Services → Credentials
2. Service Account:
   - Create Service Account
   - Download JSON key
   - Salvar como `google-credentials.json` na raiz do projeto

# NÃO commitar este arquivo no git!
echo "google-credentials.json" >> .gitignore
```

### 4.2 Compartilhar pastas com Service Account

```bash
1. Abrir pasta FINANÇAS_PESSOAIS no Drive
2. Botão Compartilhar
3. Colar email do Service Account
4. Dar acesso de Editor
```

---

## 5️⃣ Backend

### 5.1 Estrutura de pastas

```
backend/
├── src/
│   ├── routes/
│   │   ├── auth.js          # OAuth routes
│   │   ├── transacoes.js    # CRUD de transações
│   │   ├── contas.js        # CRUD de contas
│   │   ├── categorias.js    # CRUD de categorias
│   │   ├── upload.js        # Upload de arquivos
│   │   └── relatorios.js    # Relatórios e dashboards
│   ├── middleware/
│   │   ├── auth.js          # JWT verification
│   │   └── errorHandler.js  # Error handling
│   ├── services/
│   │   ├── drive.js         # Google Drive API wrapper
│   │   ├── parser.js        # CSV parsing
│   │   └── categorizer.js   # Auto-categorization
│   ├── models/
│   │   ├── Usuario.js
│   │   ├── Conta.js
│   │   ├── Transacao.js
│   │   ├── Categoria.js
│   │   └── Importacao.js
│   └── server.js            # Entry point
├── .env
├── .env.example
├── package.json
└── schema.sql
```

### 5.2 Arquivo principal (server.js)

```javascript
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Database pool
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/transacoes', require('./src/routes/transacoes'));
app.use('/api/contas', require('./src/routes/contas'));
app.use('/api/categorias', require('./src/routes/categorias'));
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/relatorios', require('./src/routes/relatorios'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server rodando na porta ${PORT}`);
});

module.exports = { app, pgPool };
```

### 5.3 Rota de autenticação (routes/auth.js)

```javascript
const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { pgPool } = require('../server');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Gerar URL de login
router.get('/google/url', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  res.json({ url: authorizationUrl });
});

// Callback após login
router.post('/google/callback', async (req, res) => {
  try {
    const { code } = req.body;

    // Trocar código por tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Obter info do usuário
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    const { email, name, picture, id } = userInfo.data;

    // Verificar/criar usuário no BD
    const result = await pgPool.query(
      `INSERT INTO usuarios (email, nome, foto_url, google_id) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_id) DO UPDATE SET
       nome = $2, foto_url = $3, atualizado_em = CURRENT_TIMESTAMP
       RETURNING id`,
      [email, name, picture, id]
    );

    const usuario_id = result.rows[0].id;

    // Gerar JWT
    const jwtToken = jwt.sign(
      { usuario_id, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token: jwtToken,
      usuario: { id: usuario_id, email, nome: name, foto: picture },
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
  } catch (error) {
    console.error('Erro auth:', error);
    res.status(500).json({ erro: error.message });
  }
});

module.exports = router;
```

### 5.4 Rota de upload (routes/upload.js)

```javascript
const express = require('express');
const router = express.Router();
const { processarExtratoDorive } = require('../services/parser');
const { autenticarMiddleware } = require('../middleware/auth');

router.post('/arquivo', autenticarMiddleware, async (req, res) => {
  try {
    const { arquivo, accessToken } = req.body;
    const { usuario_id } = req.usuario;

    // Processar arquivo
    const resultado = await processarExtratoDorive(
      accessToken,
      usuario_id,
      arquivo.id,
      arquivo.name
    );

    if (resultado.sucesso) {
      res.json({
        sucesso: true,
        importacaoId: resultado.importacaoId,
        inseridas: resultado.inseridas,
        duplicadas: resultado.duplicadas,
      });
    } else {
      res.status(400).json({ erro: resultado.erro });
    }
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

module.exports = router;
```

### 5.5 Cronjob de sincronização

```javascript
// services/sync.js
const cron = require('node-cron');
const { sincronizarTodooDrive } = require('./parser');

// Executar a cada 6 horas
cron.schedule('0 */6 * * *', async () => {
  console.log('⏰ Iniciando sincronização automática...');
  try {
    await sincronizarTodooDrive();
    console.log('✅ Sincronização completa');
  } catch (error) {
    console.error('❌ Erro na sincronização:', error);
  }
});

module.exports = { iniciarCronjob: () => {} };
```

---

## 6️⃣ Frontend (React)

### 6.1 Estrutura

```
frontend/
├── src/
│   ├── components/
│   │   ├── Dashboard.jsx
│   │   ├── UploadArea.jsx
│   │   ├── TransacoesList.jsx
│   │   ├── CategorizeModal.jsx
│   │   └── Charts.jsx
│   ├── pages/
│   │   ├── Login.jsx
│   │   ├── Home.jsx
│   │   ├── Transacoes.jsx
│   │   ├── Contas.jsx
│   │   └── Relatorios.jsx
│   ├── hooks/
│   │   ├── useAuth.js
│   │   ├── useTransacoes.js
│   │   └── useContas.js
│   ├── api/
│   │   └── client.js
│   ├── App.jsx
│   └── index.jsx
└── package.json
```

### 6.2 Hook de autenticação

```javascript
// hooks/useAuth.js
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function useAuth() {
  const [usuario, setUsuario] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      // Validar token (chamada ao backend)
      setUsuario(JSON.parse(localStorage.getItem('usuario')));
    }
    setCarregando(false);
  }, []);

  const login = async (accessToken) => {
    const response = await fetch('/api/auth/google/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: accessToken }),
    });

    const dados = await response.json();
    localStorage.setItem('token', dados.token);
    localStorage.setItem('usuario', JSON.stringify(dados.usuario));
    localStorage.setItem('access_token', dados.access_token);
    setUsuario(dados.usuario);
    navigate('/dashboard');
  };

  const logout = () => {
    localStorage.clear();
    setUsuario(null);
    navigate('/login');
  };

  return { usuario, carregando, login, logout };
}
```

### 6.3 Componente de upload

```javascript
// components/UploadArea.jsx
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

export function UploadArea() {
  const { usuario } = useAuth();
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState(null);

  const handleUpload = async (e) => {
    const arquivo = e.target.files[0];
    if (!arquivo) return;

    setCarregando(true);
    const formData = new FormData();
    formData.append('arquivo', arquivo);

    try {
      const response = await fetch('/api/upload/arquivo', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: formData,
      });

      const dados = await response.json();
      setResultado(dados);
    } catch (error) {
      setResultado({ erro: error.message });
    } finally {
      setCarregando(false);
    }
  };

  return (
    <div className="p-6 bg-blue-50 rounded-lg border-2 border-dashed border-blue-300">
      <h2 className="text-xl font-bold mb-4">Importar Extrato</h2>
      <input
        type="file"
        accept=".csv"
        onChange={handleUpload}
        disabled={carregando}
        className="block mb-4"
      />
      {carregando && <p>Processando...</p>}
      {resultado && (
        <div>
          {resultado.sucesso ? (
            <p className="text-green-600">
              ✅ {resultado.inseridas} transações importadas
              ({resultado.duplicadas} duplicadas)
            </p>
          ) : (
            <p className="text-red-600">❌ {resultado.erro}</p>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## 7️⃣ Testes

### 7.1 Testar OAuth

```bash
# 1. Abrir navegador e ir para:
http://localhost:3000/api/auth/google/url

# 2. Copiar URL de login
# 3. Clicar no link
# 4. Fazer login com sua conta Google
# 5. Deverá ser redirecionado com token
```

### 7.2 Testar importação

```bash
# Criar arquivo CSV de teste
cat > test.csv << EOF
data,descricao,categoria,valor
01/01/2025,Supermercado,Alimentação,-150.00
02/01/2025,Salário,,+5000.00
EOF

# Upload via API
curl -X POST http://localhost:3000/api/upload/arquivo \
  -H "Authorization: Bearer seu_token" \
  -F "arquivo=@test.csv"
```

### 7.3 Testar banco de dados

```bash
psql -U seu_usuario -d financas_pessoais

SELECT COUNT(*) FROM transacoes;
SELECT * FROM transacoes LIMIT 5;
SELECT * FROM importacoes;
```

---

## 8️⃣ Deploy

### 8.1 Preparar para produção

```bash
# Usar variáveis de ambiente seguras
# Configurar CORS para seu domínio
# Habilitar HTTPS
# Rate limiting
# Validação de entrada
```

### 8.2 Deploy no Railway (recomendado)

```bash
# 1. Criar conta em railway.app
# 2. Conectar repositório GitHub
# 3. Configurar variáveis de ambiente
# 4. Railway faz deploy automaticamente
```

### 8.3 Deploy do PostgreSQL

```bash
# Railway oferece PostgreSQL gerenciado
# Ou usar neon.tech
# Ou AWS RDS
```

---

## ✅ Checklist Final

- [ ] Google OAuth configurado
- [ ] PostgreSQL criado e schema executado
- [ ] Pastas no Drive organizadas
- [ ] .env configurado
- [ ] Backend iniciando sem erros
- [ ] Frontend fazendo login
- [ ] Upload de arquivo funcionando
- [ ] Transações aparecendo no BD
- [ ] Categorização funcionando
- [ ] Relatórios gerando

---

## 🐛 Troubleshooting

### Erro: "Could not find credentials"
```
→ Verificar se google-credentials.json existe
→ Verificar se GOOGLE_CLIENT_ID está no .env
```

### Erro: "ECONNREFUSED" no PostgreSQL
```
→ PostgreSQL não está rodando
→ Iniciar: brew services start postgresql
```

### Erro: "Folder not found" no Drive
```
→ Copiar folder ID correto da URL
→ Compartilhar pasta com o service account
```

---

Pronto! Sua arquitetura está completa! 🎉
