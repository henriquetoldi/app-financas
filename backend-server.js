// ============================================================================
// BACKEND: Finance App - Server Principal
// ============================================================================

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const csv = require('csv-parser');
const { Readable } = require('stream');

dotenv.config();

const app = express();

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173', // Vite
    process.env.FRONTEND_URL
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================================================
// DATABASE
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://seu_usuario:sua_senha@localhost:5432/financas'
});

async function inicializarBanco() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      nome VARCHAR(255),
      foto_url TEXT,
      google_id VARCHAR(255) UNIQUE,
      access_token TEXT,
      refresh_token TEXT,
      moeda_padrao VARCHAR(3) DEFAULT 'BRL',
      timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ativo BOOLEAN DEFAULT true
    )
  `);

  await pool.query(`
    ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS access_token TEXT,
      ADD COLUMN IF NOT EXISTS refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS moeda_padrao VARCHAR(3) DEFAULT 'BRL',
      ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo',
      ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true
  `);

  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_unique ON usuarios(email)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_google_id_unique ON usuarios(google_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      nome VARCHAR(255) NOT NULL,
      banco VARCHAR(100) NOT NULL,
      tipo VARCHAR(50) NOT NULL,
      cpf_parcial VARCHAR(11),
      agencia VARCHAR(10),
      numero_conta VARCHAR(20),
      digito_verificador VARCHAR(2),
      drive_folder_id VARCHAR(255),
      cor VARCHAR(7) DEFAULT '#1E90FF',
      icon VARCHAR(50),
      ativo BOOLEAN DEFAULT true,
      saldo_inicial DECIMAL(12, 2) DEFAULT 0,
      saldo_atual DECIMAL(12, 2),
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_contas_usuario ON contas(usuario_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_contas_banco_tipo ON contas(banco, tipo)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categorias (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
      nome VARCHAR(255) NOT NULL,
      descricao TEXT,
      cor VARCHAR(7) DEFAULT '#999999',
      icon VARCHAR(50),
      emoji VARCHAR(5),
      categoria_pai_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      tipo VARCHAR(50) DEFAULT 'DESPESA',
      customizada BOOLEAN DEFAULT true,
      ativa BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_categorias_usuario ON categorias(usuario_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_categorias_ativa ON categorias(ativa)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conta_id UUID NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
      data DATE NOT NULL,
      descricao TEXT NOT NULL,
      valor DECIMAL(12, 2) NOT NULL,
      tipo VARCHAR(20) NOT NULL,
      categoria_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      subcategoria VARCHAR(255),
      saldo DECIMAL(12, 2),
      referencia_banco VARCHAR(50),
      nota_usuario TEXT,
      hash_transacao VARCHAR(64) UNIQUE,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deletado_em TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_conta ON transacoes(conta_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_categoria ON transacoes(categoria_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_data ON transacoes(data)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_hash ON transacoes(hash_transacao)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS backups_drive (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      conta_id UUID REFERENCES contas(id) ON DELETE SET NULL,
      nome_arquivo VARCHAR(255) NOT NULL,
      arquivo_hash VARCHAR(64) NOT NULL,
      drive_file_id VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pendente',
      mensagem_erro TEXT,
      total_transacoes INT DEFAULT 0,
      data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      data_backup TIMESTAMP,
      tentativas INT DEFAULT 0,
      proxima_tentativa TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_backups_drive_usuario ON backups_drive(usuario_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_backups_drive_status ON backups_drive(status)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_drive_usuario_hash ON backups_drive(usuario_id, arquivo_hash)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notificacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      tipo VARCHAR(50) NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      mensagem TEXT NOT NULL,
      prioridade VARCHAR(20) DEFAULT 'normal',
      lida BOOLEAN DEFAULT false,
      metadata JSONB DEFAULT '{}'::jsonb,
      criada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario ON notificacoes(usuario_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_notificacoes_lida ON notificacoes(lida)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS preferencias_notificacoes (
      usuario_id UUID PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
      email_backup_sucesso BOOLEAN DEFAULT false,
      email_backup_erro BOOLEAN DEFAULT true,
      app_backup_sucesso BOOLEAN DEFAULT true,
      app_backup_erro BOOLEAN DEFAULT true,
      frequencia_resumo VARCHAR(20) DEFAULT 'diaria',
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    INSERT INTO categorias (nome, tipo, emoji, customizada)
    VALUES
      ('Alimentação', 'DESPESA', '🍔', false),
      ('Transporte', 'DESPESA', '🚗', false),
      ('Saúde', 'DESPESA', '❤️', false),
      ('Educação', 'DESPESA', '📚', false),
      ('Moradia', 'DESPESA', '🏠', false),
      ('Diversão', 'DESPESA', '🎭', false),
      ('Salário', 'RECEITA', '💼', false),
      ('Outros', 'DESPESA', '•••', false)
    ON CONFLICT DO NOTHING
  `);
}

// ============================================================================
// GOOGLE OAUTH
// ============================================================================

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ============================================================================
// HELPERS
// ============================================================================

function gerarHashTransacao(tx) {
  const data = tx.data instanceof Date ? tx.data.toISOString().slice(0, 10) : String(tx.data || '').slice(0, 10);
  const descricao = String(tx.descricao || '').trim().toLowerCase();
  const valor = Number(tx.valor || 0).toFixed(2);
  const tipo = String(tx.tipo || '').trim().toUpperCase();
  const str = `${data}|${descricao}|${valor}|${tipo}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

function gerarHashArquivo(nomeArquivo, transacoes = []) {
  const payload = JSON.stringify({ nomeArquivo, transacoes });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function normalizarTipoTransacao(tipo) {
  const valor = String(tipo || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['CREDITO', 'CRÉDITO', 'RECEITA', 'ENTRADA'].includes(valor)) return 'CREDITO';
  return 'DEBITO';
}

function normalizarDataImportacao(data) {
  const d = new Date(data);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function validarTransacoesImportacao(transacoes) {
  if (!Array.isArray(transacoes) || transacoes.length === 0) {
    throw new Error('Envie ao menos uma transação para importar.');
  }

  return transacoes.map((tx, index) => {
    const linha = index + 2;
    const data = normalizarDataImportacao(tx.data);
    const descricao = String(tx.descricao || '').trim();
    const categoria = String(tx.categoria || '').trim() || 'Outros';
    const valor = Math.abs(Number(tx.valor));
    const tipo = normalizarTipoTransacao(tx.tipo);

    if (!data) throw new Error(`Linha ${linha}: data inválida.`);
    if (!descricao) throw new Error(`Linha ${linha}: descrição obrigatória.`);
    if (!Number.isFinite(valor) || valor <= 0) throw new Error(`Linha ${linha}: valor inválido.`);

    return { data, descricao, categoria, valor, tipo };
  });
}

async function criarNotificacao(usuarioId, tipo, { titulo, mensagem, prioridade = 'normal', metadata = {} }) {
  const prefs = await pool.query(
    'SELECT * FROM preferencias_notificacoes WHERE usuario_id = $1',
    [usuarioId]
  );
  const preferencias = prefs.rows[0];
  const chavePref = tipo === 'backup_sucesso' ? 'app_backup_sucesso' : 'app_backup_erro';

  if (preferencias && preferencias[chavePref] === false) {
    return null;
  }

  const result = await pool.query(
    `INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem, prioridade, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [usuarioId, tipo, titulo, mensagem, prioridade, metadata]
  );

  return result.rows[0];
}

async function obterOAuthUsuario(usuarioId) {
  const usuarioResult = await pool.query(
    'SELECT access_token, refresh_token FROM usuarios WHERE id = $1',
    [usuarioId]
  );

  if (usuarioResult.rows.length === 0) {
    throw new Error('Usuário não encontrado para backup no Drive.');
  }

  const usuario = usuarioResult.rows[0];
  const credentials = {};
  if (usuario.access_token) credentials.access_token = Buffer.from(usuario.access_token, 'base64').toString();
  if (usuario.refresh_token) credentials.refresh_token = Buffer.from(usuario.refresh_token, 'base64').toString();
  oauth2Client.setCredentials(credentials);
  return oauth2Client;
}

async function buscarOuCriarPastaDrive(drive, nome, parentId) {
  const nomeSeguro = nome.replace(/'/g, "\\'");
  const parentQuery = parentId ? ` and '${parentId}' in parents` : '';
  const existente = await drive.files.list({
    q: `name='${nomeSeguro}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQuery}`,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  if (existente.data.files?.length) return existente.data.files[0].id;

  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id',
  });

  return response.data.id;
}

async function backupParaDrive({ backupId, usuarioId, contaId, nomeArquivo, transacoes, arquivoBase64 }) {
  try {
    const auth = await obterOAuthUsuario(usuarioId);
    const drive = google.drive({ version: 'v3', auth });
    const contaResult = await pool.query('SELECT nome FROM contas WHERE id = $1', [contaId]);
    const contaNome = contaResult.rows[0]?.nome || 'Conta';
    const baseFolderId = getDriveBackupsFolderId();
    const raizId = baseFolderId || await buscarOuCriarPastaDrive(drive, 'FINANÇAS', null);
    const contaFolderId = await buscarOuCriarPastaDrive(drive, contaNome, raizId);
    const dataReferencia = transacoes[0]?.data || new Date().toISOString().slice(0, 10);
    const mesFolderId = await buscarOuCriarPastaDrive(drive, String(dataReferencia).slice(0, 7), contaFolderId);
    const buffer = arquivoBase64
      ? Buffer.from(arquivoBase64, 'base64')
      : Buffer.from(JSON.stringify(transacoes, null, 2));

    const upload = await drive.files.create({
      requestBody: {
        name: nomeArquivo || `importacao_${Date.now()}.xlsx`,
        parents: [mesFolderId],
      },
      media: {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: Readable.from(buffer),
      },
      fields: 'id',
    });

    await pool.query(
      `UPDATE backups_drive
       SET status = 'sucesso', drive_file_id = $1, data_backup = NOW(), mensagem_erro = NULL, proxima_tentativa = NULL
       WHERE id = $2`,
      [upload.data.id, backupId]
    );

    await criarNotificacao(usuarioId, 'backup_sucesso', {
      titulo: '✅ Backup Concluído',
      mensagem: `${nomeArquivo} foi salvo no Google Drive.`,
      prioridade: 'info',
      metadata: { backupId, driveFileId: upload.data.id },
    });
  } catch (error) {
    console.error('Erro no backup para Drive:', error);
    await pool.query(
      `UPDATE backups_drive
       SET status = 'erro', mensagem_erro = $1, tentativas = tentativas + 1, proxima_tentativa = NOW() + INTERVAL '1 hour'
       WHERE id = $2`,
      [error.message, backupId]
    );

    await criarNotificacao(usuarioId, 'backup_erro', {
      titulo: '❌ Erro no Backup',
      mensagem: `Falha ao salvar no Google Drive: ${error.message}`,
      prioridade: 'alta',
      metadata: { backupId },
    });
  }
}

function parseDataNubank(dataStr) {
  // Formatos: DD/MM/YYYY, DDMMMYYYY, etc
  if (!dataStr) return null;

  const formats = [
    /(\d{2})\/(\d{2})\/(\d{4})/,  // DD/MM/YYYY
    /(\d{2})([A-Za-z]{3})(\d{4})/, // DDMMMYYYY
  ];

  for (const regex of formats) {
    const match = dataStr.trim().match(regex);
    if (match) {
      if (!isNaN(match[2])) {
        // DD/MM/YYYY
        return new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
      } else {
        // DDMMMYYYY - converter mês por nome
        const meses = {
          'jan': 0, 'fev': 1, 'mar': 2, 'abr': 3, 'mai': 4, 'jun': 5,
          'jul': 6, 'ago': 7, 'set': 8, 'out': 9, 'nov': 10, 'dez': 11
        };
        const mes = meses[match[2].toLowerCase()];
        return new Date(match[3], mes, match[1]);
      }
    }
  }
  return null;
}

function parseValorNubank(valorStr) {
  if (!valorStr) return 0;
  // Remove R$ e espaços, converte , para .
  return parseFloat(
    valorStr
      .replace(/R\$/, '')
      .replace(/\s/g, '')
      .replace(/,/, '.')
  );
}

const PLACEHOLDER_FOLDER_ID = 'seu_folder_id_aqui';

function normalizarFolderId(folderId) {
  if (!folderId || folderId.trim() === '' || folderId.trim() === PLACEHOLDER_FOLDER_ID) {
    return null;
  }

  return folderId.trim();
}

function getDriveFinancasFolderId() {
  return normalizarFolderId(
    process.env.DRIVE_FINANCAS_FOLDER_ID ||
    process.env.DRIVE_FINANÇAS_FOLDER_ID
  );
}

function getDriveImportacoesFolderId() {
  return normalizarFolderId(process.env.DRIVE_IMPORTACOES_FOLDER_ID) || getDriveFinancasFolderId();
}

function getDriveBackupsFolderId() {
  return normalizarFolderId(process.env.DRIVE_BACKUPS_FOLDER_ID) || getDriveFinancasFolderId();
}

function criarErroDriveFinancasNaoConfigurado() {
  return {
    erro: 'Configure DRIVE_FINANCAS_FOLDER_ID no Railway com o ID da pasta principal de armazenamento financeiro do Google Drive.'
  };
}

// ============================================================================
// ROTAS: AUTENTICAÇÃO
// ============================================================================

app.get('/api/auth/google/url', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    prompt: 'consent',
  });

  res.json({ url: authUrl });
});

async function processarCallbackGoogle(code) {
  if (!code) {
    const error = new Error('Código de autorização não fornecido pelo Google');
    error.statusCode = 400;
    throw error;
  }

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();

  const { email, name, picture, id } = userInfo.data;

  // Verificar/criar usuário
  const result = await pool.query(
    `INSERT INTO usuarios (email, nome, foto_url, google_id, access_token, refresh_token)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (google_id) DO UPDATE SET
     nome = $2, foto_url = $3, access_token = $5, refresh_token = $6, atualizado_em = CURRENT_TIMESTAMP
     RETURNING id`,
    [email, name, picture, id,
     Buffer.from(tokens.access_token).toString('base64'),
     tokens.refresh_token ? Buffer.from(tokens.refresh_token).toString('base64') : null
    ]
  );

  const usuario_id = result.rows[0].id;
  const usuario = {
    id: usuario_id,
    email,
    nome: name,
    foto_url: picture
  };

  // Gerar JWT
  const token = jwt.sign(
    { usuario_id, email, nome: name, foto_url: picture },
    process.env.JWT_SECRET || 'seu_secret_aqui',
    { expiresIn: '7d' }
  );

  return { token, usuario };
}

function montarUrlFrontend(params = {}) {
  const frontendUrl = process.env.FRONTEND_URL || '/';

  if (frontendUrl.startsWith('http://') || frontendUrl.startsWith('https://')) {
    const url = new URL(frontendUrl);

    Object.entries(params).forEach(([key, value]) => {
      if (value) {
        url.searchParams.set(key, value);
      }
    });

    return url.toString();
  }

  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      query.set(key, value);
    }
  });

  const separator = frontendUrl.includes('?') ? '&' : '?';
  return query.toString() ? `${frontendUrl}${separator}${query}` : frontendUrl;
}

function redirecionarComToken(res, token) {
  return res.redirect(montarUrlFrontend({ token }));
}

function redirecionarComErro(res, mensagem) {
  return res.redirect(montarUrlFrontend({ auth_error: mensagem }));
}

async function responderCallbackGoogleJson(res, code) {
  try {
    const auth = await processarCallbackGoogle(code);
    return res.json(auth);
  } catch (error) {
    console.error('Erro auth:', error);
    return res.status(error.statusCode || 500).json({ erro: error.message });
  }
}

async function redirecionarCallbackGoogle(res, code) {
  try {
    const { token } = await processarCallbackGoogle(code);
    return redirecionarComToken(res, token);
  } catch (error) {
    console.error('Erro auth:', error);
    return redirecionarComErro(res, error.message);
  }
}

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return redirecionarComErro(res, `Login com Google cancelado ou recusado: ${error}`);
  }

  return redirecionarCallbackGoogle(res, code);
});

app.post('/api/auth/google/callback', async (req, res) => {
  return responderCallbackGoogleJson(res, req.body.code);
});

// ============================================================================
// MIDDLEWARE: Verificar JWT
// ============================================================================

function verificarToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'seu_secret_aqui');
    req.usuario = decoded;
    next();
  } catch (error) {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

// ============================================================================
// ROTAS: DRIVE
// ============================================================================

app.get('/api/drive/pastas', verificarToken, async (req, res) => {
  try {
    const usuarioResult = await pool.query(
      'SELECT access_token FROM usuarios WHERE id = $1',
      [req.usuario.usuario_id]
    );

    if (!usuarioResult.rows[0]) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const accessToken = Buffer.from(usuarioResult.rows[0].access_token, 'base64').toString();
    oauth2Client.setCredentials({ access_token: accessToken });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Listar pastas dentro da pasta de armazenamento configurada no Google Drive
    const financasFolderId = getDriveFinancasFolderId();

    if (!financasFolderId) {
      return res.status(400).json(criarErroDriveFinancasNaoConfigurado());
    }

    const res1 = await drive.files.list({
      q: `'${financasFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id, name)',
      pageSize: 50,
    });

    res.json({ pastas: res1.data.files });
  } catch (error) {
    console.error('Erro ao listar pastas:', error);
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/drive/arquivos/:pastaId', verificarToken, async (req, res) => {
  try {
    const usuarioResult = await pool.query(
      'SELECT access_token FROM usuarios WHERE id = $1',
      [req.usuario.usuario_id]
    );

    const accessToken = Buffer.from(usuarioResult.rows[0].access_token, 'base64').toString();
    oauth2Client.setCredentials({ access_token: accessToken });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const res1 = await drive.files.list({
      q: `'${req.params.pastaId}' in parents and mimeType='text/csv'`,
      fields: 'files(id, name, modifiedTime)',
      pageSize: 100,
      orderBy: 'modifiedTime desc'
    });

    res.json({ arquivos: res1.data.files });
  } catch (error) {
    console.error('Erro ao listar arquivos:', error);
    res.status(500).json({ erro: error.message });
  }
});

// ============================================================================
// ROTAS: IMPORTAÇÃO
// ============================================================================

app.post('/api/importar/:arquivoId', verificarToken, async (req, res) => {
  try {
    const { nomePasta } = req.body;

    const usuarioResult = await pool.query(
      'SELECT access_token FROM usuarios WHERE id = $1',
      [req.usuario.usuario_id]
    );

    const accessToken = Buffer.from(usuarioResult.rows[0].access_token, 'base64').toString();
    oauth2Client.setCredentials({ access_token: accessToken });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Download do arquivo
    const fileRes = await drive.files.get(
      { fileId: req.params.arquivoId, alt: 'media' },
      { responseType: 'stream' }
    );

    let conteudo = '';
    fileRes.data.on('data', chunk => {
      conteudo += chunk.toString('utf-8');
    });

    fileRes.data.on('end', async () => {
      try {
        // Parse CSV
        const transacoes = [];
        const linhas = conteudo.split('\n').filter(l => l.trim());

        // Detectar tipo de conta (Corrente ou Cartão)
        const eh_corrente = nomePasta.includes('CORRENTE') || nomePasta.includes('CONTA');

        for (let i = 1; i < linhas.length; i++) {
          const partes = linhas[i].split(',').map(p => p.trim());

          if (partes.length < 3) continue;

          const data = parseDataNubank(partes[0]);
          if (!data) continue;

          let descricao = partes[1];
          let valor = 0;
          let tipo = 'DEBITO';

          if (eh_corrente) {
            // Conta: [data, descricao, tipo, valor]
            valor = parseValorNubank(partes[3] || partes[2]);
            tipo = partes[2].includes('Crédito') || partes[3]?.includes('Crédito') ? 'CREDITO' : 'DEBITO';
          } else {
            // Cartão: [data, descricao, categoria, valor, saldo]
            valor = parseValorNubank(partes[3] || partes[2]);
            tipo = valor < 0 ? 'DEBITO' : 'CREDITO';
            valor = Math.abs(valor);
          }

          if (!descricao || valor === 0) continue;

          transacoes.push({
            data,
            descricao,
            valor,
            tipo,
            hash: gerarHashTransacao({ data, descricao, valor })
          });
        }

        // Criar/buscar conta
        let contaId = await buscarConta(req.usuario.usuario_id, nomePasta);
        if (!contaId) {
          contaId = await criarConta(req.usuario.usuario_id, nomePasta);
        }

        // Inserir transações
        let inseridas = 0, duplicadas = 0;

        for (const tx of transacoes) {
          const existe = await pool.query(
            'SELECT id FROM transacoes WHERE conta_id = $1 AND hash_transacao = $2',
            [contaId, tx.hash]
          );

          if (existe.rows.length > 0) {
            duplicadas++;
            continue;
          }

          await pool.query(
            `INSERT INTO transacoes
             (id, conta_id, data, descricao, valor, tipo, hash_transacao, criado_em)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [crypto.randomUUID(), contaId, tx.data, tx.descricao, tx.valor, tx.tipo, tx.hash]
          );

          inseridas++;
        }

        res.json({
          sucesso: true,
          contaId,
          inseridas,
          duplicadas,
          total: transacoes.length
        });
      } catch (parseError) {
        console.error('Erro ao processar CSV:', parseError);
        res.status(400).json({ erro: parseError.message });
      }
    });
  } catch (error) {
    console.error('Erro ao importar:', error);
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/importar', verificarToken, async (req, res) => {
  try {
    const {
      conta_id,
      conta_nome,
      banco = 'Importação Manual',
      tipo_conta = 'CHECKING',
      transacoes,
      nome_arquivo = `importacao_${new Date().toISOString().slice(0, 10)}.xlsx`,
      arquivo_base64,
    } = req.body;

    const transacoesValidadas = validarTransacoesImportacao(transacoes);
    let contaId = conta_id;

    if (contaId) {
      const conta = await pool.query(
        'SELECT id FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = true',
        [contaId, req.usuario.usuario_id]
      );

      if (conta.rows.length === 0) {
        return res.status(404).json({ erro: 'Conta não encontrada para este usuário.' });
      }
    } else {
      const nomeConta = String(conta_nome || 'Importação XLSX').trim();
      contaId = await buscarConta(req.usuario.usuario_id, nomeConta);
      if (!contaId) {
        const id = crypto.randomUUID();
        await pool.query(
          `INSERT INTO contas (id, usuario_id, nome, banco, tipo)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, req.usuario.usuario_id, nomeConta, banco, tipo_conta]
        );
        contaId = id;
      }
    }

    let inseridas = 0;
    let duplicadas = 0;

    for (const tx of transacoesValidadas) {
      const hash = gerarHashTransacao(tx);
      const insert = await pool.query(
        `INSERT INTO transacoes (conta_id, data, descricao, valor, tipo, hash_transacao, criado_em)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (hash_transacao) DO NOTHING
         RETURNING id`,
        [contaId, tx.data, tx.descricao, tx.valor, tx.tipo, hash]
      );

      if (insert.rows.length === 0) {
        duplicadas++;
      } else {
        inseridas++;
      }
    }

    const arquivoHash = gerarHashArquivo(nome_arquivo, transacoesValidadas);
    const backup = await pool.query(
      `INSERT INTO backups_drive (usuario_id, conta_id, nome_arquivo, arquivo_hash, status, total_transacoes)
       VALUES ($1, $2, $3, $4, 'pendente', $5)
       ON CONFLICT (usuario_id, arquivo_hash) DO UPDATE SET
         conta_id = EXCLUDED.conta_id,
         nome_arquivo = EXCLUDED.nome_arquivo,
         total_transacoes = EXCLUDED.total_transacoes,
         data_importacao = NOW(),
         status = 'pendente',
         mensagem_erro = NULL
       RETURNING id`,
      [req.usuario.usuario_id, contaId, nome_arquivo, arquivoHash, transacoesValidadas.length]
    );

    setImmediate(() => {
      backupParaDrive({
        backupId: backup.rows[0].id,
        usuarioId: req.usuario.usuario_id,
        contaId,
        nomeArquivo: nome_arquivo,
        transacoes: transacoesValidadas,
        arquivoBase64: arquivo_base64,
      });
    });

    res.json({
      sucesso: true,
      contaId,
      inseridas,
      duplicadas,
      total: transacoesValidadas.length,
      backupId: backup.rows[0].id,
      mensagem: `✅ ${inseridas} transações importadas. Backup agendado em segundo plano.`,
    });
  } catch (error) {
    console.error('Erro ao importar XLSX:', error);
    res.status(400).json({ erro: error.message });
  }
});

app.get('/api/notificacoes', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notificacoes
       WHERE usuario_id = $1
       ORDER BY criada_em DESC
       LIMIT 50`,
      [req.usuario.usuario_id]
    );
    const naoLidas = result.rows.filter((notificacao) => !notificacao.lida).length;
    res.json({ notificacoes: result.rows, naoLidas });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/notificacoes/:id/lida', verificarToken, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notificacoes SET lida = true WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.usuario_id]
    );
    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.delete('/api/notificacoes/:id', verificarToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM notificacoes WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.usuario_id]
    );
    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/admin/backups', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, c.nome AS conta_nome
       FROM backups_drive b
       LEFT JOIN contas c ON c.id = b.conta_id
       WHERE b.usuario_id = $1
       ORDER BY b.data_importacao DESC
       LIMIT 100`,
      [req.usuario.usuario_id]
    );
    const total = result.rows.length;
    const sucessos = result.rows.filter((backup) => backup.status === 'sucesso').length;
    const erros = result.rows.filter((backup) => backup.status === 'erro').length;
    res.json({
      backups: result.rows,
      stats: {
        total,
        sucessos,
        erros,
        pendentes: result.rows.filter((backup) => backup.status === 'pendente').length,
        taxaSucesso: total ? Math.round((sucessos / total) * 100) : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================================================
// ROTAS: TRANSAÇÕES
// ============================================================================

app.get('/api/transacoes/:contaId', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, c.nome as categoria_nome
       FROM transacoes t
       LEFT JOIN categorias c ON t.categoria_id = c.id
       WHERE t.conta_id = $1
       ORDER BY t.data DESC
       LIMIT 100`,
      [req.params.contaId]
    );

    res.json({ transacoes: result.rows });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/transacoes/:id/categorizar', verificarToken, async (req, res) => {
  try {
    const { categoriaId } = req.body;

    await pool.query(
      'UPDATE transacoes SET categoria_id = $1 WHERE id = $2',
      [categoriaId, req.params.id]
    );

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================================================
// ROTAS: CONTAS
// ============================================================================

async function buscarConta(usuarioId, nomePasta) {
  const result = await pool.query(
    'SELECT id FROM contas WHERE usuario_id = $1 AND nome = $2',
    [usuarioId, nomePasta]
  );
  return result.rows[0]?.id;
}

async function criarConta(usuarioId, nomePasta) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO contas (id, usuario_id, nome, banco, tipo)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, usuarioId, nomePasta, 'Nubank',
     nomePasta.includes('CORRENTE') || nomePasta.includes('CONTA') ? 'CHECKING' : 'CREDIT_CARD'
    ]
  );
  return id;
}

app.get('/api/contas', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM contas WHERE usuario_id = $1 ORDER BY criado_em DESC',
      [req.usuario.usuario_id]
    );

    // Buscar saldo de cada conta
    const contas = await Promise.all(
      result.rows.map(async (conta) => {
        const saldoResult = await pool.query(
          `SELECT
            SUM(CASE WHEN tipo = 'CREDITO' THEN valor ELSE -valor END) as saldo
           FROM transacoes
           WHERE conta_id = $1`,
          [conta.id]
        );

        return {
          ...conta,
          saldo: parseFloat(saldoResult.rows[0]?.saldo || 0)
        };
      })
    );

    res.json({ contas });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================================================
// ROTAS: CATEGORIAS PADRÃO
// ============================================================================

app.get('/api/categorias', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM categorias WHERE usuario_id = $1 OR usuario_id IS NULL ORDER BY nome',
      [req.usuario.usuario_id]
    );

    res.json({ categorias: result.rows });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// ============================================================================
// INICIAR SERVER
// ============================================================================

// ===========================================================================
// FRONTEND STATIC FILES
// ===========================================================================

const distPath = path.join(__dirname, 'dist');
const indexPath = path.join(distPath, 'index.html');

// Serve static files from React build
app.use(express.static(distPath));

// Fallback: send index.html for all non-API routes (SPA)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    return res.status(404).json({ erro: 'Rota nao encontrada' });
  }

  if (!fs.existsSync(indexPath)) {
    return res.status(503).send(
      'Frontend build not found. Run `npm run build` before starting the server.'
    );
  }

  return res.sendFile(indexPath);
});

async function iniciarServidor() {
  try {
    if (process.env.SKIP_DB_INIT !== 'true') {
      await inicializarBanco();
      console.log('✅ Banco de dados inicializado/verificado');
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`✅ Server rodando na porta ${PORT}`);
      console.log(`📍 http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Erro ao inicializar servidor:', error);
    process.exit(1);
  }
}

iniciarServidor();
