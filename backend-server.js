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
const uploadLimit = process.env.UPLOAD_LIMIT || '50mb';

app.use(express.json({ limit: uploadLimit }));
app.use(express.urlencoded({ extended: true, limit: uploadLimit }));

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({
      erro: 'Arquivo grande demais para o limite atual do servidor.',
      detalhes: `O limite atual para envio é ${uploadLimit}. Divida a planilha em arquivos menores ou remova abas, fórmulas e imagens desnecessárias.`,
    });
  }

  return next(error);
});

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
    DO $$
    BEGIN
      IF to_regclass('public.transacoes') IS NOT NULL THEN
        EXECUTE '
          WITH duplicadas AS (
            SELECT
              id,
              FIRST_VALUE(id) OVER (
                PARTITION BY nome, tipo
                ORDER BY criado_em ASC NULLS LAST, id ASC
              ) AS categoria_principal_id
            FROM categorias
            WHERE usuario_id IS NULL
          )
          UPDATE transacoes t
          SET categoria_id = duplicadas.categoria_principal_id
          FROM duplicadas
          WHERE t.categoria_id = duplicadas.id
            AND duplicadas.id <> duplicadas.categoria_principal_id
        ';
      END IF;

      IF to_regclass('public.regras_categorizacao') IS NOT NULL THEN
        EXECUTE '
          WITH duplicadas AS (
            SELECT
              id,
              FIRST_VALUE(id) OVER (
                PARTITION BY nome, tipo
                ORDER BY criado_em ASC NULLS LAST, id ASC
              ) AS categoria_principal_id
            FROM categorias
            WHERE usuario_id IS NULL
          )
          UPDATE regras_categorizacao r
          SET categoria_id = duplicadas.categoria_principal_id
          FROM duplicadas
          WHERE r.categoria_id = duplicadas.id
            AND duplicadas.id <> duplicadas.categoria_principal_id
        ';
      END IF;

      IF to_regclass('public.descricao_categoria_mapping') IS NOT NULL THEN
        EXECUTE '
          WITH duplicadas AS (
            SELECT
              id,
              FIRST_VALUE(id) OVER (
                PARTITION BY nome, tipo
                ORDER BY criado_em ASC NULLS LAST, id ASC
              ) AS categoria_principal_id
            FROM categorias
            WHERE usuario_id IS NULL
          )
          UPDATE descricao_categoria_mapping m
          SET categoria_id = duplicadas.categoria_principal_id
          FROM duplicadas
          WHERE m.categoria_id = duplicadas.id
            AND duplicadas.id <> duplicadas.categoria_principal_id
        ';
      END IF;

      IF to_regclass('public.orcamentos') IS NOT NULL THEN
        EXECUTE '
          WITH duplicadas AS (
            SELECT
              id,
              FIRST_VALUE(id) OVER (
                PARTITION BY nome, tipo
                ORDER BY criado_em ASC NULLS LAST, id ASC
              ) AS categoria_principal_id
            FROM categorias
            WHERE usuario_id IS NULL
          )
          UPDATE orcamentos o
          SET categoria_id = duplicadas.categoria_principal_id
          FROM duplicadas
          WHERE o.categoria_id = duplicadas.id
            AND duplicadas.id <> duplicadas.categoria_principal_id
        ';
      END IF;

      WITH duplicadas AS (
        SELECT
          id,
          FIRST_VALUE(id) OVER (
            PARTITION BY nome, tipo
            ORDER BY criado_em ASC NULLS LAST, id ASC
          ) AS categoria_principal_id
        FROM categorias
        WHERE usuario_id IS NULL
      )
      UPDATE categorias c
      SET categoria_pai_id = duplicadas.categoria_principal_id
      FROM duplicadas
      WHERE c.categoria_pai_id = duplicadas.id
        AND duplicadas.id <> duplicadas.categoria_principal_id;

      WITH categorias_duplicadas AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY nome, tipo
            ORDER BY criado_em ASC NULLS LAST, id ASC
          ) AS ordem
        FROM categorias
        WHERE usuario_id IS NULL
      )
      DELETE FROM categorias c
      USING categorias_duplicadas
      WHERE c.id = categorias_duplicadas.id
        AND categorias_duplicadas.ordem > 1;
    END $$;
  `);

  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_padrao_nome_tipo_unique ON categorias(nome, tipo) WHERE usuario_id IS NULL");

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

  await pool.query(`
    ALTER TABLE transacoes
      ADD COLUMN IF NOT EXISTS categoria_origem VARCHAR(20),
      ADD COLUMN IF NOT EXISTS regra_categorizacao_id UUID,
      ADD COLUMN IF NOT EXISTS eh_transferencia_interna BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS transferencia_grupo_id UUID
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS regras_categorizacao (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      categoria_id UUID NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
      termo TEXT NOT NULL,
      termo_normalizado TEXT NOT NULL,
      tipo_match VARCHAR(20) DEFAULT 'CONTAINS',
      prioridade INT DEFAULT 0,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_conta ON transacoes(conta_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_categoria ON transacoes(categoria_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_data ON transacoes(data)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_hash ON transacoes(hash_transacao)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_categoria_origem ON transacoes(categoria_origem)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_transferencia_interna ON transacoes(eh_transferencia_interna, transferencia_grupo_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_regras_categorizacao_usuario ON regras_categorizacao(usuario_id, ativo)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_regras_categorizacao_termo ON regras_categorizacao(termo_normalizado)');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_regras_categorizacao_unique
    ON regras_categorizacao(usuario_id, categoria_id, termo_normalizado, tipo_match)
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_transacoes_regra_categorizacao'
      ) THEN
        ALTER TABLE transacoes
          ADD CONSTRAINT fk_transacoes_regra_categorizacao
          FOREIGN KEY (regra_categorizacao_id)
          REFERENCES regras_categorizacao(id)
          ON DELETE SET NULL;
      END IF;
    END $$;
  `);

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


function normalizarDescricaoCategorizacao(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g, ' ')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, ' ')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sugerirTermoRegra(descricao) {
  const partes = String(descricao || '')
    .split(/\s+-\s+|\s+–\s+|\s+—\s+/)
    .map((parte) => normalizarDescricaoCategorizacao(parte))
    .filter(Boolean)
    .filter((parte) => !/^\d+$/.test(parte))
    .filter((parte) => !/^(TRANSFERENCIA|ENVIADA|RECEBIDA|PIX|PAGAMENTO|COMPRA|DEBITO|CREDITO)\b/.test(parte));

  const fornecedor = partes.find((parte) => /[A-Z]/.test(parte) && parte.length >= 3);
  return fornecedor || normalizarDescricaoCategorizacao(descricao);
}

async function buscarRegraCompatível(usuarioId, descricao) {
  const descricaoNormalizada = normalizarDescricaoCategorizacao(descricao);
  if (!descricaoNormalizada) return null;

  const regras = await pool.query(
    `SELECT r.*, c.nome AS categoria_nome
     FROM regras_categorizacao r
     JOIN categorias c ON c.id = r.categoria_id
     WHERE r.usuario_id = $1 AND r.ativo = true
     ORDER BY r.prioridade DESC, r.criado_em ASC`,
    [usuarioId]
  );

  return regras.rows.find((regra) => {
    if (regra.tipo_match !== 'CONTAINS') return false;
    return descricaoNormalizada.includes(regra.termo_normalizado);
  }) || null;
}

async function criarOuAtualizarRegraCategorizacao(usuarioId, categoriaId, termo, prioridade = 0) {
  const termoLimpo = sugerirTermoRegra(termo);
  const termoNormalizado = normalizarDescricaoCategorizacao(termoLimpo);

  if (!termoNormalizado) {
    throw new Error('Informe um termo válido para criar a regra de categorização.');
  }

  const result = await pool.query(
    `INSERT INTO regras_categorizacao (usuario_id, categoria_id, termo, termo_normalizado, tipo_match, prioridade, ativo, atualizado_em)
     VALUES ($1, $2, $3, $4, 'CONTAINS', $5, true, NOW())
     ON CONFLICT (usuario_id, categoria_id, termo_normalizado, tipo_match)
     DO UPDATE SET
       termo = EXCLUDED.termo,
       prioridade = GREATEST(regras_categorizacao.prioridade, EXCLUDED.prioridade),
       ativo = true,
       atualizado_em = NOW()
     RETURNING *`,
    [usuarioId, categoriaId, termoLimpo, termoNormalizado, prioridade]
  );

  return result.rows[0];
}

async function aplicarRegraEmTransacoesSemCategoria(usuarioId, regra) {
  const transacoes = await pool.query(
    `SELECT t.id, t.descricao
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND t.categoria_id IS NULL`,
    [usuarioId]
  );

  const ids = transacoes.rows
    .filter((tx) => normalizarDescricaoCategorizacao(tx.descricao).includes(regra.termo_normalizado))
    .map((tx) => tx.id);

  if (ids.length === 0) return 0;

  const result = await pool.query(
    `UPDATE transacoes
     SET categoria_id = $1,
         categoria_origem = 'AUTO',
         regra_categorizacao_id = $2,
         atualizado_em = NOW()
     WHERE id = ANY($3::uuid[])
     RETURNING id`,
    [regra.categoria_id, regra.id, ids]
  );

  return result.rowCount;
}

async function aplicarRegrasAtivasEmTransacoesSemCategoria(usuarioId) {
  const regras = await pool.query(
    `SELECT * FROM regras_categorizacao
     WHERE usuario_id = $1 AND ativo = true
     ORDER BY prioridade DESC, criado_em ASC`,
    [usuarioId]
  );

  let total = 0;
  for (const regra of regras.rows) {
    total += await aplicarRegraEmTransacoesSemCategoria(usuarioId, regra);
  }

  return total;
}

async function validarCategoriaDoUsuario(usuarioId, categoriaId) {
  const categoria = await pool.query(
    `SELECT id FROM categorias
     WHERE id = $1 AND ativa = true AND (usuario_id = $2 OR usuario_id IS NULL)`,
    [categoriaId, usuarioId]
  );

  if (categoria.rows.length === 0) {
    throw new Error('Categoria não encontrada para este usuário.');
  }
}

async function categorizarTransacoesUsuario(usuarioId, transacaoIds, categoriaId, { origem = 'MANUAL', regraId = null } = {}) {
  if (!Array.isArray(transacaoIds) || transacaoIds.length === 0) return [];

  const result = await pool.query(
    `UPDATE transacoes t
     SET categoria_id = $1,
         categoria_origem = $2,
         regra_categorizacao_id = $3,
         atualizado_em = NOW()
     FROM contas c
     WHERE c.id = t.conta_id
       AND c.usuario_id = $4
       AND t.id = ANY($5::uuid[])
       AND t.deletado_em IS NULL
     RETURNING t.*`,
    [categoriaId, origem, regraId, usuarioId, transacaoIds]
  );

  return result.rows;
}

async function montarRespostaTransacoes(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const result = await pool.query(
    `SELECT t.*, cat.nome as categoria_nome
     FROM transacoes t
     LEFT JOIN categorias cat ON t.categoria_id = cat.id
     WHERE t.id = ANY($1::uuid[])
     ORDER BY t.data DESC`,
    [ids]
  );
  return result.rows;
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
    const mensagemDrive = 'Não foi possível salvar o backup no Google Drive. A importação foi concluída, mas o backup será tentado novamente em segundo plano.';
    const detalhesDrive = error.message || 'Erro desconhecido no Google Drive.';

    await pool.query(
      `UPDATE backups_drive
       SET status = 'erro', mensagem_erro = $1, tentativas = tentativas + 1, proxima_tentativa = NOW() + INTERVAL '1 hour'
       WHERE id = $2`,
      [`${mensagemDrive} Detalhes: ${detalhesDrive}`, backupId]
    );

    await criarNotificacao(usuarioId, 'backup_erro', {
      titulo: '❌ Erro no Backup',
      mensagem: `${mensagemDrive} Detalhes: ${detalhesDrive}`,
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

          const regra = await buscarRegraCompatível(req.usuario.usuario_id, tx.descricao);

          await pool.query(
            `INSERT INTO transacoes
             (id, conta_id, data, descricao, valor, tipo, categoria_id, categoria_origem, regra_categorizacao_id, hash_transacao, criado_em)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
            [
              crypto.randomUUID(),
              contaId,
              tx.data,
              tx.descricao,
              tx.valor,
              tx.tipo,
              regra?.categoria_id || null,
              regra ? 'AUTO' : null,
              regra?.id || null,
              tx.hash,
            ]
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
        res.status(400).json({
          erro: 'Não foi possível importar o arquivo porque os dados estão inválidos.',
          detalhes: parseError.message,
        });
      }
    });
  } catch (error) {
    console.error('Erro ao importar:', error);
    res.status(500).json({
      erro: 'Não foi possível concluir a importação do arquivo.',
      detalhes: error.message || 'Erro inesperado no servidor.',
    });
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
      const regra = await buscarRegraCompatível(req.usuario.usuario_id, tx.descricao);
      const insert = await pool.query(
        `INSERT INTO transacoes (conta_id, data, descricao, valor, tipo, categoria_id, categoria_origem, regra_categorizacao_id, hash_transacao, criado_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (hash_transacao) DO NOTHING
         RETURNING id`,
        [
          contaId,
          tx.data,
          tx.descricao,
          tx.valor,
          tx.tipo,
          regra?.categoria_id || null,
          regra ? 'AUTO' : null,
          regra?.id || null,
          hash,
        ]
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

    if (error?.code) {
      return res.status(500).json({
        erro: 'Não foi possível salvar a importação no banco de dados.',
        detalhes: error.detail || error.message || 'Erro interno do banco de dados.',
      });
    }

    if (error?.message) {
      return res.status(400).json({
        erro: 'Não foi possível importar a planilha porque há dados inválidos.',
        detalhes: error.message,
      });
    }

    return res.status(500).json({
      erro: 'Erro inesperado ao importar. Tente novamente ou contate o suporte.',
    });
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
// ROTAS: DASHBOARD
// ============================================================================

function normalizarDataDashboard(valor, fallback) {
  const texto = String(valor || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;
  return fallback;
}

app.get('/api/dashboard/resumo', verificarToken, async (req, res) => {
  try {
    const hoje = new Date();
    const inicioMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const fimMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const dataInicial = normalizarDataDashboard(req.query.dataInicial, inicioMes);
    const dataFinal = normalizarDataDashboard(req.query.dataFinal, fimMes);

    const transacoesResult = await pool.query(
      `SELECT
         t.id,
         t.data::date AS data,
         t.valor,
         t.tipo,
         t.categoria_id,
         COALESCE(t.eh_transferencia_interna, false) AS eh_transferencia_interna,
         COALESCE(cat.nome, 'Sem categoria') AS categoria_nome,
         conta.id AS conta_id,
         conta.nome AS conta_nome
       FROM transacoes t
       JOIN contas conta ON conta.id = t.conta_id
       LEFT JOIN categorias cat ON cat.id = t.categoria_id
       WHERE conta.usuario_id = $1
         AND t.deletado_em IS NULL
         AND t.data BETWEEN $2::date AND $3::date`,
      [req.usuario.usuario_id, dataInicial, dataFinal]
    );

    const transacoes = transacoesResult.rows.map((tx) => ({
      ...tx,
      valor: Number(tx.valor || 0),
      data: tx.data instanceof Date ? tx.data.toISOString().slice(0, 10) : String(tx.data).slice(0, 10),
    }));

    const transacoesOperacionais = transacoes.filter((tx) => !tx.eh_transferencia_interna);
    const transferenciasInternas = transacoes.filter((tx) => tx.eh_transferencia_interna);
    const receitas = transacoesOperacionais
      .filter((tx) => tx.tipo === 'CREDITO')
      .reduce((total, tx) => total + tx.valor, 0);
    const despesasTransacoes = transacoesOperacionais.filter((tx) => tx.tipo === 'DEBITO');
    const despesas = despesasTransacoes.reduce((total, tx) => total + tx.valor, 0);
    const quantidadeTransacoes = transacoes.length;
    const transacoesCategorizadas = transacoes.filter((tx) => tx.categoria_id).length;

    const movimentacaoPorPeriodoMap = new Map();
    const despesasPorCategoriaMap = new Map();
    const movimentacaoPorContaMap = new Map();
    const gastosPorDiaMap = new Map();

    transacoesOperacionais.forEach((tx) => {
      const periodo = tx.data;
      if (!movimentacaoPorPeriodoMap.has(periodo)) {
        movimentacaoPorPeriodoMap.set(periodo, { periodo, receitas: 0, despesas: 0, saldo: 0 });
      }
      const itemPeriodo = movimentacaoPorPeriodoMap.get(periodo);
      if (tx.tipo === 'CREDITO') itemPeriodo.receitas += tx.valor;
      if (tx.tipo === 'DEBITO') itemPeriodo.despesas += tx.valor;
      itemPeriodo.saldo = itemPeriodo.receitas - itemPeriodo.despesas;

      if (!movimentacaoPorContaMap.has(tx.conta_id)) {
        movimentacaoPorContaMap.set(tx.conta_id, {
          contaId: tx.conta_id,
          contaNome: tx.conta_nome,
          receitas: 0,
          despesas: 0,
          saldo: 0,
          quantidadeTransacoes: 0,
          volume: 0,
        });
      }
      const itemConta = movimentacaoPorContaMap.get(tx.conta_id);
      itemConta.quantidadeTransacoes += 1;
      itemConta.volume += tx.valor;
      if (tx.tipo === 'CREDITO') itemConta.receitas += tx.valor;
      if (tx.tipo === 'DEBITO') itemConta.despesas += tx.valor;
      itemConta.saldo = itemConta.receitas - itemConta.despesas;

      if (tx.tipo === 'DEBITO') {
        const categoria = tx.categoria_nome || 'Sem categoria';
        despesasPorCategoriaMap.set(categoria, (despesasPorCategoriaMap.get(categoria) || 0) + tx.valor);
        gastosPorDiaMap.set(tx.data, (gastosPorDiaMap.get(tx.data) || 0) + tx.valor);
      }
    });

    const movimentacaoPorPeriodo = Array.from(movimentacaoPorPeriodoMap.values())
      .sort((a, b) => a.periodo.localeCompare(b.periodo));
    const despesasPorCategoria = Array.from(despesasPorCategoriaMap.entries())
      .map(([categoriaNome, valor]) => ({
        categoriaNome,
        valor,
        percentual: despesas > 0 ? Number(((valor / despesas) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 8);
    const movimentacaoPorConta = Array.from(movimentacaoPorContaMap.values())
      .sort((a, b) => b.volume - a.volume);

    const maiorCategoriaDespesa = despesasPorCategoria[0] || null;
    const contaMaiorMovimento = movimentacaoPorConta[0] || null;
    const diaMaiorGasto = Array.from(gastosPorDiaMap.entries())
      .map(([data, valor]) => ({ data, valor }))
      .sort((a, b) => b.valor - a.valor)[0] || null;

    res.json({
      periodo: { dataInicial, dataFinal },
      kpis: {
        receitas,
        despesas,
        saldoLiquido: receitas - despesas,
        quantidadeTransacoes,
        ticketMedioDespesa: despesasTransacoes.length ? despesas / despesasTransacoes.length : 0,
        percentualCategorizado: quantidadeTransacoes ? Number(((transacoesCategorizadas / quantidadeTransacoes) * 100).toFixed(1)) : 0,
        transferenciasInternas: transferenciasInternas.length,
        valorTransferenciasInternas: transferenciasInternas.reduce((total, tx) => total + tx.valor, 0),
      },
      series: {
        movimentacaoPorPeriodo,
        despesasPorCategoria,
        movimentacaoPorConta,
      },
      insights: {
        maiorCategoriaDespesa,
        contaMaiorMovimento,
        diaMaiorGasto,
        percentualPrincipalCategoria: maiorCategoriaDespesa?.percentual || 0,
        transacoesSemCategoria: quantidadeTransacoes - transacoesCategorizadas,
      },
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});


function diferencaDias(dataA, dataB) {
  const a = new Date(`${String(dataA).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(dataB).slice(0, 10)}T00:00:00Z`);
  return Math.abs(Math.round((a - b) / 86400000));
}

function descricaoIndicaTransferencia(descricao) {
  return /\b(PIX|TRANSFERENCIA|TRANSFERÊNCIA|TED|DOC|ENVIO|ENVIADO|RECEBIDA|RECEBIDO|ENTRE CONTAS)\b/i.test(String(descricao || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

function montarTransacaoTransferencia(tx) {
  return {
    id: tx.id,
    data: tx.data,
    conta_id: tx.conta_id,
    conta_nome: tx.conta_nome,
    descricao: tx.descricao,
    valor: Number(tx.valor || 0),
    tipo: tx.tipo,
  };
}

async function buscarTransacoesUsuario(usuarioId, filtros = {}) {
  const valores = [usuarioId];
  const where = ['conta.usuario_id = $1', 't.deletado_em IS NULL'];

  if (filtros.contaId) {
    valores.push(filtros.contaId);
    where.push(`t.conta_id = $${valores.length}`);
  }
  if (filtros.categoriaId) {
    valores.push(filtros.categoriaId);
    where.push(`t.categoria_id = $${valores.length}`);
  }
  if (filtros.status === 'sem') where.push('t.categoria_id IS NULL');
  if (filtros.status === 'categorizadas') where.push('t.categoria_id IS NOT NULL');
  if (['CREDITO', 'DEBITO'].includes(filtros.tipo)) {
    valores.push(filtros.tipo);
    where.push(`t.tipo = $${valores.length}`);
  }
  if (filtros.dataInicial) {
    valores.push(filtros.dataInicial);
    where.push(`t.data >= $${valores.length}::date`);
  }
  if (filtros.dataFinal) {
    valores.push(filtros.dataFinal);
    where.push(`t.data <= $${valores.length}::date`);
  }
  if (filtros.busca) {
    valores.push(`%${String(filtros.busca).trim()}%`);
    where.push(`t.descricao ILIKE $${valores.length}`);
  }

  const result = await pool.query(
    `SELECT t.*, conta.nome AS conta_nome, cat.nome AS categoria_nome
     FROM transacoes t
     JOIN contas conta ON conta.id = t.conta_id
     LEFT JOIN categorias cat ON cat.id = t.categoria_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.data DESC, t.criado_em DESC
     LIMIT 1000`,
    valores
  );

  return result.rows;
}

app.get('/api/transacoes', verificarToken, async (req, res) => {
  try {
    await aplicarRegrasAtivasEmTransacoesSemCategoria(req.usuario.usuario_id);
    const transacoes = await buscarTransacoesUsuario(req.usuario.usuario_id, {
      contaId: req.query.contaId,
      categoriaId: req.query.categoriaId,
      status: req.query.status,
      tipo: req.query.tipo,
      dataInicial: req.query.dataInicial,
      dataFinal: req.query.dataFinal,
      busca: req.query.busca,
    });

    res.json({ transacoes });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.get('/api/transferencias-internas/sugestoes', verificarToken, async (req, res) => {
  try {
    const transacoes = await buscarTransacoesUsuario(req.usuario.usuario_id, {
      contaId: req.query.contaId,
      dataInicial: req.query.dataInicial,
      dataFinal: req.query.dataFinal,
    });

    const candidatas = transacoes
      .filter((tx) => !tx.eh_transferencia_interna)
      .map((tx) => ({ ...tx, valor: Number(tx.valor || 0), data: tx.data instanceof Date ? tx.data.toISOString().slice(0, 10) : String(tx.data).slice(0, 10) }));
    const debitos = candidatas.filter((tx) => tx.tipo === 'DEBITO');
    const creditos = candidatas.filter((tx) => tx.tipo === 'CREDITO');
    const sugestoes = [];
    const usados = new Set();

    for (const debito of debitos) {
      for (const credito of creditos) {
        if (usados.has(debito.id) || usados.has(credito.id)) continue;
        if (debito.conta_id === credito.conta_id) continue;

        const diferencaValor = Math.abs(Math.abs(debito.valor) - Math.abs(credito.valor));
        if (diferencaValor > 0.05) continue;

        const dias = diferencaDias(debito.data, credito.data);
        if (dias > 2) continue;

        const motivos = ['Mesmo valor', 'Contas diferentes'];
        if (dias === 0) motivos.push('Mesma data');
        if (dias > 0) motivos.push(`Datas próximas (${dias} dia${dias > 1 ? 's' : ''})`);
        const descricaoTransferencia = descricaoIndicaTransferencia(debito.descricao) || descricaoIndicaTransferencia(credito.descricao);
        if (descricaoTransferencia) motivos.push('Descrição contém Pix/transferência');
        const confianca = dias === 0 && descricaoTransferencia ? 'alta' : descricaoTransferencia ? 'média' : 'baixa';

        sugestoes.push({
          id: `sugestao-${sugestoes.length + 1}`,
          confianca,
          motivos,
          debito: montarTransacaoTransferencia(debito),
          credito: montarTransacaoTransferencia(credito),
        });
        usados.add(debito.id);
        usados.add(credito.id);
        break;
      }
      if (sugestoes.length >= 50) break;
    }

    res.json({ sugestoes });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/transferencias-internas/marcar', verificarToken, async (req, res) => {
  try {
    const { debitoId, creditoId } = req.body;
    const result = await pool.query(
      `SELECT t.*, conta.usuario_id
       FROM transacoes t
       JOIN contas conta ON conta.id = t.conta_id
       WHERE t.id = ANY($1::uuid[]) AND conta.usuario_id = $2 AND t.deletado_em IS NULL`,
      [[debitoId, creditoId], req.usuario.usuario_id]
    );

    if (result.rows.length !== 2) {
      return res.status(404).json({ erro: 'Transações não encontradas ou não pertencem ao usuário.' });
    }

    const debito = result.rows.find((tx) => tx.tipo === 'DEBITO');
    const credito = result.rows.find((tx) => tx.tipo === 'CREDITO');
    if (!debito || !credito) return res.status(400).json({ erro: 'Selecione uma transação de débito e uma de crédito.' });
    if (debito.conta_id === credito.conta_id) return res.status(400).json({ erro: 'As transações precisam pertencer a contas diferentes.' });
    const diferencaValor = Math.abs(Math.abs(Number(debito.valor || 0)) - Math.abs(Number(credito.valor || 0)));
    if (diferencaValor > 0.05) return res.status(400).json({ erro: 'Os valores das transações não são compatíveis.' });

    const grupoId = crypto.randomUUID();
    await pool.query(
      `UPDATE transacoes
       SET eh_transferencia_interna = true,
           transferencia_grupo_id = $1,
           atualizado_em = NOW()
       WHERE id = ANY($2::uuid[])`,
      [grupoId, [debito.id, credito.id]]
    );

    res.json({ sucesso: true, transferenciaGrupoId: grupoId, mensagem: 'Transferência interna marcada com sucesso.' });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/transferencias-internas/desmarcar', verificarToken, async (req, res) => {
  try {
    const { transferenciaGrupoId, transacaoId } = req.body;
    let grupoId = transferenciaGrupoId;

    if (!grupoId && transacaoId) {
      const grupo = await pool.query(
        `SELECT t.transferencia_grupo_id
         FROM transacoes t
         JOIN contas c ON c.id = t.conta_id
         WHERE t.id = $1 AND c.usuario_id = $2`,
        [transacaoId, req.usuario.usuario_id]
      );
      grupoId = grupo.rows[0]?.transferencia_grupo_id;
    }

    if (!grupoId) return res.status(400).json({ erro: 'Informe uma transferência para desmarcar.' });

    const result = await pool.query(
      `UPDATE transacoes t
       SET eh_transferencia_interna = false,
           transferencia_grupo_id = NULL,
           atualizado_em = NOW()
       FROM contas c
       WHERE c.id = t.conta_id
         AND c.usuario_id = $1
         AND t.transferencia_grupo_id = $2
       RETURNING t.id`,
      [req.usuario.usuario_id, grupoId]
    );

    if (result.rows.length === 0) return res.status(404).json({ erro: 'Transferência interna não encontrada para este usuário.' });
    res.json({ sucesso: true, atualizadas: result.rows.length, mensagem: 'Transferência interna desmarcada com sucesso.' });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================================================
// ROTAS: TRANSAÇÕES
// ============================================================================

app.get('/api/transacoes/:contaId', verificarToken, async (req, res) => {
  try {
    await aplicarRegrasAtivasEmTransacoesSemCategoria(req.usuario.usuario_id);

    const result = await pool.query(
      `SELECT t.*, c.nome as categoria_nome
       FROM transacoes t
       JOIN contas conta ON conta.id = t.conta_id
       LEFT JOIN categorias c ON t.categoria_id = c.id
       WHERE t.conta_id = $1 AND conta.usuario_id = $2 AND t.deletado_em IS NULL
       ORDER BY t.data DESC
       LIMIT 500`,
      [req.params.contaId, req.usuario.usuario_id]
    );

    res.json({ transacoes: result.rows });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.delete('/api/transacoes/:id', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM transacoes t
       USING contas c
       WHERE t.conta_id = c.id
         AND t.id = $1
         AND c.usuario_id = $2
       RETURNING t.id`,
      [req.params.id, req.usuario.usuario_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada ou não pertence ao usuário' });
    }

    res.json({
      sucesso: true,
      mensagem: 'Transação excluída com sucesso',
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/transacoes/categorizar-lote', verificarToken, async (req, res) => {
  try {
    const { transacaoIds, categoriaId, criarRegra = false, termoRegra } = req.body;

    if (!Array.isArray(transacaoIds) || transacaoIds.length === 0) {
      return res.status(400).json({ erro: 'Selecione ao menos uma transação para categorizar.' });
    }

    await validarCategoriaDoUsuario(req.usuario.usuario_id, categoriaId);

    let regra = null;
    let atualizadasPorRegra = 0;

    if (criarRegra) {
      let termoBase = termoRegra;

      if (!termoBase) {
        const primeiraTransacao = await pool.query(
          `SELECT t.descricao
           FROM transacoes t
           JOIN contas c ON c.id = t.conta_id
           WHERE c.usuario_id = $1 AND t.id = ANY($2::uuid[])
           LIMIT 1`,
          [req.usuario.usuario_id, transacaoIds]
        );
        termoBase = primeiraTransacao.rows[0]?.descricao;
      }

      regra = await criarOuAtualizarRegraCategorizacao(req.usuario.usuario_id, categoriaId, termoBase);
      atualizadasPorRegra = await aplicarRegraEmTransacoesSemCategoria(req.usuario.usuario_id, regra);
    }

    const atualizadas = await categorizarTransacoesUsuario(req.usuario.usuario_id, transacaoIds, categoriaId, {
      origem: 'MANUAL',
      regraId: regra?.id || null,
    });

    res.json({
      sucesso: true,
      atualizadas: atualizadas.length,
      atualizadasPorRegra,
      regra,
      transacoes: await montarRespostaTransacoes(atualizadas),
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/transacoes/:id/categorizar', verificarToken, async (req, res) => {
  try {
    const { categoriaId, criarRegra = false, termoRegra } = req.body;

    await validarCategoriaDoUsuario(req.usuario.usuario_id, categoriaId);

    const transacao = await pool.query(
      `SELECT t.*
       FROM transacoes t
       JOIN contas c ON c.id = t.conta_id
       WHERE t.id = $1 AND c.usuario_id = $2 AND t.deletado_em IS NULL`,
      [req.params.id, req.usuario.usuario_id]
    );

    if (transacao.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada para este usuário.' });
    }

    let regra = null;
    let atualizadasPorRegra = 0;

    if (criarRegra) {
      regra = await criarOuAtualizarRegraCategorizacao(
        req.usuario.usuario_id,
        categoriaId,
        termoRegra || transacao.rows[0].descricao
      );
      atualizadasPorRegra = await aplicarRegraEmTransacoesSemCategoria(req.usuario.usuario_id, regra);
    }

    const atualizadas = await categorizarTransacoesUsuario(req.usuario.usuario_id, [req.params.id], categoriaId, {
      origem: 'MANUAL',
      regraId: regra?.id || null,
    });

    res.json({
      sucesso: true,
      atualizadas: atualizadas.length,
      atualizadasPorRegra,
      regra,
      transacao: (await montarRespostaTransacoes(atualizadas))[0],
    });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// ============================================================================
// ROTAS: REGRAS DE CATEGORIZAÇÃO
// ============================================================================

app.get('/api/regras-categorizacao', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, c.nome AS categoria_nome, c.emoji AS categoria_emoji
       FROM regras_categorizacao r
       JOIN categorias c ON c.id = r.categoria_id
       WHERE r.usuario_id = $1
       ORDER BY r.ativo DESC, r.prioridade DESC, r.termo ASC`,
      [req.usuario.usuario_id]
    );

    res.json({ regras: result.rows });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/regras-categorizacao', verificarToken, async (req, res) => {
  try {
    const { categoriaId, termo, prioridade = 0 } = req.body;

    await validarCategoriaDoUsuario(req.usuario.usuario_id, categoriaId);
    const regra = await criarOuAtualizarRegraCategorizacao(req.usuario.usuario_id, categoriaId, termo, prioridade);
    const atualizadasPorRegra = await aplicarRegraEmTransacoesSemCategoria(req.usuario.usuario_id, regra);

    res.status(201).json({ sucesso: true, regra, atualizadasPorRegra });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/regras-categorizacao/:id/desativar', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE regras_categorizacao
       SET ativo = false, atualizado_em = NOW()
       WHERE id = $1 AND usuario_id = $2
       RETURNING *`,
      [req.params.id, req.usuario.usuario_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Regra não encontrada para este usuário.' });
    }

    res.json({ sucesso: true, regra: result.rows[0] });
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
      `SELECT DISTINCT ON (COALESCE(usuario_id::text, 'padrao'), nome, tipo) *
       FROM categorias
       WHERE (usuario_id = $1 OR usuario_id IS NULL) AND ativa = true
       ORDER BY COALESCE(usuario_id::text, 'padrao'), nome, tipo, criado_em`,
      [req.usuario.usuario_id]
    );

    const categorias = result.rows.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ categorias });
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
