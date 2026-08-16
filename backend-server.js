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
const previewsImportacao = new Map();
const PREVIEW_IMPORTACAO_TTL_MS = 30 * 60 * 1000;

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

  await pool.query(`
    ALTER TABLE contas
      ADD COLUMN IF NOT EXISTS saldo_inicial DECIMAL(12, 2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS data_saldo_inicial DATE
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
      nivel VARCHAR(20) DEFAULT 'MACRO',
      tipo VARCHAR(50) DEFAULT 'DESPESA',
      customizada BOOLEAN DEFAULT true,
      ativa BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_categorias_usuario ON categorias(usuario_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_categorias_ativa ON categorias(ativa)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_categorias_pai ON categorias(categoria_pai_id)');

  await pool.query(`
    ALTER TABLE categorias
      ADD COLUMN IF NOT EXISTS nivel VARCHAR(20) DEFAULT 'MACRO'
  `);

  await pool.query(`
    UPDATE categorias
    SET nivel = CASE WHEN categoria_pai_id IS NULL THEN 'MACRO' ELSE 'DETALHADA' END
    WHERE nivel IS NULL
  `);

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
      ADD COLUMN IF NOT EXISTS categoria_macro_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS categoria_detalhada_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS categoria_origem VARCHAR(20),
      ADD COLUMN IF NOT EXISTS regra_categorizacao_id UUID,
      ADD COLUMN IF NOT EXISTS eh_transferencia_interna BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS transferencia_grupo_id UUID
  `);

  await pool.query(`
    UPDATE transacoes t
    SET categoria_macro_id = CASE
          WHEN c.categoria_pai_id IS NULL THEN t.categoria_id
          ELSE c.categoria_pai_id
        END,
        categoria_detalhada_id = CASE
          WHEN c.categoria_pai_id IS NULL THEN NULL
          ELSE t.categoria_id
        END
    FROM categorias c
    WHERE t.categoria_id = c.id
      AND (t.categoria_macro_id IS NULL AND t.categoria_detalhada_id IS NULL)
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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_categoria_macro ON transacoes(categoria_macro_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_transacoes_categoria_detalhada ON transacoes(categoria_detalhada_id)');
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
    CREATE TABLE IF NOT EXISTS provisoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      descricao TEXT NOT NULL,
      valor_previsto DECIMAL(12, 2) NOT NULL,
      tipo VARCHAR(20) NOT NULL,
      data_prevista DATE NOT NULL,
      data_vencimento DATE,
      conta_id UUID REFERENCES contas(id) ON DELETE SET NULL,
      categoria_macro_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      categoria_detalhada_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'PENDENTE',
      observacao TEXT,
      recorrente BOOLEAN DEFAULT false,
      periodicidade VARCHAR(20),
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras_programadas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      descricao TEXT NOT NULL,
      valor_estimado DECIMAL(12, 2) NOT NULL,
      data_desejada DATE NOT NULL,
      prioridade VARCHAR(20) NOT NULL DEFAULT 'MEDIA',
      forma_pagamento VARCHAR(20) NOT NULL DEFAULT 'A_VISTA',
      parcelas INT NOT NULL DEFAULT 1,
      conta_id UUID REFERENCES contas(id) ON DELETE SET NULL,
      categoria_macro_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      categoria_detalhada_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PLANEJADA',
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE compras_programadas
      ADD COLUMN IF NOT EXISTS valor_realizado DECIMAL(12, 2),
      ADD COLUMN IF NOT EXISTS data_realizada DATE
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_compras_programadas_usuario_data ON compras_programadas(usuario_id, data_desejada)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_compras_programadas_usuario_status ON compras_programadas(usuario_id, status)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conciliacoes_compras (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      compra_id UUID NOT NULL REFERENCES compras_programadas(id) ON DELETE CASCADE,
      transacao_id UUID NOT NULL REFERENCES transacoes(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMADA',
      confianca VARCHAR(20),
      score DECIMAL(5, 2),
      motivos JSONB DEFAULT '[]'::jsonb,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      confirmado_em TIMESTAMP,
      desfeito_em TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_conciliacoes_compras_usuario_status ON conciliacoes_compras(usuario_id, status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conciliacoes_compras_compra ON conciliacoes_compras(compra_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conciliacoes_compras_transacao ON conciliacoes_compras(transacao_id)');
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_conciliacoes_compras_compra_confirmada ON conciliacoes_compras(compra_id) WHERE status = 'CONFIRMADA'");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_conciliacoes_compras_transacao_confirmada ON conciliacoes_compras(transacao_id) WHERE status = 'CONFIRMADA'");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conciliacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      provisao_id UUID NOT NULL REFERENCES provisoes(id) ON DELETE CASCADE,
      transacao_id UUID NOT NULL REFERENCES transacoes(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'SUGERIDA',
      confianca VARCHAR(20),
      score DECIMAL(5, 2),
      motivos JSONB DEFAULT '[]'::jsonb,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      confirmado_em TIMESTAMP,
      ignorado_em TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_provisoes_usuario_status ON provisoes(usuario_id, status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_provisoes_datas ON provisoes(data_prevista, data_vencimento)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_provisoes_conta ON provisoes(conta_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conciliacoes_usuario_status ON conciliacoes(usuario_id, status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conciliacoes_provisao ON conciliacoes(provisao_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conciliacoes_transacao ON conciliacoes(transacao_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS planejamentos_mensais (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      mes INT NOT NULL,
      ano INT NOT NULL,
      descricao TEXT NOT NULL,
      categoria TEXT,
      categoria_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      tipo_despesa VARCHAR(20) NOT NULL,
      valor_previsto DECIMAL(12, 2) NOT NULL,
      dia_previsto INT,
      observacao TEXT,
      recorrencia_tipo VARCHAR(20) NOT NULL DEFAULT 'UNICA',
      recorrencia_id UUID,
      quantidade_parcelas INT,
      parcela_atual INT,
      mes_inicio INT,
      ano_inicio INT,
      mes_fim INT,
      ano_fim INT,
      ativa BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_planejamentos_mes CHECK (mes BETWEEN 1 AND 12),
      CONSTRAINT chk_planejamentos_ano CHECK (ano BETWEEN 1900 AND 2100),
      CONSTRAINT chk_planejamentos_tipo CHECK (tipo_despesa IN ('FIXA', 'VARIAVEL')),
      CONSTRAINT chk_planejamentos_valor CHECK (valor_previsto > 0),
      CONSTRAINT chk_planejamentos_dia CHECK (dia_previsto IS NULL OR dia_previsto BETWEEN 1 AND 31),
      CONSTRAINT chk_planejamentos_recorrencia CHECK (recorrencia_tipo IN ('UNICA', 'MENSAL', 'PARCELADA')),
      CONSTRAINT chk_planejamentos_parcelas CHECK (quantidade_parcelas IS NULL OR quantidade_parcelas > 0),
      CONSTRAINT chk_planejamentos_parcela_atual CHECK (parcela_atual IS NULL OR parcela_atual > 0),
      CONSTRAINT chk_planejamentos_mes_fim CHECK (mes_fim IS NULL OR mes_fim BETWEEN 1 AND 12),
      CONSTRAINT chk_planejamentos_ano_fim CHECK (ano_fim IS NULL OR ano_fim BETWEEN 1900 AND 2100)
    )
  `);

  await pool.query(`
    ALTER TABLE planejamentos_mensais
      ADD COLUMN IF NOT EXISTS recorrencia_tipo VARCHAR(20) NOT NULL DEFAULT 'UNICA',
      ADD COLUMN IF NOT EXISTS recorrencia_id UUID,
      ADD COLUMN IF NOT EXISTS quantidade_parcelas INT,
      ADD COLUMN IF NOT EXISTS parcela_atual INT,
      ADD COLUMN IF NOT EXISTS mes_inicio INT,
      ADD COLUMN IF NOT EXISTS ano_inicio INT,
      ADD COLUMN IF NOT EXISTS mes_fim INT,
      ADD COLUMN IF NOT EXISTS ano_fim INT,
      ADD COLUMN IF NOT EXISTS ativa BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS categoria_id UUID REFERENCES categorias(id) ON DELETE SET NULL
  `);

  await pool.query(`
    UPDATE planejamentos_mensais
    SET mes_inicio = COALESCE(mes_inicio, mes),
        ano_inicio = COALESCE(ano_inicio, ano),
        ativa = COALESCE(ativa, true),
        recorrencia_tipo = COALESCE(recorrencia_tipo, 'UNICA')
    WHERE mes_inicio IS NULL OR ano_inicio IS NULL OR ativa IS NULL OR recorrencia_tipo IS NULL
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_planejamentos_recorrencia') THEN
        ALTER TABLE planejamentos_mensais ADD CONSTRAINT chk_planejamentos_recorrencia CHECK (recorrencia_tipo IN ('UNICA', 'MENSAL', 'PARCELADA'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_planejamentos_parcelas') THEN
        ALTER TABLE planejamentos_mensais ADD CONSTRAINT chk_planejamentos_parcelas CHECK (quantidade_parcelas IS NULL OR quantidade_parcelas > 0);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_planejamentos_parcela_atual') THEN
        ALTER TABLE planejamentos_mensais ADD CONSTRAINT chk_planejamentos_parcela_atual CHECK (parcela_atual IS NULL OR parcela_atual > 0);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_planejamentos_mes_fim') THEN
        ALTER TABLE planejamentos_mensais ADD CONSTRAINT chk_planejamentos_mes_fim CHECK (mes_fim IS NULL OR mes_fim BETWEEN 1 AND 12);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_planejamentos_ano_fim') THEN
        ALTER TABLE planejamentos_mensais ADD CONSTRAINT chk_planejamentos_ano_fim CHECK (ano_fim IS NULL OR ano_fim BETWEEN 1900 AND 2100);
      END IF;
    END $$;
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_planejamentos_usuario_mes_ano ON planejamentos_mensais(usuario_id, ano, mes)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_planejamentos_recorrencia ON planejamentos_mensais(usuario_id, recorrencia_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_planejamentos_categoria ON planejamentos_mensais(usuario_id, categoria_id)');

  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_conciliacoes_provisao_ativa ON conciliacoes(provisao_id) WHERE status = 'CONFIRMADA'");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_conciliacoes_transacao_ativa ON conciliacoes(transacao_id) WHERE status = 'CONFIRMADA'");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conferencias_saldo (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      conta_id UUID NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
      data_referencia DATE NOT NULL,
      saldo_real DECIMAL(12, 2) NOT NULL,
      saldo_calculado DECIMAL(12, 2) NOT NULL,
      diferenca DECIMAL(12, 2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_conferencias_saldo_status CHECK (status IN ('CONCILIADO', 'DIVERGENTE', 'PENDENTE', 'EM_ANALISE'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conferencias_saldo_usuario ON conferencias_saldo(usuario_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conferencias_saldo_conta_data ON conferencias_saldo(conta_id, data_referencia DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_conferencias_saldo_status ON conferencias_saldo(status)');

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
    INSERT INTO categorias (nome, tipo, emoji, customizada, nivel)
    VALUES
      ('Alimentação', 'DESPESA', '🍔', false, 'MACRO'),
      ('Transporte', 'DESPESA', '🚗', false, 'MACRO'),
      ('Saúde', 'DESPESA', '❤️', false, 'MACRO'),
      ('Educação', 'DESPESA', '📚', false, 'MACRO'),
      ('Moradia', 'DESPESA', '🏠', false, 'MACRO'),
      ('Diversão', 'DESPESA', '🎭', false, 'MACRO'),
      ('Salário', 'RECEITA', '💼', false, 'MACRO'),
      ('Outros', 'DESPESA', '•••', false, 'MACRO')
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

function gerarHashTransacao(tx, contaId = tx.conta_id || tx.contaId || tx.conta) {
  const data = tx.data instanceof Date ? tx.data.toISOString().slice(0, 10) : String(tx.data || '').slice(0, 10);
  const descricao = normalizarDescricaoCategorizacao(tx.descricao).toLowerCase();
  const valor = Number(tx.valor || 0).toFixed(2);
  const tipo = String(tx.tipo || '').trim().toUpperCase();
  const str = `${contaId || ''}|${data}|${descricao}|${valor}|${tipo}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

function gerarHashTransacaoLegado(tx) {
  const data = tx.data instanceof Date ? tx.data.toISOString().slice(0, 10) : String(tx.data || '').slice(0, 10);
  const descricao = String(tx.descricao || '').trim().toLowerCase();
  const valor = Number(tx.valor || 0).toFixed(2);
  const tipo = String(tx.tipo || '').trim().toUpperCase();
  return crypto.createHash('sha256').update(`${data}|${descricao}|${valor}|${tipo}`).digest('hex');
}

function normalizarReferenciaImportacao(tx) {
  const referencia = String(tx?.referencia_banco || tx?.transacao_id || tx?.transacaoId || tx?.id || '').trim();
  if (!referencia || referencia.length > 50) return null;
  return referencia;
}

function referenciaImportacaoEhUuid(referencia) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(referencia || '').trim());
}

function gerarHashTransacaoImportacao(tx, contaId = tx.conta_id || tx.contaId || tx.conta) {
  const referencia = normalizarReferenciaImportacao(tx);
  if (!referencia) return gerarHashTransacao(tx, contaId);
  const identidade = `${contaId || ''}|referencia_importacao|${referencia}`;
  return crypto.createHash('sha256').update(identidade).digest('hex');
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

function normalizarNomeCategoria(nome) {
  return String(nome || '').trim().replace(/\s+/g, ' ');
}

function normalizarCategoriaComparacao(nome) {
  return normalizarNomeCategoria(nome)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((palavra) => {
      if (palavra.length > 5 && palavra.endsWith('oes')) return palavra.slice(0, -3) + 'ao';
      if (palavra.length > 4 && palavra.endsWith('es')) return palavra.slice(0, -2);
      if (palavra.length > 3 && palavra.endsWith('s')) return palavra.slice(0, -1);
      return palavra;
    })
    .join(' ');
}

function distanciaLevenshtein(a, b) {
  const s = normalizarCategoriaComparacao(a);
  const t = normalizarCategoriaComparacao(b);
  if (s === t) return 0;
  if (!s) return t.length;
  if (!t) return s.length;

  const matriz = Array.from({ length: s.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= t.length; j++) matriz[0][j] = j;

  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const custo = s[i - 1] === t[j - 1] ? 0 : 1;
      matriz[i][j] = Math.min(
        matriz[i - 1][j] + 1,
        matriz[i][j - 1] + 1,
        matriz[i - 1][j - 1] + custo
      );
    }
  }

  return matriz[s.length][t.length];
}

function calcularSimilaridadeCategoria(a, b) {
  const normalizadaA = normalizarCategoriaComparacao(a);
  const normalizadaB = normalizarCategoriaComparacao(b);
  if (!normalizadaA || !normalizadaB) return 0;
  if (normalizadaA === normalizadaB) return 1;

  const maior = Math.max(normalizadaA.length, normalizadaB.length);
  const similaridadeLevenshtein = maior ? 1 - (distanciaLevenshtein(normalizadaA, normalizadaB) / maior) : 0;
  const includes = normalizadaA.includes(normalizadaB) || normalizadaB.includes(normalizadaA) ? 0.88 : 0;
  const palavrasA = new Set(normalizadaA.split(' ').filter(Boolean));
  const palavrasB = new Set(normalizadaB.split(' ').filter(Boolean));
  const intersecao = [...palavrasA].filter((palavra) => palavrasB.has(palavra)).length;
  const uniao = new Set([...palavrasA, ...palavrasB]).size || 1;
  const similaridadePalavras = intersecao / uniao;

  return Number(Math.max(similaridadeLevenshtein, includes, similaridadePalavras).toFixed(2));
}


const STATUS_PROVISAO = ['PENDENTE', 'CONCILIADA', 'ATRASADA', 'CANCELADA', 'IGNORADA'];
const TIPOS_PROVISAO = ['CREDITO', 'DEBITO'];
const STATUS_CONCILIACAO = ['SUGERIDA', 'CONFIRMADA', 'IGNORADA', 'DESFEITA'];

function normalizarTextoConciliacao(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similaridadeTextoConciliacao(a, b) {
  const palavrasA = new Set(normalizarTextoConciliacao(a).split(' ').filter((p) => p.length >= 3));
  const palavrasB = new Set(normalizarTextoConciliacao(b).split(' ').filter((p) => p.length >= 3));
  if (palavrasA.size === 0 || palavrasB.size === 0) return 0;
  const intersecao = [...palavrasA].filter((palavra) => palavrasB.has(palavra)).length;
  const menor = Math.min(palavrasA.size, palavrasB.size) || 1;
  return intersecao / menor;
}

function diasEntreConciliacao(dataA, dataB) {
  const a = new Date(`${String(dataA).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(dataB).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 999;
  return Math.abs(Math.round((a - b) / 86400000));
}

function montarProvisao(row = {}) {
  return {
    ...row,
    valor_previsto: Number(row.valor_previsto || 0),
    recorrente: Boolean(row.recorrente),
    conciliacao_id: row.conciliacao_id || null,
    transacao_conciliada_id: row.transacao_conciliada_id || null,
  };
}

function montarTransacaoConciliacao(tx = {}) {
  return {
    ...tx,
    valor: Number(tx.valor || 0),
  };
}

function calcularSugestaoConciliacao(provisao, transacao) {
  if (!provisao || !transacao) return null;
  if (provisao.status && !['PENDENTE', 'ATRASADA'].includes(provisao.status)) return null;
  if (String(provisao.tipo).toUpperCase() !== String(transacao.tipo).toUpperCase()) return null;

  const valorProvisao = Math.abs(Number(provisao.valor_previsto || 0));
  const valorTransacao = Math.abs(Number(transacao.valor || 0));
  const diferencaValor = Math.abs(valorProvisao - valorTransacao);
  if (diferencaValor > 0.05) return null;

  const diasPrevista = diasEntreConciliacao(provisao.data_prevista, transacao.data);
  const diasVencimento = provisao.data_vencimento ? diasEntreConciliacao(provisao.data_vencimento, transacao.data) : diasPrevista;
  const dias = Math.min(diasPrevista, diasVencimento);
  if (dias > 3) return null;

  const motivos = ['Mesmo valor'];
  let score = 0.45;
  if (dias === 0) {
    motivos.push('Mesma data');
    score += 0.2;
  } else {
    motivos.push(`Data próxima (${dias} dia${dias > 1 ? 's' : ''})`);
    score += dias <= 1 ? 0.16 : 0.1;
  }

  if (provisao.conta_id && transacao.conta_id === provisao.conta_id) {
    motivos.push('Mesma conta');
    score += 0.18;
  } else if (provisao.conta_id) {
    motivos.push('Conta diferente');
    score -= 0.04;
  }

  const similaridadeDescricao = similaridadeTextoConciliacao(provisao.descricao, transacao.descricao);
  if (similaridadeDescricao >= 0.6) {
    motivos.push('Descrição semelhante');
    score += 0.15;
  } else if (similaridadeDescricao >= 0.25) {
    motivos.push('Descrição parcialmente semelhante');
    score += 0.08;
  }

  if (provisao.categoria_macro_id && provisao.categoria_macro_id === transacao.categoria_macro_id) {
    motivos.push('Mesma categoria macro');
    score += 0.05;
  }
  if (provisao.categoria_detalhada_id && provisao.categoria_detalhada_id === transacao.categoria_detalhada_id) {
    motivos.push('Mesma categoria detalhada');
    score += 0.04;
  }

  score = Math.max(0, Math.min(0.99, Number(score.toFixed(2))));
  const confianca = score >= 0.85 ? 'ALTA' : score >= 0.65 ? 'MEDIA' : 'BAIXA';

  return { confianca, score, motivos };
}

async function buscarProvisoesPendentesParaConciliacao(usuarioId, { dataInicial, dataFinal } = {}) {
  const valores = [usuarioId];
  const where = ["p.usuario_id = $1", "p.status IN ('PENDENTE', 'ATRASADA')"];
  if (dataInicial) {
    valores.push(dataInicial);
    where.push(`COALESCE(p.data_vencimento, p.data_prevista) >= ($${valores.length}::date - INTERVAL '3 days')`);
  }
  if (dataFinal) {
    valores.push(dataFinal);
    where.push(`p.data_prevista <= ($${valores.length}::date + INTERVAL '3 days')`);
  }

  const result = await pool.query(
    `SELECT p.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome
     FROM provisoes p
     LEFT JOIN contas c ON c.id = p.conta_id
     LEFT JOIN categorias cm ON cm.id = p.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = p.categoria_detalhada_id
     WHERE ${where.join(' AND ')}
       AND NOT EXISTS (SELECT 1 FROM conciliacoes ca WHERE ca.provisao_id = p.id AND ca.status = 'CONFIRMADA')
     ORDER BY p.data_prevista ASC`,
    valores
  );
  return result.rows.map(montarProvisao);
}

function montarSugestoesConciliacao(provisoes, transacoes, ignoradas = []) {
  const ignoradasSet = new Set(ignoradas.map((item) => `${item.provisao_id}|${item.transacao_id || item.transacao_temp_id}`));
  const sugestoes = [];

  for (const provisao of provisoes) {
    for (const transacao of transacoes) {
      const transacaoId = transacao.id || transacao.transacaoId || transacao.hash_transacao;
      if (!transacaoId || ignoradasSet.has(`${provisao.id}|${transacaoId}`)) continue;
      const analise = calcularSugestaoConciliacao(provisao, transacao);
      if (!analise) continue;
      sugestoes.push({
        provisaoId: provisao.id,
        transacaoId: transacao.id || transacao.transacaoId || null,
        transacaoTempId: transacao.hash_transacao || transacao.id || transacao.transacaoId || null,
        ...analise,
        provisao,
        transacao: montarTransacaoConciliacao(transacao),
      });
    }
  }

  return sugestoes.sort((a, b) => b.score - a.score).slice(0, 50);
}

async function validarEntidadesConciliacao(usuarioId, provisaoId, transacaoId) {
  const provisaoResult = await pool.query(
    `SELECT p.* FROM provisoes p WHERE p.id = $1 AND p.usuario_id = $2`,
    [provisaoId, usuarioId]
  );
  const transacaoResult = await pool.query(
    `SELECT t.* FROM transacoes t JOIN contas c ON c.id = t.conta_id WHERE t.id = $1 AND c.usuario_id = $2 AND t.deletado_em IS NULL`,
    [transacaoId, usuarioId]
  );
  const provisao = provisaoResult.rows[0];
  const transacao = transacaoResult.rows[0];
  if (!provisao || !transacao) throw new Error('Provisão ou transação não encontrada para este usuário.');
  if (provisao.status === 'CANCELADA') throw new Error('Não é possível conciliar provisão cancelada.');
  if (provisao.status === 'CONCILIADA') throw new Error('Esta provisão já está conciliada.');

  const jaConciliada = await pool.query(
    `SELECT id, provisao_id, transacao_id FROM conciliacoes
     WHERE status = 'CONFIRMADA' AND (provisao_id = $1 OR transacao_id = $2)`,
    [provisaoId, transacaoId]
  );
  if (jaConciliada.rows.length > 0) throw new Error('Provisão ou transação já possui conciliação ativa.');
  return { provisao, transacao };
}

async function confirmarConciliacaoUsuario(usuarioId, provisaoId, transacaoId, analiseManual = null) {
  const { provisao, transacao } = await validarEntidadesConciliacao(usuarioId, provisaoId, transacaoId);
  const analise = analiseManual || calcularSugestaoConciliacao(provisao, transacao) || { confianca: 'BAIXA', score: 0.5, motivos: ['Conciliação manual confirmada pelo usuário'] };
  const result = await pool.query(
    `INSERT INTO conciliacoes (usuario_id, provisao_id, transacao_id, status, confianca, score, motivos, confirmado_em)
     VALUES ($1, $2, $3, 'CONFIRMADA', $4, $5, $6::jsonb, NOW())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [usuarioId, provisaoId, transacaoId, analise.confianca, analise.score, JSON.stringify(analise.motivos || [])]
  );
  if (result.rows.length === 0) throw new Error('Provisão ou transação já possui conciliação ativa.');
  await pool.query(`UPDATE provisoes SET status = 'CONCILIADA', atualizado_em = NOW() WHERE id = $1 AND usuario_id = $2`, [provisaoId, usuarioId]);
  return result.rows[0];
}

const LIMITE_VALOR_TRANSACAO = 9999999999.99;

function parseValorMonetario(valorOriginal) {
  const arredondarMoeda = (numero) => Math.round((numero + Number.EPSILON) * 100) / 100;

  if (typeof valorOriginal === 'number') {
    const valor = Number.isFinite(valorOriginal) ? arredondarMoeda(valorOriginal) : null;
    return {
      valor,
      erro: valor === null ? 'A célula contém um número que o app não conseguiu interpretar.' : null,
      valorOriginal,
      interpretadoComo: valor,
    };
  }

  const textoOriginal = String(valorOriginal ?? '').trim();
  if (!textoOriginal) {
    return {
      valor: null,
      erro: 'A célula de valor está vazia.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  let texto = textoOriginal
    .replace(/\u00a0/g, ' ')
    .replace(/R\$/gi, '')
    .replace(/\s+/g, '')
    .trim();

  let negativo = false;
  if (/^\(.*\)$/.test(texto)) {
    negativo = true;
    texto = texto.slice(1, -1);
  }
  if (texto.startsWith('-')) negativo = true;
  texto = texto.replace(/^[+-]/, '');

  if (!texto) {
    return {
      valor: null,
      erro: 'A célula de valor está vazia.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  const aplicarSinalEArredondar = (numero) => {
    if (!Number.isFinite(numero)) return null;
    const arredondado = arredondarMoeda(numero);
    return negativo ? -Math.abs(arredondado) : arredondado;
  };

  // O Excel pode serializar números decimais com ruído de ponto flutuante e
  // notação científica, por exemplo 0.14000000000000001 ou 7E-2.
  if (/^\d+(?:[.,]\d+)?[eE][+-]?\d+$/.test(texto)) {
    const numeroCientifico = Number(texto.replace(',', '.'));
    const interpretadoComo = aplicarSinalEArredondar(numeroCientifico);
    return {
      valor: interpretadoComo,
      erro: interpretadoComo === null ? 'Não foi possível converter o conteúdo da célula em número.' : null,
      valorOriginal,
      interpretadoComo,
    };
  }

  if (!/^[0-9.,]+$/.test(texto)) {
    return {
      valor: null,
      erro: 'A célula contém caracteres que não parecem formar um valor monetário.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  const ultimaVirgula = texto.lastIndexOf(',');
  const ultimoPonto = texto.lastIndexOf('.');
  let decimal = null;

  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    decimal = ultimaVirgula > ultimoPonto ? ',' : '.';
  } else {
    const separador = ultimaVirgula >= 0 ? ',' : ultimoPonto >= 0 ? '.' : null;
    if (separador) {
      const ultimoSeparador = texto.lastIndexOf(separador);
      const digitosDepois = texto.length - ultimoSeparador - 1;
      const ocorrencias = texto.split(separador).length - 1;
      const parteInteira = texto.slice(0, ultimoSeparador);

      if (ocorrencias === 1) {
        if (digitosDepois > 0 && digitosDepois <= 2) {
          decimal = separador;
        } else if (digitosDepois === 3) {
          // Mantém 1.234 / 1,234 como milhar, mas trata 0.140 e 1234.567
          // como decimais, evitando multiplicar valores oriundos do Excel.
          decimal = parteInteira === '0' || parteInteira.length > 3 ? separador : null;
        } else if (digitosDepois > 3) {
          // Muitas casas decimais normalmente são ruído binário exportado pelo Excel.
          decimal = separador;
        }
      } else if (digitosDepois > 0 && digitosDepois <= 2) {
        decimal = separador;
      }
    }
  }

  let normalizado;
  if (decimal === ',') {
    const ultimo = texto.lastIndexOf(',');
    normalizado = texto.slice(0, ultimo).replace(/[.,]/g, '') + '.' + texto.slice(ultimo + 1).replace(/[.,]/g, '');
  } else if (decimal === '.') {
    const ultimo = texto.lastIndexOf('.');
    normalizado = texto.slice(0, ultimo).replace(/[.,]/g, '') + '.' + texto.slice(ultimo + 1).replace(/[.,]/g, '');
  } else {
    normalizado = texto.replace(/[.,]/g, '');
  }

  const numero = Number(normalizado);
  const interpretadoComo = aplicarSinalEArredondar(numero);

  return {
    valor: interpretadoComo,
    erro: interpretadoComo === null ? 'Não foi possível converter o conteúdo da célula em número.' : null,
    valorOriginal,
    interpretadoComo,
  };
}

function criarErroValidacaoImportacao(detalhes) {
  const erro = new Error(detalhes.erro || 'Erro de validação na importação.');
  erro.detalhesImportacao = detalhes;
  return erro;
}

function formatarValorMoedaErro(valor) {
  return Number.isFinite(valor) ? valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '-';
}

function validarTransacoesImportacao(transacoes) {
  if (!Array.isArray(transacoes) || transacoes.length === 0) {
    throw new Error('Envie ao menos uma transação para importar.');
  }

  return transacoes.map((tx, index) => {
    const linha = tx._linha || index + 2;
    const data = normalizarDataImportacao(tx.data);
    const descricao = String(tx.descricao || '').trim();
    const categoriaLegada = String(tx.categoria || '').trim();
    const categoriaMacro = String(tx.categoria_macro || tx.categoriaMacro || tx.categoriaMacroNome || categoriaLegada || '').trim() || 'Outros';
    const categoriaDetalhada = String(tx.categoria_detalhada || tx.categoriaDetalhada || tx.categoriaDetalhadaNome || '').trim();
    const conta = String(tx.conta || tx.conta_nome || tx.contaNome || '').trim();
    const valorParse = parseValorMonetario(tx.valor);
    const valor = Math.abs(Number(valorParse.valor));
    const tipo = normalizarTipoTransacao(tx.tipo);

    if (!data) throw criarErroValidacaoImportacao({
      linha,
      coluna: 'Data',
      valorOriginal: tx.data,
      descricao,
      erro: 'A data não foi reconhecida pelo app.',
      sugestao: 'Use uma data válida, como 10/06/2026 ou 2026-06-10.',
    });
    if (!descricao) throw criarErroValidacaoImportacao({
      linha,
      coluna: 'Descrição',
      valorOriginal: tx.descricao,
      descricao,
      erro: 'A descrição da transação está vazia.',
      sugestao: 'Preencha a descrição para identificar a transação no extrato.',
    });
    if (!conta) throw criarErroValidacaoImportacao({
      linha,
      coluna: 'Conta',
      valorOriginal: tx.conta || tx.conta_nome || tx.contaNome,
      descricao,
      erro: 'A coluna Conta está vazia nesta linha.',
      sugestao: 'Informe a conta dessa transação na planilha.',
    });
    if (valorParse.erro || !Number.isFinite(valor) || valor <= 0) throw criarErroValidacaoImportacao({
      linha,
      coluna: 'Valor',
      valorOriginal: valorParse.valorOriginal,
      valorInterpretado: valorParse.interpretadoComo,
      descricao,
      erro: valorParse.erro || 'O valor precisa ser maior que zero após a interpretação.',
      sugestao: 'Informe o valor em formato brasileiro (1.234,56), americano (1,234.56) ou como número do Excel (1234.56).',
    });
    if (valor > LIMITE_VALOR_TRANSACAO) {
      throw criarErroValidacaoImportacao({
        linha,
        coluna: 'Valor',
        valorOriginal: valorParse.valorOriginal,
        valorInterpretado: valorParse.interpretadoComo,
        descricao,
        erro: `O valor interpretado (${formatarValorMoedaErro(valor)}) excede o limite permitido de ${formatarValorMoedaErro(LIMITE_VALOR_TRANSACAO)}.`,
        sugestao: 'Confira se o separador de milhar e o separador decimal estão corretos na planilha.',
      });
    }

    return {
      _linha: linha,
      id: tx.id || tx.transacao_id || tx.transacaoId || null,
      transacao_id: tx.transacao_id || tx.transacaoId || tx.id || null,
      conta,
      data,
      descricao,
      categoria: categoriaLegada || categoriaMacro,
      categoria_macro: categoriaMacro,
      categoria_detalhada: categoriaDetalhada || null,
      valor,
      tipo,
    };
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
         categoria_macro_id = COALESCE((SELECT categoria_pai_id FROM categorias WHERE id = $1), $1),
         categoria_detalhada_id = CASE WHEN (SELECT categoria_pai_id FROM categorias WHERE id = $1) IS NULL THEN NULL ELSE $1 END,
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
  if (!categoriaId) return null;
  const categoria = await pool.query(
    `SELECT * FROM categorias
     WHERE id = $1 AND ativa = true AND (usuario_id = $2 OR usuario_id IS NULL)`,
    [categoriaId, usuarioId]
  );

  if (categoria.rows.length === 0) {
    throw new Error('Categoria não encontrada para este usuário.');
  }

  return categoria.rows[0];
}

async function validarParCategoriasDoUsuario(usuarioId, categoriaMacroId, categoriaDetalhadaId) {
  const macro = await validarCategoriaDoUsuario(usuarioId, categoriaMacroId);
  const detalhada = await validarCategoriaDoUsuario(usuarioId, categoriaDetalhadaId);

  if (detalhada && macro && detalhada.categoria_pai_id && detalhada.categoria_pai_id !== macro.id) {
    throw new Error('A categoria detalhada não pertence à categoria macro escolhida.');
  }

  if (detalhada && !macro && detalhada.categoria_pai_id) {
    return { macroId: detalhada.categoria_pai_id, detalhadaId: detalhada.id, categoriaId: detalhada.id };
  }

  return {
    macroId: macro?.id || null,
    detalhadaId: detalhada?.id || null,
    categoriaId: detalhada?.id || macro?.id || null,
  };
}

async function buscarCategoriaPorNome(usuarioId, nome, { nivel = 'MACRO', categoriaPaiId = null, tipo = 'DESPESA', criar = false } = {}) {
  const nomeLimpo = normalizarNomeCategoria(nome);
  if (!nomeLimpo) return null;

  const result = await pool.query(
    `SELECT *
     FROM categorias
     WHERE ativa = true
       AND (usuario_id = $1 OR usuario_id IS NULL)
       AND LOWER(nome) = LOWER($2)
       AND COALESCE(nivel, CASE WHEN categoria_pai_id IS NULL THEN 'MACRO' ELSE 'DETALHADA' END) = $3
       AND ($4::uuid IS NULL OR categoria_pai_id = $4)
     ORDER BY usuario_id NULLS LAST, criado_em ASC
     LIMIT 1`,
    [usuarioId, nomeLimpo, nivel, categoriaPaiId]
  );

  if (result.rows[0]) return result.rows[0];

  if (!criar) {
    const prefixo = nivel === 'DETALHADA' ? 'Categoria detalhada' : 'Categoria macro';
    throw new Error(`${prefixo} "${nomeLimpo}" não existe.`);
  }

  const insert = await pool.query(
    `INSERT INTO categorias (usuario_id, nome, tipo, categoria_pai_id, nivel, customizada, ativa, criado_em, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, true, true, NOW(), NOW())
     RETURNING *`,
    [usuarioId, nomeLimpo, tipo, categoriaPaiId, nivel]
  );

  return insert.rows[0];
}

async function resolverCategoriasImportacao(usuarioId, tx, { criar = false } = {}) {
  const macroNome = normalizarNomeCategoria(tx.categoria_macro || tx.categoria || 'Outros') || 'Outros';
  const detalhadaNome = normalizarNomeCategoria(tx.categoria_detalhada);
  const macro = await buscarCategoriaPorNome(usuarioId, macroNome, { nivel: 'MACRO', tipo: tx.tipo === 'CREDITO' ? 'RECEITA' : 'DESPESA', criar });
  const detalhada = detalhadaNome
    ? await buscarCategoriaPorNome(usuarioId, detalhadaNome, { nivel: 'DETALHADA', categoriaPaiId: macro.id, tipo: macro.tipo || (tx.tipo === 'CREDITO' ? 'RECEITA' : 'DESPESA'), criar })
    : null;

  return {
    categoriaMacroId: macro.id,
    categoriaDetalhadaId: detalhada?.id || null,
    categoriaId: detalhada?.id || macro.id,
    categoriaMacroNome: macro.nome,
    categoriaDetalhadaNome: detalhada?.nome || null,
  };
}

async function listarCategoriasComparacao(usuarioId, { nivel, categoriaPaiId = null } = {}) {
  const params = [usuarioId, nivel];
  const wherePai = categoriaPaiId
    ? `AND c.categoria_pai_id = $3`
    : '';
  if (categoriaPaiId) params.push(categoriaPaiId);

  const result = await pool.query(
    `SELECT c.*, pai.nome AS categoria_macro_nome
     FROM categorias c
     LEFT JOIN categorias pai ON pai.id = c.categoria_pai_id
     WHERE c.ativa = true
       AND (c.usuario_id = $1 OR c.usuario_id IS NULL)
       AND COALESCE(c.nivel, CASE WHEN c.categoria_pai_id IS NULL THEN 'MACRO' ELSE 'DETALHADA' END) = $2
       ${wherePai}
     ORDER BY c.usuario_id NULLS LAST, c.nome ASC`,
    params
  );

  return result.rows;
}

function montarChaveCategoriaPendente({ tipo, nomePlanilha, categoriaMacroPlanilha }) {
  return [tipo, normalizarCategoriaComparacao(categoriaMacroPlanilha || ''), normalizarCategoriaComparacao(nomePlanilha || '')].join('|');
}

function encontrarCategoriaExataPorNome(categorias, nome) {
  const nomeLimpo = normalizarNomeCategoria(nome).toLowerCase();
  return categorias.find((categoria) => normalizarNomeCategoria(categoria.nome).toLowerCase() === nomeLimpo) || null;
}

function encontrarCategoriasParecidas(categorias, nome) {
  return categorias
    .map((categoria) => ({
      ...categoria,
      similaridade: calcularSimilaridadeCategoria(nome, categoria.nome),
    }))
    .filter((categoria) => categoria.similaridade >= 0.78)
    .sort((a, b) => b.similaridade - a.similaridade)
    .slice(0, 5)
    .map((categoria) => ({
      id: categoria.id,
      nome: categoria.nome,
      categoriaMacro: categoria.categoria_macro_nome || null,
      similaridade: categoria.similaridade,
    }));
}

function registrarCategoriaPendente(preview, pendencia) {
  const chave = montarChaveCategoriaPendente(pendencia);
  if (preview.categoriasPendentes.some((item) => item.chave === chave)) return chave;

  preview.categoriasPendentes.push({
    chave,
    acaoSugerida: pendencia.possiveisCorrespondencias?.length ? 'USAR_EXISTENTE' : 'CRIAR_NOVA',
    ...pendencia,
  });

  return chave;
}

async function resolverCategoriaPreview(usuarioId, preview, { tipo, nome, categoriaPaiId = null, categoriaMacroPlanilha = null }) {
  const nomeLimpo = normalizarNomeCategoria(nome);
  if (!nomeLimpo) return null;

  const categorias = await listarCategoriasComparacao(usuarioId, { nivel: tipo, categoriaPaiId });
  const exata = encontrarCategoriaExataPorNome(categorias, nomeLimpo);
  if (exata) return { categoria: exata, pendente: false };

  const possiveisCorrespondencias = encontrarCategoriasParecidas(categorias, nomeLimpo);
  if (possiveisCorrespondencias.length > 0) {
    const chave = registrarCategoriaPendente(preview, {
      tipo,
      nomePlanilha: nomeLimpo,
      categoriaMacroPlanilha,
      possiveisCorrespondencias,
    });
    const sugerida = categorias.find((categoria) => categoria.id === possiveisCorrespondencias[0].id);
    return { categoria: sugerida, pendente: true, pendenciaChave: chave };
  }

  const chave = montarChaveCategoriaPendente({ tipo, nomePlanilha: nomeLimpo, categoriaMacroPlanilha });
  if (!preview.categoriasNovas.some((item) => item.chave === chave)) {
    preview.categoriasNovas.push({
      chave,
      tipo,
      nomePlanilha: nomeLimpo,
      categoriaMacroPlanilha,
      acaoSugerida: 'CRIAR_NOVA',
    });
  }

  return {
    categoria: {
      id: null,
      nome: nomeLimpo,
      tipo: tipo === 'MACRO' ? 'DESPESA' : undefined,
      categoria_pai_id: categoriaPaiId,
    },
    pendente: false,
    criarNome: nomeLimpo,
  };
}

async function resolverCategoriasPreview(usuarioId, tx, preview) {
  const macroNome = normalizarNomeCategoria(tx.categoria_macro || tx.categoria || 'Outros') || 'Outros';
  const macroResolvida = await resolverCategoriaPreview(usuarioId, preview, {
    tipo: 'MACRO',
    nome: macroNome,
  });
  const macro = macroResolvida?.categoria;

  const detalhadaNome = normalizarNomeCategoria(tx.categoria_detalhada);
  const detalhadaResolvida = detalhadaNome
    ? await resolverCategoriaPreview(usuarioId, preview, {
        tipo: 'DETALHADA',
        nome: detalhadaNome,
        categoriaPaiId: macro?.id || null,
        categoriaMacroPlanilha: macroNome,
      })
    : null;
  const detalhada = detalhadaResolvida?.categoria || null;

  return {
    categoriaMacroId: macro?.id || null,
    categoriaDetalhadaId: detalhada?.id || null,
    categoriaId: detalhada?.id || macro?.id || null,
    categoriaMacroNome: macro?.nome || macroNome,
    categoriaDetalhadaNome: detalhada?.nome || detalhadaNome || null,
    categoriaMacroPlanilha: macroNome,
    categoriaDetalhadaPlanilha: detalhadaNome || null,
    categoriaMacroPendenteChave: macroResolvida?.pendenciaChave || null,
    categoriaDetalhadaPendenteChave: detalhadaResolvida?.pendenciaChave || null,
    criarCategoriaMacroNome: macroResolvida?.criarNome || null,
    criarCategoriaDetalhadaNome: detalhadaResolvida?.criarNome || null,
  };
}

function buscarDecisaoCategoria(mapeamentoCategorias, { tipo, nomePlanilha, categoriaMacroPlanilha }) {
  const chave = montarChaveCategoriaPendente({ tipo, nomePlanilha, categoriaMacroPlanilha });
  return (mapeamentoCategorias || []).find((item) => montarChaveCategoriaPendente(item) === chave) || null;
}

async function resolverCategoriaConfirmacao(usuarioId, { tipo, nomePlanilha, categoriaMacroPlanilha, categoriaPaiId, tipoFinanceiro, decisao }) {
  const nomeBase = normalizarNomeCategoria(nomePlanilha);

  if (decisao?.acao === 'USAR_EXISTENTE') {
    if (!decisao.categoriaExistenteId) throw new Error(`Selecione a categoria existente para "${nomeBase}".`);
    return validarCategoriaDoUsuario(usuarioId, decisao.categoriaExistenteId);
  }

  const nomeFinal = decisao?.acao === 'CORRIGIR_NOME'
    ? normalizarNomeCategoria(decisao.nomeCorrigido)
    : nomeBase;

  if (!nomeFinal) throw new Error(`Informe um nome válido para a categoria "${nomeBase}".`);

  return buscarCategoriaPorNome(usuarioId, nomeFinal, {
    nivel: tipo,
    categoriaPaiId,
    tipo: tipoFinanceiro,
    criar: true,
  });
}

async function resolverCategoriasConfirmacao(usuarioId, tx, mapeamentoCategorias = []) {
  const macroNome = normalizarNomeCategoria(tx.categoria_macro || tx.categoria || 'Outros') || 'Outros';
  const decisaoMacro = buscarDecisaoCategoria(mapeamentoCategorias, { tipo: 'MACRO', nomePlanilha: macroNome });
  const macro = await resolverCategoriaConfirmacao(usuarioId, {
    tipo: 'MACRO',
    nomePlanilha: macroNome,
    tipoFinanceiro: tx.tipo === 'CREDITO' ? 'RECEITA' : 'DESPESA',
    decisao: decisaoMacro,
  });

  const detalhadaNome = normalizarNomeCategoria(tx.categoria_detalhada);
  const decisaoDetalhada = detalhadaNome
    ? buscarDecisaoCategoria(mapeamentoCategorias, { tipo: 'DETALHADA', nomePlanilha: detalhadaNome, categoriaMacroPlanilha: macroNome })
    : null;
  const detalhada = detalhadaNome
    ? await resolverCategoriaConfirmacao(usuarioId, {
        tipo: 'DETALHADA',
        nomePlanilha: detalhadaNome,
        categoriaMacroPlanilha: macroNome,
        categoriaPaiId: macro.id,
        tipoFinanceiro: macro.tipo || (tx.tipo === 'CREDITO' ? 'RECEITA' : 'DESPESA'),
        decisao: decisaoDetalhada,
      })
    : null;

  return {
    categoriaMacroId: macro.id,
    categoriaDetalhadaId: detalhada?.id || null,
    categoriaId: detalhada?.id || macro.id,
    categoriaMacroNome: macro.nome,
    categoriaDetalhadaNome: detalhada?.nome || null,
  };
}


async function categorizarTransacoesUsuario(usuarioId, transacaoIds, categoriaId, { origem = 'MANUAL', regraId = null, categoriaMacroId = null, categoriaDetalhadaId = null } = {}) {
  if (!Array.isArray(transacaoIds) || transacaoIds.length === 0) return [];

  const par = await validarParCategoriasDoUsuario(usuarioId, categoriaMacroId || categoriaId, categoriaDetalhadaId);

  const result = await pool.query(
    `UPDATE transacoes t
     SET categoria_id = $1,
         categoria_macro_id = $2,
         categoria_detalhada_id = $3,
         categoria_origem = $4,
         regra_categorizacao_id = $5,
         atualizado_em = NOW()
     FROM contas c
     WHERE c.id = t.conta_id
       AND c.usuario_id = $6
       AND t.id = ANY($7::uuid[])
       AND t.deletado_em IS NULL
     RETURNING t.*`,
    [par.categoriaId, par.macroId, par.detalhadaId, origem, regraId, usuarioId, transacaoIds]
  );

  return result.rows;
}

async function montarRespostaTransacoes(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const result = await pool.query(
      `SELECT t.*,
            COALESCE(t.categoria_macro_id, CASE WHEN cat.categoria_pai_id IS NULL THEN t.categoria_id ELSE cat.categoria_pai_id END) AS categoria_macro_id,
            COALESCE(t.categoria_detalhada_id, CASE WHEN cat.categoria_pai_id IS NOT NULL THEN t.categoria_id ELSE NULL END) AS categoria_detalhada_id,
            cat.nome as categoria_nome,
            COALESCE(cm.nome, cat_macro.nome, CASE WHEN cat.categoria_pai_id IS NULL THEN cat.nome ELSE NULL END) AS categoria_macro_nome,
            COALESCE(cd.nome, CASE WHEN cat.categoria_pai_id IS NOT NULL THEN cat.nome ELSE NULL END) AS categoria_detalhada_nome
     FROM transacoes t
     LEFT JOIN categorias cat ON t.categoria_id = cat.id
     LEFT JOIN categorias cat_macro ON cat_macro.id = cat.categoria_pai_id
     LEFT JOIN categorias cm ON t.categoria_macro_id = cm.id
     LEFT JOIN categorias cd ON t.categoria_detalhada_id = cd.id
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
            tipo = valor < 0 ? 'CREDITO' : 'DEBITO';
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
        const transacoesImportadasIds = [];

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
          const transacaoId = crypto.randomUUID();

          await pool.query(
            `INSERT INTO transacoes
             (id, conta_id, data, descricao, valor, tipo, categoria_id, categoria_origem, regra_categorizacao_id, hash_transacao, criado_em)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
            [
              transacaoId,
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
          transacoesImportadasIds.push(transacaoId);
        }

        const pagamentosCartao = await conciliarPagamentosCartaoImportados(req.usuario.usuario_id, transacoesImportadasIds);

        res.json({
          sucesso: true,
          contaId,
          inseridas,
          duplicadas,
          pagamentosCartaoPareados: pagamentosCartao.pareadas,
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


async function resolverContaImportacao(usuarioId, { conta_id, conta_nome } = {}) {
  if (conta_id) {
    const conta = await pool.query(
      'SELECT id, nome FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = true',
      [conta_id, usuarioId]
    );

    if (conta.rows.length === 0) {
      throw new Error('Conta não encontrada para este usuário.');
    }

    return conta.rows[0];
  }

  const nomeConta = String(conta_nome || 'Importação XLSX').trim();
  if (nomeConta) {
    const contaId = await buscarConta(usuarioId, nomeConta);
    if (contaId) return { id: contaId, nome: nomeConta, hashKey: contaId };
    return { id: null, nome: nomeConta, nova: true, hashKey: `nova:${nomeConta.toLowerCase()}` };
  }

  throw new Error('Informe uma conta de destino antes de gerar o preview.');
}

async function resolverContaConfirmacao(usuarioId, preview) {
  if (preview.contaId) return preview.contaId;

  const nomeConta = String(preview.contaNome || 'Importação XLSX').trim();
  let contaId = await buscarConta(usuarioId, nomeConta);
  if (!contaId) {
    contaId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO contas (id, usuario_id, nome, banco, tipo)
       VALUES ($1, $2, $3, 'Importação Manual', 'CHECKING')`,
      [contaId, usuarioId, nomeConta]
    );
  }

  preview.contaId = contaId;
  return contaId;
}

function normalizarNomeConta(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similaridadeNomeConta(a, b) {
  const na = normalizarNomeConta(a);
  const nb = normalizarNomeConta(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const palavrasA = new Set(na.split(' ').filter(Boolean));
  const palavrasB = new Set(nb.split(' ').filter(Boolean));
  const intersecao = [...palavrasA].filter((p) => palavrasB.has(p)).length;
  const uniao = new Set([...palavrasA, ...palavrasB]).size || 1;
  return intersecao / uniao;
}

async function listarContasUsuario(usuarioId) {
  const result = await pool.query(
    'SELECT id, nome FROM contas WHERE usuario_id = $1 AND ativo = true ORDER BY nome',
    [usuarioId]
  );
  return result.rows;
}

function montarResumoContasImportacao(transacoes, contasUsuario) {
  const agrupadas = new Map();
  transacoes.forEach((tx) => {
    const nome = String(tx.conta || '').trim();
    if (!agrupadas.has(nome)) agrupadas.set(nome, { nomePlanilha: nome, quantidade: 0 });
    agrupadas.get(nome).quantidade += 1;
  });

  return [...agrupadas.values()].map((item) => {
    const normalizado = normalizarNomeConta(item.nomePlanilha);
    const exata = contasUsuario.find((conta) => normalizarNomeConta(conta.nome) === normalizado);
    if (exata) {
      return { ...item, contaEncontradaId: exata.id, contaEncontradaNome: exata.nome, status: 'CONFIRMADA', statusLabel: 'Confirmada', similaridade: 1 };
    }

    const possivel = contasUsuario
      .map((conta) => ({ conta, similaridade: similaridadeNomeConta(item.nomePlanilha, conta.nome) }))
      .sort((a, b) => b.similaridade - a.similaridade)[0];

    if (possivel && possivel.similaridade >= 0.5) {
      return {
        ...item,
        contaEncontradaId: possivel.conta.id,
        contaEncontradaNome: possivel.conta.nome,
        status: 'POSSIVEL_CORRESPONDENCIA',
        statusLabel: 'Possível correspondência',
        similaridade: possivel.similaridade,
      };
    }

    return { ...item, contaEncontradaId: null, contaEncontradaNome: null, status: 'NAO_ENCONTRADA', statusLabel: 'Pendente', similaridade: 0 };
  });
}

async function resolverMapeamentoContasConfirmacao(usuarioId, preview, mapeamentoContas = []) {
  const pendentes = preview.contasImportacao || [];
  const mapaEntrada = new Map(mapeamentoContas.map((item) => [String(item.nomePlanilha || '').trim(), item]));
  const resolvidas = new Map();

  for (const contaPreview of pendentes) {
    const nomePlanilha = String(contaPreview.nomePlanilha || '').trim();
    const decisao = mapaEntrada.get(nomePlanilha);
    if (!decisao?.acao) throw new Error('Resolva todas as contas da planilha antes de concluir a importação.');

    if (decisao.acao === 'USAR_EXISTENTE') {
      if (!decisao.contaExistenteId) throw new Error(`Selecione a conta existente para "${nomePlanilha}".`);
      const conta = await pool.query(
        'SELECT id, nome FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = true',
        [decisao.contaExistenteId, usuarioId]
      );
      if (!conta.rows[0]) throw new Error(`Conta existente inválida para "${nomePlanilha}".`);
      resolvidas.set(nomePlanilha, { id: conta.rows[0].id, nome: conta.rows[0].nome });
      continue;
    }

    if (decisao.acao === 'CRIAR_NOVA' || decisao.acao === 'CORRIGIR_NOME') {
      const nomeCorrigido = String(decisao.nomeCorrigido || nomePlanilha).trim();
      if (!nomeCorrigido) throw new Error(`Informe o nome da conta para "${nomePlanilha}".`);
      let contaId = await buscarContaNormalizada(usuarioId, nomeCorrigido);
      if (!contaId) contaId = await criarConta(usuarioId, nomeCorrigido);
      resolvidas.set(nomePlanilha, { id: contaId, nome: nomeCorrigido });
      continue;
    }

    throw new Error(`Ação de conta inválida para "${nomePlanilha}".`);
  }

  return resolvidas;
}

function limparPreviewsExpirados() {
  const agora = Date.now();
  for (const [tokenPreview, preview] of previewsImportacao.entries()) {
    if (agora - preview.criadoEm > PREVIEW_IMPORTACAO_TTL_MS) previewsImportacao.delete(tokenPreview);
  }
}

function valoresComparaveis(tx, categorias, contaId) {
  return {
    conta_id: contaId,
    data: tx.data,
    descricao: tx.descricao,
    valor: Number(tx.valor || 0).toFixed(2),
    tipo: tx.tipo,
    categoria_macro_id: categorias.categoriaMacroId || categorias.macroId || null,
    categoria_detalhada_id: categorias.categoriaDetalhadaId || categorias.detalhadaId || null,
  };
}

function montarAlteracoesTransacao(atual, novo) {
  const campos = [
    ['conta_id', 'conta'],
    ['data', 'data'],
    ['descricao', 'descricao'],
    ['valor', 'valor'],
    ['tipo', 'tipo'],
    ['categoria_macro_id', 'categoria_macro'],
    ['categoria_detalhada_id', 'categoria_detalhada'],
  ];

  return campos.reduce((alteracoes, [campo, label]) => {
    const valorAtual = campo === 'data'
      ? (atual[campo] instanceof Date ? atual[campo].toISOString().slice(0, 10) : String(atual[campo] || '').slice(0, 10))
      : campo === 'valor'
        ? Number(atual[campo] || 0).toFixed(2)
        : (atual[campo] || null);
    const novoValor = novo[campo] || null;

    if (String(valorAtual || '') !== String(novoValor || '')) {
      alteracoes.push({ campo: label, valorAtual, novoValor });
    }

    return alteracoes;
  }, []);
}

async function buscarTransacaoExistenteParaImportacao(usuarioId, tx, contaId, hash, idsConsumidos = new Set()) {
  const referencia = normalizarReferenciaImportacao(tx);
  const campos = `t.*, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome`;
  const joins = `FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id`;

  if (referencia && referenciaImportacaoEhUuid(referencia)) {
    const porId = await pool.query(
      `SELECT ${campos}
       ${joins}
       WHERE t.id = $1 AND c.usuario_id = $2 AND t.deletado_em IS NULL`,
      [referencia, usuarioId]
    );
    if (porId.rows[0]) return { ...porId.rows[0], _match_importacao: 'REFERENCIA' };
  }

  if (referencia) {
    const porReferencia = await pool.query(
      `SELECT ${campos}
       ${joins}
       WHERE t.referencia_banco = $1 AND t.conta_id = $2 AND c.usuario_id = $3 AND t.deletado_em IS NULL
       ORDER BY t.criado_em ASC, t.id ASC
       LIMIT 1`,
      [referencia, contaId, usuarioId]
    );
    if (porReferencia.rows[0]) return { ...porReferencia.rows[0], _match_importacao: 'REFERENCIA' };
  }

  const hashBase = gerarHashTransacao(tx, contaId);
  if (hash && hash !== hashBase) {
    const porHashImportacao = await pool.query(
      `SELECT ${campos}
       ${joins}
       WHERE t.hash_transacao = $1 AND t.conta_id = $2 AND c.usuario_id = $3 AND t.deletado_em IS NULL
       LIMIT 1`,
      [hash, contaId, usuarioId]
    );
    if (porHashImportacao.rows[0]) return { ...porHashImportacao.rows[0], _match_importacao: 'REFERENCIA' };
  }

  const hashLegado = gerarHashTransacaoLegado(tx);
  const params = [[hashBase, hashLegado], usuarioId, contaId, hashBase];
  let filtroReferencia = '';
  if (referencia) {
    params.push(referencia);
    filtroReferencia = `AND (t.referencia_banco IS NULL OR t.referencia_banco = $5)`;
  }
  const porHash = await pool.query(
    `SELECT ${campos}
     ${joins}
     WHERE t.hash_transacao = ANY($1::text[])
       AND c.usuario_id = $2
       AND t.conta_id = $3
       AND t.deletado_em IS NULL
       ${filtroReferencia}
     ORDER BY CASE WHEN t.hash_transacao = $4 THEN 0 ELSE 1 END, t.criado_em ASC, t.id ASC`,
    params
  );

  const disponivel = porHash.rows.find((row) => !idsConsumidos.has(row.id));
  return disponivel ? { ...disponivel, _match_importacao: 'HASH_NATURAL' } : null;
}

async function associarReferenciaImportacao(usuarioId, transacaoId, contaId, referencia) {
  if (!referencia) return false;
  const result = await pool.query(
    `UPDATE transacoes t
     SET referencia_banco = $1,
         atualizado_em = NOW()
     FROM contas c
     WHERE c.id = t.conta_id
       AND c.usuario_id = $2
       AND t.id = $3
       AND t.conta_id = $4
       AND t.deletado_em IS NULL
       AND (t.referencia_banco IS NULL OR t.referencia_banco = $1)
     RETURNING t.id`,
    [referencia, usuarioId, transacaoId, contaId]
  );
  return result.rows.length > 0;
}

async function montarPreviewImportacao(usuarioId, dados) {
  const transacoesValidadas = validarTransacoesImportacao(dados.transacoes);
  const contasUsuario = await listarContasUsuario(usuarioId);
  const contasImportacao = montarResumoContasImportacao(transacoesValidadas, contasUsuario);
  const contaPreviewPorNome = new Map(contasImportacao.map((conta) => [conta.nomePlanilha, conta]));
  const preview = {
    usuarioId,
    contasImportacao,
    nomeArquivo: dados.nome_arquivo || `importacao_${new Date().toISOString().slice(0, 10)}.xlsx`,
    arquivoBase64: dados.arquivo_base64,
    criadoEm: Date.now(),
    novas: [],
    semAlteracao: [],
    comAlteracao: [],
    erros: [],
    categoriasPendentes: [],
    categoriasNovas: [],
    sugestoesConciliacao: [],
    transacoesValidadas,
  };

  const idsExistentesConsumidos = new Set();

  for (const [index, tx] of transacoesValidadas.entries()) {
    const linha = tx._linha || index + 2;
    try {
      const categorias = await resolverCategoriasPreview(usuarioId, tx, preview);
      const contaPreview = contaPreviewPorNome.get(tx.conta) || { nomePlanilha: tx.conta };
      const contaIdPreview = contaPreview.contaEncontradaId || null;
      const contaHashKey = contaIdPreview || `planilha:${normalizarNomeConta(tx.conta)}`;
      const hash = gerarHashTransacaoImportacao(tx, contaHashKey);
      const existente = contaIdPreview
        ? await buscarTransacaoExistenteParaImportacao(usuarioId, tx, contaIdPreview, hash, idsExistentesConsumidos)
        : null;
      if (existente?._match_importacao === 'HASH_NATURAL') idsExistentesConsumidos.add(existente.id);
      tx.hash_transacao = hash;
      const normalizada = {
        ...tx,
        linha,
        conta_id: contaIdPreview,
        conta_nome: contaPreview.contaEncontradaNome || tx.conta,
        conta_planilha: tx.conta,
        hash_transacao: hash,
        categoria_id: categorias.categoriaId,
        categoria_macro_id: categorias.categoriaMacroId,
        categoria_detalhada_id: categorias.categoriaDetalhadaId,
        categoria_macro_nome: categorias.categoriaMacroNome,
        categoria_detalhada_nome: categorias.categoriaDetalhadaNome,
        categoria_macro_planilha: categorias.categoriaMacroPlanilha,
        categoria_detalhada_planilha: categorias.categoriaDetalhadaPlanilha,
        criar_categoria_macro_nome: categorias.criarCategoriaMacroNome,
        criar_categoria_detalhada_nome: categorias.criarCategoriaDetalhadaNome,
      };

      if (!existente) {
        preview.novas.push(normalizada);
        continue;
      }

      const alteracoes = montarAlteracoesTransacao(existente, valoresComparaveis(tx, categorias, contaIdPreview));
      if (alteracoes.length === 0) {
        preview.semAlteracao.push({ ...normalizada, transacaoId: existente.id });
      } else {
        preview.comAlteracao.push({
          ...normalizada,
          transacaoId: existente.id,
          descricaoAtual: existente.descricao,
          alteracoes,
        });
      }
    } catch (error) {
      preview.erros.push(error.detalhesImportacao || {
        linha,
        coluna: 'Linha',
        valorOriginal: '',
        descricao: tx.descricao || '',
        erro: error.message,
        sugestao: 'Revise os dados desta linha na planilha e tente novamente.',
      });
    }
  }

  const transacoesParaConciliacao = [...preview.novas, ...preview.comAlteracao, ...preview.semAlteracao]
    .map((tx) => ({ ...tx, id: tx.transacaoId || null, transacaoId: tx.transacaoId || null }));
  const datas = transacoesParaConciliacao.map((tx) => tx.data).filter(Boolean).sort();
  const provisoesPendentes = await buscarProvisoesPendentesParaConciliacao(usuarioId, {
    dataInicial: datas[0],
    dataFinal: datas[datas.length - 1],
  });
  const ignoradasPreview = await pool.query(
    `SELECT provisao_id, transacao_id FROM conciliacoes WHERE usuario_id = $1 AND status = 'IGNORADA'`,
    [usuarioId]
  );
  preview.sugestoesConciliacao = montarSugestoesConciliacao(provisoesPendentes, transacoesParaConciliacao, ignoradasPreview.rows);

  const tokenPreview = crypto.randomUUID();
  previewsImportacao.set(tokenPreview, preview);

  return {
    resumo: {
      novas: preview.novas.length,
      semAlteracao: preview.semAlteracao.length,
      comAlteracao: preview.comAlteracao.length,
      comErro: preview.erros.length,
    },
    novas: preview.novas.slice(0, 50),
    semAlteracao: preview.semAlteracao.slice(0, 50),
    comAlteracao: preview.comAlteracao.slice(0, 50),
    erros: preview.erros,
    categoriasPendentes: preview.categoriasPendentes,
    categoriasNovas: preview.categoriasNovas,
    contasImportacao: preview.contasImportacao,
    sugestoesConciliacao: preview.sugestoesConciliacao,
    tokenPreview,
  };
}

async function prepararTransacaoConfirmacao(usuarioId, tx, mapeamentoCategorias) {
  const categorias = await resolverCategoriasConfirmacao(usuarioId, tx, mapeamentoCategorias);
  return {
    ...tx,
    categoria_id: categorias.categoriaId,
    categoria_macro_id: categorias.categoriaMacroId,
    categoria_detalhada_id: categorias.categoriaDetalhadaId,
    categoria_macro_nome: categorias.categoriaMacroNome,
    categoria_detalhada_nome: categorias.categoriaDetalhadaNome,
  };
}

function validarMapeamentoCategoriasResolvido(preview, mapeamentoCategorias = []) {
  const pendentes = preview.categoriasPendentes || [];
  const faltantes = pendentes.filter((pendencia) => {
    const decisao = buscarDecisaoCategoria(mapeamentoCategorias, pendencia);
    if (!decisao?.acao) return true;
    if (decisao.acao === 'USAR_EXISTENTE' && !decisao.categoriaExistenteId) return true;
    if (decisao.acao === 'CORRIGIR_NOME' && !normalizarNomeCategoria(decisao.nomeCorrigido)) return true;
    return false;
  });

  if (faltantes.length > 0) {
    throw new Error('Resolva as categorias pendentes antes de concluir a importação.');
  }
}

async function inserirTransacaoImportacao(contaId, tx) {
  const referenciaImportacao = normalizarReferenciaImportacao(tx);
  const insert = await pool.query(
    `INSERT INTO transacoes (conta_id, data, descricao, valor, tipo, categoria_id, categoria_macro_id, categoria_detalhada_id, categoria_origem, referencia_banco, hash_transacao, criado_em, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'IMPORTACAO', $9, $10, NOW(), NOW())
     ON CONFLICT (hash_transacao) DO NOTHING
     RETURNING id`,
    [contaId, tx.data, tx.descricao, tx.valor, tx.tipo, tx.categoria_id, tx.categoria_macro_id, tx.categoria_detalhada_id, referenciaImportacao, tx.hash_transacao]
  );

  return insert.rows[0]?.id || null;
}

async function atualizarTransacaoImportacao(usuarioId, tx) {
  const referenciaImportacao = String(tx.referencia_banco || '').trim() || null;
  const result = await pool.query(
    `UPDATE transacoes t
     SET conta_id = $1,
         data = $2,
         descricao = $3,
         valor = $4,
         tipo = $5,
         categoria_id = $6,
         categoria_macro_id = $7,
         categoria_detalhada_id = $8,
         categoria_origem = 'IMPORTACAO',
         referencia_banco = COALESCE(t.referencia_banco, $9),
         hash_transacao = $10,
         atualizado_em = NOW()
     FROM contas c
     WHERE c.id = t.conta_id
       AND c.usuario_id = $11
       AND t.id = $12
       AND t.deletado_em IS NULL
     RETURNING t.id`,
    [tx.conta_id, tx.data, tx.descricao, tx.valor, tx.tipo, tx.categoria_id, tx.categoria_macro_id, tx.categoria_detalhada_id, referenciaImportacao, tx.hash_transacao, usuarioId, tx.transacaoId]
  );

  return result.rows.length > 0;
}

app.post('/api/importacoes/xlsx/preview', verificarToken, async (req, res) => {
  try {
    limparPreviewsExpirados();
    const preview = await montarPreviewImportacao(req.usuario.usuario_id, req.body);
    res.json(preview);
  } catch (error) {
    res.status(400).json({ erro: 'Não foi possível gerar o preview da importação.', detalhes: error.message });
  }
});

app.post('/api/importacoes/xlsx/confirmar', verificarToken, async (req, res) => {
  try {
    limparPreviewsExpirados();
    const { tokenPreview, acao, mapeamentoContas = [], mapeamentoCategorias = [], conciliacoesConfirmadas = [], conciliacoesIgnoradas = [] } = req.body;
    const preview = previewsImportacao.get(tokenPreview);

    if (!preview || preview.usuarioId !== req.usuario.usuario_id) {
      return res.status(404).json({ erro: 'Preview de importação não encontrado ou expirado.' });
    }

    if (acao === 'CANCELAR') {
      previewsImportacao.delete(tokenPreview);
      return res.json({ sucesso: true, inseridas: 0, atualizadas: 0, mensagem: 'Importação cancelada sem alterações no banco.' });
    }

    const importarNovas = ['IMPORTAR_APENAS_NOVAS', 'IMPORTAR_NOVAS_E_ATUALIZAR_EXISTENTES'].includes(acao);
    const atualizarExistentes = ['ATUALIZAR_EXISTENTES', 'IMPORTAR_NOVAS_E_ATUALIZAR_EXISTENTES'].includes(acao);

    if (!importarNovas && !atualizarExistentes) {
      return res.status(400).json({ erro: 'Ação de confirmação inválida.' });
    }

    validarMapeamentoCategoriasResolvido(preview, mapeamentoCategorias);
    const contasResolvidas = await resolverMapeamentoContasConfirmacao(req.usuario.usuario_id, preview, mapeamentoContas);

    let inseridas = 0;
    let atualizadas = 0;
    let ignoradas = 0;
    const transacaoPorTempId = new Map();
    const transacoesImportadasIds = new Set();
    const idsExistentesConsumidos = new Set();

    for (const tx of (preview.transacoesValidadas || [])) {
      const contaResolvida = contasResolvidas.get(String(tx.conta || '').trim());
      if (!contaResolvida) throw new Error(`Resolva a conta da planilha "${tx.conta}" antes de concluir a importação.`);

      const txConfirmada = await prepararTransacaoConfirmacao(req.usuario.usuario_id, tx, mapeamentoCategorias);
      const hash = gerarHashTransacaoImportacao(txConfirmada, contaResolvida.id);
      const existente = await buscarTransacaoExistenteParaImportacao(
        req.usuario.usuario_id,
        txConfirmada,
        contaResolvida.id,
        hash,
        idsExistentesConsumidos
      );
      if (existente?._match_importacao === 'HASH_NATURAL') idsExistentesConsumidos.add(existente.id);
      const referenciaImportacao = normalizarReferenciaImportacao(txConfirmada);
      const referenciaPersistida = !existente || existente._match_importacao === 'HASH_NATURAL'
        ? referenciaImportacao
        : (existente.referencia_banco || null);
      const txComConta = {
        ...txConfirmada,
        conta_id: contaResolvida.id,
        conta_nome: contaResolvida.nome,
        referencia_banco: referenciaPersistida,
        hash_transacao: hash,
      };

      if (!existente) {
        if (importarNovas) {
          const transacaoInseridaId = await inserirTransacaoImportacao(contaResolvida.id, txComConta);
          if (transacaoInseridaId) {
            tx.transacaoIdConfirmada = transacaoInseridaId;
            inseridas++;
            transacaoPorTempId.set(tx.hash_transacao || hash, transacaoInseridaId);
            transacoesImportadasIds.add(transacaoInseridaId);
          }
        } else {
          ignoradas++;
        }
        continue;
      }

      if (existente._match_importacao === 'HASH_NATURAL' && txComConta.referencia_banco && !existente.referencia_banco) {
        await associarReferenciaImportacao(req.usuario.usuario_id, existente.id, contaResolvida.id, txComConta.referencia_banco);
      }

      const categoriasComparacao = {
        categoriaMacroId: txComConta.categoria_macro_id,
        categoriaDetalhadaId: txComConta.categoria_detalhada_id,
      };
      const alteracoes = montarAlteracoesTransacao(existente, valoresComparaveis(txComConta, categoriasComparacao, contaResolvida.id));
      tx.transacaoIdConfirmada = existente.id;
      transacaoPorTempId.set(tx.hash_transacao || hash, existente.id);

      if (alteracoes.length > 0 && atualizarExistentes) {
        if (await atualizarTransacaoImportacao(req.usuario.usuario_id, { ...txComConta, transacaoId: existente.id })) {
          atualizadas++;
          transacoesImportadasIds.add(existente.id);
        }
      } else {
        ignoradas++;
      }
    }

    const pagamentosCartao = await conciliarPagamentosCartaoImportados(req.usuario.usuario_id, [...transacoesImportadasIds]);

    let conciliacoesAplicadas = 0;

    for (const sugestao of conciliacoesIgnoradas) {
      const transacaoId = sugestao.transacaoId || transacaoPorTempId.get(sugestao.transacaoTempId);
      if (!sugestao.provisaoId || !transacaoId) continue;
      await pool.query(
        `INSERT INTO conciliacoes (usuario_id, provisao_id, transacao_id, status, confianca, score, motivos, ignorado_em)
         VALUES ($1, $2, $3, 'IGNORADA', $4, $5, $6::jsonb, NOW())
         ON CONFLICT DO NOTHING`,
        [req.usuario.usuario_id, sugestao.provisaoId, transacaoId, sugestao.confianca || 'BAIXA', sugestao.score || 0, JSON.stringify(sugestao.motivos || ['Sugestão ignorada no preview de importação'])]
      );
    }

    for (const sugestao of conciliacoesConfirmadas) {
      const transacaoId = sugestao.transacaoId || transacaoPorTempId.get(sugestao.transacaoTempId);
      if (!sugestao.provisaoId || !transacaoId) continue;
      await confirmarConciliacaoUsuario(req.usuario.usuario_id, sugestao.provisaoId, transacaoId, {
        confianca: sugestao.confianca || 'BAIXA',
        score: sugestao.score || 0.5,
        motivos: sugestao.motivos || ['Conciliação confirmada no preview de importação'],
      });
      conciliacoesAplicadas++;
    }

    previewsImportacao.delete(tokenPreview);
    res.json({
      sucesso: true,
      inseridas,
      atualizadas,
      ignoradas,
      conciliacoesAplicadas,
      pagamentosCartaoPareados: pagamentosCartao.pareadas,
      erros: preview.erros.length,
      mensagem: `Importação confirmada: ${inseridas} inserida(s), ${atualizadas} atualizada(s), ${ignoradas} sem alteração e ${conciliacoesAplicadas} conciliação(ões) aplicada(s).`,
    });
  } catch (error) {
    const status = /Resolva|Selecione|Informe|Categoria|Conta/.test(error.message || '') ? 400 : 500;
    res.status(status).json({ erro: 'Erro ao confirmar importação.', detalhes: error.message });
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
    const transacoesImportadasIds = [];
    const idsExistentesConsumidos = new Set();

    for (const tx of transacoesValidadas) {
      const hash = gerarHashTransacaoImportacao(tx, contaId);
      const existente = await buscarTransacaoExistenteParaImportacao(req.usuario.usuario_id, tx, contaId, hash, idsExistentesConsumidos);
      if (existente) {
        if (existente._match_importacao === 'HASH_NATURAL') idsExistentesConsumidos.add(existente.id);
        const referenciaImportacao = normalizarReferenciaImportacao(tx);
        if (existente._match_importacao === 'HASH_NATURAL' && referenciaImportacao && !existente.referencia_banco) {
          await associarReferenciaImportacao(req.usuario.usuario_id, existente.id, contaId, referenciaImportacao);
        }
        duplicadas++;
        continue;
      }
      const regra = await buscarRegraCompatível(req.usuario.usuario_id, tx.descricao);
      const categoriasImportacao = regra
        ? await validarParCategoriasDoUsuario(req.usuario.usuario_id, regra.categoria_id, null)
        : await resolverCategoriasImportacao(req.usuario.usuario_id, tx, { criar: true });
      const insert = await pool.query(
        `INSERT INTO transacoes (conta_id, data, descricao, valor, tipo, categoria_id, categoria_macro_id, categoria_detalhada_id, categoria_origem, regra_categorizacao_id, referencia_banco, hash_transacao, criado_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (hash_transacao) DO NOTHING
         RETURNING id`,
        [
          contaId,
          tx.data,
          tx.descricao,
          tx.valor,
          tx.tipo,
          categoriasImportacao.categoriaId || categoriasImportacao.categoria_id || null,
          categoriasImportacao.categoriaMacroId || categoriasImportacao.macroId || null,
          categoriasImportacao.categoriaDetalhadaId || categoriasImportacao.detalhadaId || null,
          regra ? 'AUTO' : 'IMPORTACAO',
          regra?.id || null,
          normalizarReferenciaImportacao(tx),
          hash,
        ]
      );

      if (insert.rows.length === 0) {
        duplicadas++;
      } else {
        inseridas++;
        transacoesImportadasIds.push(insert.rows[0].id);
      }
    }

    const pagamentosCartao = await conciliarPagamentosCartaoImportados(req.usuario.usuario_id, transacoesImportadasIds);

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
      pagamentosCartaoPareados: pagamentosCartao.pareadas,
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
// ROTAS: COMPRAS PROGRAMADAS
// ============================================================================

const PRIORIDADES_COMPRA = ['BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'];
const FORMAS_PAGAMENTO_COMPRA = ['A_VISTA', 'PARCELADO'];
const STATUS_COMPRA = ['PLANEJADA', 'ADIADA', 'COMPRADA', 'CANCELADA'];

function validarPayloadCompraProgramada(body = {}, parcial = false) {
  const payload = {};

  if (!parcial || body.descricao !== undefined) {
    payload.descricao = String(body.descricao || '').trim();
    if (!payload.descricao) throw new Error('Descrição da compra é obrigatória.');
  }

  if (!parcial || body.valorEstimado !== undefined || body.valor_estimado !== undefined) {
    payload.valorEstimado = Number(body.valorEstimado ?? body.valor_estimado);
    if (!Number.isFinite(payload.valorEstimado) || payload.valorEstimado <= 0) throw new Error('Valor estimado deve ser positivo.');
  }

  if (!parcial || body.dataDesejada !== undefined || body.data_desejada !== undefined) {
    payload.dataDesejada = normalizarDataImportacao(body.dataDesejada ?? body.data_desejada);
    if (!payload.dataDesejada) throw new Error('Data desejada é obrigatória.');
  }

  if (!parcial || body.prioridade !== undefined) {
    payload.prioridade = String(body.prioridade || 'MEDIA').toUpperCase();
    if (!PRIORIDADES_COMPRA.includes(payload.prioridade)) throw new Error('Prioridade inválida.');
  }

  if (!parcial || body.formaPagamento !== undefined || body.forma_pagamento !== undefined) {
    payload.formaPagamento = String(body.formaPagamento ?? body.forma_pagamento ?? 'A_VISTA').toUpperCase();
    if (!FORMAS_PAGAMENTO_COMPRA.includes(payload.formaPagamento)) throw new Error('Forma de pagamento inválida.');
  }

  if (!parcial || body.parcelas !== undefined) {
    payload.parcelas = Number(body.parcelas ?? 1);
    if (!Number.isInteger(payload.parcelas) || payload.parcelas < 1 || payload.parcelas > 60) throw new Error('Quantidade de parcelas inválida.');
    if ((payload.formaPagamento || body.formaPagamento || body.forma_pagamento) === 'A_VISTA') payload.parcelas = 1;
    if ((payload.formaPagamento || body.formaPagamento || body.forma_pagamento) === 'PARCELADO' && payload.parcelas < 2) throw new Error('Compra parcelada deve ter pelo menos 2 parcelas.');
  }

  if (body.contaId !== undefined || body.conta_id !== undefined) payload.contaId = body.contaId || body.conta_id || null;
  if (body.categoriaMacroId !== undefined || body.categoria_macro_id !== undefined) payload.categoriaMacroId = body.categoriaMacroId || body.categoria_macro_id || null;
  if (body.categoriaDetalhadaId !== undefined || body.categoria_detalhada_id !== undefined) payload.categoriaDetalhadaId = body.categoriaDetalhadaId || body.categoria_detalhada_id || null;

  if (body.status !== undefined) {
    payload.status = String(body.status || '').toUpperCase();
    if (!STATUS_COMPRA.includes(payload.status)) throw new Error('Status da compra inválido.');
  }

  if (body.observacao !== undefined) payload.observacao = body.observacao || null;
  return payload;
}

async function validarRelacionamentosCompraProgramada(usuarioId, payload) {
  if (payload.contaId) {
    const conta = await pool.query(
      'SELECT id FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = true',
      [payload.contaId, usuarioId]
    );
    if (conta.rows.length === 0) throw new Error('Conta não encontrada para este usuário.');
  }

  for (const [campo, id] of [['categoriaMacroId', payload.categoriaMacroId], ['categoriaDetalhadaId', payload.categoriaDetalhadaId]]) {
    if (!id) continue;
    const categoria = await pool.query(
      'SELECT id FROM categorias WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) AND ativa = true',
      [id, usuarioId]
    );
    if (categoria.rows.length === 0) throw new Error(`${campo} inválida para este usuário.`);
  }

  if (payload.categoriaMacroId && payload.categoriaDetalhadaId) {
    const relacao = await pool.query(
      'SELECT id FROM categorias WHERE id = $1 AND categoria_pai_id = $2 AND (usuario_id = $3 OR usuario_id IS NULL) AND ativa = true',
      [payload.categoriaDetalhadaId, payload.categoriaMacroId, usuarioId]
    );
    if (relacao.rows.length === 0) throw new Error('Categoria detalhada não pertence à categoria macro selecionada.');
  }
}

app.get('/api/compras-programadas', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cp.*,
              c.nome AS conta_nome,
              cm.nome AS categoria_macro_nome,
              cd.nome AS categoria_detalhada_nome,
              cc.id AS conciliacao_compra_id,
              cc.transacao_id AS transacao_conciliada_id,
              cc.confianca AS conciliacao_confianca,
              tx.descricao AS transacao_conciliada_descricao,
              tx.data AS transacao_conciliada_data,
              tx.valor AS transacao_conciliada_valor,
              conta_tx.nome AS transacao_conciliada_conta
       FROM compras_programadas cp
       LEFT JOIN contas c ON c.id = cp.conta_id
       LEFT JOIN categorias cm ON cm.id = cp.categoria_macro_id
       LEFT JOIN categorias cd ON cd.id = cp.categoria_detalhada_id
       LEFT JOIN conciliacoes_compras cc ON cc.compra_id = cp.id AND cc.status = 'CONFIRMADA'
       LEFT JOIN transacoes tx ON tx.id = cc.transacao_id
       LEFT JOIN contas conta_tx ON conta_tx.id = tx.conta_id
       WHERE cp.usuario_id = $1
       ORDER BY
         CASE cp.status WHEN 'PLANEJADA' THEN 0 WHEN 'ADIADA' THEN 1 WHEN 'COMPRADA' THEN 2 ELSE 3 END,
         cp.data_desejada ASC,
         cp.criado_em DESC`,
      [req.usuario.usuario_id]
    );
    res.json({ compras: result.rows });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/compras-programadas', verificarToken, async (req, res) => {
  try {
    const payload = validarPayloadCompraProgramada(req.body);
    await validarRelacionamentosCompraProgramada(req.usuario.usuario_id, payload);
    const result = await pool.query(
      `INSERT INTO compras_programadas (
        usuario_id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento,
        parcelas, conta_id, categoria_macro_id, categoria_detalhada_id, status, observacao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        req.usuario.usuario_id,
        payload.descricao,
        payload.valorEstimado,
        payload.dataDesejada,
        payload.prioridade,
        payload.formaPagamento,
        payload.parcelas,
        payload.contaId || null,
        payload.categoriaMacroId || null,
        payload.categoriaDetalhadaId || null,
        payload.status || 'PLANEJADA',
        payload.observacao || null,
      ]
    );
    res.status(201).json({ compra: result.rows[0] });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.post('/api/compras-programadas/lote', verificarToken, async (req, res) => {
  const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
  if (itens.length === 0) return res.status(400).json({ erro: 'Informe pelo menos uma compra para cadastrar.' });
  if (itens.length > 30) return res.status(400).json({ erro: 'Cadastre no máximo 30 compras por vez.' });

  let client;
  try {
    const payloads = itens.map((item) => validarPayloadCompraProgramada(item));
    for (const payload of payloads) {
      await validarRelacionamentosCompraProgramada(req.usuario.usuario_id, payload);
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const compras = [];
    for (const payload of payloads) {
      const result = await client.query(
        `INSERT INTO compras_programadas (
          usuario_id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento,
          parcelas, conta_id, categoria_macro_id, categoria_detalhada_id, status, observacao
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          req.usuario.usuario_id,
          payload.descricao,
          payload.valorEstimado,
          payload.dataDesejada,
          payload.prioridade,
          payload.formaPagamento,
          payload.parcelas,
          payload.contaId || null,
          payload.categoriaMacroId || null,
          payload.categoriaDetalhadaId || null,
          payload.status || 'PLANEJADA',
          payload.observacao || null,
        ]
      );
      compras.push(result.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ compras });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ erro: error.message });
  } finally {
    client?.release();
  }
});


function normalizarMetodoPagamentoCompra(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function calcularSugestaoConciliacaoCompra(compra, transacao, contexto = {}) {
  if (!compra || !transacao || String(transacao.tipo).toUpperCase() !== 'DEBITO') return null;
  if (transacao.eh_transferencia_interna) return null;

  const valorCompra = Math.abs(Number(compra.valor_estimado ?? compra.valorEstimado ?? 0));
  const valorTransacao = Math.abs(Number(transacao.valor || 0));
  if (!valorCompra || !valorTransacao) return null;

  const diferenca = Math.abs(valorCompra - valorTransacao);
  const percentual = diferenca / valorCompra;
  const compraExistente = Boolean(contexto.compraExistente);
  const limitePercentual = compraExistente ? 0.15 : 0.02;
  const limiteAbsoluto = compraExistente ? Math.max(5, Math.min(100, valorCompra * limitePercentual)) : Math.max(0.05, Math.min(5, valorCompra * limitePercentual));
  if (diferenca > limiteAbsoluto) return null;

  const motivos = [];
  let score = 0;
  if (diferenca <= 0.05) {
    score += 0.58;
    motivos.push('Mesmo valor');
  } else if (percentual <= 0.005) {
    score += 0.52;
    motivos.push('Valor praticamente igual');
  } else if (percentual <= 0.02) {
    score += 0.42;
    motivos.push('Valor muito próximo');
  } else if (percentual <= 0.10) {
    score += 0.32;
    motivos.push('Valor próximo do planejado');
  } else {
    score += 0.24;
    motivos.push('Valor dentro da tolerância do planejado');
  }

  const dataReferencia = contexto.dataReferencia ? normalizarDataImportacao(contexto.dataReferencia) : null;
  const dataTransacao = transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10);
  if (dataReferencia) {
    const dias = diasEntreConciliacao(dataReferencia, dataTransacao);
    if (dias === 0) {
      score += 0.20;
      motivos.push('Mesma data informada');
    } else if (dias <= 2) {
      score += 0.15;
      motivos.push(`Data próxima (${dias} dia${dias > 1 ? 's' : ''})`);
    } else if (dias <= 7) {
      score += 0.08;
      motivos.push(`Data na mesma janela (${dias} dias)`);
    }
  }

  const descricaoCompra = compra.descricao || contexto.descricao || '';
  const similaridade = similaridadeTextoConciliacao(descricaoCompra, transacao.descricao);
  if (similaridade >= 0.60) {
    score += 0.16;
    motivos.push('Descrição semelhante');
  } else if (similaridade >= 0.25) {
    score += 0.08;
    motivos.push('Descrição parcialmente semelhante');
  }

  const metodo = normalizarMetodoPagamentoCompra(contexto.metodoPagamento);
  const descricaoTransacao = normalizarMetodoPagamentoCompra(transacao.descricao);
  if (metodo.includes('PIX') && descricaoTransacao.includes('PIX')) {
    score += 0.12;
    motivos.push('Lançamento identificado como PIX');
  } else if ((metodo.includes('CARTAO') || metodo.includes('CRÉDITO') || metodo.includes('CREDITO')) && /CARTAO|COMPRA|CREDITO/.test(descricaoTransacao)) {
    score += 0.08;
    motivos.push('Descrição compatível com cartão');
  }

  score = Math.max(0, Math.min(0.99, Number(score.toFixed(2))));
  const confianca = score >= 0.82 ? 'ALTA' : score >= 0.62 ? 'MEDIA' : 'BAIXA';
  return { score, confianca, motivos, diferenca: Number(diferenca.toFixed(2)), dataTransacao };
}

async function buscarCandidatasTransacaoCompra(usuarioId, compra, contexto = {}) {
  const valorCompra = Math.abs(Number(compra.valor_estimado ?? compra.valorEstimado ?? 0));
  if (!Number.isFinite(valorCompra) || valorCompra <= 0) return [];

  const compraExistente = Boolean(contexto.compraExistente);
  const limiteAbsoluto = compraExistente
    ? Math.max(5, Math.min(100, valorCompra * 0.15))
    : Math.max(0.05, Math.min(5, valorCompra * 0.02));
  const dataReferencia = contexto.dataReferencia ? normalizarDataImportacao(contexto.dataReferencia) : null;
  const diasBusca = Math.min(365, Math.max(30, Number(contexto.diasBusca || 180)));

  const valores = [usuarioId, valorCompra, limiteAbsoluto];
  let filtroData;
  if (dataReferencia) {
    valores.push(dataReferencia);
    filtroData = `AND t.data BETWEEN ($${valores.length}::date - INTERVAL '7 days') AND ($${valores.length}::date + INTERVAL '7 days')`;
  } else {
    valores.push(diasBusca);
    filtroData = `AND t.data >= CURRENT_DATE - ($${valores.length}::int * INTERVAL '1 day')`;
  }

  const result = await pool.query(
    `SELECT t.*, c.nome AS conta_nome,
            cm.nome AS categoria_macro_nome,
            cd.nome AS categoria_detalhada_nome
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND t.tipo = 'DEBITO'
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND ABS(ABS(t.valor) - ABS($2::numeric)) <= $3::numeric
       ${filtroData}
       AND NOT EXISTS (
         SELECT 1 FROM conciliacoes_compras cc
         WHERE cc.transacao_id = t.id AND cc.status = 'CONFIRMADA'
       )
     ORDER BY ABS(ABS(t.valor) - ABS($2::numeric)) ASC, t.data DESC
     LIMIT 20`,
    valores
  );

  return result.rows
    .map((transacao) => ({
      transacao,
      analise: calcularSugestaoConciliacaoCompra(compra, transacao, contexto),
    }))
    .filter((item) => item.analise)
    .sort((a, b) => b.analise.score - a.analise.score || String(b.analise.dataTransacao).localeCompare(String(a.analise.dataTransacao)))
    .slice(0, 8);
}

app.post('/api/compras-programadas/conciliar-transacao', verificarToken, async (req, res) => {
  const usuarioId = req.usuario.usuario_id;
  const compraId = req.body?.compraId || null;
  const transacaoId = req.body?.transacaoId;
  const compraNova = req.body?.compra || null;
  if (!transacaoId) return res.status(400).json({ erro: 'Selecione um lançamento para associar à compra.' });
  if (!compraId && !compraNova) return res.status(400).json({ erro: 'Informe a compra que será associada.' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const transacaoResult = await client.query(
      `SELECT t.*, c.nome AS conta_nome
       FROM transacoes t
       JOIN contas c ON c.id = t.conta_id
       WHERE t.id = $1
         AND c.usuario_id = $2
         AND t.deletado_em IS NULL
         AND t.tipo = 'DEBITO'
         AND COALESCE(t.eh_transferencia_interna, false) = false
       FOR UPDATE`,
      [transacaoId, usuarioId]
    );
    const transacao = transacaoResult.rows[0];
    if (!transacao) throw new Error('Lançamento de débito não encontrado para este usuário.');

    const vinculoExistente = await client.query(
      `SELECT id FROM conciliacoes_compras
       WHERE transacao_id = $1 AND status = 'CONFIRMADA'
       LIMIT 1`,
      [transacaoId]
    );
    if (vinculoExistente.rows.length > 0) throw new Error('Este lançamento já está associado a outra compra.');

    let compra;
    if (compraId) {
      const compraResult = await client.query(
        `SELECT * FROM compras_programadas
         WHERE id = $1 AND usuario_id = $2
         FOR UPDATE`,
        [compraId, usuarioId]
      );
      compra = compraResult.rows[0];
      if (!compra) throw new Error('Compra Programada não encontrada.');
      if (compra.status === 'CANCELADA') throw new Error('Não é possível associar uma compra cancelada.');

      const jaVinculada = await client.query(
        `SELECT id FROM conciliacoes_compras
         WHERE compra_id = $1 AND status = 'CONFIRMADA'
         LIMIT 1`,
        [compraId]
      );
      if (jaVinculada.rows.length > 0) throw new Error('Esta compra já possui um lançamento associado.');
    } else {
      const payload = validarPayloadCompraProgramada({
        ...compraNova,
        dataDesejada: transacao.data,
        status: 'COMPRADA',
      });
      await validarRelacionamentosCompraProgramada(usuarioId, payload);

      const possivelDuplicada = await client.query(
        `SELECT id, descricao, valor_estimado, status
         FROM compras_programadas
         WHERE usuario_id = $1
           AND status IN ('PLANEJADA', 'ADIADA', 'COMPRADA')
           AND LOWER(descricao) = LOWER($2)
           AND ABS(valor_estimado - $3::numeric) <= GREATEST(5, ABS($3::numeric) * 0.15)
         ORDER BY criado_em DESC
         LIMIT 1`,
        [usuarioId, payload.descricao, payload.valorEstimado]
      );
      if (possivelDuplicada.rows.length > 0) {
        throw new Error('Já existe uma Compra Programada compatível com essa descrição e valor. Associe o lançamento à compra existente em vez de criar uma duplicata.');
      }

      const insert = await client.query(
        `INSERT INTO compras_programadas (
          usuario_id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento,
          parcelas, conta_id, categoria_macro_id, categoria_detalhada_id, status, observacao,
          valor_realizado, data_realizada
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'COMPRADA',$11,$12,$13)
        RETURNING *`,
        [
          usuarioId,
          payload.descricao,
          payload.valorEstimado,
          payload.dataDesejada,
          payload.prioridade,
          payload.formaPagamento,
          payload.parcelas,
          payload.contaId || transacao.conta_id || null,
          payload.categoriaMacroId || null,
          payload.categoriaDetalhadaId || null,
          payload.observacao || null,
          Math.abs(Number(transacao.valor || 0)),
          transacao.data,
        ]
      );
      compra = insert.rows[0];
    }

    const analise = calcularSugestaoConciliacaoCompra(compra, transacao, {
      compraExistente: Boolean(compraId),
      dataReferencia: compraId ? compra.data_desejada : null,
    }) || { confianca: 'BAIXA', score: 0.5, motivos: ['Associação confirmada manualmente pelo usuário'] };

    if (compraId) {
      const update = await client.query(
        `UPDATE compras_programadas
         SET status = 'COMPRADA',
             valor_realizado = $1,
             data_realizada = $2,
             atualizado_em = NOW()
         WHERE id = $3 AND usuario_id = $4
         RETURNING *`,
        [Math.abs(Number(transacao.valor || 0)), transacao.data, compra.id, usuarioId]
      );
      compra = update.rows[0];
    }

    const conciliacao = await client.query(
      `INSERT INTO conciliacoes_compras (
        usuario_id, compra_id, transacao_id, status, confianca, score, motivos, confirmado_em
       ) VALUES ($1,$2,$3,'CONFIRMADA',$4,$5,$6::jsonb,NOW())
       RETURNING *`,
      [usuarioId, compra.id, transacao.id, analise.confianca, analise.score, JSON.stringify(analise.motivos || [])]
    );

    await client.query('COMMIT');
    res.status(201).json({
      compra,
      conciliacao: conciliacao.rows[0],
      transacao: {
        descricao: transacao.descricao,
        valor: Number(transacao.valor || 0),
        data: transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10),
        conta: transacao.conta_nome,
      },
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ erro: error.message });
  } finally {
    client?.release();
  }
});

app.patch('/api/compras-programadas/:id', verificarToken, async (req, res) => {
  try {
    const existente = await pool.query(
      'SELECT id FROM compras_programadas WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.usuario_id]
    );
    if (existente.rows.length === 0) return res.status(404).json({ erro: 'Compra programada não encontrada.' });

    const payload = validarPayloadCompraProgramada(req.body, true);
    await validarRelacionamentosCompraProgramada(req.usuario.usuario_id, payload);

    const mapa = {
      descricao: 'descricao',
      valorEstimado: 'valor_estimado',
      dataDesejada: 'data_desejada',
      prioridade: 'prioridade',
      formaPagamento: 'forma_pagamento',
      parcelas: 'parcelas',
      contaId: 'conta_id',
      categoriaMacroId: 'categoria_macro_id',
      categoriaDetalhadaId: 'categoria_detalhada_id',
      status: 'status',
      observacao: 'observacao',
    };

    const sets = [];
    const valores = [];
    for (const [campo, coluna] of Object.entries(mapa)) {
      if (payload[campo] === undefined) continue;
      valores.push(payload[campo]);
      sets.push(`${coluna} = $${valores.length}`);
    }

    if (sets.length === 0) return res.status(400).json({ erro: 'Nenhum campo válido para atualizar.' });
    valores.push(req.params.id, req.usuario.usuario_id);

    const result = await pool.query(
      `UPDATE compras_programadas
       SET ${sets.join(', ')}, atualizado_em = NOW()
       WHERE id = $${valores.length - 1} AND usuario_id = $${valores.length}
       RETURNING *`,
      valores
    );
    res.json({ compra: result.rows[0] });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.delete('/api/compras-programadas/:id', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM compras_programadas WHERE id = $1 AND usuario_id = $2 RETURNING id',
      [req.params.id, req.usuario.usuario_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Compra programada não encontrada.' });
    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

function chaveMesCompra(data) {
  const texto = String(data || '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})/.exec(texto);
  return match ? `${match[1]}-${match[2]}` : null;
}

function somarMesesChaveCompra(chave, incremento) {
  const [ano, mes] = String(chave).split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1 + incremento, 1));
  return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
}

function diferencaMesesCompra(inicio, fim) {
  const [anoInicio, mesInicio] = String(inicio).split('-').map(Number);
  const [anoFim, mesFim] = String(fim).split('-').map(Number);
  return (anoFim * 12 + mesFim) - (anoInicio * 12 + mesInicio);
}

function distribuirCompraEmMeses({ valor, formaPagamento, parcelas, mesInicio }) {
  const total = Math.round(Number(valor || 0) * 100);
  const qtd = formaPagamento === 'PARCELADO' ? Math.max(2, Number(parcelas || 2)) : 1;
  const base = Math.floor(total / qtd);
  const resto = total - (base * qtd);
  const impactos = new Map();

  for (let i = 0; i < qtd; i += 1) {
    const centavos = base + (i === qtd - 1 ? resto : 0);
    const chave = somarMesesChaveCompra(mesInicio, i);
    impactos.set(chave, (impactos.get(chave) || 0) + (centavos / 100));
  }
  return impactos;
}

function adicionarImpactosCompra(destino, origem) {
  for (const [mes, valor] of origem.entries()) destino.set(mes, (destino.get(mes) || 0) + Number(valor || 0));
}

async function simularCompraProgramada(usuarioId, compraId, parametros = {}, compraVirtual = null) {
    let compra = compraVirtual;
    if (!compra) {
      const compraResult = await pool.query(
        'SELECT * FROM compras_programadas WHERE id = $1 AND usuario_id = $2',
        [compraId, usuarioId]
      );
      if (compraResult.rows.length === 0) throw new Error('Compra programada não encontrada.');
      compra = compraResult.rows[0];
    }
    const dataDesejada = normalizarDataImportacao(parametros?.dataDesejada ?? parametros?.data_desejada ?? compra.data_desejada);
    const formaPagamento = String(parametros?.formaPagamento ?? parametros?.forma_pagamento ?? compra.forma_pagamento ?? 'A_VISTA').toUpperCase();
    const parcelas = formaPagamento === 'PARCELADO' ? Number(parametros?.parcelas ?? compra.parcelas ?? 2) : 1;

    if (!dataDesejada) throw new Error('Data simulada inválida.');
    if (!FORMAS_PAGAMENTO_COMPRA.includes(formaPagamento)) throw new Error('Forma de pagamento inválida.');
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 60) throw new Error('Quantidade de parcelas inválida.');
    if (formaPagamento === 'PARCELADO' && parcelas < 2) throw new Error('Compra parcelada deve ter pelo menos 2 parcelas.');

    const hoje = new Date().toISOString().slice(0, 10);
    const mesAtual = chaveMesCompra(hoje);
    const mesDesejadoOriginal = chaveMesCompra(dataDesejada);
    const mesCompra = diferencaMesesCompra(mesAtual, mesDesejadoOriginal) < 0 ? mesAtual : mesDesejadoOriginal;
    const mesesAteCompra = Math.max(0, diferencaMesesCompra(mesAtual, mesCompra));
    const horizonteSolicitado = Number(parametros?.horizonteMeses || 0);
    const horizonteAuto = Math.max(6, mesesAteCompra + parcelas + 2);
    const horizonteMeses = Math.min(36, Math.max(3, Number.isInteger(horizonteSolicitado) && horizonteSolicitado > 0 ? horizonteSolicitado : horizonteAuto));
    const mesDepoisDoHorizonte = somarMesesChaveCompra(mesAtual, horizonteMeses);
    const dataLimiteExclusiva = `${mesDepoisDoHorizonte}-01`;

    const saldoResult = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(saldo_atual, saldo_inicial, 0)), 0)::numeric AS saldo
       FROM contas
       WHERE usuario_id = $1 AND ativo = true`,
      [usuarioId]
    );
    const saldoInicial = Number(saldoResult.rows[0]?.saldo || 0);

    const provisoesResult = await pool.query(
      `SELECT id, tipo, valor_previsto, data_prevista, status
       FROM provisoes
       WHERE usuario_id = $1
         AND status IN ('PENDENTE', 'ATRASADA')
         AND data_prevista < $2::date
       ORDER BY data_prevista ASC`,
      [usuarioId, dataLimiteExclusiva]
    );

    const outrasComprasResult = compra.id
      ? await pool.query(
        `SELECT id, valor_estimado, data_desejada, forma_pagamento, parcelas
         FROM compras_programadas
         WHERE usuario_id = $1
           AND status = 'PLANEJADA'
           AND id <> $2`,
        [usuarioId, compra.id]
      )
      : await pool.query(
        `SELECT id, valor_estimado, data_desejada, forma_pagamento, parcelas
         FROM compras_programadas
         WHERE usuario_id = $1
           AND status = 'PLANEJADA'`,
        [usuarioId]
      );

    const entradasPorMes = new Map();
    const saidasPorMes = new Map();
    const outrasComprasPorMes = new Map();

    for (const provisao of provisoesResult.rows) {
      let mes = chaveMesCompra(provisao.data_prevista);
      if (!mes) continue;
      if (diferencaMesesCompra(mesAtual, mes) < 0) mes = mesAtual;
      const valor = Number(provisao.valor_previsto || 0);
      if (provisao.tipo === 'CREDITO') entradasPorMes.set(mes, (entradasPorMes.get(mes) || 0) + valor);
      else if (provisao.tipo === 'DEBITO') saidasPorMes.set(mes, (saidasPorMes.get(mes) || 0) + valor);
    }

    for (const outra of outrasComprasResult.rows) {
      let inicio = chaveMesCompra(outra.data_desejada);
      if (!inicio) continue;
      if (diferencaMesesCompra(mesAtual, inicio) < 0) inicio = mesAtual;
      adicionarImpactosCompra(outrasComprasPorMes, distribuirCompraEmMeses({
        valor: outra.valor_estimado,
        formaPagamento: outra.forma_pagamento,
        parcelas: outra.parcelas,
        mesInicio: inicio,
      }));
    }

    const impactoCompra = distribuirCompraEmMeses({
      valor: compra.valor_estimado,
      formaPagamento,
      parcelas,
      mesInicio: mesCompra,
    });

    let saldoSemCompra = saldoInicial;
    let saldoComCompra = saldoInicial;
    const meses = [];

    for (let i = 0; i < horizonteMeses; i += 1) {
      const mes = somarMesesChaveCompra(mesAtual, i);
      const entradasPrevistas = Number(entradasPorMes.get(mes) || 0);
      const saidasPrevistas = Number(saidasPorMes.get(mes) || 0);
      const outrasCompras = Number(outrasComprasPorMes.get(mes) || 0);
      const impacto = Number(impactoCompra.get(mes) || 0);

      saldoSemCompra += entradasPrevistas - saidasPrevistas - outrasCompras;
      saldoComCompra += entradasPrevistas - saidasPrevistas - outrasCompras - impacto;

      meses.push({
        mes,
        entradasPrevistas: Number(entradasPrevistas.toFixed(2)),
        saidasPrevistas: Number(saidasPrevistas.toFixed(2)),
        outrasCompras: Number(outrasCompras.toFixed(2)),
        impactoCompra: Number(impacto.toFixed(2)),
        saldoSemCompra: Number(saldoSemCompra.toFixed(2)),
        saldoComCompra: Number(saldoComCompra.toFixed(2)),
      });
    }

    const menorSaldoSemCompra = Math.min(saldoInicial, ...meses.map((item) => item.saldoSemCompra));
    const menorSaldoComCompra = Math.min(saldoInicial, ...meses.map((item) => item.saldoComCompra));
    const mesesNegativos = meses.filter((item) => item.saldoComCompra < 0).map((item) => item.mes);
    const primeiroMesNegativo = mesesNegativos[0] || null;
    const valorParcela = formaPagamento === 'PARCELADO' ? Number((Number(compra.valor_estimado) / parcelas).toFixed(2)) : Number(compra.valor_estimado);

    return {
      compra: { id: compra.id, descricao: compra.descricao, valorEstimado: Number(compra.valor_estimado), dataOriginal: String(compra.data_desejada).slice(0, 10) },
      parametros: { dataDesejada, formaPagamento, parcelas, horizonteMeses, valorParcela },
      base: {
        saldoInicial: Number(saldoInicial.toFixed(2)),
        provisoesConsideradas: provisoesResult.rows.length,
        outrasComprasConsideradas: outrasComprasResult.rows.length,
        incluiOrcamentoMensal: false,
      },
      resumo: {
        menorSaldoSemCompra: Number(menorSaldoSemCompra.toFixed(2)),
        menorSaldoComCompra: Number(menorSaldoComCompra.toFixed(2)),
        diferencaMenorSaldo: Number((menorSaldoComCompra - menorSaldoSemCompra).toFixed(2)),
        mesesNegativos,
        primeiroMesNegativo,
        caixaFicaNegativo: mesesNegativos.length > 0,
      },
      meses,
      observacoes: [
        'A projeção parte da soma dos saldos atuais das contas ativas.',
        'Entradas e saídas futuras usam contas previstas pendentes ou atrasadas.',
        'Outras compras programadas com status PLANEJADA entram no cenário base.',
        'Orçamento mensal ainda não entra no cálculo para evitar dupla contagem com contas previstas.',
      ],
    };
}

app.post('/api/compras-programadas/:id/simular', verificarToken, async (req, res) => {
  try {
    const resultado = await simularCompraProgramada(req.usuario.usuario_id, req.params.id, req.body || {});
    res.json(resultado);
  } catch (error) {
    const status = error.message === 'Compra programada não encontrada.' ? 404 : 400;
    res.status(status).json({ erro: error.message });
  }
});


// ============================================================================
// ASSISTENTE FINANCEIRO — SOMENTE LEITURA
// ============================================================================

const ASSISTENTE_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const ASSISTENTE_GEMINI_MODEL_FALLBACK = 'gemini-3.1-flash-lite';
const ASSISTENTE_MAX_HISTORICO = 10;
const ASSISTENTE_MAX_MENSAGEM = 2000;

function inteiroAssistente(valor, minimo, maximo, padrao) {
  const numero = Number(valor);
  if (!Number.isInteger(numero)) return padrao;
  return Math.min(maximo, Math.max(minimo, numero));
}

function periodoPassadoAssistente(meses) {
  const qtd = inteiroAssistente(meses, 1, 24, 6);
  const hoje = new Date();
  const inicio = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - (qtd - 1), 1));
  const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 1));
  return { meses: qtd, inicio: inicio.toISOString().slice(0, 10), fim: fim.toISOString().slice(0, 10) };
}

function periodoFuturoAssistente(meses) {
  const qtd = inteiroAssistente(meses, 1, 24, 6);
  const hoje = new Date();
  const inicio = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
  const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + qtd, 1));
  return { meses: qtd, inicio: inicio.toISOString().slice(0, 10), fim: fim.toISOString().slice(0, 10) };
}

async function ferramentaGastosPorCategoria(usuarioId, args = {}) {
  const periodo = periodoPassadoAssistente(args.meses);
  const nivel = args.nivel === 'detalhada' ? 'detalhada' : 'macro';
  const limite = inteiroAssistente(args.limite, 1, 20, 10);
  const expressaoCategoria = nivel === 'detalhada'
    ? "COALESCE(cd.nome, CASE WHEN legado.categoria_pai_id IS NOT NULL THEN legado.nome END, 'Sem detalhamento')"
    : "COALESCE(cm.nome, CASE WHEN legado.categoria_pai_id IS NULL THEN legado.nome ELSE pai_legado.nome END, 'Não categorizado')";

  const result = await pool.query(
    `SELECT ${expressaoCategoria} AS categoria,
            COUNT(*)::int AS quantidade,
            ROUND(SUM(ABS(t.valor))::numeric, 2) AS valor,
            ROUND(SUM(SUM(ABS(t.valor))) OVER ()::numeric, 2) AS total_geral
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
     LEFT JOIN categorias legado ON legado.id = t.categoria_id
     LEFT JOIN categorias pai_legado ON pai_legado.id = legado.categoria_pai_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND t.tipo = 'DEBITO'
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND t.data >= $2::date
       AND t.data < $3::date
     GROUP BY 1
     ORDER BY valor DESC
     LIMIT $4`,
    [usuarioId, periodo.inicio, periodo.fim, limite]
  );
  const totalGastoPeriodo = Number(result.rows[0]?.total_geral || 0);
  return {
    periodo,
    nivel,
    totalGastoPeriodo: Number(totalGastoPeriodo.toFixed(2)),
    categorias: result.rows.map((item) => ({
      categoria: item.categoria,
      quantidade: Number(item.quantidade || 0),
      valor: Number(item.valor || 0),
      percentualDoGastoPeriodo: totalGastoPeriodo ? Number(((Number(item.valor || 0) / totalGastoPeriodo) * 100).toFixed(1)) : 0,
    })),
  };
}

async function ferramentaNaoCategorizados(usuarioId, args = {}) {
  const periodo = periodoPassadoAssistente(args.meses);
  const limite = inteiroAssistente(args.limite, 1, 50, 20);
  const resumo = await pool.query(
    `SELECT COUNT(*)::int AS quantidade,
            COUNT(*) FILTER (WHERE t.tipo = 'DEBITO')::int AS quantidade_debitos,
            COUNT(*) FILTER (WHERE t.tipo = 'CREDITO')::int AS quantidade_creditos,
            ROUND(COALESCE(SUM(ABS(t.valor)) FILTER (WHERE t.tipo = 'DEBITO'), 0)::numeric, 2) AS valor_debitos,
            ROUND(COALESCE(SUM(ABS(t.valor)) FILTER (WHERE t.tipo = 'CREDITO'), 0)::numeric, 2) AS valor_creditos
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND t.data >= $2::date
       AND t.data < $3::date
       AND t.categoria_id IS NULL
       AND t.categoria_macro_id IS NULL
       AND t.categoria_detalhada_id IS NULL`,
    [usuarioId, periodo.inicio, periodo.fim]
  );
  const itens = await pool.query(
    `SELECT t.data, t.descricao, t.tipo, t.valor, c.nome AS conta_nome
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND t.data >= $2::date
       AND t.data < $3::date
       AND t.categoria_id IS NULL
       AND t.categoria_macro_id IS NULL
       AND t.categoria_detalhada_id IS NULL
     ORDER BY t.data DESC, t.criado_em DESC
     LIMIT $4`,
    [usuarioId, periodo.inicio, periodo.fim, limite]
  );
  return {
    periodo,
    quantidade: Number(resumo.rows[0]?.quantidade || 0),
    debitos: {
      quantidade: Number(resumo.rows[0]?.quantidade_debitos || 0),
      valor: Number(resumo.rows[0]?.valor_debitos || 0),
    },
    creditos: {
      quantidade: Number(resumo.rows[0]?.quantidade_creditos || 0),
      valor: Number(resumo.rows[0]?.valor_creditos || 0),
    },
    exemplos: itens.rows.map((item) => ({
      data: String(item.data).slice(0, 10),
      descricao: item.descricao,
      tipo: item.tipo,
      valor: Number(item.valor || 0),
      conta: item.conta_nome,
    })),
  };
}

async function ferramentaComprasProgramadas(usuarioId, args = {}) {
  const periodo = periodoFuturoAssistente(args.meses);
  const mesAtual = chaveMesCompra(periodo.inicio);
  const chaves = Array.from({ length: periodo.meses }, (_, indice) => somarMesesChaveCompra(mesAtual, indice));
  const impactos = new Map(chaves.map((chave) => [chave, 0]));

  const result = await pool.query(
    `SELECT descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas
     FROM compras_programadas
     WHERE usuario_id = $1
       AND status = 'PLANEJADA'
       AND data_desejada < $2::date
     ORDER BY data_desejada ASC, prioridade DESC`,
    [usuarioId, periodo.fim]
  );

  for (const compra of result.rows) {
    let inicio = chaveMesCompra(compra.data_desejada);
    if (!inicio) continue;
    if (diferencaMesesCompra(mesAtual, inicio) < 0) inicio = mesAtual;
    const distribuicao = distribuirCompraEmMeses({
      valor: compra.valor_estimado,
      formaPagamento: compra.forma_pagamento,
      parcelas: compra.parcelas,
      mesInicio: inicio,
    });
    for (const [mes, valor] of distribuicao.entries()) {
      if (impactos.has(mes)) impactos.set(mes, impactos.get(mes) + Number(valor || 0));
    }
  }

  return {
    periodo,
    quantidadeCompras: result.rows.length,
    valorTotalDasCompras: Number(result.rows.reduce((soma, item) => soma + Number(item.valor_estimado || 0), 0).toFixed(2)),
    impactoPorMes: chaves.map((mes) => ({ mes, valor: Number((impactos.get(mes) || 0).toFixed(2)) })),
    compras: result.rows.slice(0, 30).map((item) => ({
      descricao: item.descricao,
      valorEstimado: Number(item.valor_estimado || 0),
      dataDesejada: String(item.data_desejada).slice(0, 10),
      prioridade: item.prioridade,
      pagamento: item.forma_pagamento,
      parcelas: Number(item.parcelas || 1),
    })),
  };
}

async function ferramentaContasPrevistas(usuarioId, args = {}) {
  const periodo = periodoFuturoAssistente(args.meses);
  const mesAtual = chaveMesCompra(periodo.inicio);
  const chaves = Array.from({ length: periodo.meses }, (_, indice) => somarMesesChaveCompra(mesAtual, indice));
  const mapa = new Map(chaves.map((chave) => [chave, { creditos: 0, debitos: 0, quantidade: 0 }]));

  const result = await pool.query(
    `SELECT id, descricao, valor_previsto, tipo, data_prevista, status
     FROM provisoes
     WHERE usuario_id = $1
       AND status IN ('PENDENTE', 'ATRASADA')
       AND data_prevista < $2::date
     ORDER BY data_prevista ASC`,
    [usuarioId, periodo.fim]
  );

  for (const item of result.rows) {
    let mes = chaveMesCompra(item.data_prevista);
    if (!mes) continue;
    if (diferencaMesesCompra(mesAtual, mes) < 0) mes = mesAtual;
    if (!mapa.has(mes)) continue;
    const atual = mapa.get(mes);
    const valor = Number(item.valor_previsto || 0);
    if (item.tipo === 'CREDITO') atual.creditos += valor;
    if (item.tipo === 'DEBITO') atual.debitos += valor;
    atual.quantidade += 1;
  }

  return {
    periodo,
    quantidadeContas: result.rows.length,
    porMes: chaves.map((mes) => {
      const item = mapa.get(mes);
      return {
        mes,
        creditos: Number(item.creditos.toFixed(2)),
        debitos: Number(item.debitos.toFixed(2)),
        saldoLiquido: Number((item.creditos - item.debitos).toFixed(2)),
        quantidade: item.quantidade,
      };
    }),
    exemplos: result.rows.slice(0, 30).map((item) => ({
      descricao: item.descricao,
      valor: Number(item.valor_previsto || 0),
      tipo: item.tipo,
      data: String(item.data_prevista).slice(0, 10),
      status: item.status,
    })),
  };
}

async function ferramentaSaldos(usuarioId) {
  const result = await pool.query(
    `SELECT nome, banco, tipo, COALESCE(saldo_atual, saldo_inicial, 0)::numeric AS saldo
     FROM contas
     WHERE usuario_id = $1 AND ativo = true
     ORDER BY nome ASC`,
    [usuarioId]
  );
  const contas = result.rows.map((item) => ({
    nome: item.nome,
    banco: item.banco,
    tipo: item.tipo,
    saldo: Number(item.saldo || 0),
  }));
  return {
    saldoTotal: Number(contas.reduce((soma, item) => soma + item.saldo, 0).toFixed(2)),
    quantidadeContas: contas.length,
    contas,
  };
}

async function ferramentaCompararCompraProgramada(usuarioId, args = {}) {
  const termo = String(args.termo || '').trim();
  const reservaMinima = Math.max(0, Number(args.reservaMinima || 0));
  if (!termo) return { encontrada: false, motivo: 'Informe uma descrição ou parte do nome da compra programada.' };

  const comprasResult = await pool.query(
    `SELECT id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas, status
     FROM compras_programadas
     WHERE usuario_id = $1
       AND status IN ('PLANEJADA', 'ADIADA')
       AND LOWER(descricao) LIKE LOWER($2)
     ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, data_desejada ASC
     LIMIT 5`,
    [usuarioId, `%${termo}%`, termo]
  );

  if (comprasResult.rows.length === 0) {
    return { encontrada: false, motivo: `Nenhuma compra programada ativa corresponde a "${termo}".` };
  }

  if (comprasResult.rows.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma compra correspondente. Peça ao usuário para indicar qual delas deseja analisar.',
      opcoes: comprasResult.rows.map((item) => ({
        descricao: item.descricao,
        valorEstimado: Number(item.valor_estimado || 0),
        dataDesejada: String(item.data_desejada).slice(0, 10),
        status: item.status,
      })),
    };
  }

  const compra = comprasResult.rows[0];
  const hoje = new Date().toISOString().slice(0, 10);
  const dataOriginal = String(compra.data_desejada || '').slice(0, 10);
  const dataBase = dataOriginal && dataOriginal > hoje ? dataOriginal : hoje;
  const adicionarMeses = (dataIso, quantidade) => {
    const [ano, mes, dia] = dataIso.split('-').map(Number);
    const indice = (ano * 12) + (mes - 1) + quantidade;
    const novoAno = Math.floor(indice / 12);
    const novoMes = indice % 12;
    const ultimoDia = new Date(Date.UTC(novoAno, novoMes + 1, 0)).getUTCDate();
    return `${novoAno}-${String(novoMes + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
  };

  const parcelasAtuais = Number(compra.parcelas || 1);
  const opcoesParcelas = Array.from(new Set([1, 3, 6, 10, 12, parcelasAtuais]))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 12)
    .sort((a, b) => a - b);
  const parametrosCenarios = [];
  for (let adiamentoMeses = 0; adiamentoMeses <= 2; adiamentoMeses += 1) {
    const dataDesejada = adicionarMeses(dataBase, adiamentoMeses);
    for (const parcelas of opcoesParcelas) {
      parametrosCenarios.push({ dataDesejada, adiamentoMeses, parcelas });
    }
  }

  const cenarios = [];
  for (let indice = 0; indice < parametrosCenarios.length; indice += 3) {
    const lote = parametrosCenarios.slice(indice, indice + 3);
    const resultados = await Promise.all(lote.map(async (cenario) => {
      const simulacao = await simularCompraProgramada(usuarioId, compra.id, {
        dataDesejada: cenario.dataDesejada,
        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',
        parcelas: cenario.parcelas,
        horizonteMeses: 18,
      });
      return {
        ...cenario,
        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',
        valorParcela: Number(simulacao.parametros.valorParcela || 0),
        menorSaldoComCompra: Number(simulacao.resumo.menorSaldoComCompra || 0),
        menorSaldoSemCompra: Number(simulacao.resumo.menorSaldoSemCompra || 0),
        mesesNegativos: simulacao.resumo.mesesNegativos || [],
        atendeReserva: Number(simulacao.resumo.menorSaldoComCompra || 0) >= reservaMinima,
      };
    }));
    cenarios.push(...resultados);
  }

  cenarios.sort((a, b) => {
    if (a.atendeReserva !== b.atendeReserva) return a.atendeReserva ? -1 : 1;
    if (a.atendeReserva && b.atendeReserva) {
      if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
      if (a.parcelas !== b.parcelas) return a.parcelas - b.parcelas;
      return b.menorSaldoComCompra - a.menorSaldoComCompra;
    }
    if (a.menorSaldoComCompra !== b.menorSaldoComCompra) return b.menorSaldoComCompra - a.menorSaldoComCompra;
    if (a.mesesNegativos.length !== b.mesesNegativos.length) return a.mesesNegativos.length - b.mesesNegativos.length;
    if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
    return a.parcelas - b.parcelas;
  });

  const melhor = cenarios[0] || null;
  return {
    encontrada: true,
    compra: {
      descricao: compra.descricao,
      valorEstimado: Number(compra.valor_estimado || 0),
      dataDesejadaOriginal: dataOriginal,
      prioridade: compra.prioridade,
      status: compra.status,
    },
    reservaMinima,
    criterio: melhor?.atendeReserva
      ? 'Prioriza a data mais próxima que preserva a reserva e, depois, o menor número de parcelas.'
      : 'Nenhum cenário preserva a reserva; prioriza o maior saldo mínimo projetado e menor exposição a meses negativos.',
    melhorCenario: melhor,
    melhoresAlternativas: cenarios.slice(0, 5),
    premissas: [
      'Horizonte de projeção de 18 meses.',
      'Compara a data desejada e os dois meses seguintes.',
      'Compara à vista e parcelamentos de até 12x sem estimar juros, taxas ou descontos.',
      'Usa o mesmo motor financeiro da tela de Compras Programadas.',
    ],
  };
}

async function ferramentaPlanejarCompraHipotetica(usuarioId, args = {}) {
  const descricao = String(args.descricao || '').trim();
  const valorEstimado = Number(args.valorEstimado);
  const dataLimite = normalizarDataImportacao(args.dataLimite);
  const reservaMinima = Math.max(0, Number(args.reservaMinima || 0));
  const prioridade = String(args.prioridade || 'MEDIA').toUpperCase();
  const maxParcelasBruto = Number(args.maxParcelas || 12);
  const maxParcelas = Number.isInteger(maxParcelasBruto) ? Math.min(12, Math.max(1, maxParcelasBruto)) : 12;

  if (!descricao) return { planejada: false, motivo: 'Informe o que deseja comprar.' };
  if (!Number.isFinite(valorEstimado) || valorEstimado <= 0) return { planejada: false, motivo: 'Informe um valor estimado positivo.' };
  if (!dataLimite) return { planejada: false, motivo: 'Informe uma data limite válida para a compra.' };
  if (!PRIORIDADES_COMPRA.includes(prioridade)) return { planejada: false, motivo: 'Prioridade inválida.' };

  const hoje = new Date().toISOString().slice(0, 10);
  if (dataLimite < hoje) return { planejada: false, motivo: 'A data limite da compra não pode estar no passado.' };

  const mesAtual = chaveMesCompra(hoje);
  const mesLimite = chaveMesCompra(dataLimite);
  const mesesAteLimite = diferencaMesesCompra(mesAtual, mesLimite);
  if (!Number.isInteger(mesesAteLimite) || mesesAteLimite < 0) return { planejada: false, motivo: 'Data limite inválida.' };
  if (mesesAteLimite > 12) return { planejada: false, motivo: 'Para manter a projeção objetiva, informe um prazo de até 12 meses.' };

  const diaAlvo = Math.max(1, Math.min(31, Number(String(dataLimite).slice(8, 10)) || 1));
  const dataNoMes = (chave) => {
    const [ano, mes] = String(chave).split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const data = `${chave}-${String(Math.min(diaAlvo, ultimoDia)).padStart(2, '0')}`;
    return data < hoje ? hoje : data;
  };

  const datasCandidatas = [];
  for (let indice = 0; indice <= mesesAteLimite; indice += 1) {
    const data = dataNoMes(somarMesesChaveCompra(mesAtual, indice));
    if (data <= dataLimite && !datasCandidatas.includes(data)) datasCandidatas.push(data);
  }
  if (!datasCandidatas.includes(dataLimite)) datasCandidatas.push(dataLimite);

  const opcoesParcelas = Array.from(new Set([1, 3, 6, 10, 12, maxParcelas]))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= maxParcelas)
    .sort((a, b) => a - b);

  const compraVirtual = {
    id: null,
    descricao,
    valor_estimado: valorEstimado,
    data_desejada: dataLimite,
    prioridade,
    forma_pagamento: 'A_VISTA',
    parcelas: 1,
    status: 'PLANEJADA',
  };

  const parametrosCenarios = datasCandidatas.flatMap((dataDesejada, indiceData) => opcoesParcelas.map((parcelas) => ({
    dataDesejada,
    adiamentoMeses: indiceData,
    parcelas,
  })));

  const cenarios = [];
  for (let indice = 0; indice < parametrosCenarios.length; indice += 3) {
    const lote = parametrosCenarios.slice(indice, indice + 3);
    const resultados = await Promise.all(lote.map(async (cenario) => {
      const simulacao = await simularCompraProgramada(usuarioId, null, {
        dataDesejada: cenario.dataDesejada,
        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',
        parcelas: cenario.parcelas,
        horizonteMeses: 18,
      }, compraVirtual);
      return {
        ...cenario,
        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',
        valorParcela: Number(simulacao.parametros.valorParcela || 0),
        menorSaldoComCompra: Number(simulacao.resumo.menorSaldoComCompra || 0),
        menorSaldoSemCompra: Number(simulacao.resumo.menorSaldoSemCompra || 0),
        mesesNegativos: simulacao.resumo.mesesNegativos || [],
        atendeReserva: Number(simulacao.resumo.menorSaldoComCompra || 0) >= reservaMinima,
      };
    }));
    cenarios.push(...resultados);
  }

  cenarios.sort((a, b) => {
    if (a.atendeReserva !== b.atendeReserva) return a.atendeReserva ? -1 : 1;
    if (a.atendeReserva && b.atendeReserva) {
      if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
      if (a.parcelas !== b.parcelas) return a.parcelas - b.parcelas;
      return b.menorSaldoComCompra - a.menorSaldoComCompra;
    }
    if (a.menorSaldoComCompra !== b.menorSaldoComCompra) return b.menorSaldoComCompra - a.menorSaldoComCompra;
    if (a.mesesNegativos.length !== b.mesesNegativos.length) return a.mesesNegativos.length - b.mesesNegativos.length;
    if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
    return a.parcelas - b.parcelas;
  });

  const melhor = cenarios[0] || null;
  const criterio = melhor?.atendeReserva
    ? 'Prioriza a data mais próxima que preserva a reserva e, depois, o menor número de parcelas.'
    : 'Nenhum cenário preserva a reserva; prioriza o maior saldo mínimo projetado e menor exposição a meses negativos.';
  const propostaCadastro = melhor ? {
    descricao,
    valorEstimado: Number(valorEstimado.toFixed(2)),
    dataDesejada: melhor.dataDesejada,
    prioridade,
    formaPagamento: melhor.formaPagamento,
    parcelas: melhor.parcelas,
    contaId: null,
    categoriaMacroId: null,
    categoriaDetalhadaId: null,
    observacao: `Planejada com o Assistente Financeiro. Reserva mínima considerada: R$ ${reservaMinima.toFixed(2)}.`,
  } : null;

  return {
    planejada: Boolean(melhor),
    compra: { descricao, valorEstimado: Number(valorEstimado.toFixed(2)), dataLimite, prioridade, maxParcelas },
    reservaMinima,
    criterio,
    melhorCenario: melhor,
    melhoresAlternativas: cenarios.slice(0, 5),
    propostaCadastro,
    premissas: [
      'A compra ainda não foi cadastrada; estes cenários são apenas uma simulação.',
      'O horizonte financeiro de cada cenário é de 18 meses.',
      'São comparados meses até a data limite informada e parcelamentos de até 12x.',
      'Não são estimados juros, taxas ou descontos.',
      'A gravação da compra exige confirmação explícita do usuário na interface.',
    ],
  };
}

async function ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args = {}) {
  const termo = String(args.termo || '').trim();
  const acao = String(args.acao || '').trim().toUpperCase();
  const novaDescricao = String(args.novaDescricao || '').trim();
  const novoValorEstimado = Number(args.novoValorEstimado || 0);
  const novaDataInformada = String(args.novaData || '').trim();
  const adiarMeses = Number(args.adiarMeses || 0);
  const novaPrioridade = String(args.novaPrioridade || 'MANTER').trim().toUpperCase();
  const novaFormaPagamento = String(args.novaFormaPagamento || 'MANTER').trim().toUpperCase();
  const novasParcelas = Number(args.novasParcelas || 0);
  const acoesPermitidas = ['ADIAR', 'EDITAR', 'MARCAR_COMPRADA', 'CANCELAR'];

  if (!termo) return { encontrada: false, motivo: 'Informe a descrição ou parte do nome da compra programada.' };
  if (!acoesPermitidas.includes(acao)) return { encontrada: false, motivo: 'Ação de compra programada inválida.' };

  const comprasResult = await pool.query(
    `SELECT id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas, status, observacao
     FROM compras_programadas
     WHERE usuario_id = $1
       AND status IN ('PLANEJADA', 'ADIADA')
       AND LOWER(descricao) LIKE LOWER($2)
     ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, data_desejada ASC
     LIMIT 5`,
    [usuarioId, `%${termo}%`, termo]
  );

  if (comprasResult.rows.length === 0) {
    return { encontrada: false, motivo: `Nenhuma compra programada ativa corresponde a "${termo}".` };
  }

  if (comprasResult.rows.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma compra correspondente. Peça ao usuário para indicar qual delas deseja alterar.',
      opcoes: comprasResult.rows.map((item) => ({
        descricao: item.descricao,
        valorEstimado: Number(item.valor_estimado || 0),
        dataDesejada: String(item.data_desejada || '').slice(0, 10),
        status: item.status,
      })),
    };
  }

  const compra = comprasResult.rows[0];
  const payload = {};
  const detalhes = [];
  const hoje = new Date().toISOString().slice(0, 10);
  const dataAtual = String(compra.data_desejada || '').slice(0, 10);
  const formatarDataAcao = (data) => {
    const [ano, mes, dia] = String(data || '').slice(0, 10).split('-');
    return ano && mes && dia ? `${dia}/${mes}/${ano}` : String(data || '');
  };
  const formatarMoedaAcao = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const rotuloPagamento = (forma, parcelas) => forma === 'PARCELADO' ? `${Number(parcelas || 1)}x` : 'À vista';
  const adicionarMesesData = (dataIso, quantidade) => {
    const [ano, mes, dia] = String(dataIso || '').slice(0, 10).split('-').map(Number);
    if (![ano, mes, dia].every(Number.isFinite)) return null;
    const indice = (ano * 12) + (mes - 1) + quantidade;
    const novoAno = Math.floor(indice / 12);
    const novoMes = indice % 12;
    const ultimoDia = new Date(Date.UTC(novoAno, novoMes + 1, 0)).getUTCDate();
    return `${novoAno}-${String(novoMes + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
  };

  if (acao === 'ADIAR') {
    let novaData = novaDataInformada ? normalizarDataImportacao(novaDataInformada) : null;
    if (!novaData && Number.isInteger(adiarMeses) && adiarMeses > 0) novaData = adicionarMesesData(dataAtual || hoje, adiarMeses);
    if (!novaData) return { encontrada: true, preparada: false, motivo: 'Informe a nova data ou por quantos meses deseja adiar.' };
    if (novaData < hoje) return { encontrada: true, preparada: false, motivo: 'A nova data não pode estar no passado.' };
    if (dataAtual && novaData <= dataAtual) return { encontrada: true, preparada: false, motivo: 'Para adiar, a nova data deve ser posterior à data atual da compra.' };
    payload.dataDesejada = novaData;
    payload.status = 'ADIADA';
    detalhes.push(`Data: ${formatarDataAcao(dataAtual)} → ${formatarDataAcao(novaData)}`);
    if (compra.status !== 'ADIADA') detalhes.push(`Status: ${compra.status} → ADIADA`);
  }

  if (acao === 'MARCAR_COMPRADA') {
    payload.status = 'COMPRADA';
    detalhes.push(`Status: ${compra.status} → COMPRADA`);
  }

  if (acao === 'CANCELAR') {
    payload.status = 'CANCELADA';
    detalhes.push(`Status: ${compra.status} → CANCELADA`);
  }

  if (acao === 'EDITAR') {
    if (novaDescricao && novaDescricao !== compra.descricao) {
      payload.descricao = novaDescricao;
      detalhes.push(`Descrição: ${compra.descricao} → ${novaDescricao}`);
    }
    if (Number.isFinite(novoValorEstimado) && novoValorEstimado > 0 && novoValorEstimado !== Number(compra.valor_estimado || 0)) {
      payload.valorEstimado = novoValorEstimado;
      detalhes.push(`Valor: ${formatarMoedaAcao(compra.valor_estimado)} → ${formatarMoedaAcao(novoValorEstimado)}`);
    }
    if (novaDataInformada) {
      const novaData = normalizarDataImportacao(novaDataInformada);
      if (!novaData) return { encontrada: true, preparada: false, motivo: 'A nova data informada é inválida.' };
      if (novaData < hoje) return { encontrada: true, preparada: false, motivo: 'A nova data não pode estar no passado.' };
      if (novaData !== dataAtual) {
        payload.dataDesejada = novaData;
        detalhes.push(`Data: ${formatarDataAcao(dataAtual)} → ${formatarDataAcao(novaData)}`);
      }
    }
    if (novaPrioridade !== 'MANTER') {
      if (!PRIORIDADES_COMPRA.includes(novaPrioridade)) return { encontrada: true, preparada: false, motivo: 'Nova prioridade inválida.' };
      if (novaPrioridade !== compra.prioridade) {
        payload.prioridade = novaPrioridade;
        detalhes.push(`Prioridade: ${compra.prioridade} → ${novaPrioridade}`);
      }
    }
    if (novaFormaPagamento !== 'MANTER') {
      if (!FORMAS_PAGAMENTO_COMPRA.includes(novaFormaPagamento)) return { encontrada: true, preparada: false, motivo: 'Nova forma de pagamento inválida.' };
      if (novaFormaPagamento === 'A_VISTA') {
        if (compra.forma_pagamento !== 'A_VISTA' || Number(compra.parcelas || 1) !== 1) {
          payload.formaPagamento = 'A_VISTA';
          payload.parcelas = 1;
          detalhes.push(`Pagamento: ${rotuloPagamento(compra.forma_pagamento, compra.parcelas)} → À vista`);
        }
      } else {
        const parcelas = Number.isInteger(novasParcelas) && novasParcelas >= 2 ? novasParcelas : (compra.forma_pagamento === 'PARCELADO' ? Number(compra.parcelas || 0) : 0);
        if (!Number.isInteger(parcelas) || parcelas < 2 || parcelas > 60) return { encontrada: true, preparada: false, motivo: 'Informe pelo menos 2 parcelas para pagamento parcelado.' };
        if (compra.forma_pagamento !== 'PARCELADO' || Number(compra.parcelas || 1) !== parcelas) {
          payload.formaPagamento = 'PARCELADO';
          payload.parcelas = parcelas;
          detalhes.push(`Pagamento: ${rotuloPagamento(compra.forma_pagamento, compra.parcelas)} → ${parcelas}x`);
        }
      }
    } else if (Number.isInteger(novasParcelas) && novasParcelas > 0) {
      if (compra.forma_pagamento !== 'PARCELADO') return { encontrada: true, preparada: false, motivo: 'Para alterar parcelas de uma compra à vista, informe também a nova forma de pagamento como PARCELADO.' };
      if (novasParcelas < 2 || novasParcelas > 60) return { encontrada: true, preparada: false, motivo: 'Quantidade de parcelas inválida.' };
      if (novasParcelas !== Number(compra.parcelas || 0)) {
        payload.parcelas = novasParcelas;
        detalhes.push(`Pagamento: ${rotuloPagamento(compra.forma_pagamento, compra.parcelas)} → ${novasParcelas}x`);
      }
    }
    if (detalhes.length === 0) return { encontrada: true, preparada: false, motivo: 'Nenhuma alteração diferente dos dados atuais foi informada.' };
  }

  const rotulosAcao = {
    ADIAR: 'Adiar compra',
    EDITAR: 'Editar compra',
    MARCAR_COMPRADA: 'Marcar como comprada',
    CANCELAR: 'Cancelar compra',
  };

  return {
    encontrada: true,
    preparada: true,
    acao,
    rotuloAcao: rotulosAcao[acao],
    compra: {
      descricao: compra.descricao,
      valorEstimado: Number(compra.valor_estimado || 0),
      dataDesejada: dataAtual,
      prioridade: compra.prioridade,
      formaPagamento: compra.forma_pagamento,
      parcelas: Number(compra.parcelas || 1),
      status: compra.status,
    },
    alteracoes: detalhes,
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'ALTERAR_COMPRA_PROGRAMADA',
      compraId: compra.id,
      acao,
      rotuloAcao: rotulosAcao[acao],
      compraDescricao: compra.descricao,
      payload,
      detalhes,
    },
  };
}

async function ferramentaBuscarTransacoesCompraRealizada(usuarioId, args = {}) {
  const termoCompraExistente = String(args.termoCompraExistente || '').trim();
  const descricaoInformada = String(args.descricao || '').trim();
  const valorInformado = Number(args.valor || 0);
  const dataInformada = String(args.dataCompra || '').trim();
  const dataCompra = dataInformada ? normalizarDataImportacao(dataInformada) : null;
  const metodoPagamento = String(args.metodoPagamento || '').trim();
  const prioridade = String(args.prioridade || 'MEDIA').trim().toUpperCase();
  const formaPagamento = String(args.formaPagamento || 'A_VISTA').trim().toUpperCase();
  const parcelas = formaPagamento === 'PARCELADO' ? Number(args.parcelas || 0) : 1;
  const condicao = String(args.condicao || 'NAO_INFORMADO').trim().toUpperCase();
  const link = String(args.link || '').trim();
  const observacao = String(args.observacao || '').trim();
  const diasBusca = inteiroAssistente(args.diasBusca, 30, 365, 180);

  if (dataInformada && !dataCompra) return { encontrada: false, motivo: 'A data informada é inválida.' };
  if (!PRIORIDADES_COMPRA.includes(prioridade)) return { encontrada: false, motivo: 'Prioridade inválida.' };
  if (!FORMAS_PAGAMENTO_COMPRA.includes(formaPagamento)) return { encontrada: false, motivo: 'Forma de pagamento inválida.' };
  if (formaPagamento === 'PARCELADO' && (!Number.isInteger(parcelas) || parcelas < 2 || parcelas > 60)) {
    return { encontrada: false, motivo: 'Informe a quantidade de parcelas da compra.' };
  }

  let compraExistente = null;
  let comprasResult = null;
  if (termoCompraExistente) {
    comprasResult = await pool.query(
      `SELECT * FROM compras_programadas
       WHERE usuario_id = $1
         AND status IN ('PLANEJADA', 'ADIADA', 'COMPRADA')
         AND LOWER(descricao) LIKE LOWER($2)
       ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, criado_em DESC
       LIMIT 5`,
      [usuarioId, `%${termoCompraExistente}%`, termoCompraExistente]
    );
    if (comprasResult.rows.length === 0) {
      return { encontrada: false, motivo: `Nenhuma Compra Programada corresponde a "${termoCompraExistente}".` };
    }
  } else if (descricaoInformada) {
    const valoresCompra = [usuarioId, descricaoInformada];
    let filtroValor = '';
    if (Number.isFinite(valorInformado) && valorInformado > 0) {
      valoresCompra.push(valorInformado);
      const indiceValor = valoresCompra.length;
      filtroValor = `AND ABS(valor_estimado - $${indiceValor}::numeric) <= GREATEST(5, ABS($${indiceValor}::numeric) * 0.15)`;
    }
    comprasResult = await pool.query(
      `SELECT * FROM compras_programadas
       WHERE usuario_id = $1
         AND status IN ('PLANEJADA', 'ADIADA', 'COMPRADA')
         AND LOWER(descricao) = LOWER($2)
         ${filtroValor}
       ORDER BY criado_em DESC
       LIMIT 5`,
      valoresCompra
    );
  }

  if (comprasResult?.rows?.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma Compra Programada correspondente. Peça ao usuário para indicar qual delas foi comprada.',
      opcoes: comprasResult.rows.map((item) => ({
        descricao: item.descricao,
        valor: Number(item.valor_estimado || 0),
        dataDesejada: String(item.data_desejada || '').slice(0, 10),
        status: item.status,
      })),
    };
  }
  if (comprasResult?.rows?.length === 1) compraExistente = comprasResult.rows[0];

  if (compraExistente) {
    const jaVinculada = await pool.query(
      `SELECT id FROM conciliacoes_compras WHERE compra_id = $1 AND status = 'CONFIRMADA' LIMIT 1`,
      [compraExistente.id]
    );
    if (jaVinculada.rows.length > 0) return { encontrada: false, motivo: 'Essa compra já possui um lançamento associado.' };
  }

  const descricao = compraExistente?.descricao || descricaoInformada;
  const valor = compraExistente ? Number(compraExistente.valor_estimado || 0) : valorInformado;
  if (!descricao) return { encontrada: false, motivo: 'Informe o que foi comprado.' };
  if (!Number.isFinite(valor) || valor <= 0) return { encontrada: false, motivo: 'Informe quanto foi pago para procurar o lançamento.' };

  const compraBusca = compraExistente || { descricao, valor_estimado: valor };
  const candidatas = await buscarCandidatasTransacaoCompra(usuarioId, compraBusca, {
    compraExistente: Boolean(compraExistente),
    dataReferencia: dataCompra || null,
    metodoPagamento,
    diasBusca,
  });

  if (candidatas.length === 0) {
    return {
      encontrada: false,
      motivo: dataCompra
        ? 'Não encontrei lançamento de débito compatível com o valor e a data informados. Confira se a transação já foi importada.'
        : `Não encontrei lançamento de débito compatível nos últimos ${diasBusca} dias. Não vou assumir que a compra foi hoje. Informe uma data aproximada ou importe o extrato correspondente.`,
      compra: { descricao, valor, dataCompra: dataCompra || null },
    };
  }

  const observacoes = [];
  if (observacao) observacoes.push(observacao);
  if (condicao === 'NOVO') observacoes.push('Condição: novo.');
  if (condicao === 'USADO') observacoes.push('Condição: usado.');
  if (metodoPagamento) observacoes.push(`Método de pagamento: ${metodoPagamento}.`);
  if (link) observacoes.push(`Referência: ${link}`);

  const compraNova = compraExistente ? null : {
    descricao,
    valorEstimado: Number(valor.toFixed(2)),
    prioridade,
    formaPagamento,
    parcelas: formaPagamento === 'PARCELADO' ? parcelas : 1,
    contaId: null,
    categoriaMacroId: null,
    categoriaDetalhadaId: null,
    observacao: observacoes.join(' ').trim() || null,
  };

  const candidatos = candidatas.map(({ transacao, analise }) => ({
    transacaoId: transacao.id,
    descricao: transacao.descricao,
    valor: Number(transacao.valor || 0),
    data: analise.dataTransacao,
    conta: transacao.conta_nome,
    categoria: transacao.categoria_detalhada_nome || transacao.categoria_macro_nome || null,
    confianca: analise.confianca,
    score: analise.score,
    motivos: analise.motivos,
    diferenca: analise.diferenca,
  }));

  return {
    encontrada: true,
    preparada: true,
    quantidadeCandidatos: candidatos.length,
    compra: {
      descricao,
      valor: Number(valor.toFixed(2)),
      existente: Boolean(compraExistente),
      dataInformada: dataCompra,
    },
    candidatos: candidatos.map(({ transacaoId, ...visivel }) => visivel),
    observacao: candidatos.length === 1
      ? 'Confira o lançamento encontrado antes de associar.'
      : 'Há mais de um lançamento plausível. Escolha o correto no card de confirmação.',
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'CONCILIAR_COMPRA_TRANSACAO',
      rotuloAcao: compraExistente ? 'Associar compra ao lançamento' : 'Registrar compra pelo lançamento',
      compraId: compraExistente?.id || null,
      compraNova,
      compra: {
        descricao,
        valor: Number(valor.toFixed(2)),
        existente: Boolean(compraExistente),
      },
      candidatos,
    },
  };
}

async function ferramentaPrepararNovasCompras(usuarioId, args = {}) {
  const itens = Array.isArray(args.itens) ? args.itens : [];
  if (itens.length === 0) return { preparada: false, motivo: 'Informe pelo menos uma compra.' };
  if (itens.length > 30) return { preparada: false, motivo: 'Prepare no máximo 30 compras por vez.' };

  const hoje = new Date().toISOString().slice(0, 10);
  const preparados = [];
  const pendencias = [];
  const statusPermitidos = ['PLANEJADA', 'COMPRADA'];
  const condicoesPermitidas = ['NOVO', 'USADO', 'NAO_INFORMADO'];

  for (let indice = 0; indice < itens.length; indice += 1) {
    const item = itens[indice] || {};
    const descricao = String(item.descricao || '').trim();
    const valorEstimado = Number(item.valorEstimado || 0);
    const status = String(item.status || 'PLANEJADA').trim().toUpperCase();
    const prioridade = String(item.prioridade || 'MEDIA').trim().toUpperCase();
    const dataInformada = String(item.dataDesejada || '').trim();
    const dataDesejada = dataInformada ? normalizarDataImportacao(dataInformada) : null;
    const formaInformada = String(item.formaPagamento || '').trim().toUpperCase();
    const parcelasInformadas = Number(item.parcelas || 0);
    const formaPagamento = formaInformada || (parcelasInformadas >= 2 ? 'PARCELADO' : 'A_VISTA');
    const parcelas = formaPagamento === 'PARCELADO' ? parcelasInformadas : 1;
    const metodoPagamento = String(item.metodoPagamento || '').trim();
    const condicao = String(item.condicao || 'NAO_INFORMADO').trim().toUpperCase();
    const link = String(item.link || '').trim();
    const observacaoOriginal = String(item.observacao || '').trim();

    const faltas = [];
    if (!descricao) faltas.push('descrição');
    if (!Number.isFinite(valorEstimado) || valorEstimado <= 0) faltas.push('valor positivo');
    if (!statusPermitidos.includes(status)) faltas.push('status PLANEJADA ou COMPRADA');
    if (!PRIORIDADES_COMPRA.includes(prioridade)) faltas.push('prioridade válida');
    if (!dataDesejada) {
      faltas.push(status === 'COMPRADA'
        ? 'data da compra ou associação com um lançamento real'
        : 'data desejada');
    }
    if (!FORMAS_PAGAMENTO_COMPRA.includes(formaPagamento)) faltas.push('forma de pagamento válida');
    if (formaPagamento === 'PARCELADO' && (!Number.isInteger(parcelas) || parcelas < 2 || parcelas > 60)) faltas.push('parcelas entre 2 e 60');
    if (!condicoesPermitidas.includes(condicao)) faltas.push('condição NOVO, USADO ou NAO_INFORMADO');
    if (status === 'PLANEJADA' && dataInformada && dataDesejada && dataDesejada < hoje) faltas.push('data futura ou atual para compra planejada');

    if (faltas.length > 0) {
      pendencias.push({ item: indice + 1, descricao: descricao || 'Sem descrição', faltam: faltas });
      continue;
    }

    const existente = await pool.query(
      `SELECT descricao, valor_estimado, data_desejada, status
       FROM compras_programadas
       WHERE usuario_id = $1
         AND status IN ('PLANEJADA', 'ADIADA')
         AND LOWER(descricao) = LOWER($2)
       ORDER BY data_desejada ASC
       LIMIT 1`,
      [usuarioId, descricao]
    );
    if (existente.rows.length > 0) {
      pendencias.push({
        item: indice + 1,
        descricao,
        faltam: ['já existe uma Compra Programada ativa com a mesma descrição; use a alteração da compra existente para evitar duplicidade'],
      });
      continue;
    }

    const observacoes = [];
    if (observacaoOriginal) observacoes.push(observacaoOriginal);
    if (condicao === 'NOVO') observacoes.push('Condição: novo.');
    if (condicao === 'USADO') observacoes.push('Condição: usado.');
    if (metodoPagamento) observacoes.push(`Método de pagamento: ${metodoPagamento}.`);
    if (link) observacoes.push(`Referência: ${link}`);

    const payload = {
      descricao,
      valorEstimado: Number(valorEstimado.toFixed(2)),
      dataDesejada,
      prioridade,
      formaPagamento,
      parcelas: formaPagamento === 'PARCELADO' ? parcelas : 1,
      contaId: null,
      categoriaMacroId: null,
      categoriaDetalhadaId: null,
      status,
      observacao: observacoes.join(' ').trim() || null,
    };

    const detalhes = [
      `Status: ${status === 'COMPRADA' ? 'Comprada' : 'Planejada'}`,
      `Valor: ${Number(valorEstimado).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
      `Data: ${dataDesejada.split('-').reverse().join('/')}`,
      `Pagamento: ${formaPagamento === 'PARCELADO' ? `${parcelas}x` : 'À vista'}${metodoPagamento ? ` · ${metodoPagamento}` : ''}`,
    ];
    if (condicao !== 'NAO_INFORMADO') detalhes.push(`Condição: ${condicao === 'USADO' ? 'Usado' : 'Novo'}`);
    if (link) detalhes.push('Link de referência preservado');

    preparados.push({ payload, detalhes });
  }

  if (pendencias.length > 0) {
    return {
      preparada: false,
      motivo: 'Ainda faltam dados ou há possível duplicidade em uma ou mais compras. Resolva os itens abaixo antes de confirmar o lote.',
      pendencias,
      quantidadePreparada: preparados.length,
    };
  }

  return {
    preparada: true,
    quantidade: preparados.length,
    compras: preparados.map(({ payload }) => ({
      descricao: payload.descricao,
      valorEstimado: payload.valorEstimado,
      dataDesejada: payload.dataDesejada,
      status: payload.status,
      formaPagamento: payload.formaPagamento,
      parcelas: payload.parcelas,
    })),
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'CRIAR_COMPRAS_LOTE',
      rotuloAcao: preparados.length === 1 ? 'Registrar compra' : `Registrar ${preparados.length} compras`,
      quantidade: preparados.length,
      itens: preparados,
    },
  };
}

async function ferramentaPrepararNovaProvisao(usuarioId, args = {}) {
  const descricao = String(args.descricao || '').trim();
  const valorPrevisto = Number(args.valorPrevisto);
  const tipo = String(args.tipo || '').trim().toUpperCase();
  const dataPrevista = normalizarDataImportacao(args.dataPrevista);
  const dataVencimentoInformada = String(args.dataVencimento || '').trim();
  const dataVencimento = dataVencimentoInformada ? normalizarDataImportacao(dataVencimentoInformada) : null;
  const observacao = String(args.observacao || '').trim();

  if (!descricao) return { preparada: false, motivo: 'Informe a descrição da conta prevista.' };
  if (!Number.isFinite(valorPrevisto) || valorPrevisto <= 0) return { preparada: false, motivo: 'Informe um valor previsto positivo.' };
  if (!TIPOS_PROVISAO.includes(tipo)) return { preparada: false, motivo: 'Informe se a conta prevista é um crédito ou débito.' };
  if (!dataPrevista) return { preparada: false, motivo: 'Informe uma data prevista válida.' };
  if (dataVencimentoInformada && !dataVencimento) return { preparada: false, motivo: 'A data de vencimento informada é inválida.' };

  const payload = {
    descricao,
    valorPrevisto: Number(valorPrevisto.toFixed(2)),
    tipo,
    dataPrevista,
    status: 'PENDENTE',
    recorrente: false,
  };
  if (dataVencimento) payload.dataVencimento = dataVencimento;
  if (observacao) payload.observacao = observacao;

  const detalhes = [
    `Tipo: ${tipo === 'CREDITO' ? 'A receber' : 'A pagar'}`,
    `Valor: ${Number(valorPrevisto).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    `Data prevista: ${dataPrevista.split('-').reverse().join('/')}`,
  ];
  if (dataVencimento) detalhes.push(`Vencimento: ${dataVencimento.split('-').reverse().join('/')}`);

  return {
    preparada: true,
    contaPrevista: { descricao, valorPrevisto: Number(valorPrevisto.toFixed(2)), tipo, dataPrevista, dataVencimento },
    detalhes,
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'CRIAR_PROVISAO',
      rotuloAcao: 'Adicionar conta prevista',
      payload,
      detalhes,
    },
  };
}

async function ferramentaPrepararAlteracaoProvisao(usuarioId, args = {}) {
  const termo = String(args.termo || '').trim();
  const acao = String(args.acao || '').trim().toUpperCase();
  const novaDescricao = String(args.novaDescricao || '').trim();
  const novoValorPrevisto = Number(args.novoValorPrevisto || 0);
  const novoTipo = String(args.novoTipo || 'MANTER').trim().toUpperCase();
  const novaDataPrevistaInformada = String(args.novaDataPrevista || '').trim();
  const novaDataVencimentoInformada = String(args.novaDataVencimento || '').trim();
  const adiarMeses = Number(args.adiarMeses || 0);
  const novaObservacao = String(args.novaObservacao || '').trim();
  const acoesPermitidas = ['ADIAR', 'EDITAR', 'CANCELAR', 'MARCAR_REALIZADA'];

  if (!termo) return { encontrada: false, motivo: 'Informe a descrição ou parte do nome da conta prevista.' };
  if (!acoesPermitidas.includes(acao)) return { encontrada: false, motivo: 'Ação de conta prevista inválida.' };

  const result = await pool.query(
    `SELECT id, descricao, valor_previsto, tipo, data_prevista, data_vencimento, status, observacao
     FROM provisoes
     WHERE usuario_id = $1
       AND status IN ('PENDENTE', 'ATRASADA')
       AND LOWER(descricao) LIKE LOWER($2)
     ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, data_prevista ASC
     LIMIT 5`,
    [usuarioId, `%${termo}%`, termo]
  );

  if (result.rows.length === 0) return { encontrada: false, motivo: `Nenhuma conta prevista ativa corresponde a "${termo}".` };
  if (result.rows.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma conta prevista correspondente. Peça ao usuário para indicar qual deseja alterar.',
      opcoes: result.rows.map((item) => ({
        descricao: item.descricao,
        valorPrevisto: Number(item.valor_previsto || 0),
        tipo: item.tipo,
        dataPrevista: String(item.data_prevista || '').slice(0, 10),
        status: item.status,
      })),
    };
  }

  const provisao = result.rows[0];
  if (acao === 'MARCAR_REALIZADA') {
    return {
      encontrada: true,
      preparada: false,
      requerConciliacao: true,
      contaPrevista: {
        descricao: provisao.descricao,
        valorPrevisto: Number(provisao.valor_previsto || 0),
        tipo: provisao.tipo,
        dataPrevista: String(provisao.data_prevista || '').slice(0, 10),
        status: provisao.status,
      },
      motivo: 'Uma Conta Prevista só deve ser marcada como realizada por meio da conciliação com uma transação real. Não altere o status diretamente. Oriente o usuário a localizar ou importar a transação correspondente para confirmar a conciliação.',
    };
  }

  const payload = {};
  const detalhes = [];
  const hoje = new Date().toISOString().slice(0, 10);
  const dataAtual = String(provisao.data_prevista || '').slice(0, 10);
  const formatarData = (data) => String(data || '').slice(0, 10).split('-').reverse().join('/');
  const formatarMoeda = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const adicionarMeses = (dataIso, quantidade) => {
    const [ano, mes, dia] = String(dataIso || '').slice(0, 10).split('-').map(Number);
    if (![ano, mes, dia].every(Number.isFinite)) return null;
    const indice = (ano * 12) + (mes - 1) + quantidade;
    const novoAno = Math.floor(indice / 12);
    const novoMes = indice % 12;
    const ultimoDia = new Date(Date.UTC(novoAno, novoMes + 1, 0)).getUTCDate();
    return `${novoAno}-${String(novoMes + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
  };

  if (acao === 'ADIAR') {
    let novaData = novaDataPrevistaInformada ? normalizarDataImportacao(novaDataPrevistaInformada) : null;
    if (!novaData && Number.isInteger(adiarMeses) && adiarMeses > 0) novaData = adicionarMeses(dataAtual || hoje, adiarMeses);
    if (!novaData) return { encontrada: true, preparada: false, motivo: 'Informe a nova data ou por quantos meses deseja adiar.' };
    if (novaData < hoje) return { encontrada: true, preparada: false, motivo: 'A nova data não pode estar no passado.' };
    if (dataAtual && novaData <= dataAtual) return { encontrada: true, preparada: false, motivo: 'Para adiar, a nova data deve ser posterior à data atual.' };
    payload.dataPrevista = novaData;
    payload.status = 'PENDENTE';
    detalhes.push(`Data prevista: ${formatarData(dataAtual)} → ${formatarData(novaData)}`);
    if (provisao.status !== 'PENDENTE') detalhes.push(`Status: ${provisao.status} → PENDENTE`);
  }

  if (acao === 'CANCELAR') {
    payload.status = 'CANCELADA';
    detalhes.push(`Status: ${provisao.status} → CANCELADA`);
  }

  if (acao === 'EDITAR') {
    if (novaDescricao && novaDescricao !== provisao.descricao) {
      payload.descricao = novaDescricao;
      detalhes.push(`Descrição: ${provisao.descricao} → ${novaDescricao}`);
    }
    if (Number.isFinite(novoValorPrevisto) && novoValorPrevisto > 0 && novoValorPrevisto !== Number(provisao.valor_previsto || 0)) {
      payload.valorPrevisto = novoValorPrevisto;
      detalhes.push(`Valor: ${formatarMoeda(provisao.valor_previsto)} → ${formatarMoeda(novoValorPrevisto)}`);
    }
    if (novoTipo !== 'MANTER') {
      if (!TIPOS_PROVISAO.includes(novoTipo)) return { encontrada: true, preparada: false, motivo: 'Novo tipo inválido. Use CREDITO ou DEBITO.' };
      if (novoTipo !== provisao.tipo) {
        payload.tipo = novoTipo;
        detalhes.push(`Tipo: ${provisao.tipo} → ${novoTipo}`);
      }
    }
    if (novaDataPrevistaInformada) {
      const novaData = normalizarDataImportacao(novaDataPrevistaInformada);
      if (!novaData) return { encontrada: true, preparada: false, motivo: 'A nova data prevista é inválida.' };
      if (novaData !== dataAtual) {
        payload.dataPrevista = novaData;
        detalhes.push(`Data prevista: ${formatarData(dataAtual)} → ${formatarData(novaData)}`);
      }
    }
    if (novaDataVencimentoInformada) {
      const novaDataVencimento = normalizarDataImportacao(novaDataVencimentoInformada);
      if (!novaDataVencimento) return { encontrada: true, preparada: false, motivo: 'A nova data de vencimento é inválida.' };
      const atualVencimento = String(provisao.data_vencimento || '').slice(0, 10);
      if (novaDataVencimento !== atualVencimento) {
        payload.dataVencimento = novaDataVencimento;
        detalhes.push(`Vencimento: ${atualVencimento ? formatarData(atualVencimento) : 'não informado'} → ${formatarData(novaDataVencimento)}`);
      }
    }
    if (novaObservacao && novaObservacao !== String(provisao.observacao || '').trim()) {
      payload.observacao = novaObservacao;
      detalhes.push('Observação atualizada');
    }
    if (detalhes.length === 0) return { encontrada: true, preparada: false, motivo: 'Nenhuma alteração diferente dos dados atuais foi informada.' };
  }

  const rotulos = { ADIAR: 'Adiar conta prevista', EDITAR: 'Editar conta prevista', CANCELAR: 'Cancelar conta prevista' };
  return {
    encontrada: true,
    preparada: true,
    acao,
    rotuloAcao: rotulos[acao],
    contaPrevista: {
      descricao: provisao.descricao,
      valorPrevisto: Number(provisao.valor_previsto || 0),
      tipo: provisao.tipo,
      dataPrevista: dataAtual,
      status: provisao.status,
    },
    alteracoes: detalhes,
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'ALTERAR_PROVISAO',
      provisaoId: provisao.id,
      acao,
      rotuloAcao: rotulos[acao],
      provisaoDescricao: provisao.descricao,
      payload,
      detalhes,
    },
  };
}

async function ferramentaSugerirConciliacoesPendentes(usuarioId, args = {}) {
  const dias = inteiroAssistente(args.dias, 1, 120, 30);
  const provisoesResult = await pool.query(
    `SELECT p.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome
     FROM provisoes p
     LEFT JOIN contas c ON c.id = p.conta_id
     LEFT JOIN categorias cm ON cm.id = p.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = p.categoria_detalhada_id
     WHERE p.usuario_id = $1
       AND p.status IN ('PENDENTE', 'ATRASADA')
       AND COALESCE(p.data_vencimento, p.data_prevista) >= CURRENT_DATE - ($2::int * INTERVAL '1 day')
       AND COALESCE(p.data_vencimento, p.data_prevista) <= CURRENT_DATE + INTERVAL '3 days'
       AND NOT EXISTS (
         SELECT 1 FROM conciliacoes ca
         WHERE ca.provisao_id = p.id AND ca.status = 'CONFIRMADA'
       )
     ORDER BY COALESCE(p.data_vencimento, p.data_prevista) DESC
     LIMIT 30`,
    [usuarioId, dias]
  );

  const sugestoes = [];
  for (const provisao of provisoesResult.rows) {
    const transacoesResult = await pool.query(
      `SELECT t.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome
       FROM transacoes t
       JOIN contas c ON c.id = t.conta_id
       LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
       LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
       WHERE c.usuario_id = $1
         AND t.deletado_em IS NULL
         AND COALESCE(t.eh_transferencia_interna, false) = false
         AND t.tipo = $2
         AND ABS(ABS(t.valor) - ABS($3::numeric)) <= 0.05
         AND t.data BETWEEN ($4::date - INTERVAL '3 days') AND ($4::date + INTERVAL '3 days')
         AND NOT EXISTS (
           SELECT 1 FROM conciliacoes ca
           WHERE ca.transacao_id = t.id AND ca.status = 'CONFIRMADA'
         )
       ORDER BY ABS(t.data - $4::date), t.data DESC
       LIMIT 8`,
      [usuarioId, provisao.tipo, provisao.valor_previsto, provisao.data_prevista]
    );

    for (const transacao of transacoesResult.rows) {
      const analise = calcularSugestaoConciliacao(provisao, transacao);
      if (!analise) continue;
      sugestoes.push({
        confianca: analise.confianca,
        score: analise.score,
        motivos: analise.motivos,
        contaPrevista: {
          descricao: provisao.descricao,
          valor: Number(provisao.valor_previsto || 0),
          tipo: provisao.tipo,
          data: String(provisao.data_prevista || '').slice(0, 10),
          status: provisao.status,
        },
        transacao: {
          descricao: transacao.descricao,
          valor: Number(transacao.valor || 0),
          tipo: transacao.tipo,
          data: transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10),
          conta: transacao.conta_nome,
          categoria: transacao.categoria_detalhada_nome || transacao.categoria_macro_nome || null,
        },
      });
    }
  }

  sugestoes.sort((a, b) => b.score - a.score);
  return {
    periodoDias: dias,
    quantidadeContasAnalisadas: provisoesResult.rows.length,
    quantidadeSugestoes: sugestoes.length,
    sugestoes: sugestoes.slice(0, 10),
    observacao: 'São apenas sugestões. A conciliação exige confirmação explícita do usuário.',
  };
}

async function ferramentaPrepararConciliacaoAssistente(usuarioId, args = {}) {
  const termoProvisao = String(args.termoProvisao || '').trim();
  const termoTransacao = String(args.termoTransacao || '').trim();
  if (!termoProvisao) return { encontrada: false, motivo: 'Informe a descrição ou parte do nome da Conta Prevista.' };

  const provisoesResult = await pool.query(
    `SELECT p.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome
     FROM provisoes p
     LEFT JOIN contas c ON c.id = p.conta_id
     LEFT JOIN categorias cm ON cm.id = p.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = p.categoria_detalhada_id
     WHERE p.usuario_id = $1
       AND p.status IN ('PENDENTE', 'ATRASADA')
       AND LOWER(p.descricao) LIKE LOWER($2)
       AND NOT EXISTS (
         SELECT 1 FROM conciliacoes ca
         WHERE ca.provisao_id = p.id AND ca.status = 'CONFIRMADA'
       )
     ORDER BY CASE WHEN LOWER(p.descricao) = LOWER($3) THEN 0 ELSE 1 END,
              p.data_prevista DESC
     LIMIT 5`,
    [usuarioId, `%${termoProvisao}%`, termoProvisao]
  );

  if (provisoesResult.rows.length === 0) {
    return { encontrada: false, motivo: `Nenhuma Conta Prevista pendente corresponde a "${termoProvisao}".` };
  }
  if (provisoesResult.rows.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma Conta Prevista correspondente. Peça ao usuário para indicar qual deseja conciliar.',
      opcoes: provisoesResult.rows.map((item) => ({
        descricao: item.descricao,
        valor: Number(item.valor_previsto || 0),
        tipo: item.tipo,
        data: String(item.data_prevista || '').slice(0, 10),
        status: item.status,
      })),
    };
  }

  const provisao = provisoesResult.rows[0];
  const valores = [usuarioId, provisao.tipo, provisao.valor_previsto, provisao.data_prevista];
  const whereBusca = termoTransacao
    ? (() => { valores.push(`%${termoTransacao}%`); return `AND t.descricao ILIKE $${valores.length}`; })()
    : '';
  const transacoesResult = await pool.query(
    `SELECT t.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND t.tipo = $2
       AND ABS(ABS(t.valor) - ABS($3::numeric)) <= 0.05
       AND t.data BETWEEN ($4::date - INTERVAL '3 days') AND ($4::date + INTERVAL '3 days')
       ${whereBusca}
       AND NOT EXISTS (
         SELECT 1 FROM conciliacoes ca
         WHERE ca.transacao_id = t.id AND ca.status = 'CONFIRMADA'
       )
     ORDER BY ABS(t.data - $4::date), t.data DESC
     LIMIT 8`,
    valores
  );

  const candidatas = transacoesResult.rows
    .map((transacao) => ({ transacao, analise: calcularSugestaoConciliacao(provisao, transacao) }))
    .filter((item) => item.analise)
    .sort((a, b) => b.analise.score - a.analise.score);

  if (candidatas.length === 0) {
    return {
      encontrada: true,
      preparada: false,
      motivo: 'Não encontrei uma transação compatível por valor, tipo e janela de até 3 dias. Importe ou localize o lançamento real antes de conciliar.',
      contaPrevista: {
        descricao: provisao.descricao,
        valor: Number(provisao.valor_previsto || 0),
        tipo: provisao.tipo,
        data: String(provisao.data_prevista || '').slice(0, 10),
      },
    };
  }

  const melhor = candidatas[0];
  const segunda = candidatas[1];
  const identificacaoExplicita = Boolean(termoTransacao) && candidatas.length === 1;
  const claramenteMelhor = identificacaoExplicita || (melhor.analise.score >= 0.65 && (!segunda || (melhor.analise.score - segunda.analise.score) >= 0.15));
  if (!claramenteMelhor) {
    const motivoAmbiguidade = candidatas.length === 1
      ? 'Encontrei um candidato de baixa confiança. Peça ao usuário para confirmar a descrição desse lançamento antes de preparar a conciliação.'
      : 'Encontrei mais de uma transação plausível. Peça ao usuário para indicar qual lançamento corresponde à Conta Prevista.';
    return {
      encontrada: true,
      preparada: false,
      ambigua: true,
      motivo: motivoAmbiguidade,
      contaPrevista: {
        descricao: provisao.descricao,
        valor: Number(provisao.valor_previsto || 0),
        tipo: provisao.tipo,
        data: String(provisao.data_prevista || '').slice(0, 10),
      },
      candidatas: candidatas.slice(0, 5).map(({ transacao, analise }) => ({
        descricao: transacao.descricao,
        valor: Number(transacao.valor || 0),
        data: transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10),
        conta: transacao.conta_nome,
        confianca: analise.confianca,
        score: analise.score,
        motivos: analise.motivos,
      })),
    };
  }

  const transacao = melhor.transacao;
  const detalhes = [
    `Mesmo valor: ${Number(transacao.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    `Data da previsão: ${String(provisao.data_prevista || '').slice(0, 10).split('-').reverse().join('/')}`,
    `Data do lançamento: ${(transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10)).split('-').reverse().join('/')}`,
    ...melhor.analise.motivos,
  ];

  return {
    encontrada: true,
    preparada: true,
    confianca: melhor.analise.confianca,
    score: melhor.analise.score,
    motivos: melhor.analise.motivos,
    contaPrevista: {
      descricao: provisao.descricao,
      valor: Number(provisao.valor_previsto || 0),
      tipo: provisao.tipo,
      data: String(provisao.data_prevista || '').slice(0, 10),
      conta: provisao.conta_nome,
    },
    transacao: {
      descricao: transacao.descricao,
      valor: Number(transacao.valor || 0),
      tipo: transacao.tipo,
      data: transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10),
      conta: transacao.conta_nome,
      categoria: transacao.categoria_detalhada_nome || transacao.categoria_macro_nome || null,
    },
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'CONCILIAR_PROVISAO',
      provisaoId: provisao.id,
      transacaoId: transacao.id,
      rotuloAcao: 'Conciliar Conta Prevista',
      contaPrevista: {
        descricao: provisao.descricao,
        valor: Number(provisao.valor_previsto || 0),
        data: String(provisao.data_prevista || '').slice(0, 10),
      },
      transacao: {
        descricao: transacao.descricao,
        valor: Number(transacao.valor || 0),
        data: transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10),
        conta: transacao.conta_nome,
      },
      confianca: melhor.analise.confianca,
      score: melhor.analise.score,
      detalhes,
    },
  };
}

async function ferramentaPrepararCategorizacaoTransacao(usuarioId, args = {}) {
  const termoTransacao = String(args.termoTransacao || '').trim();
  const categoriaNome = String(args.categoria || '').trim();
  const valorInformado = Number(args.valor || 0);
  const dataInformada = String(args.data || '').trim();
  const data = dataInformada ? normalizarDataImportacao(dataInformada) : null;
  const criarRegra = Boolean(args.criarRegra);

  if (!termoTransacao) return { encontrada: false, motivo: 'Informe a descrição ou parte do lançamento que deseja categorizar.' };
  if (!categoriaNome) return { encontrada: false, motivo: 'Informe a categoria desejada.' };
  if (dataInformada && !data) return { encontrada: false, motivo: 'A data informada para localizar a transação é inválida.' };

  const categoriasResult = await pool.query(
    `SELECT c.id, c.nome, c.nivel, c.categoria_pai_id, pai.nome AS categoria_macro_nome
     FROM categorias c
     LEFT JOIN categorias pai ON pai.id = c.categoria_pai_id
     WHERE c.ativa = true
       AND (c.usuario_id = $1 OR c.usuario_id IS NULL)
       AND LOWER(c.nome) = LOWER($2)
     ORDER BY CASE WHEN c.usuario_id = $1 THEN 0 ELSE 1 END, c.criado_em ASC
     LIMIT 5`,
    [usuarioId, categoriaNome]
  );

  let categoria = categoriasResult.rows[0] || null;
  if (!categoria) {
    const todas = await pool.query(
      `SELECT c.nome, c.nivel, pai.nome AS categoria_macro_nome
       FROM categorias c
       LEFT JOIN categorias pai ON pai.id = c.categoria_pai_id
       WHERE c.ativa = true AND (c.usuario_id = $1 OR c.usuario_id IS NULL)
       ORDER BY c.nome ASC`,
      [usuarioId]
    );
    const sugestoes = todas.rows
      .map((item) => ({ ...item, similaridade: calcularSimilaridadeCategoria(categoriaNome, item.nome) }))
      .filter((item) => item.similaridade >= 0.55)
      .sort((a, b) => b.similaridade - a.similaridade)
      .slice(0, 5)
      .map((item) => ({ nome: item.nome, nivel: item.nivel, categoriaMacro: item.categoria_macro_nome, similaridade: item.similaridade }));
    return {
      encontrada: false,
      motivo: `A categoria "${categoriaNome}" não existe. Escolha uma categoria existente antes de categorizar.`,
      sugestoesCategorias: sugestoes,
    };
  }

  const nivel = categoria.nivel || (categoria.categoria_pai_id ? 'DETALHADA' : 'MACRO');
  const categoriaMacroId = nivel === 'DETALHADA' ? categoria.categoria_pai_id : categoria.id;
  const categoriaDetalhadaId = nivel === 'DETALHADA' ? categoria.id : null;
  const categoriaId = categoriaDetalhadaId || categoriaMacroId;

  const valores = [usuarioId, `%${termoTransacao}%`, termoTransacao];
  const filtros = [];
  if (Number.isFinite(valorInformado) && valorInformado > 0) {
    valores.push(valorInformado);
    filtros.push(`AND ABS(ABS(t.valor) - ABS($${valores.length}::numeric)) <= 0.01`);
  }
  if (data) {
    valores.push(data);
    filtros.push(`AND t.data = $${valores.length}::date`);
  }

  const transacoesResult = await pool.query(
    `SELECT t.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND t.descricao ILIKE $2
       ${filtros.join('\n       ')}
     ORDER BY CASE WHEN LOWER(t.descricao) = LOWER($3) THEN 0 ELSE 1 END,
              t.data DESC, t.criado_em DESC
     LIMIT 6`,
    valores
  );

  if (transacoesResult.rows.length === 0) {
    return { encontrada: false, motivo: `Nenhum lançamento corresponde a "${termoTransacao}" com os filtros informados.` };
  }
  if (transacoesResult.rows.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de um lançamento correspondente. Peça ao usuário para informar data ou valor para identificar o lançamento exato.',
      opcoes: transacoesResult.rows.map((item) => ({
        descricao: item.descricao,
        valor: Number(item.valor || 0),
        tipo: item.tipo,
        data: item.data instanceof Date ? item.data.toISOString().slice(0, 10) : String(item.data || '').slice(0, 10),
        conta: item.conta_nome,
        categoriaAtual: item.categoria_detalhada_nome || item.categoria_macro_nome || 'Não categorizado',
      })),
    };
  }

  const transacao = transacoesResult.rows[0];
  const macroAtual = transacao.categoria_macro_id || null;
  const detalhadaAtual = transacao.categoria_detalhada_id || null;
  if (String(macroAtual || '') === String(categoriaMacroId || '') && String(detalhadaAtual || '') === String(categoriaDetalhadaId || '')) {
    return {
      encontrada: true,
      preparada: false,
      motivo: `Esse lançamento já está categorizado como ${categoria.categoria_macro_nome ? `${categoria.categoria_macro_nome} > ` : ''}${categoria.nome}.`,
    };
  }

  const categoriaRotulo = categoria.categoria_macro_nome ? `${categoria.categoria_macro_nome} > ${categoria.nome}` : categoria.nome;
  const transacaoData = transacao.data instanceof Date ? transacao.data.toISOString().slice(0, 10) : String(transacao.data || '').slice(0, 10);
  const detalhes = [
    `Lançamento: ${transacao.descricao}`,
    `Valor: ${Number(transacao.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    `Data: ${transacaoData.split('-').reverse().join('/')}`,
    `Categoria atual: ${transacao.categoria_detalhada_nome || transacao.categoria_macro_nome || 'Não categorizado'}`,
    `Nova categoria: ${categoriaRotulo}`,
  ];
  if (criarRegra) detalhes.push('Também criar regra para descrições semelhantes ainda sem categoria');

  return {
    encontrada: true,
    preparada: true,
    transacao: {
      descricao: transacao.descricao,
      valor: Number(transacao.valor || 0),
      tipo: transacao.tipo,
      data: transacaoData,
      conta: transacao.conta_nome,
      categoriaAtual: transacao.categoria_detalhada_nome || transacao.categoria_macro_nome || 'Não categorizado',
    },
    categoria: { nome: categoria.nome, nivel, categoriaMacro: categoria.categoria_macro_nome || categoria.nome },
    criarRegra,
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'CATEGORIZAR_TRANSACAO',
      transacaoId: transacao.id,
      rotuloAcao: 'Categorizar lançamento',
      transacao: {
        descricao: transacao.descricao,
        valor: Number(transacao.valor || 0),
        data: transacaoData,
        conta: transacao.conta_nome,
        categoriaAtual: transacao.categoria_detalhada_nome || transacao.categoria_macro_nome || 'Não categorizado',
      },
      categoria: { nome: categoriaRotulo },
      payload: {
        categoriaId,
        categoriaMacroId,
        categoriaDetalhadaId,
        criarRegra,
        termoRegra: criarRegra ? transacao.descricao : undefined,
      },
      detalhes,
    },
  };
}

const FERRAMENTAS_ASSISTENTE = [
  {
    type: 'function',
    name: 'gastos_por_categoria',
    description: 'Consulta despesas reais agrupadas por categoria nos últimos meses. Use para descobrir onde o usuário mais gastou e comparar categorias.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        meses: { type: 'integer', minimum: 1, maximum: 24, description: 'Quantidade de meses incluindo o mês atual.' },
        nivel: { type: 'string', enum: ['macro', 'detalhada'], description: 'Nível de categoria a analisar.' },
        limite: { type: 'integer', minimum: 1, maximum: 20, description: 'Quantidade máxima de categorias retornadas.' },
      },
      required: ['meses', 'nivel', 'limite'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'lancamentos_nao_categorizados',
    description: 'Conta e lista exemplos de lançamentos sem qualquer categoria nos últimos meses.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        meses: { type: 'integer', minimum: 1, maximum: 24 },
        limite: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['meses', 'limite'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'compras_programadas_por_mes',
    description: 'Consulta compras programadas planejadas e distribui o impacto à vista ou parcelado nos próximos meses.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { meses: { type: 'integer', minimum: 1, maximum: 24 } },
      required: ['meses'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'comparar_cenarios_compra_programada',
    description: 'Analisa uma compra programada específica e compara datas e parcelamentos usando o mesmo motor financeiro do simulador. Use quando o usuário perguntar se pode comprar algo, quando comprar, em quantas parcelas ou qual opção preserva melhor o caixa.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Descrição ou parte do nome da compra programada a analisar.' },
        reservaMinima: { type: 'number', minimum: 0, description: 'Saldo mínimo em BRL que o usuário deseja preservar. Use 0 se ele não informar uma reserva.' },
      },
      required: ['termo', 'reservaMinima'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'planejar_compra_hipotetica',
    description: 'Planeja uma compra que ainda não está cadastrada. Compara datas até o prazo informado e parcelamentos usando o mesmo motor financeiro das Compras Programadas, sem gravar nada. Use quando o usuário disser que quer comprar algo novo e pedir a melhor data, parcelamento ou impacto no caixa.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'Nome claro do item ou objetivo de compra.' },
        valorEstimado: { type: 'number', minimum: 0.01, description: 'Valor total estimado da compra em BRL.' },
        dataLimite: { type: 'string', description: 'Data limite no formato AAAA-MM-DD.' },
        reservaMinima: { type: 'number', minimum: 0, description: 'Saldo mínimo em BRL que o usuário deseja preservar. Use 0 apenas se ele não informar.' },
        prioridade: { type: 'string', enum: ['BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'], description: 'Prioridade da compra. Use MEDIA se o usuário não informar.' },
        maxParcelas: { type: 'integer', minimum: 1, maximum: 12, description: 'Máximo de parcelas a considerar. Use 12 se o usuário não informar.' },
      },
      required: ['descricao', 'valorEstimado', 'dataLimite', 'reservaMinima', 'prioridade', 'maxParcelas'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'buscar_transacoes_para_compra_realizada',
    description: 'Procura lançamentos reais de débito para uma compra que já aconteceu e prepara a associação sem gravar. Use obrigatoriamente quando o usuário disser que já comprou/pagou algo mas não souber a data, quando pedir para localizar o pagamento no extrato ou quando quiser associar uma Compra Programada a uma transação. Não assuma hoje como data.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termoCompraExistente: { type: 'string', description: 'Parte do nome da Compra Programada existente. Use string vazia quando a compra ainda não estava cadastrada.' },
        descricao: { type: 'string', description: 'Descrição do item comprado. Use string vazia quando termoCompraExistente identificar a compra.' },
        valor: { type: 'number', minimum: 0, description: 'Valor pago ou estimado em BRL. Use 0 quando uma compra existente fornecer o valor.' },
        dataCompra: { type: 'string', description: 'Data AAAA-MM-DD ou string vazia quando o usuário não souber.' },
        metodoPagamento: { type: 'string', description: 'PIX, cartão, débito, dinheiro etc., ou string vazia.' },
        prioridade: { type: 'string', enum: ['BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'], description: 'Use MEDIA quando não informada.' },
        formaPagamento: { type: 'string', enum: ['A_VISTA', 'PARCELADO'], description: 'PIX/débito/dinheiro = A_VISTA. Cartão parcelado = PARCELADO.' },
        parcelas: { type: 'integer', minimum: 0, maximum: 60, description: '1 para à vista; quantidade real para parcelado; 0 se desconhecida.' },
        condicao: { type: 'string', enum: ['NOVO', 'USADO', 'NAO_INFORMADO'] },
        link: { type: 'string', description: 'URL de referência ou string vazia.' },
        observacao: { type: 'string', description: 'Contexto adicional ou string vazia.' },
        diasBusca: { type: 'integer', minimum: 30, maximum: 365, description: 'Janela de busca quando a data for desconhecida. Use 180 por padrão.' },
      },
      required: ['termoCompraExistente', 'descricao', 'valor', 'dataCompra', 'metodoPagamento', 'prioridade', 'formaPagamento', 'parcelas', 'condicao', 'link', 'observacao', 'diasBusca'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'preparar_novas_compras',
    description: 'Prepara, sem gravar, uma ou várias Compras Programadas para cadastro direto quando a data da compra já é conhecida ou quando se trata de compra futura com data desejada informada. Não invente a data atual. Para compra já realizada sem data conhecida ou quando o usuário quiser associar ao extrato, use buscar_transacoes_para_compra_realizada.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          description: 'Lista de compras a preparar. Use um único item quando houver apenas uma compra.',
          items: {
            type: 'object',
            properties: {
              descricao: { type: 'string', description: 'Descrição clara da compra.' },
              valorEstimado: { type: 'number', minimum: 0, description: 'Valor total em BRL. Use 0 se não foi informado para que a ferramenta peça o dado faltante.' },
              dataDesejada: { type: 'string', description: 'Data AAAA-MM-DD. Use string vazia se não informada; a ferramenta não deve inventar uma data.' },
              status: { type: 'string', enum: ['PLANEJADA', 'COMPRADA'], description: 'COMPRADA quando o usuário disser que já comprou/pagou/adquiriu; PLANEJADA para intenção futura.' },
              prioridade: { type: 'string', enum: ['BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'], description: 'Use MEDIA quando não informada.' },
              formaPagamento: { type: 'string', enum: ['A_VISTA', 'PARCELADO'], description: 'PIX, débito, dinheiro ou pagamento único devem ser A_VISTA; use PARCELADO quando houver 2 ou mais parcelas.' },
              parcelas: { type: 'integer', minimum: 0, maximum: 60, description: '1 para à vista; quantidade real para parcelado. Use 0 apenas quando a forma ainda não puder ser inferida.' },
              metodoPagamento: { type: 'string', description: 'Ex.: PIX, cartão de crédito, cartão de débito, dinheiro; string vazia se não informado.' },
              condicao: { type: 'string', enum: ['NOVO', 'USADO', 'NAO_INFORMADO'], description: 'Condição do produto quando informada.' },
              link: { type: 'string', description: 'URL de referência do produto ou string vazia.' },
              observacao: { type: 'string', description: 'Contexto adicional, por exemplo Novo apartamento, ou string vazia.' },
            },
            required: ['descricao', 'valorEstimado', 'dataDesejada', 'status', 'prioridade', 'formaPagamento', 'parcelas', 'metodoPagamento', 'condicao', 'link', 'observacao'],
            additionalProperties: false,
          },
        },
      },
      required: ['itens'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'preparar_alteracao_compra_programada',
    description: 'Prepara, sem gravar, uma alteração em uma Compra Programada existente. Use para adiar, editar dados, marcar como comprada ou cancelar. A alteração só será aplicada depois de confirmação explícita no frontend.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Descrição ou parte do nome da compra programada.' },
        acao: { type: 'string', enum: ['ADIAR', 'EDITAR', 'MARCAR_COMPRADA', 'CANCELAR'] },
        novaDescricao: { type: 'string', description: 'Nova descrição. Use string vazia quando não alterar.' },
        novoValorEstimado: { type: 'number', minimum: 0, description: 'Novo valor total em BRL. Use 0 quando não alterar.' },
        novaData: { type: 'string', description: 'Nova data no formato AAAA-MM-DD. Use string vazia quando não alterar ou quando usar adiarMeses.' },
        adiarMeses: { type: 'integer', minimum: 0, maximum: 12, description: 'Quantidade de meses para adiar. Use 0 quando não aplicável.' },
        novaPrioridade: { type: 'string', enum: ['MANTER', 'BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'] },
        novaFormaPagamento: { type: 'string', enum: ['MANTER', 'A_VISTA', 'PARCELADO'] },
        novasParcelas: { type: 'integer', minimum: 0, maximum: 60, description: 'Nova quantidade de parcelas. Use 0 quando não alterar.' },
      },
      required: ['termo', 'acao', 'novaDescricao', 'novoValorEstimado', 'novaData', 'adiarMeses', 'novaPrioridade', 'novaFormaPagamento', 'novasParcelas'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'preparar_nova_conta_prevista',
    description: 'Prepara, sem gravar, uma nova Conta Prevista (provisão) a pagar ou receber. Use quando o usuário pedir para cadastrar uma conta futura. A criação só ocorre após confirmação explícita no frontend.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'Descrição da conta prevista.' },
        valorPrevisto: { type: 'number', minimum: 0.01, description: 'Valor previsto em BRL.' },
        tipo: { type: 'string', enum: ['CREDITO', 'DEBITO'], description: 'CREDITO para valor a receber e DEBITO para valor a pagar.' },
        dataPrevista: { type: 'string', description: 'Data prevista no formato AAAA-MM-DD.' },
        dataVencimento: { type: 'string', description: 'Data de vencimento AAAA-MM-DD ou string vazia se não informada.' },
        observacao: { type: 'string', description: 'Observação ou string vazia se não informada.' },
      },
      required: ['descricao', 'valorPrevisto', 'tipo', 'dataPrevista', 'dataVencimento', 'observacao'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'preparar_alteracao_conta_prevista',
    description: 'Prepara, sem gravar, uma alteração em Conta Prevista existente. Use para adiar, editar ou cancelar. Se o usuário disser que a conta foi paga/recebida/realizada, use MARCAR_REALIZADA para informar que é necessária conciliação com uma transação real.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Descrição ou parte do nome da conta prevista.' },
        acao: { type: 'string', enum: ['ADIAR', 'EDITAR', 'CANCELAR', 'MARCAR_REALIZADA'] },
        novaDescricao: { type: 'string', description: 'Nova descrição ou string vazia para manter.' },
        novoValorPrevisto: { type: 'number', minimum: 0, description: 'Novo valor ou 0 para manter.' },
        novoTipo: { type: 'string', enum: ['MANTER', 'CREDITO', 'DEBITO'] },
        novaDataPrevista: { type: 'string', description: 'Nova data AAAA-MM-DD ou string vazia.' },
        novaDataVencimento: { type: 'string', description: 'Novo vencimento AAAA-MM-DD ou string vazia.' },
        adiarMeses: { type: 'integer', minimum: 0, maximum: 24, description: 'Meses para adiar ou 0.' },
        novaObservacao: { type: 'string', description: 'Nova observação ou string vazia para manter.' },
      },
      required: ['termo', 'acao', 'novaDescricao', 'novoValorPrevisto', 'novoTipo', 'novaDataPrevista', 'novaDataVencimento', 'adiarMeses', 'novaObservacao'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'sugerir_conciliacoes_pendentes',
    description: 'Procura Contas Previstas pendentes ou atrasadas recentes que tenham transações reais compatíveis por valor, tipo e data. Use para responder perguntas como "tenho alguma conta prevista que provavelmente já foi paga?". Apenas consulta, não concilia.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        dias: { type: 'integer', minimum: 1, maximum: 120, description: 'Janela retroativa em dias. Use 30 se o usuário não informar.' },
      },
      required: ['dias'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'preparar_conciliacao_conta_prevista',
    description: 'Localiza uma Conta Prevista pendente e a transação real compatível, preparando a conciliação sem gravar. Use quando o usuário disser que uma conta foi paga/recebida/realizada e quiser localizar e conciliar o lançamento.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termoProvisao: { type: 'string', description: 'Descrição ou parte do nome da Conta Prevista.' },
        termoTransacao: { type: 'string', description: 'Parte da descrição da transação, ou string vazia se o usuário não souber.' },
      },
      required: ['termoProvisao', 'termoTransacao'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'preparar_categorizacao_transacao',
    description: 'Localiza um lançamento existente e prepara sua categorização em uma categoria já existente, sem gravar. Use quando o usuário pedir para categorizar um lançamento. Se houver mais de um candidato, peça data ou valor. Só crie regra automática se o usuário pedir explicitamente algo como "sempre categorize assim".',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termoTransacao: { type: 'string', description: 'Descrição ou parte do lançamento.' },
        valor: { type: 'number', minimum: 0, description: 'Valor do lançamento para desambiguar. Use 0 se não informado.' },
        data: { type: 'string', description: 'Data AAAA-MM-DD para desambiguar, ou string vazia.' },
        categoria: { type: 'string', description: 'Nome exato da categoria existente desejada.' },
        criarRegra: { type: 'boolean', description: 'True somente se o usuário pedir explicitamente uma regra para lançamentos semelhantes.' },
      },
      required: ['termoTransacao', 'valor', 'data', 'categoria', 'criarRegra'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'contas_previstas_por_mes',
    description: 'Consulta créditos e débitos previstos pendentes ou atrasados nos próximos meses.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { meses: { type: 'integer', minimum: 1, maximum: 24 } },
      required: ['meses'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'saldos_das_contas',
    description: 'Consulta os saldos atuais das contas ativas do usuário e o saldo total.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

const ROTULOS_FERRAMENTAS_ASSISTENTE = {
  gastos_por_categoria: 'gastos por categoria',
  lancamentos_nao_categorizados: 'não categorizados',
  compras_programadas_por_mes: 'compras programadas',
  comparar_cenarios_compra_programada: 'comparação de cenários de compra',
  planejar_compra_hipotetica: 'planejamento de nova compra',
  buscar_transacoes_para_compra_realizada: 'busca de lançamento para compra realizada',
  preparar_novas_compras: 'cadastro de compras',
  preparar_alteracao_compra_programada: 'alteração de compra programada',
  preparar_nova_conta_prevista: 'nova conta prevista',
  preparar_alteracao_conta_prevista: 'alteração de conta prevista',
  sugerir_conciliacoes_pendentes: 'sugestões de conciliação',
  preparar_conciliacao_conta_prevista: 'conciliação de conta prevista',
  preparar_categorizacao_transacao: 'categorização de lançamento',
  contas_previstas_por_mes: 'contas previstas',
  saldos_das_contas: 'saldos das contas',
};

async function executarFerramentaAssistente(usuarioId, nome, args) {
  if (nome === 'gastos_por_categoria') return ferramentaGastosPorCategoria(usuarioId, args);
  if (nome === 'lancamentos_nao_categorizados') return ferramentaNaoCategorizados(usuarioId, args);
  if (nome === 'compras_programadas_por_mes') return ferramentaComprasProgramadas(usuarioId, args);
  if (nome === 'comparar_cenarios_compra_programada') return ferramentaCompararCompraProgramada(usuarioId, args);
  if (nome === 'planejar_compra_hipotetica') return ferramentaPlanejarCompraHipotetica(usuarioId, args);
  if (nome === 'buscar_transacoes_para_compra_realizada') return ferramentaBuscarTransacoesCompraRealizada(usuarioId, args);
  if (nome === 'preparar_novas_compras') return ferramentaPrepararNovasCompras(usuarioId, args);
  if (nome === 'preparar_alteracao_compra_programada') return ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args);
  if (nome === 'preparar_nova_conta_prevista') return ferramentaPrepararNovaProvisao(usuarioId, args);
  if (nome === 'preparar_alteracao_conta_prevista') return ferramentaPrepararAlteracaoProvisao(usuarioId, args);
  if (nome === 'sugerir_conciliacoes_pendentes') return ferramentaSugerirConciliacoesPendentes(usuarioId, args);
  if (nome === 'preparar_conciliacao_conta_prevista') return ferramentaPrepararConciliacaoAssistente(usuarioId, args);
  if (nome === 'preparar_categorizacao_transacao') return ferramentaPrepararCategorizacaoTransacao(usuarioId, args);
  if (nome === 'contas_previstas_por_mes') return ferramentaContasPrevistas(usuarioId, args);
  if (nome === 'saldos_das_contas') return ferramentaSaldos(usuarioId);
  throw new Error('Ferramenta não autorizada para o assistente.');
}

function sanitizarSchemaFunctionCallingGemini(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;

  const sanitizado = {};
  if (schema.type) sanitizado.type = schema.type;
  if (schema.description) sanitizado.description = schema.description;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) sanitizado.enum = schema.enum;

  if (schema.properties && typeof schema.properties === 'object') {
    sanitizado.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([nome, propriedade]) => [
        nome,
        sanitizarSchemaFunctionCallingGemini(propriedade),
      ])
    );
  }

  if (schema.items && typeof schema.items === 'object') {
    sanitizado.items = sanitizarSchemaFunctionCallingGemini(schema.items);
  }

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const nomesValidos = sanitizado.properties ? new Set(Object.keys(sanitizado.properties)) : null;
    const required = nomesValidos ? schema.required.filter((nome) => nomesValidos.has(nome)) : [];
    if (required.length > 0) sanitizado.required = required;
  }

  return sanitizado;
}

function declaracoesGeminiAssistente(nomesPermitidos = null) {
  const filtro = Array.isArray(nomesPermitidos) && nomesPermitidos.length > 0
    ? new Set(nomesPermitidos)
    : null;

  return FERRAMENTAS_ASSISTENTE
    .filter(({ name }) => !filtro || filtro.has(name))
    .map(({ name, description, parameters }) => {
      const declaracao = { name, description };
      const propriedades = parameters?.properties && typeof parameters.properties === 'object'
        ? Object.keys(parameters.properties)
        : [];
      if (propriedades.length > 0) {
        declaracao.parameters = sanitizarSchemaFunctionCallingGemini(parameters);
      }
      return declaracao;
    });
}

function extrairTextoRespostaAssistente(response) {
  const partes = response?.candidates?.[0]?.content?.parts || [];
  return partes
    .filter((parte) => typeof parte?.text === 'string')
    .map((parte) => parte.text)
    .join('\n')
    .trim();
}

function extrairChamadasGeminiAssistente(response) {
  const partes = response?.candidates?.[0]?.content?.parts || [];
  return partes
    .filter((parte) => parte?.functionCall?.name)
    .map((parte) => ({
      name: parte.functionCall.name,
      args: parte.functionCall.args || {},
      id: parte.functionCall.id || null,
    }));
}

function modelosGeminiAssistente() {
  return Array.from(new Set([ASSISTENTE_GEMINI_MODEL, ASSISTENTE_GEMINI_MODEL_FALLBACK].filter(Boolean)));
}

async function chamarGeminiAssistente({ contents, instructions, toolConfig = null }) {
  const nomesPermitidos = toolConfig?.functionCallingConfig?.allowedFunctionNames || null;
  const functionDeclarations = declaracoesGeminiAssistente(nomesPermitidos);
  const modelos = modelosGeminiAssistente();
  let ultimoErro = null;

  for (let indiceModelo = 0; indiceModelo < modelos.length; indiceModelo += 1) {
    const nomeModelo = modelos[indiceModelo];
    const modelo = encodeURIComponent(nomeModelo);
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents,
          tools: [{ functionDeclarations }],
          toolConfig: toolConfig || { functionCallingConfig: { mode: 'AUTO' } },
          generationConfig: {
            maxOutputTokens: 1200,
          },
        }),
      });
    } catch (error) {
      throw new Error('Não foi possível conectar ao serviço gratuito de IA.');
    }

    const data = await response.json().catch(() => ({}));
    if (response.ok) return { ...data, _modeloUsado: nomeModelo };

    const erro = new Error(data?.error?.message || `Falha no serviço Gemini (${response.status}).`);
    erro.statusGemini = response.status;
    erro.codigoGemini = data?.error?.status || null;
    erro.modeloGemini = nomeModelo;
    ultimoErro = erro;

    const podeUsarFallback = response.status === 404 && indiceModelo < modelos.length - 1;
    if (podeUsarFallback) {
      console.warn('Modelo Gemini indisponível; tentando fallback compatível:', {
        modelo: nomeModelo,
        fallback: modelos[indiceModelo + 1],
      });
      continue;
    }

    throw erro;
  }

  throw ultimoErro || new Error('Nenhum modelo Gemini disponível para o Assistente.');
}

function normalizarHistoricoAssistente(historico) {
  if (!Array.isArray(historico)) return [];
  return historico
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    .slice(-ASSISTENTE_MAX_HISTORICO)
    .map((item) => ({ role: item.role, content: item.content.slice(0, ASSISTENTE_MAX_MENSAGEM) }));
}

function normalizarIntencaoAssistente(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function detectarRoteamentoOperacionalAssistente(mensagem) {
  const texto = normalizarIntencaoAssistente(mensagem);
  const compraRealizada = /\b(comprei|paguei|adquiri|ja comprei|ja paguei)\b/.test(texto);
  const querAssociar = /\b(associ|concili|lancamento|transacao|extrato|procura|localiza|encontra)\w*/.test(texto);
  const dataExplicita = /\b(hoje|ontem|anteontem)\b|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/.test(texto);
  const naoSabeData = /nao (lembro|sei).*\b(data|quando)\b|nao lembro quando|nao sei quando|sem data/.test(texto);
  const alteraCompra = /\b(adiar|adie|edite|editar|cancele|cancelar|desisti|marque|marcar)\b/.test(texto) && /\b(compra|compras|lista)\b/.test(texto);
  const cadastroCompra = /\b(cadastre|cadastrar|adicione|adicionar|coloque|planeje|planejar)\b/.test(texto) && /\b(compra|comprar|compras|programada|programadas)\b/.test(texto);

  if (compraRealizada && (naoSabeData || !dataExplicita || querAssociar)) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['buscar_transacoes_para_compra_realizada'] } };
  }
  if (compraRealizada && dataExplicita) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['preparar_novas_compras', 'buscar_transacoes_para_compra_realizada', 'preparar_alteracao_compra_programada'] } };
  }
  if (alteraCompra) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['preparar_alteracao_compra_programada', 'buscar_transacoes_para_compra_realizada'] } };
  }
  if (cadastroCompra) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['preparar_novas_compras', 'planejar_compra_hipotetica'] } };
  }
  return null;
}

app.post('/api/assistente', verificarToken, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      erro: 'Assistente financeiro gratuito ainda não configurado no servidor.',
      codigo: 'GEMINI_API_KEY_AUSENTE',
    });
  }

  const mensagem = String(req.body?.mensagem || '').trim().slice(0, ASSISTENTE_MAX_MENSAGEM);
  if (!mensagem) return res.status(400).json({ erro: 'Escreva uma pergunta para o assistente.' });

  const usuarioId = req.usuario.usuario_id;
  const historico = normalizarHistoricoAssistente(req.body?.historico);
  const contents = historico.map((item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: mensagem }] });

  const ferramentasUsadas = new Set();
  let acaoPendente = null;
  const roteamentoOperacional = detectarRoteamentoOperacionalAssistente(mensagem);
  const hoje = new Date().toISOString().slice(0, 10);
  const instructions = `Você é o Assistente Financeiro de um aplicativo de finanças pessoais. Data atual do servidor: ${hoje}.
Responda em português do Brasil, de forma direta, clara e útil.
Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou, conciliou ou alterou dados. Você pode preparar propostas estruturadas de criação ou alteração de Compras Programadas e Contas Previstas, categorização de lançamentos e conciliação de Contas Previstas com transações reais, mas qualquer gravação só ocorre depois de confirmação explícita do usuário na interface.
Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar sobre uma compra que já está cadastrada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use comparar_cenarios_compra_programada antes de recomendar. Se o usuário estiver PEDINDO UMA DECISÃO sobre uma compra nova, como melhor data, melhor parcelamento, impacto no caixa ou se cabe no orçamento, use planejar_compra_hipotetica. Se ele apenas pedir para cadastrar/adicionar uma compra futura sem solicitar otimização, use preparar_novas_compras com status PLANEJADA e exija data desejada. Se disser que já comprou, pagou ou adquiriu algo e a data real NÃO estiver clara, ou se pedir para localizar/associar o pagamento no extrato, use obrigatoriamente buscar_transacoes_para_compra_realizada; NUNCA assuma que foi hoje. Se a compra realizada já estiver em Compras Programadas, informe termoCompraExistente para a ferramenta localizar a compra antes de buscar o lançamento. Se a data real estiver explicitamente informada e não houver pedido de associação ao extrato, preparar_novas_compras pode ser usado com status COMPRADA. Se trouxer várias compras futuras na mesma mensagem, use preparar_novas_compras em lote. Se o usuário pedir para adiar, editar ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada. Comandos operacionais claros como cadastrar, adicionar, marcar, associar, conciliar, cancelar ou adiar devem resultar em chamada de ferramenta; não responda apenas com instruções genéricas sobre como o usuário poderia fazer isso manualmente. Se pedir para criar uma Conta Prevista, use preparar_nova_conta_prevista. Se pedir para adiar, editar ou cancelar uma Conta Prevista existente, use preparar_alteracao_conta_prevista. Se disser que uma Conta Prevista foi paga, recebida ou realizada, use preparar_conciliacao_conta_prevista para localizar a transação real; nunca altere o status diretamente. Se perguntar se existem Contas Previstas provavelmente já realizadas, use sugerir_conciliacoes_pendentes. Se pedir para categorizar um lançamento existente, use preparar_categorizacao_transacao e nunca invente uma categoria inexistente. Só peça criação de regra automática quando o usuário solicitar explicitamente que lançamentos semelhantes sejam categorizados da mesma forma. Não edite nem exclua transações por meio do assistente neste fluxo. Para campos que não serão alterados nessas ferramentas, use os sentinelas indicados no schema, como string vazia, 0 ou MANTER. Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Para simulação de compra nova, se faltarem descrição, valor ou prazo/data limite, peça esses dados antes de planejar; na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12. Para cadastro direto, descrição, valor positivo e data são obrigatórios. Se uma compra já realizada não tiver data conhecida, não invente data: procure uma transação real com buscar_transacoes_para_compra_realizada. Interprete PIX, débito, dinheiro e pagamento único como A_VISTA e preserve o método em metodoPagamento. Preserve URLs recebidas no campo link e informações como usado/novo em condicao.
Se os dados disponíveis não forem suficientes para responder, diga exatamente o que falta.
Valores são em BRL. Diferencie fatos encontrados nos dados de interpretações ou sugestões. Ao explicar uma compra, cite a data, forma de pagamento, menor saldo projetado e se a reserva informada é preservada. Não trate o ranking como garantia de liquidez futura.
Não exponha IDs internos, SQL, tokens, chaves ou detalhes técnicos do banco.
Não use tabelas Markdown complexas; prefira conclusão curta, números principais e bullets quando ajudarem.
As ferramentas disponíveis são exclusivamente de consulta e já estão limitadas ao usuário autenticado.`;

  try {
    let response = null;
    for (let rodada = 0; rodada < 5; rodada += 1) {
      response = await chamarGeminiAssistente({
        contents,
        instructions,
        toolConfig: rodada === 0 ? roteamentoOperacional : null,
      });

      const conteudoModelo = response?.candidates?.[0]?.content;
      if (!conteudoModelo?.parts?.length) {
        const motivo = response?.candidates?.[0]?.finishReason;
        throw new Error(motivo ? `A IA não retornou conteúdo (${motivo}).` : 'A IA não retornou conteúdo.');
      }

      contents.push({
        role: conteudoModelo.role || 'model',
        parts: conteudoModelo.parts,
      });

      const chamadas = extrairChamadasGeminiAssistente(response);
      if (chamadas.length === 0) {
        const resposta = extrairTextoRespostaAssistente(response);
        if (!resposta) throw new Error('A IA não retornou uma resposta em texto.');
        return res.json({
          resposta,
          modelo: response?._modeloUsado || ASSISTENTE_GEMINI_MODEL,
          provedor: 'gemini-free-tier',
          consultas: Array.from(ferramentasUsadas).map((nome) => ROTULOS_FERRAMENTAS_ASSISTENTE[nome] || nome),
          acaoPendente,
        });
      }

      const partesRespostaFerramentas = [];
      for (const chamada of chamadas) {
        const resultadoBruto = await executarFerramentaAssistente(usuarioId, chamada.name, chamada.args || {});
        const resultado = resultadoBruto && typeof resultadoBruto === 'object' && !Array.isArray(resultadoBruto) ? { ...resultadoBruto } : resultadoBruto;
        ferramentasUsadas.add(chamada.name);
        if (resultado?._acaoPendente) {
          acaoPendente = resultado._acaoPendente;
          delete resultado._acaoPendente;
        }
        if (chamada.name === 'planejar_compra_hipotetica' && resultado?.propostaCadastro) {
          acaoPendente = {
            tipo: 'CRIAR_COMPRA_PROGRAMADA',
            payload: resultado.propostaCadastro,
            analise: {
              reservaMinima: resultado.reservaMinima,
              criterio: resultado.criterio,
              melhorCenario: resultado.melhorCenario,
              melhoresAlternativas: resultado.melhoresAlternativas,
            },
          };
        }
        const functionResponse = {
          name: chamada.name,
          response: resultado,
        };
        if (chamada.id) functionResponse.id = chamada.id;
        partesRespostaFerramentas.push({ functionResponse });
      }

      contents.push({ role: 'user', parts: partesRespostaFerramentas });
    }

    return res.status(502).json({ erro: 'A análise exigiu chamadas demais. Tente fazer uma pergunta mais específica.' });
  } catch (error) {
    console.error('Erro no assistente financeiro gratuito:', {
      mensagem: error.message,
      statusGemini: error.statusGemini || null,
      codigoGemini: error.codigoGemini || null,
      modeloGemini: error.modeloGemini || null,
    });
    if (error.statusGemini === 400) {
      return res.status(502).json({
        erro: 'O serviço de IA recusou a configuração desta solicitação. Tente novamente; se persistir, revise as ferramentas do Assistente.',
        codigo: 'GEMINI_REQUISICAO_INVALIDA',
      });
    }
    if (error.statusGemini === 404) {
      return res.status(503).json({
        erro: 'O modelo configurado para o Assistente não está disponível. Tente novamente após atualizar a configuração do Gemini.',
        codigo: 'GEMINI_MODELO_INDISPONIVEL',
      });
    }
    if (error.statusGemini === 429) {
      return res.status(503).json({
        erro: 'A cota gratuita da IA foi atingida por enquanto. Nenhuma cobrança será feita. Tente novamente depois.',
        codigo: 'GEMINI_COTA_GRATUITA_ATINGIDA',
      });
    }
    if (error.statusGemini === 401 || error.statusGemini === 403) {
      return res.status(503).json({
        erro: 'A chave gratuita do Gemini precisa ser revisada.',
        codigo: 'GEMINI_CONFIG_INVALIDA',
      });
    }
    return res.status(500).json({ erro: 'Não foi possível concluir a análise agora. Tente novamente.' });
  }
});


// ============================================================================
// ROTAS: PROVISÕES E CONCILIAÇÕES
// ============================================================================

function validarPayloadProvisao(body = {}, parcial = false) {
  const payload = {};
  if (!parcial || body.descricao !== undefined) {
    payload.descricao = String(body.descricao || '').trim();
    if (!payload.descricao) throw new Error('Descrição é obrigatória.');
  }
  if (!parcial || body.valorPrevisto !== undefined || body.valor_previsto !== undefined) {
    payload.valorPrevisto = Number(body.valorPrevisto ?? body.valor_previsto);
    if (!Number.isFinite(payload.valorPrevisto) || payload.valorPrevisto <= 0) throw new Error('Valor previsto deve ser positivo.');
  }
  if (!parcial || body.tipo !== undefined) {
    payload.tipo = normalizarTipoTransacao(body.tipo);
    if (!TIPOS_PROVISAO.includes(payload.tipo)) throw new Error('Tipo inválido. Use CREDITO ou DEBITO.');
  }
  if (!parcial || body.dataPrevista !== undefined || body.data_prevista !== undefined) {
    payload.dataPrevista = normalizarDataImportacao(body.dataPrevista ?? body.data_prevista);
    if (!payload.dataPrevista) throw new Error('Data prevista é obrigatória.');
  }
  if (body.dataVencimento !== undefined || body.data_vencimento !== undefined) payload.dataVencimento = normalizarDataImportacao(body.dataVencimento ?? body.data_vencimento);
  if (body.contaId !== undefined || body.conta_id !== undefined) payload.contaId = body.contaId || body.conta_id || null;
  if (body.categoriaMacroId !== undefined || body.categoria_macro_id !== undefined) payload.categoriaMacroId = body.categoriaMacroId || body.categoria_macro_id || null;
  if (body.categoriaDetalhadaId !== undefined || body.categoria_detalhada_id !== undefined) payload.categoriaDetalhadaId = body.categoriaDetalhadaId || body.categoria_detalhada_id || null;
  if (body.status !== undefined) {
    payload.status = String(body.status || '').toUpperCase();
    if (!STATUS_PROVISAO.includes(payload.status)) throw new Error('Status de provisão inválido.');
  }
  if (body.observacao !== undefined) payload.observacao = body.observacao || null;
  if (body.recorrente !== undefined) payload.recorrente = Boolean(body.recorrente);
  if (body.periodicidade !== undefined) payload.periodicidade = body.periodicidade || null;
  return payload;
}

async function validarRelacionamentosProvisao(usuarioId, payload) {
  if (payload.contaId) {
    const conta = await pool.query('SELECT id FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = true', [payload.contaId, usuarioId]);
    if (conta.rows.length === 0) throw new Error('Conta não encontrada para este usuário.');
  }
  for (const [campo, id] of [['categoriaMacroId', payload.categoriaMacroId], ['categoriaDetalhadaId', payload.categoriaDetalhadaId]]) {
    if (!id) continue;
    const categoria = await pool.query('SELECT id FROM categorias WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) AND ativa = true', [id, usuarioId]);
    if (categoria.rows.length === 0) throw new Error(`${campo} inválida para este usuário.`);
  }
}


function validarMesAnoPlanejamento(mes, ano) {
  const mesNumero = Number(mes);
  const anoNumero = Number(ano);
  if (!Number.isInteger(mesNumero) || mesNumero < 1 || mesNumero > 12) throw new Error('Mês obrigatório deve estar entre 1 e 12.');
  if (!Number.isInteger(anoNumero) || anoNumero < 1900 || anoNumero > 2100) throw new Error('Ano obrigatório inválido.');
  return { mes: mesNumero, ano: anoNumero };
}

function adicionarMesesPlanejamento(mes, ano, incremento) {
  const data = new Date(Number(ano), Number(mes) - 1 + incremento, 1);
  return { mes: data.getMonth() + 1, ano: data.getFullYear() };
}

function compararPeriodoPlanejamento(aMes, aAno, bMes, bAno) {
  return (Number(aAno) * 12 + Number(aMes)) - (Number(bAno) * 12 + Number(bMes));
}

function validarPayloadPlanejamento(body = {}, parcial = false) {
  const payload = {};
  if (!parcial || body.mes !== undefined || body.ano !== undefined) Object.assign(payload, validarMesAnoPlanejamento(body.mes, body.ano));
  if (!parcial || body.descricao !== undefined) {
    payload.descricao = String(body.descricao || '').trim();
    if (!payload.descricao) throw new Error('Descrição é obrigatória.');
  }
  if (!parcial || body.tipo_despesa !== undefined || body.tipoDespesa !== undefined) {
    payload.tipoDespesa = String(body.tipo_despesa || body.tipoDespesa || '').trim().toUpperCase();
    if (!['FIXA', 'VARIAVEL'].includes(payload.tipoDespesa)) throw new Error('Tipo da despesa deve ser FIXA ou VARIAVEL.');
  }
  if (!parcial || body.recorrencia_tipo !== undefined || body.recorrenciaTipo !== undefined) {
    payload.recorrenciaTipo = String(body.recorrencia_tipo || body.recorrenciaTipo || '').trim().toUpperCase();
    if (!['UNICA', 'MENSAL', 'PARCELADA'].includes(payload.recorrenciaTipo)) throw new Error('Recorrência deve ser UNICA, MENSAL ou PARCELADA.');
  }
  if (payload.recorrenciaTipo === 'MENSAL') {
    const terminaEm = String(body.recorrencia_termino || body.recorrenciaTermino || 'SEM_FIM').trim().toUpperCase();
    payload.recorrenciaTermino = terminaEm === 'COM_FIM' || terminaEm === 'DATA' ? 'COM_FIM' : 'SEM_FIM';
    if (payload.recorrenciaTermino === 'COM_FIM') {
      const fim = validarMesAnoPlanejamento(body.mes_fim ?? body.mesFim, body.ano_fim ?? body.anoFim);
      if (compararPeriodoPlanejamento(fim.mes, fim.ano, payload.mes, payload.ano) < 0) throw new Error('Mês/ano final não pode ser anterior ao início da recorrência.');
      payload.mesFim = fim.mes;
      payload.anoFim = fim.ano;
    } else {
      payload.mesFim = null;
      payload.anoFim = null;
    }
  } else {
    payload.recorrenciaTermino = null;
    payload.mesFim = null;
    payload.anoFim = null;
  }
  if (!parcial || body.valor_previsto !== undefined || body.valorPrevisto !== undefined) {
    payload.valorPrevisto = Number(body.valor_previsto ?? body.valorPrevisto);
    if (!Number.isFinite(payload.valorPrevisto) || payload.valorPrevisto <= 0) throw new Error('Valor previsto é obrigatório e deve ser maior que zero.');
  }
  if (body.dia_previsto !== undefined || body.diaPrevisto !== undefined) {
    const valorDia = body.dia_previsto ?? body.diaPrevisto;
    payload.diaPrevisto = valorDia === '' || valorDia === null ? null : Number(valorDia);
    if (payload.diaPrevisto !== null && (!Number.isInteger(payload.diaPrevisto) || payload.diaPrevisto < 1 || payload.diaPrevisto > 31)) throw new Error('Dia previsto deve estar entre 1 e 31.');
  }
  if (payload.recorrenciaTipo === 'PARCELADA') {
    payload.quantidadeParcelas = Number(body.quantidade_parcelas ?? body.quantidadeParcelas);
    if (!Number.isInteger(payload.quantidadeParcelas) || payload.quantidadeParcelas <= 0) throw new Error('Quantidade de parcelas é obrigatória e deve ser maior que zero.');
    const parcelaInicialBruta = body.parcela_inicial ?? body.parcelaInicial ?? body.parcela_atual ?? body.parcelaAtual ?? 1;
    payload.parcelaInicial = parcelaInicialBruta === '' || parcelaInicialBruta === null ? 1 : Number(parcelaInicialBruta);
    if (!Number.isInteger(payload.parcelaInicial) || payload.parcelaInicial < 1 || payload.parcelaInicial > payload.quantidadeParcelas) throw new Error('Parcela inicial deve estar entre 1 e a quantidade de parcelas.');
  } else {
    payload.quantidadeParcelas = null;
    payload.parcelaInicial = null;
  }
  if (body.categoria !== undefined) payload.categoria = String(body.categoria || '').trim() || null;
  if (body.categoria_id !== undefined || body.categoriaId !== undefined) payload.categoriaId = String(body.categoria_id || body.categoriaId || '').trim() || null;
  if (body.observacao !== undefined) payload.observacao = String(body.observacao || '').trim() || null;
  return payload;
}

function montarLancamentosPlanejamento(usuarioId, payload, recorrenciaId = crypto.randomUUID()) {
  const totalLancamentos = payload.recorrenciaTipo === 'PARCELADA'
    ? payload.quantidadeParcelas - payload.parcelaInicial + 1
    : payload.recorrenciaTipo === 'MENSAL' && payload.mesFim && payload.anoFim
      ? compararPeriodoPlanejamento(payload.mesFim, payload.anoFim, payload.mes, payload.ano) + 1
      : 1;

  return Array.from({ length: totalLancamentos }, (_, indice) => {
    const periodo = adicionarMesesPlanejamento(payload.mes, payload.ano, indice);
    const parcelaAtual = payload.recorrenciaTipo === 'PARCELADA' ? payload.parcelaInicial + indice : null;
    const descricao = payload.recorrenciaTipo === 'PARCELADA' ? `${payload.descricao} (${parcelaAtual}/${payload.quantidadeParcelas})` : payload.descricao;
    return [usuarioId, periodo.mes, periodo.ano, descricao, payload.categoria || null, payload.categoriaId || null, payload.tipoDespesa, payload.valorPrevisto, payload.diaPrevisto ?? null, payload.observacao || null, payload.recorrenciaTipo, recorrenciaId, payload.quantidadeParcelas, parcelaAtual, payload.mes, payload.ano, payload.mesFim, payload.anoFim, true];
  });
}

async function materializarRecorrenciasMensaisUsuario(usuarioId, mes, ano) {
  const recorrentes = await pool.query(
    `SELECT DISTINCT ON (recorrencia_id) *
     FROM planejamentos_mensais
     WHERE usuario_id = $1
       AND recorrencia_tipo = 'MENSAL'
       AND ativa = true
       AND recorrencia_id IS NOT NULL
       AND (ano_inicio * 12 + mes_inicio) <= ($3::int * 12 + $2::int)
       AND (ano * 12 + mes) <= ($3::int * 12 + $2::int)
       AND (ano_fim IS NULL OR mes_fim IS NULL OR (ano_fim * 12 + mes_fim) >= ($3::int * 12 + $2::int))
     ORDER BY recorrencia_id, ano DESC, mes DESC, criado_em DESC`,
    [usuarioId, mes, ano]
  );

  for (const item of recorrentes.rows) {
    const existente = await pool.query(
      `SELECT id FROM planejamentos_mensais WHERE usuario_id = $1 AND recorrencia_id = $2 AND mes = $3 AND ano = $4 LIMIT 1`,
      [usuarioId, item.recorrencia_id, mes, ano]
    );
    if (existente.rows.length > 0) continue;

    await pool.query(
      `INSERT INTO planejamentos_mensais (usuario_id, mes, ano, descricao, categoria, categoria_id, tipo_despesa, valor_previsto, dia_previsto, observacao, recorrencia_tipo, recorrencia_id, quantidade_parcelas, parcela_atual, mes_inicio, ano_inicio, mes_fim, ano_fim, ativa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'MENSAL',$11,NULL,NULL,$12,$13,$14,$15,true)`,
      [usuarioId, mes, ano, item.descricao, item.categoria, item.categoria_id, item.tipo_despesa, item.valor_previsto, item.dia_previsto, item.observacao, item.recorrencia_id, item.mes_inicio, item.ano_inicio, item.mes_fim, item.ano_fim]
    );
  }
}


function montarResumoPlanejamento(rows = [], totalRealizado = 0) {
  const totalFixas = rows.filter((item) => item.tipo_despesa === 'FIXA').reduce((soma, item) => soma + Number(item.valor_previsto || 0), 0);
  const totalVariaveis = rows.filter((item) => item.tipo_despesa === 'VARIAVEL').reduce((soma, item) => soma + Number(item.valor_previsto || 0), 0);
  const totalPrevisto = totalFixas + totalVariaveis;
  return { totalFixas, totalVariaveis, totalPrevisto, quantidade: rows.length, totalRealizado, diferencaPrevistoRealizado: totalPrevisto - totalRealizado };
}

async function validarCategoriaPlanejamentoUsuario(usuarioId, categoriaId) {
  if (!categoriaId) return null;
  const result = await pool.query(
    `SELECT id, nome FROM categorias WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) AND ativa = true LIMIT 1`,
    [categoriaId, usuarioId]
  );
  if (result.rows.length === 0) throw new Error('Categoria inválida para este usuário.');
  return result.rows[0];
}

function chaveComparativoCategoria(id, nome) {
  return id ? `id:${id}` : `nome:${String(nome || 'Sem categoria').trim().toLowerCase()}`;
}

async function buscarComparativoPlanejadoRealizadoPorCategoria(usuarioId, mes, ano) {
  const planejados = await pool.query(
    `SELECT p.categoria_id, COALESCE(cat.nome, NULLIF(TRIM(p.categoria), ''), 'Sem categoria') AS categoria_nome, COALESCE(SUM(p.valor_previsto), 0) AS valor_planejado
     FROM planejamentos_mensais p
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     WHERE p.usuario_id = $1 AND p.mes = $2 AND p.ano = $3 AND p.ativa = true
     GROUP BY p.categoria_id, COALESCE(cat.nome, NULLIF(TRIM(p.categoria), ''), 'Sem categoria')`,
    [usuarioId, mes, ano]
  );

  const realizados = await pool.query(
    `SELECT COALESCE(t.categoria_macro_id, CASE WHEN cat.categoria_pai_id IS NULL THEN t.categoria_id ELSE cat.categoria_pai_id END) AS categoria_id,
            COALESCE(cm.nome, cat_macro.nome, CASE WHEN cat.categoria_pai_id IS NULL THEN cat.nome ELSE NULL END, cat.nome, 'Sem categoria') AS categoria_nome,
            COALESCE(SUM(ABS(t.valor)), 0) AS valor_realizado
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     LEFT JOIN categorias cat ON cat.id = t.categoria_id
     LEFT JOIN categorias cat_macro ON cat_macro.id = cat.categoria_pai_id
     LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND EXTRACT(MONTH FROM t.data) = $2
       AND EXTRACT(YEAR FROM t.data) = $3
       AND UPPER(t.tipo) IN ('DEBITO', 'DESPESA')
     GROUP BY COALESCE(t.categoria_macro_id, CASE WHEN cat.categoria_pai_id IS NULL THEN t.categoria_id ELSE cat.categoria_pai_id END),
              COALESCE(cm.nome, cat_macro.nome, CASE WHEN cat.categoria_pai_id IS NULL THEN cat.nome ELSE NULL END, cat.nome, 'Sem categoria')`,
    [usuarioId, mes, ano]
  );

  const mapa = new Map();
  for (const row of planejados.rows) {
    const chave = chaveComparativoCategoria(row.categoria_id, row.categoria_nome);
    mapa.set(chave, { categoriaId: row.categoria_id, categoria: row.categoria_nome, valorPlanejado: Number(row.valor_planejado || 0), valorRealizado: 0 });
  }
  for (const row of realizados.rows) {
    const chavePorId = chaveComparativoCategoria(row.categoria_id, row.categoria_nome);
    const chavePorNome = chaveComparativoCategoria(null, row.categoria_nome);
    const chave = mapa.has(chavePorId) ? chavePorId : mapa.has(chavePorNome) ? chavePorNome : chavePorId;
    const atual = mapa.get(chave) || { categoriaId: row.categoria_id, categoria: row.categoria_nome, valorPlanejado: 0, valorRealizado: 0 };
    atual.categoriaId = atual.categoriaId || row.categoria_id;
    atual.valorRealizado += Number(row.valor_realizado || 0);
    mapa.set(chave, atual);
  }

  return Array.from(mapa.values()).map((item) => {
    const diferenca = item.valorPlanejado - item.valorRealizado;
    const percentualUtilizado = item.valorPlanejado > 0 ? Number(((item.valorRealizado / item.valorPlanejado) * 100).toFixed(1)) : null;
    return { ...item, diferenca, percentualUtilizado };
  }).sort((a, b) => (b.valorPlanejado + b.valorRealizado) - (a.valorPlanejado + a.valorRealizado));
}

async function buscarTotalRealizadoMes(usuarioId, mes, ano) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(ABS(t.valor)), 0) AS total
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE c.usuario_id = $1
       AND t.deletado_em IS NULL
       AND COALESCE(t.eh_transferencia_interna, false) = false
       AND EXTRACT(MONTH FROM t.data) = $2
       AND EXTRACT(YEAR FROM t.data) = $3
       AND UPPER(t.tipo) IN ('DEBITO', 'DESPESA')`,
    [usuarioId, mes, ano]
  );
  return Number(result.rows[0]?.total || 0);
}

app.get('/api/planejamento', verificarToken, async (req, res) => {
  try {
    const { mes, ano } = validarMesAnoPlanejamento(req.query.mes, req.query.ano);
    await materializarRecorrenciasMensaisUsuario(req.usuario.usuario_id, mes, ano);
    const filtros = normalizarFiltrosPlanejamento(req.query);
    const valores = [req.usuario.usuario_id, mes, ano];
    const where = ['usuario_id = $1', 'mes = $2', 'ano = $3', 'ativa = true'];
    aplicarFiltrosPlanejamento(where, valores, filtros, 'planejamentos_mensais');
    const result = await pool.query(
      `SELECT * FROM planejamentos_mensais WHERE ${where.join(' AND ')} ORDER BY tipo_despesa, dia_previsto NULLS LAST, criado_em DESC`,
      valores
    );
    const totalRealizado = await buscarTotalRealizadoMes(req.usuario.usuario_id, mes, ano);
    const comparativoCategorias = await buscarComparativoPlanejadoRealizadoPorCategoria(req.usuario.usuario_id, mes, ano);
    res.json({ planejamentos: result.rows, resumo: montarResumoPlanejamento(result.rows, totalRealizado), comparativoCategorias });
  } catch (error) { res.status(400).json({ erro: error.message }); }
});


function montarLabelMesPlanejamento(mes, ano) {
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${nomes[Number(mes) - 1]}/${String(ano).slice(-2)}`;
}


function normalizarFiltrosPlanejamento(query = {}) {
  const tipo = String(query.tipo || 'TODOS').trim().toUpperCase();
  const recorrencia = String(query.recorrencia || 'TODAS').trim().toUpperCase();
  const categoria = String(query.categoria || '').trim();
  return {
    tipo: ['FIXA', 'VARIAVEL'].includes(tipo) ? tipo : 'TODOS',
    recorrencia: ['UNICA', 'MENSAL', 'PARCELADA'].includes(recorrencia) ? recorrencia : 'TODAS',
    categoria,
  };
}

function aplicarFiltrosPlanejamento(where, valores, filtros, alias = 'p') {
  if (filtros.tipo !== 'TODOS') {
    valores.push(filtros.tipo);
    where.push(`${alias}.tipo_despesa = $${valores.length}`);
  }
  if (filtros.recorrencia !== 'TODAS') {
    valores.push(filtros.recorrencia);
    where.push(`${alias}.recorrencia_tipo = $${valores.length}`);
  }
  if (filtros.categoria) {
    valores.push(filtros.categoria);
    const indice = valores.length;
    where.push(`(${alias}.categoria_id::text = $${indice} OR LOWER(COALESCE(NULLIF(TRIM(${alias}.categoria), ''), 'Sem categoria')) = LOWER($${indice}))`);
  }
}

app.get('/api/planejamento/resumo-mensal', verificarToken, async (req, res) => {
  try {
    const { mes: mesInicio, ano: anoInicio } = validarMesAnoPlanejamento(req.query.mesInicio, req.query.anoInicio);
    const quantidadeMeses = Number(req.query.quantidadeMeses || 12);
    if (!Number.isInteger(quantidadeMeses) || quantidadeMeses < 1 || quantidadeMeses > 24) throw new Error('Quantidade de meses deve estar entre 1 e 24.');

    const meses = [];
    for (let indice = 0; indice < quantidadeMeses; indice++) {
      const periodo = adicionarMesesPlanejamento(mesInicio, anoInicio, indice);
      await materializarRecorrenciasMensaisUsuario(req.usuario.usuario_id, periodo.mes, periodo.ano);
      meses.push(periodo);
    }

    const primeiro = meses[0];
    const ultimo = meses[meses.length - 1];
    const filtros = normalizarFiltrosPlanejamento(req.query);
    const valores = [req.usuario.usuario_id, primeiro.ano, primeiro.mes, ultimo.ano, ultimo.mes];
    const where = ['usuario_id = $1', 'ativa = true', '(ano * 12 + mes) BETWEEN ($2::int * 12 + $3::int) AND ($4::int * 12 + $5::int)'];
    aplicarFiltrosPlanejamento(where, valores, filtros, 'planejamentos_mensais');
    const result = await pool.query(
      `SELECT mes, ano,
              COALESCE(SUM(CASE WHEN tipo_despesa = 'FIXA' THEN valor_previsto ELSE 0 END), 0) AS total_fixas,
              COALESCE(SUM(CASE WHEN tipo_despesa = 'VARIAVEL' THEN valor_previsto ELSE 0 END), 0) AS total_variaveis,
              COALESCE(SUM(CASE WHEN recorrencia_tipo = 'PARCELADA' THEN valor_previsto ELSE 0 END), 0) AS total_parceladas,
              COALESCE(SUM(valor_previsto), 0) AS total_previsto,
              COUNT(*)::int AS quantidade_itens
       FROM planejamentos_mensais
       WHERE ${where.join(' AND ')}
       GROUP BY mes, ano`,
      valores
    );

    const porPeriodo = new Map(result.rows.map((row) => [`${row.ano}-${row.mes}`, row]));
    res.json({
      meses: meses.map((periodo) => {
        const row = porPeriodo.get(`${periodo.ano}-${periodo.mes}`) || {};
        const totalFixas = Number(row.total_fixas || 0);
        const totalVariaveis = Number(row.total_variaveis || 0);
        const totalParceladas = Number(row.total_parceladas || 0);
        return {
          mes: periodo.mes,
          ano: periodo.ano,
          label: montarLabelMesPlanejamento(periodo.mes, periodo.ano),
          total_fixas: totalFixas,
          total_variaveis: totalVariaveis,
          total_parceladas: totalParceladas,
          total_previsto: Number(row.total_previsto || totalFixas + totalVariaveis),
          quantidade_itens: Number(row.quantidade_itens || 0),
        };
      })
    });
  } catch (error) { res.status(400).json({ erro: error.message }); }
});


app.get('/api/planejamento/resumo-categorias', verificarToken, async (req, res) => {
  try {
    const { mes: mesInicio, ano: anoInicio } = validarMesAnoPlanejamento(req.query.mesInicio, req.query.anoInicio);
    const quantidadeMeses = Number(req.query.quantidadeMeses || 12);
    if (!Number.isInteger(quantidadeMeses) || quantidadeMeses < 1 || quantidadeMeses > 24) throw new Error('Quantidade de meses deve estar entre 1 e 24.');

    const meses = [];
    for (let indice = 0; indice < quantidadeMeses; indice++) {
      const periodo = adicionarMesesPlanejamento(mesInicio, anoInicio, indice);
      await materializarRecorrenciasMensaisUsuario(req.usuario.usuario_id, periodo.mes, periodo.ano);
      meses.push(periodo);
    }

    const primeiro = meses[0];
    const ultimo = meses[meses.length - 1];
    const filtros = normalizarFiltrosPlanejamento(req.query);
    const valores = [req.usuario.usuario_id, primeiro.ano, primeiro.mes, ultimo.ano, ultimo.mes];
    const where = ['p.usuario_id = $1', 'p.ativa = true', '(p.ano * 12 + p.mes) BETWEEN ($2::int * 12 + $3::int) AND ($4::int * 12 + $5::int)'];
    aplicarFiltrosPlanejamento(where, valores, filtros, 'p');

    const result = await pool.query(
      `SELECT p.mes, p.ano,
              COALESCE(cat.nome, NULLIF(TRIM(p.categoria), ''), 'Sem categoria') AS categoria,
              COALESCE(SUM(p.valor_previsto), 0) AS valor
       FROM planejamentos_mensais p
       LEFT JOIN categorias cat ON cat.id = p.categoria_id
       WHERE ${where.join(' AND ')}
       GROUP BY p.mes, p.ano, COALESCE(cat.nome, NULLIF(TRIM(p.categoria), ''), 'Sem categoria')
       ORDER BY p.ano, p.mes, categoria`,
      valores
    );

    const porPeriodo = new Map(meses.map((periodo) => [`${periodo.ano}-${periodo.mes}`, []]));
    for (const row of result.rows) {
      const chave = `${row.ano}-${row.mes}`;
      const lista = porPeriodo.get(chave) || [];
      lista.push({ categoria: row.categoria || 'Sem categoria', valor: Number(row.valor || 0) });
      porPeriodo.set(chave, lista);
    }

    res.json({
      meses: meses.map((periodo) => {
        const categorias = (porPeriodo.get(`${periodo.ano}-${periodo.mes}`) || []).sort((a, b) => b.valor - a.valor);
        return {
          mes: periodo.mes,
          ano: periodo.ano,
          label: montarLabelMesPlanejamento(periodo.mes, periodo.ano),
          total_previsto: categorias.reduce((total, item) => total + Number(item.valor || 0), 0),
          categorias,
        };
      })
    });
  } catch (error) { res.status(400).json({ erro: error.message }); }
});

app.post('/api/planejamento', verificarToken, async (req, res) => {
  try {
    const p = validarPayloadPlanejamento(req.body);
    if (p.categoriaId) {
      const categoria = await validarCategoriaPlanejamentoUsuario(req.usuario.usuario_id, p.categoriaId);
      p.categoria = p.categoria || categoria.nome;
    }
    const lancamentos = montarLancamentosPlanejamento(req.usuario.usuario_id, p);
    const placeholders = lancamentos.map((_, indice) => {
      const base = indice * 19;
      return `(${Array.from({ length: 19 }, (__, coluna) => `$${base + coluna + 1}`).join(',')})`;
    }).join(',');
    const result = await pool.query(
      `INSERT INTO planejamentos_mensais (usuario_id, mes, ano, descricao, categoria, categoria_id, tipo_despesa, valor_previsto, dia_previsto, observacao, recorrencia_tipo, recorrencia_id, quantidade_parcelas, parcela_atual, mes_inicio, ano_inicio, mes_fim, ano_fim, ativa)
       VALUES ${placeholders} RETURNING *`,
      lancamentos.flat()
    );
    res.status(201).json({ planejamento: result.rows[0], planejamentos: result.rows });
  } catch (error) { res.status(400).json({ erro: error.message }); }
});

app.put('/api/planejamento/:id', verificarToken, async (req, res) => {
  try {
    const p = validarPayloadPlanejamento(req.body);
    const escopoEdicao = String(req.body.escopo_edicao || req.body.escopoEdicao || 'APENAS_ESTE').trim().toUpperCase();
    if (!['APENAS_ESTE', 'ESTE_E_PROXIMOS', 'TODA_RECORRENCIA'].includes(escopoEdicao)) throw new Error('Escopo de edição inválido.');
    if (p.categoriaId) {
      const categoria = await validarCategoriaPlanejamentoUsuario(req.usuario.usuario_id, p.categoriaId);
      p.categoria = p.categoria || categoria.nome;
    }

    const atualResult = await pool.query(
      `SELECT * FROM planejamentos_mensais WHERE id = $1 AND usuario_id = $2 LIMIT 1`,
      [req.params.id, req.usuario.usuario_id]
    );
    if (atualResult.rows.length === 0) return res.status(404).json({ erro: 'Planejamento não encontrado.' });
    const atual = atualResult.rows[0];
    const escopoEfetivo = atual.recorrencia_tipo && atual.recorrencia_tipo !== 'UNICA' ? escopoEdicao : 'APENAS_ESTE';
    if (escopoEfetivo !== 'APENAS_ESTE' && !atual.recorrencia_id) throw new Error('Este lançamento não possui identificador de recorrência.');

    const valoresComuns = [
      p.descricao,
      p.categoria || null,
      p.categoriaId || null,
      p.tipoDespesa,
      p.valorPrevisto,
      p.diaPrevisto ?? null,
      p.observacao || null,
      p.recorrenciaTipo,
      p.quantidadeParcelas,
      p.mesFim,
      p.anoFim,
    ];

    let result;
    if (escopoEfetivo === 'APENAS_ESTE') {
      result = await pool.query(
        `UPDATE planejamentos_mensais
         SET mes=$1, ano=$2, descricao=$3, categoria=$4, categoria_id=$5, tipo_despesa=$6, valor_previsto=$7, dia_previsto=$8, observacao=$9, recorrencia_tipo=$10, quantidade_parcelas=$11, parcela_atual=$12, mes_inicio=$13, ano_inicio=$14, mes_fim=$15, ano_fim=$16, atualizado_em=NOW()
         WHERE id=$17 AND usuario_id=$18 RETURNING *`,
        [p.mes, p.ano, p.descricao, p.categoria || null, p.categoriaId || null, p.tipoDespesa, p.valorPrevisto, p.diaPrevisto ?? null, p.observacao || null, p.recorrenciaTipo, p.quantidadeParcelas, p.parcelaInicial, p.mes, p.ano, p.mesFim, p.anoFim, req.params.id, req.usuario.usuario_id]
      );
    } else {
      const condicaoEscopo = escopoEfetivo === 'ESTE_E_PROXIMOS'
        ? `AND (ano * 12 + mes) >= ($15::int * 12 + $14::int)`
        : '';
      const valoresEscopo = [...valoresComuns, req.usuario.usuario_id, atual.recorrencia_id];
      if (escopoEfetivo === 'ESTE_E_PROXIMOS') valoresEscopo.push(atual.mes, atual.ano);
      result = await pool.query(
        `UPDATE planejamentos_mensais
         SET descricao=$1, categoria=$2, categoria_id=$3, tipo_despesa=$4, valor_previsto=$5, dia_previsto=$6, observacao=$7, recorrencia_tipo=$8, quantidade_parcelas=$9, mes_fim=$10, ano_fim=$11, atualizado_em=NOW()
         WHERE usuario_id=$12 AND recorrencia_id=$13 ${condicaoEscopo}
         RETURNING *`,
        valoresEscopo
      );
    }

    if (result.rows.length === 0) return res.status(404).json({ erro: 'Nenhum lançamento encontrado para o escopo selecionado.' });
    res.json({ planejamento: result.rows[0], planejamentos: result.rows, escopo_edicao: escopoEfetivo, quantidade_alterada: result.rowCount });
  } catch (error) { res.status(400).json({ erro: error.message }); }
});

app.delete('/api/planejamento/:id', verificarToken, async (req, res) => {
  try {
    const atual = await pool.query('SELECT id, recorrencia_tipo FROM planejamentos_mensais WHERE id = $1 AND usuario_id = $2', [req.params.id, req.usuario.usuario_id]);
    if (atual.rows.length === 0) return res.status(404).json({ erro: 'Planejamento não encontrado.' });

    if (atual.rows[0].recorrencia_tipo && atual.rows[0].recorrencia_tipo !== 'UNICA') {
      await pool.query('UPDATE planejamentos_mensais SET ativa = false, atualizado_em = NOW() WHERE id = $1 AND usuario_id = $2', [req.params.id, req.usuario.usuario_id]);
    } else {
      await pool.query('DELETE FROM planejamentos_mensais WHERE id = $1 AND usuario_id = $2', [req.params.id, req.usuario.usuario_id]);
    }

    res.json({ sucesso: true });
  } catch (error) { res.status(400).json({ erro: error.message }); }
});

app.get('/api/provisoes', verificarToken, async (req, res) => {
  try {
    const valores = [req.usuario.usuario_id];
    const where = ['p.usuario_id = $1'];
    const filtros = req.query;
    if (filtros.dataInicial) { valores.push(filtros.dataInicial); where.push(`p.data_prevista >= $${valores.length}::date`); }
    if (filtros.dataFinal) { valores.push(filtros.dataFinal); where.push(`p.data_prevista <= $${valores.length}::date`); }
    if (filtros.status && filtros.status !== 'todos') { valores.push(String(filtros.status).toUpperCase()); where.push(`p.status = $${valores.length}`); }
    if (filtros.tipo && filtros.tipo !== 'todos') { valores.push(String(filtros.tipo).toUpperCase()); where.push(`p.tipo = $${valores.length}`); }
    if (filtros.contaId && filtros.contaId !== 'todas') { valores.push(filtros.contaId); where.push(`p.conta_id = $${valores.length}`); }
    if (filtros.categoriaMacroId && filtros.categoriaMacroId !== 'todas') { valores.push(filtros.categoriaMacroId); where.push(`p.categoria_macro_id = $${valores.length}`); }
    if (filtros.categoriaDetalhadaId && filtros.categoriaDetalhadaId !== 'todas') { valores.push(filtros.categoriaDetalhadaId); where.push(`p.categoria_detalhada_id = $${valores.length}`); }
    if (filtros.busca) { valores.push(`%${String(filtros.busca).trim()}%`); where.push(`p.descricao ILIKE $${valores.length}`); }

    const result = await pool.query(
      `SELECT p.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome,
              ca.id AS conciliacao_id, ca.transacao_id AS transacao_conciliada_id, ca.confianca AS conciliacao_confianca,
              t.descricao AS transacao_conciliada_descricao, t.data AS transacao_conciliada_data, t.valor AS transacao_conciliada_valor
       FROM provisoes p
       LEFT JOIN contas c ON c.id = p.conta_id
       LEFT JOIN categorias cm ON cm.id = p.categoria_macro_id
       LEFT JOIN categorias cd ON cd.id = p.categoria_detalhada_id
       LEFT JOIN conciliacoes ca ON ca.provisao_id = p.id AND ca.status = 'CONFIRMADA'
       LEFT JOIN transacoes t ON t.id = ca.transacao_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.data_prevista DESC, p.criado_em DESC
       LIMIT 1000`,
      valores
    );
    res.json({ provisoes: result.rows.map(montarProvisao) });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/provisoes', verificarToken, async (req, res) => {
  try {
    const payload = validarPayloadProvisao(req.body);
    await validarRelacionamentosProvisao(req.usuario.usuario_id, payload);
    const result = await pool.query(
      `INSERT INTO provisoes (usuario_id, descricao, valor_previsto, tipo, data_prevista, data_vencimento, conta_id, categoria_macro_id, categoria_detalhada_id, status, observacao, recorrente, periodicidade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'PENDENTE'),$11,$12,$13)
       RETURNING *`,
      [req.usuario.usuario_id, payload.descricao, payload.valorPrevisto, payload.tipo, payload.dataPrevista, payload.dataVencimento || null, payload.contaId || null, payload.categoriaMacroId || null, payload.categoriaDetalhadaId || null, payload.status || 'PENDENTE', payload.observacao || null, payload.recorrente || false, payload.periodicidade || null]
    );
    res.status(201).json({ provisao: montarProvisao(result.rows[0]) });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.patch('/api/provisoes/:id', verificarToken, async (req, res) => {
  try {
    const atual = await pool.query('SELECT * FROM provisoes WHERE id = $1 AND usuario_id = $2', [req.params.id, req.usuario.usuario_id]);
    if (atual.rows.length === 0) return res.status(404).json({ erro: 'Provisão não encontrada.' });
    const camposCriticos = ['valorPrevisto', 'valor_previsto', 'tipo', 'dataPrevista', 'data_prevista', 'contaId', 'conta_id'];
    if (atual.rows[0].status === 'CONCILIADA' && camposCriticos.some((campo) => req.body[campo] !== undefined)) {
      return res.status(400).json({ erro: 'Desfaça a conciliação antes de editar campos críticos da provisão.' });
    }
    const payload = validarPayloadProvisao(req.body, true);
    await validarRelacionamentosProvisao(req.usuario.usuario_id, payload);
    const result = await pool.query(
      `UPDATE provisoes SET
        descricao = COALESCE($1, descricao),
        valor_previsto = COALESCE($2, valor_previsto),
        tipo = COALESCE($3, tipo),
        data_prevista = COALESCE($4, data_prevista),
        data_vencimento = CASE WHEN $5::text IS NULL THEN data_vencimento ELSE $5::date END,
        conta_id = CASE WHEN $6::text IS NULL THEN conta_id ELSE $6::uuid END,
        categoria_macro_id = CASE WHEN $7::text IS NULL THEN categoria_macro_id ELSE $7::uuid END,
        categoria_detalhada_id = CASE WHEN $8::text IS NULL THEN categoria_detalhada_id ELSE $8::uuid END,
        status = COALESCE($9, status),
        observacao = CASE WHEN $10::text IS NULL THEN observacao ELSE $10 END,
        recorrente = COALESCE($11, recorrente),
        periodicidade = CASE WHEN $12::text IS NULL THEN periodicidade ELSE $12 END,
        atualizado_em = NOW()
       WHERE id = $13 AND usuario_id = $14
       RETURNING *`,
      [payload.descricao, payload.valorPrevisto, payload.tipo, payload.dataPrevista, payload.dataVencimento, payload.contaId, payload.categoriaMacroId, payload.categoriaDetalhadaId, payload.status, payload.observacao, payload.recorrente, payload.periodicidade, req.params.id, req.usuario.usuario_id]
    );
    res.json({ provisao: montarProvisao(result.rows[0]) });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.delete('/api/provisoes/:id', verificarToken, async (req, res) => {
  try {
    const conciliada = await pool.query(
      `SELECT p.id, p.status, ca.id AS conciliacao_id FROM provisoes p LEFT JOIN conciliacoes ca ON ca.provisao_id = p.id AND ca.status = 'CONFIRMADA' WHERE p.id = $1 AND p.usuario_id = $2`,
      [req.params.id, req.usuario.usuario_id]
    );
    if (conciliada.rows.length === 0) return res.status(404).json({ erro: 'Provisão não encontrada.' });
    if (conciliada.rows[0].conciliacao_id && req.query.confirmar !== 'true') {
      return res.status(409).json({ erro: 'Provisão conciliada. Confirme a exclusão para desfazer/remover o vínculo.' });
    }
    await pool.query('DELETE FROM provisoes WHERE id = $1 AND usuario_id = $2', [req.params.id, req.usuario.usuario_id]);
    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/provisoes/:id/duplicar', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO provisoes (usuario_id, descricao, valor_previsto, tipo, data_prevista, data_vencimento, conta_id, categoria_macro_id, categoria_detalhada_id, status, observacao, recorrente, periodicidade)
       SELECT usuario_id, descricao || ' (cópia)', valor_previsto, tipo, data_prevista, data_vencimento, conta_id, categoria_macro_id, categoria_detalhada_id, 'PENDENTE', observacao, recorrente, periodicidade
       FROM provisoes WHERE id = $1 AND usuario_id = $2 RETURNING *`,
      [req.params.id, req.usuario.usuario_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Provisão não encontrada.' });
    res.status(201).json({ provisao: montarProvisao(result.rows[0]) });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/conciliacoes/sugerir', verificarToken, async (req, res) => {
  try {
    const { transacaoIds = [], dataInicial, dataFinal, provisaoId } = req.body;
    const provisoes = provisaoId
      ? (await pool.query(`SELECT p.* FROM provisoes p WHERE p.id = $1 AND p.usuario_id = $2`, [provisaoId, req.usuario.usuario_id])).rows.map(montarProvisao)
      : await buscarProvisoesPendentesParaConciliacao(req.usuario.usuario_id, { dataInicial, dataFinal });

    const valores = [req.usuario.usuario_id];
    const where = ['c.usuario_id = $1', 't.deletado_em IS NULL'];
    if (Array.isArray(transacaoIds) && transacaoIds.length > 0) { valores.push(transacaoIds); where.push(`t.id = ANY($${valores.length}::uuid[])`); }
    if (dataInicial) { valores.push(dataInicial); where.push(`t.data >= $${valores.length}::date`); }
    if (dataFinal) { valores.push(dataFinal); where.push(`t.data <= $${valores.length}::date`); }
    where.push(`NOT EXISTS (SELECT 1 FROM conciliacoes ca WHERE ca.transacao_id = t.id AND ca.status = 'CONFIRMADA')`);
    const transacoesResult = await pool.query(
      `SELECT t.*, c.nome AS conta_nome, cm.nome AS categoria_macro_nome, cd.nome AS categoria_detalhada_nome
       FROM transacoes t
       JOIN contas c ON c.id = t.conta_id
       LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
       LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.data DESC LIMIT 1000`,
      valores
    );
    const ignoradas = await pool.query(`SELECT provisao_id, transacao_id FROM conciliacoes WHERE usuario_id = $1 AND status = 'IGNORADA'`, [req.usuario.usuario_id]);
    res.json({ sugestoes: montarSugestoesConciliacao(provisoes, transacoesResult.rows, ignoradas.rows) });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.post('/api/conciliacoes/confirmar', verificarToken, async (req, res) => {
  try {
    const conciliacao = await confirmarConciliacaoUsuario(req.usuario.usuario_id, req.body.provisaoId, req.body.transacaoId);
    res.status(201).json({ conciliacao });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.post('/api/conciliacoes/ignorar', verificarToken, async (req, res) => {
  try {
    const { provisaoId, transacaoId, confianca = 'BAIXA', score = 0, motivos = ['Sugestão ignorada pelo usuário'] } = req.body;
    await validarEntidadesConciliacao(req.usuario.usuario_id, provisaoId, transacaoId);
    const result = await pool.query(
      `INSERT INTO conciliacoes (usuario_id, provisao_id, transacao_id, status, confianca, score, motivos, ignorado_em)
       VALUES ($1,$2,$3,'IGNORADA',$4,$5,$6::jsonb,NOW()) RETURNING *`,
      [req.usuario.usuario_id, provisaoId, transacaoId, confianca, score, JSON.stringify(motivos)]
    );
    res.status(201).json({ conciliacao: result.rows[0] });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.post('/api/conciliacoes/desfazer', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE conciliacoes SET status = 'DESFEITA' WHERE id = $1 AND usuario_id = $2 AND status = 'CONFIRMADA' RETURNING provisao_id`,
      [req.body.conciliacaoId, req.usuario.usuario_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Conciliação confirmada não encontrada.' });
    await pool.query(`UPDATE provisoes SET status = 'PENDENTE', atualizado_em = NOW() WHERE id = $1 AND usuario_id = $2`, [result.rows[0].provisao_id, req.usuario.usuario_id]);
    res.json({ sucesso: true });
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
         t.categoria_macro_id,
         t.categoria_detalhada_id,
         COALESCE(t.eh_transferencia_interna, false) AS eh_transferencia_interna,
         COALESCE(cm.nome, cat.nome, 'Sem categoria') AS categoria_nome,
         COALESCE(cm.nome, cat.nome, 'Sem categoria') AS categoria_macro_nome,
         cd.nome AS categoria_detalhada_nome,
         conta.id AS conta_id,
         conta.nome AS conta_nome,
         ca.status AS status_conciliacao
       FROM transacoes t
       JOIN contas conta ON conta.id = t.conta_id
       LEFT JOIN categorias cat ON cat.id = t.categoria_id
       LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
       LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
       LEFT JOIN conciliacoes ca ON ca.transacao_id = t.id AND ca.status = 'CONFIRMADA'
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
    const transacoesCategorizadas = transacoes.filter((tx) => tx.categoria_macro_id || tx.categoria_id).length;

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
        const categoria = tx.categoria_macro_nome || tx.categoria_nome || 'Sem categoria';
        despesasPorCategoriaMap.set(categoria, (despesasPorCategoriaMap.get(categoria) || 0) + tx.valor);
        gastosPorDiaMap.set(tx.data, (gastosPorDiaMap.get(tx.data) || 0) + tx.valor);
      }
    });

    const provisoesResult = await pool.query(
      `SELECT status, tipo, COALESCE(SUM(valor_previsto), 0) AS total, COUNT(*) AS quantidade
       FROM provisoes
       WHERE usuario_id = $1 AND data_prevista BETWEEN $2::date AND $3::date
       GROUP BY status, tipo`,
      [req.usuario.usuario_id, dataInicial, dataFinal]
    );
    const provisoesResumo = provisoesResult.rows.reduce((acc, item) => {
      const total = Number(item.total || 0);
      const quantidade = Number(item.quantidade || 0);
      if (item.tipo === 'DEBITO') acc.totalProvisionadoPagar += total;
      if (item.tipo === 'CREDITO') acc.totalProvisionadoReceber += total;
      if (item.status === 'PENDENTE') acc.pendentes += quantidade;
      if (item.status === 'CONCILIADA') acc.conciliadas += quantidade;
      if (item.status === 'ATRASADA') acc.atrasadas += quantidade;
      acc.total += quantidade;
      return acc;
    }, { totalProvisionadoPagar: 0, totalProvisionadoReceber: 0, pendentes: 0, conciliadas: 0, atrasadas: 0, total: 0 });
    provisoesResumo.percentualConciliado = provisoesResumo.total ? Number(((provisoesResumo.conciliadas / provisoesResumo.total) * 100).toFixed(1)) : 0;
    provisoesResumo.totalRealizadoConciliado = transacoes.filter((tx) => tx.status_conciliacao === 'CONFIRMADA').reduce((total, tx) => total + tx.valor, 0);
    provisoesResumo.diferencaRealizadoProvisionado = provisoesResumo.totalRealizadoConciliado - (provisoesResumo.totalProvisionadoReceber - provisoesResumo.totalProvisionadoPagar);

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
        provisoes: provisoesResumo,
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

function descricaoIndicaPagamentoCartao(descricao) {
  const texto = String(descricao || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/\bPAGAMENTO\s+(RECEBIDO|DE\s+FATURA|DA\s+FATURA|FATURA)\b/.test(texto)) return true;
  return /\bPAGAMENTO\s+EM\s+\d{1,2}\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\b/.test(texto);
}

function contaEhCartao(conta) {
  return String(conta?.conta_tipo || conta?.tipo || '').trim().toUpperCase() === 'CREDIT_CARD';
}

async function conciliarPagamentosCartaoImportados(usuarioId, transacaoIds = []) {
  const ids = [...new Set((transacaoIds || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))];
  if (ids.length === 0) return { pareadas: 0, ambiguas: 0, semContrapartida: 0 };

  const importadas = new Set(ids);
  const intervaloResult = await pool.query(
    `SELECT MIN(t.data) AS data_inicial, MAX(t.data) AS data_final
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE c.usuario_id = $1
       AND t.id = ANY($2::uuid[])
       AND t.deletado_em IS NULL`,
    [usuarioId, ids]
  );
  const dataInicial = intervaloResult.rows[0]?.data_inicial;
  const dataFinal = intervaloResult.rows[0]?.data_final;
  if (!dataInicial || !dataFinal) return { pareadas: 0, ambiguas: 0, semContrapartida: 0 };

  const pagamentosResult = await pool.query(
    `SELECT t.id, t.data, t.descricao, t.valor, t.tipo, t.conta_id,
            c.nome AS conta_nome, c.tipo AS conta_tipo
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE c.usuario_id = $1
       AND c.tipo = 'CREDIT_CARD'
       AND t.tipo = 'CREDITO'
       AND t.data BETWEEN $2::date AND $3::date
       AND t.deletado_em IS NULL
       AND COALESCE(t.eh_transferencia_interna, false) = false
     ORDER BY t.data ASC, t.criado_em ASC, t.id ASC`,
    [usuarioId, dataInicial, dataFinal]
  );

  let pareadas = 0;
  let ambiguas = 0;
  let semContrapartida = 0;

  for (const pagamento of pagamentosResult.rows) {
    if (!descricaoIndicaPagamentoCartao(pagamento.descricao)) continue;

    const candidatosResult = await pool.query(
      `SELECT t.id, t.data, t.descricao, t.valor, t.tipo, t.conta_id,
              c.nome AS conta_nome, c.tipo AS conta_tipo
       FROM transacoes t
       JOIN contas c ON c.id = t.conta_id
       WHERE c.usuario_id = $1
         AND c.tipo <> 'CREDIT_CARD'
         AND t.tipo = 'DEBITO'
         AND t.data = $2::date
         AND ABS(ABS(t.valor) - ABS($3::numeric)) <= 0.01
         AND t.deletado_em IS NULL
         AND COALESCE(t.eh_transferencia_interna, false) = false
       ORDER BY t.criado_em ASC, t.id ASC`,
      [usuarioId, pagamento.data, pagamento.valor]
    );

    let candidatos = candidatosResult.rows;
    if (!importadas.has(String(pagamento.id))) {
      candidatos = candidatos.filter((tx) => importadas.has(String(tx.id)));
    }

    if (candidatos.length === 0) {
      if (importadas.has(String(pagamento.id))) semContrapartida++;
      continue;
    }

    const pontuar = (tx) => descricaoIndicaPagamentoCartao(tx.descricao)
      ? 3
      : descricaoIndicaTransferencia(tx.descricao) ? 2 : 1;
    const maiorPontuacao = Math.max(...candidatos.map(pontuar));
    const melhores = candidatos.filter((tx) => pontuar(tx) === maiorPontuacao);
    if (melhores.length !== 1) {
      ambiguas++;
      continue;
    }

    const debito = melhores[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bloqueadas = await client.query(
        `SELECT t.id
         FROM transacoes t
         JOIN contas c ON c.id = t.conta_id
         WHERE c.usuario_id = $1
           AND t.id = ANY($2::uuid[])
           AND t.deletado_em IS NULL
           AND COALESCE(t.eh_transferencia_interna, false) = false
         FOR UPDATE OF t`,
        [usuarioId, [debito.id, pagamento.id]]
      );

      if (bloqueadas.rows.length !== 2) {
        await client.query('ROLLBACK');
        continue;
      }

      const grupoId = crypto.randomUUID();
      const atualizadas = await client.query(
        `UPDATE transacoes
         SET eh_transferencia_interna = true,
             transferencia_grupo_id = $1,
             atualizado_em = NOW()
         WHERE id = ANY($2::uuid[])
         RETURNING id`,
        [grupoId, [debito.id, pagamento.id]]
      );

      if (atualizadas.rows.length !== 2) {
        await client.query('ROLLBACK');
        continue;
      }

      await client.query('COMMIT');
      pareadas++;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { pareadas, ambiguas, semContrapartida };
}

function montarTransacaoTransferencia(tx) {
  return {
    id: tx.id,
    data: tx.data,
    conta_id: tx.conta_id,
    conta_nome: tx.conta_nome,
    conta_tipo: tx.conta_tipo || null,
    descricao: tx.descricao,
    valor: Number(tx.valor || 0),
    tipo: tx.tipo,
  };
}

async function buscarTransacoesUsuario(usuarioId, filtros = {}) {
  const valores = [usuarioId];
  const where = ['conta.usuario_id = $1', 't.deletado_em IS NULL'];
  const limite = Math.min(Math.max(parseInt(filtros.limite, 10) || 50, 1), 500);
  const pagina = Math.max(parseInt(filtros.pagina, 10) || 1, 1);
  const offset = (pagina - 1) * limite;

  if (filtros.contaId) {
    valores.push(filtros.contaId);
    where.push(`t.conta_id = $${valores.length}`);
  }
  if (filtros.categoriaId) {
    valores.push(filtros.categoriaId);
    where.push(`(t.categoria_id = $${valores.length} OR t.categoria_macro_id = $${valores.length} OR t.categoria_detalhada_id = $${valores.length})`);
  }
  if (filtros.categoriaMacroId) {
    valores.push(filtros.categoriaMacroId);
    where.push(`(t.categoria_macro_id = $${valores.length} OR (t.categoria_macro_id IS NULL AND (t.categoria_id = $${valores.length} OR cat.categoria_pai_id = $${valores.length})))`);
  }
  if (filtros.categoriaDetalhadaId) {
    valores.push(filtros.categoriaDetalhadaId);
    where.push(`(t.categoria_detalhada_id = $${valores.length} OR (t.categoria_detalhada_id IS NULL AND t.categoria_id = $${valores.length} AND cat.categoria_pai_id IS NOT NULL))`);
  }
  if (filtros.status === 'sem') where.push('t.categoria_macro_id IS NULL AND t.categoria_id IS NULL');
  if (filtros.status === 'categorizadas') where.push('(t.categoria_macro_id IS NOT NULL OR t.categoria_id IS NOT NULL)');
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

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM transacoes t
     JOIN contas conta ON conta.id = t.conta_id
     LEFT JOIN categorias cat ON cat.id = t.categoria_id
     WHERE ${where.join(' AND ')}`,
    valores
  );
  const total = Number(countResult.rows[0]?.total || 0);
  const valoresPaginados = [...valores, limite, offset];
  const limiteParam = valoresPaginados.length - 1;
  const offsetParam = valoresPaginados.length;

  const result = await pool.query(
    `SELECT t.*,
            COALESCE(t.categoria_macro_id, CASE WHEN cat.categoria_pai_id IS NULL THEN t.categoria_id ELSE cat.categoria_pai_id END) AS categoria_macro_id,
            COALESCE(t.categoria_detalhada_id, CASE WHEN cat.categoria_pai_id IS NOT NULL THEN t.categoria_id ELSE NULL END) AS categoria_detalhada_id,
            conta.nome AS conta_nome,
            conta.tipo AS conta_tipo,
            cat.nome AS categoria_nome,
            COALESCE(cm.nome, cat_macro.nome, CASE WHEN cat.categoria_pai_id IS NULL THEN cat.nome ELSE NULL END) AS categoria_macro_nome,
            COALESCE(cd.nome, CASE WHEN cat.categoria_pai_id IS NOT NULL THEN cat.nome ELSE NULL END) AS categoria_detalhada_nome,
            ca.id AS conciliacao_id,
            ca.provisao_id AS provisao_conciliada_id,
            p.descricao AS provisao_conciliada_descricao,
            CASE
              WHEN conta.data_saldo_inicial IS NULL THEN NULL
              ELSE conta.saldo_inicial + COALESCE((
                SELECT SUM(CASE WHEN t2.tipo = 'CREDITO' THEN t2.valor ELSE -t2.valor END)
                FROM transacoes t2
                WHERE t2.conta_id = t.conta_id
                  AND t2.deletado_em IS NULL
                  AND t2.data >= conta.data_saldo_inicial
                  AND (
                    t2.data < t.data
                    OR (
                      t2.data = t.data
                      AND (
                        COALESCE(t2.criado_em, t2.atualizado_em, TIMESTAMP '1970-01-01') < COALESCE(t.criado_em, t.atualizado_em, TIMESTAMP '1970-01-01')
                        OR (
                          COALESCE(t2.criado_em, t2.atualizado_em, TIMESTAMP '1970-01-01') = COALESCE(t.criado_em, t.atualizado_em, TIMESTAMP '1970-01-01')
                          AND t2.id::text <= t.id::text
                        )
                      )
                    )
                  )
              ), 0)
            END AS saldo_acumulado,
            conta.saldo_inicial AS conta_saldo_inicial,
            conta.data_saldo_inicial AS conta_data_saldo_inicial
     FROM transacoes t
     JOIN contas conta ON conta.id = t.conta_id
     LEFT JOIN categorias cat ON cat.id = t.categoria_id
     LEFT JOIN categorias cat_macro ON cat_macro.id = cat.categoria_pai_id
     LEFT JOIN categorias cm ON cm.id = t.categoria_macro_id
     LEFT JOIN categorias cd ON cd.id = t.categoria_detalhada_id
     LEFT JOIN conciliacoes ca ON ca.transacao_id = t.id AND ca.status = 'CONFIRMADA'
     LEFT JOIN provisoes p ON p.id = ca.provisao_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.data DESC, t.criado_em DESC, t.id DESC
     LIMIT $${limiteParam} OFFSET $${offsetParam}`,
    valoresPaginados
  );

  return {
    transacoes: result.rows,
    paginacao: {
      total,
      pagina,
      limite,
      totalPaginas: Math.max(1, Math.ceil(total / limite)),
    },
  };
}

app.get('/api/transacoes', verificarToken, async (req, res) => {
  try {
    await aplicarRegrasAtivasEmTransacoesSemCategoria(req.usuario.usuario_id);
    const transacoes = await buscarTransacoesUsuario(req.usuario.usuario_id, {
      contaId: req.query.contaId,
      categoriaId: req.query.categoriaId,
      categoriaMacroId: req.query.categoriaMacroId,
      categoriaDetalhadaId: req.query.categoriaDetalhadaId,
      status: req.query.status,
      tipo: req.query.tipo,
      dataInicial: req.query.dataInicial,
      dataFinal: req.query.dataFinal,
      busca: req.query.busca,
      limite: req.query.limite,
      pagina: req.query.pagina,
    });

    res.json(transacoes);
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
    const creditos = candidatas
      .filter((tx) => tx.tipo === 'CREDITO')
      .sort((a, b) => Number(contaEhCartao(b) && descricaoIndicaPagamentoCartao(b.descricao)) - Number(contaEhCartao(a) && descricaoIndicaPagamentoCartao(a.descricao)));
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
        const pagamentoCartao = contaEhCartao(credito) && descricaoIndicaPagamentoCartao(credito.descricao);
        const descricaoTransferencia = descricaoIndicaTransferencia(debito.descricao) || descricaoIndicaTransferencia(credito.descricao);
        if (pagamentoCartao) motivos.push('Pagamento de fatura do cartão');
        if (descricaoTransferencia) motivos.push('Descrição contém Pix/transferência');
        const confianca = pagamentoCartao
          ? (dias === 0 ? 'alta' : 'média')
          : dias === 0 && descricaoTransferencia ? 'alta' : descricaoTransferencia ? 'média' : 'baixa';

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
    const resultado = await buscarTransacoesUsuario(req.usuario.usuario_id, {
      contaId: req.params.contaId,
      limite: req.query.limite,
      pagina: req.query.pagina,
    });
    res.json(resultado);
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.delete('/api/transacoes/:id', verificarToken, async (req, res) => {
  try {
    const conciliada = await pool.query(
      `SELECT ca.id FROM conciliacoes ca
       JOIN transacoes t ON t.id = ca.transacao_id
       JOIN contas c ON c.id = t.conta_id
       WHERE ca.transacao_id = $1 AND ca.status = 'CONFIRMADA' AND c.usuario_id = $2`,
      [req.params.id, req.usuario.usuario_id]
    );
    const compraVinculada = await pool.query(
      `SELECT cc.id, cp.descricao
       FROM conciliacoes_compras cc
       JOIN compras_programadas cp ON cp.id = cc.compra_id
       WHERE cc.transacao_id = $1
         AND cc.status = 'CONFIRMADA'
         AND cc.usuario_id = $2
       LIMIT 1`,
      [req.params.id, req.usuario.usuario_id]
    );
    if ((conciliada.rows.length > 0 || compraVinculada.rows.length > 0) && req.query.confirmar !== 'true') {
      const detalhes = [
        conciliada.rows.length > 0 ? 'uma Conta Prevista' : null,
        compraVinculada.rows.length > 0 ? `a compra “${compraVinculada.rows[0].descricao}”` : null,
      ].filter(Boolean).join(' e ');
      return res.status(409).json({ erro: `Transação vinculada a ${detalhes}. Confirme a exclusão para remover o vínculo.` });
    }

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
    const { transacaoIds, categoriaId, categoriaMacroId, categoriaDetalhadaId, criarRegra = false, termoRegra } = req.body;

    if (!Array.isArray(transacaoIds) || transacaoIds.length === 0) {
      return res.status(400).json({ erro: 'Selecione ao menos uma transação para categorizar.' });
    }

    const categorias = await validarParCategoriasDoUsuario(req.usuario.usuario_id, categoriaMacroId || categoriaId, categoriaDetalhadaId);

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

      regra = await criarOuAtualizarRegraCategorizacao(req.usuario.usuario_id, categorias.categoriaId, termoBase);
      atualizadasPorRegra = await aplicarRegraEmTransacoesSemCategoria(req.usuario.usuario_id, regra);
    }

    const atualizadas = await categorizarTransacoesUsuario(req.usuario.usuario_id, transacaoIds, categorias.categoriaId, {
      origem: 'MANUAL',
      regraId: regra?.id || null,
      categoriaMacroId: categorias.macroId,
      categoriaDetalhadaId: categorias.detalhadaId,
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

app.patch('/api/transacoes/:id', verificarToken, async (req, res) => {
  try {
    const {
      data,
      descricao,
      valor,
      tipo,
      conta_id,
      contaId,
      nota_usuario = '',
      eh_transferencia_interna = false,
      categoriaId,
      categoriaMacroId,
      categoriaDetalhadaId,
      criarRegra = false,
      termoRegra,
    } = req.body || {};
    const dataFinal = normalizarDataImportacao(data);
    const descricaoFinal = String(descricao || '').trim();
    const valorParse = parseValorMonetario(valor);
    const valorFinal = Math.abs(Number(valorParse.valor));
    const tipoFinal = String(tipo || '').trim().toUpperCase();
    const contaFinal = conta_id || contaId;
    const transferenciaInterna = Boolean(eh_transferencia_interna);

    if (!dataFinal) return res.status(400).json({ erro: 'Data inválida.' });
    if (!descricaoFinal) return res.status(400).json({ erro: 'Descrição é obrigatória.' });
    if (valorParse.erro || !Number.isFinite(valorFinal) || valorFinal <= 0) return res.status(400).json({ erro: valorParse.erro || 'Valor inválido.' });
    if (!['CREDITO', 'DEBITO'].includes(tipoFinal)) return res.status(400).json({ erro: 'Tipo inválido.' });
    if (!contaFinal) return res.status(400).json({ erro: 'Conta é obrigatória.' });

    const conta = await pool.query('SELECT id FROM contas WHERE id = $1 AND usuario_id = $2 LIMIT 1', [contaFinal, req.usuario.usuario_id]);
    if (conta.rows.length === 0) return res.status(404).json({ erro: 'Conta não encontrada para este usuário.' });

    const atual = await pool.query(
      `SELECT t.*
       FROM transacoes t
       JOIN contas c ON c.id = t.conta_id
       WHERE t.id = $1 AND c.usuario_id = $2 AND t.deletado_em IS NULL
       LIMIT 1`,
      [req.params.id, req.usuario.usuario_id]
    );
    if (atual.rows.length === 0) return res.status(404).json({ erro: 'Transação não encontrada para este usuário.' });

    const categorias = await validarParCategoriasDoUsuario(req.usuario.usuario_id, categoriaMacroId || categoriaId, categoriaDetalhadaId);
    const hashTransacao = gerarHashTransacao({ data: dataFinal, descricao: descricaoFinal, valor: valorFinal, tipo: tipoFinal }, contaFinal);

    let regra = null;
    let atualizadasPorRegra = 0;
    if (criarRegra) {
      regra = await criarOuAtualizarRegraCategorizacao(req.usuario.usuario_id, categorias.categoriaId, termoRegra || descricaoFinal);
      atualizadasPorRegra = await aplicarRegraEmTransacoesSemCategoria(req.usuario.usuario_id, regra);
    }

    const result = await pool.query(
      `UPDATE transacoes t
       SET conta_id = $1,
           data = $2,
           descricao = $3,
           valor = $4,
           tipo = $5,
           nota_usuario = $6,
           categoria_id = $7,
           categoria_macro_id = $8,
           categoria_detalhada_id = $9,
           categoria_origem = $10,
           regra_categorizacao_id = $11,
           hash_transacao = $12,
           eh_transferencia_interna = $13,
           transferencia_grupo_id = CASE
             WHEN $13 = true THEN COALESCE(t.transferencia_grupo_id, gen_random_uuid())
             ELSE NULL
           END,
           atualizado_em = NOW()
       FROM contas c
       WHERE t.id = $14
         AND c.id = t.conta_id
         AND c.usuario_id = $15
         AND t.deletado_em IS NULL
       RETURNING t.*`,
      [contaFinal, dataFinal, descricaoFinal, valorFinal, tipoFinal, nota_usuario || null, categorias.categoriaId, categorias.macroId, categorias.detalhadaId, 'MANUAL', regra?.id || null, hashTransacao, transferenciaInterna, req.params.id, req.usuario.usuario_id]
    );

    res.json({
      sucesso: true,
      atualizadas: result.rows.length,
      atualizadasPorRegra,
      regra,
      transacao: (await montarRespostaTransacoes(result.rows))[0],
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ erro: 'Já existe uma transação igual para esta conta, data, descrição, valor e tipo.' });
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/transacoes/:id/categorizar', verificarToken, async (req, res) => {
  try {
    const { categoriaId, categoriaMacroId, categoriaDetalhadaId, criarRegra = false, termoRegra } = req.body;

    const categorias = await validarParCategoriasDoUsuario(req.usuario.usuario_id, categoriaMacroId || categoriaId, categoriaDetalhadaId);

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
        categorias.categoriaId,
        termoRegra || transacao.rows[0].descricao
      );
      atualizadasPorRegra = await aplicarRegraEmTransacoesSemCategoria(req.usuario.usuario_id, regra);
    }

    const atualizadas = await categorizarTransacoesUsuario(req.usuario.usuario_id, [req.params.id], categorias.categoriaId, {
      origem: 'MANUAL',
      regraId: regra?.id || null,
      categoriaMacroId: categorias.macroId,
      categoriaDetalhadaId: categorias.detalhadaId,
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
// ROTAS: CONFERÊNCIA DE SALDOS BANCÁRIOS
// ============================================================================

function arredondarMoeda(valor) {
  return Math.round((Number(valor || 0) + Number.EPSILON) * 100) / 100;
}

function formatarMoedaDiagnostico(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function dataISO(data) {
  if (!data) return null;
  return data instanceof Date ? data.toISOString().slice(0, 10) : String(data).slice(0, 10);
}

async function obterContaDoUsuario(usuarioId, contaId) {
  const result = await pool.query(
    `SELECT id, nome, saldo_inicial, data_saldo_inicial
     FROM contas
     WHERE id = $1 AND usuario_id = $2 AND ativo = true`,
    [contaId, usuarioId]
  );
  return result.rows[0] || null;
}

async function calcularSaldoContaAteData(usuarioId, contaId, dataReferencia) {
  if (!contaId || !dataReferencia) throw new Error('Informe contaId e dataReferencia para calcular o saldo.');
  const conta = await obterContaDoUsuario(usuarioId, contaId);
  if (!conta) throw new Error('Conta não encontrada para este usuário.');

  const dataSaldoInicial = dataISO(conta.data_saldo_inicial);
  if (!dataSaldoInicial) {
    return {
      contaId: conta.id,
      contaNome: conta.nome,
      dataReferencia,
      saldoInicial: Number(conta.saldo_inicial || 0),
      dataSaldoInicial: null,
      saldoInicialConfigurado: false,
      totalCreditos: 0,
      totalDebitos: 0,
      saldoCalculado: null,
      mensagem: 'Esta conta ainda não possui saldo inicial configurado. Cadastre um saldo inicial para permitir a conferência.',
    };
  }

  const totais = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN tipo = 'CREDITO' THEN valor ELSE 0 END), 0) AS total_creditos,
       COALESCE(SUM(CASE WHEN tipo = 'DEBITO' THEN valor ELSE 0 END), 0) AS total_debitos,
       COUNT(*) AS quantidade_transacoes
     FROM transacoes
     WHERE conta_id = $1
       AND data >= $2
       AND data <= $3
       AND deletado_em IS NULL`,
    [contaId, dataSaldoInicial, dataReferencia]
  );

  const saldoInicial = Number(conta.saldo_inicial || 0);
  const totalCreditos = Number(totais.rows[0]?.total_creditos || 0);
  const totalDebitos = Number(totais.rows[0]?.total_debitos || 0);
  const saldoCalculado = arredondarMoeda(saldoInicial + totalCreditos - totalDebitos);

  return {
    contaId: conta.id,
    contaNome: conta.nome,
    dataReferencia,
    saldoInicial,
    dataSaldoInicial,
    saldoInicialConfigurado: true,
    totalCreditos: arredondarMoeda(totalCreditos),
    totalDebitos: arredondarMoeda(totalDebitos),
    saldoCalculado,
    quantidadeTransacoes: Number(totais.rows[0]?.quantidade_transacoes || 0),
  };
}

function transacaoResumoDiagnostico(tx) {
  return {
    id: tx.id,
    data: dataISO(tx.data),
    descricao: tx.descricao,
    valor: Number(tx.valor || 0),
    tipo: tx.tipo,
    contaId: tx.conta_id,
    contaNome: tx.conta_nome,
  };
}

function adicionarDiagnostico(lista, diagnostico) {
  lista.push({
    severidade: diagnostico.severidade || 'MEDIA',
    transacoesRelacionadas: diagnostico.transacoesRelacionadas || [],
    acoesSugeridas: diagnostico.acoesSugeridas || [],
    ...diagnostico,
  });
}

async function analisarDivergenciaSaldo(usuarioId, { contaId, dataReferencia, saldoReal, saldoCalculado, diferenca }) {
  const conta = await obterContaDoUsuario(usuarioId, contaId);
  if (!conta) throw new Error('Conta não encontrada para este usuário.');

  const dataSaldoInicial = dataISO(conta.data_saldo_inicial) || dataReferencia;
  const diferencaNumerica = arredondarMoeda(Number(diferenca ?? (Number(saldoReal || 0) - Number(saldoCalculado || 0))));
  const absDiferenca = Math.abs(diferencaNumerica);
  const toleranciaValor = Math.max(0.05, absDiferenca * 0.02);
  const diagnosticos = [];

  const transacoesConta = await pool.query(
    `SELECT t.*, c.nome AS conta_nome
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE t.conta_id = $1
       AND t.data >= ($2::date - INTERVAL '3 days')
       AND t.data <= ($3::date + INTERVAL '3 days')
       AND t.deletado_em IS NULL
     ORDER BY t.data, t.valor, t.descricao`,
    [contaId, dataSaldoInicial, dataReferencia]
  );

  const dentroPeriodo = transacoesConta.rows.filter((tx) => dataISO(tx.data) >= dataSaldoInicial && dataISO(tx.data) <= dataReferencia);

  for (let i = 0; i < dentroPeriodo.length; i++) {
    for (let j = i + 1; j < dentroPeriodo.length; j++) {
      const a = dentroPeriodo[i];
      const b = dentroPeriodo[j];
      if (dataISO(a.data) !== dataISO(b.data) || a.tipo !== b.tipo || Math.abs(Number(a.valor) - Number(b.valor)) > 0.01) continue;
      if (similaridadeTextoConciliacao(a.descricao, b.descricao) < 0.55) continue;
      adicionarDiagnostico(diagnosticos, {
        tipo: 'POSSIVEL_DUPLICIDADE',
        severidade: 'ALTA',
        descricao: `Encontramos duas transações parecidas em ${dataISO(a.data)} no valor de ${formatarMoedaDiagnostico(a.valor)} que podem estar duplicadas.`,
        transacoesRelacionadas: [transacaoResumoDiagnostico(a), transacaoResumoDiagnostico(b)],
        acoesSugeridas: ['Abra as transações relacionadas e confirme se uma delas deve ser excluída ou ignorada.'],
      });
      i = dentroPeriodo.length;
      break;
    }
  }

  if (absDiferenca > 0) {
    const valorProximo = dentroPeriodo.find((tx) => Math.abs(Number(tx.valor) - absDiferenca) <= toleranciaValor);
    adicionarDiagnostico(diagnosticos, {
      tipo: 'POSSIVEL_TRANSACAO_AUSENTE',
      severidade: valorProximo ? 'MEDIA' : 'BAIXA',
      descricao: valorProximo
        ? `A diferença é próxima de uma transação já registrada no valor de ${formatarMoedaDiagnostico(valorProximo.valor)}; pode existir lançamento ausente ou duplicado de valor semelhante.`
        : `A diferença de ${formatarMoedaDiagnostico(absDiferenca)} pode indicar lançamento ausente, taxa, ajuste manual ou item não importado no extrato.`,
      transacoesRelacionadas: valorProximo ? [transacaoResumoDiagnostico(valorProximo)] : [],
      acoesSugeridas: ['Compare o extrato bancário com as transações importadas nesse período.'],
    });

    const sinalInvertido = dentroPeriodo.find((tx) => Math.abs((Number(tx.valor) * 2) - absDiferenca) <= Math.max(0.05, absDiferenca * 0.02));
    if (sinalInvertido) {
      adicionarDiagnostico(diagnosticos, {
        tipo: 'POSSIVEL_ERRO_DE_SINAL',
        severidade: 'ALTA',
        descricao: `A diferença é compatível com uma transação de ${formatarMoedaDiagnostico(sinalInvertido.valor)} lançada com tipo invertido entre crédito e débito.`,
        transacoesRelacionadas: [transacaoResumoDiagnostico(sinalInvertido)],
        acoesSugeridas: ['Confira se o tipo da transação relacionada está correto.'],
      });
    }
  }

  const foraPeriodo = transacoesConta.rows.filter((tx) => dataISO(tx.data) > dataReferencia || dataISO(tx.data) < dataSaldoInicial).slice(0, 5);
  if (foraPeriodo.length > 0) {
    adicionarDiagnostico(diagnosticos, {
      tipo: 'POSSIVEL_DATA_ERRADA',
      severidade: 'MEDIA',
      descricao: 'Há transações próximas ao início/fim do período que podem ter sido lançadas com data diferente do extrato bancário.',
      transacoesRelacionadas: foraPeriodo.map(transacaoResumoDiagnostico),
      acoesSugeridas: ['Revise a data das transações próximas à data de referência.'],
    });
  }

  const outrasContas = await pool.query(
    `SELECT t.*, c.nome AS conta_nome
     FROM transacoes t
     JOIN contas c ON c.id = t.conta_id
     WHERE c.usuario_id = $1
       AND t.conta_id <> $2
       AND t.data >= $3::date
       AND t.data <= $4::date
       AND ABS(t.valor - $5) <= $6
       AND t.deletado_em IS NULL
     ORDER BY t.data DESC
     LIMIT 8`,
    [usuarioId, contaId, dataSaldoInicial, dataReferencia, absDiferenca, Math.max(1, toleranciaValor)]
  );
  if (outrasContas.rows.length > 0) {
    adicionarDiagnostico(diagnosticos, {
      tipo: 'POSSIVEL_CONTA_ERRADA',
      severidade: 'MEDIA',
      descricao: 'Encontramos transações de valor parecido em outras contas; alguma movimentação pode ter sido importada na conta errada.',
      transacoesRelacionadas: outrasContas.rows.map(transacaoResumoDiagnostico),
      acoesSugeridas: ['Confira se as transações relacionadas pertencem à conta correta.'],
    });
  }

  const transferencias = await pool.query(
    `SELECT d.id AS debito_id, d.data AS debito_data, d.descricao AS debito_descricao, d.valor AS debito_valor,
            cd.nome AS debito_conta_nome, cr.id AS credito_id, cr.data AS credito_data,
            cr.descricao AS credito_descricao, cr.valor AS credito_valor, cc.nome AS credito_conta_nome
     FROM transacoes d
     JOIN contas cd ON cd.id = d.conta_id
     JOIN transacoes cr ON cr.tipo = 'CREDITO'
       AND cr.conta_id <> d.conta_id
       AND ABS(cr.valor - d.valor) <= 0.01
       AND ABS(cr.data - d.data) <= 3
       AND cr.deletado_em IS NULL
       AND COALESCE(cr.eh_transferencia_interna, false) = false
     JOIN contas cc ON cc.id = cr.conta_id AND cc.usuario_id = cd.usuario_id
     WHERE cd.usuario_id = $1
       AND d.conta_id = $2
       AND d.tipo = 'DEBITO'
       AND d.data >= $3::date
       AND d.data <= $4::date
       AND d.deletado_em IS NULL
       AND COALESCE(d.eh_transferencia_interna, false) = false
     LIMIT 5`,
    [usuarioId, contaId, dataSaldoInicial, dataReferencia]
  );
  if (transferencias.rows.length > 0) {
    const relacionados = transferencias.rows.flatMap((tx) => ([
      { id: tx.debito_id, data: dataISO(tx.debito_data), descricao: tx.debito_descricao, valor: Number(tx.debito_valor), tipo: 'DEBITO', contaNome: tx.debito_conta_nome },
      { id: tx.credito_id, data: dataISO(tx.credito_data), descricao: tx.credito_descricao, valor: Number(tx.credito_valor), tipo: 'CREDITO', contaNome: tx.credito_conta_nome },
    ]));
    adicionarDiagnostico(diagnosticos, {
      tipo: 'POSSIVEL_TRANSFERENCIA_INTERNA',
      severidade: 'BAIXA',
      descricao: 'Encontramos pares de débito/crédito entre contas que parecem transferências internas ainda não marcadas.',
      transacoesRelacionadas: relacionados,
      acoesSugeridas: ['Marque como transferência interna se o par representar movimentação entre suas contas.'],
    });
  }

  const resumoIA = diagnosticos.length > 0
    ? `Encontramos ${diagnosticos.length} hipótese(s) para explicar a diferença de ${formatarMoedaDiagnostico(diferencaNumerica)}. Priorize os itens de severidade alta e compare com o extrato bancário.`
    : `Não encontramos uma causa provável automática para a diferença de ${formatarMoedaDiagnostico(diferencaNumerica)}. Verifique lançamentos manuais, taxas ou transações não importadas.`;

  return { diferenca: diferencaNumerica, diagnosticos, resumoIA };
}

app.patch('/api/contas/:id/saldo-inicial', verificarToken, async (req, res) => {
  try {
    const { saldoInicial, saldo_inicial, dataSaldoInicial, data_saldo_inicial } = req.body;
    const saldo = Number(saldoInicial ?? saldo_inicial ?? 0);
    const data = dataSaldoInicial || data_saldo_inicial;
    if (!Number.isFinite(saldo)) return res.status(400).json({ erro: 'Saldo inicial inválido.' });
    if (!data) return res.status(400).json({ erro: 'Informe a data do saldo inicial.' });

    const result = await pool.query(
      `UPDATE contas
       SET saldo_inicial = $1, data_saldo_inicial = $2, atualizado_em = NOW()
       WHERE id = $3 AND usuario_id = $4 AND ativo = true
       RETURNING id, nome, saldo_inicial, data_saldo_inicial`,
      [saldo, data, req.params.id, req.usuario.usuario_id]
    );
    if (!result.rows[0]) return res.status(404).json({ erro: 'Conta não encontrada para este usuário.' });
    res.json({ conta: result.rows[0] });
  } catch (error) {
    res.status(500).json({ erro: 'Erro ao salvar saldo inicial.', detalhes: error.message });
  }
});

app.get('/api/conferencia-saldos/calcular', verificarToken, async (req, res) => {
  try {
    const calculo = await calcularSaldoContaAteData(req.usuario.usuario_id, req.query.contaId, req.query.dataReferencia);
    res.json(calculo);
  } catch (error) {
    res.status(/Informe|Conta/.test(error.message || '') ? 400 : 500).json({ erro: 'Erro ao calcular saldo.', detalhes: error.message });
  }
});

app.get('/api/conferencia-saldos/historico', verificarToken, async (req, res) => {
  try {
    const valores = [req.usuario.usuario_id];
    const where = ['cs.usuario_id = $1'];
    if (req.query.contaId && req.query.contaId !== 'todas') {
      valores.push(req.query.contaId);
      where.push(`cs.conta_id = $${valores.length}`);
    }
    const result = await pool.query(
      `SELECT cs.*, c.nome AS conta_nome
       FROM conferencias_saldo cs
       JOIN contas c ON c.id = cs.conta_id
       WHERE ${where.join(' AND ')}
       ORDER BY cs.data_referencia DESC, cs.criado_em DESC
       LIMIT 100`,
      valores
    );
    res.json({ conferencias: result.rows });
  } catch (error) {
    res.status(500).json({ erro: 'Erro ao listar histórico de conferências.', detalhes: error.message });
  }
});

app.post('/api/conferencia-saldos', verificarToken, async (req, res) => {
  try {
    const { contaId, dataReferencia, saldoReal, observacao, tolerancia = 0.01 } = req.body;
    const calculo = await calcularSaldoContaAteData(req.usuario.usuario_id, contaId, dataReferencia);
    if (!calculo.saldoInicialConfigurado) return res.status(400).json({ erro: calculo.mensagem, calculo });

    const saldoRealNumero = Number(saldoReal);
    if (!Number.isFinite(saldoRealNumero)) return res.status(400).json({ erro: 'Informe um saldo real válido.' });

    const diferenca = arredondarMoeda(saldoRealNumero - Number(calculo.saldoCalculado || 0));
    const status = Math.abs(diferenca) <= Math.abs(Number(tolerancia || 0.01)) ? 'CONCILIADO' : 'DIVERGENTE';
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO conferencias_saldo (id, usuario_id, conta_id, data_referencia, saldo_real, saldo_calculado, diferenca, status, observacao, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [id, req.usuario.usuario_id, contaId, dataReferencia, saldoRealNumero, calculo.saldoCalculado, diferenca, status, observacao || null]
    );
    res.json({ ...result.rows[0], calculo });
  } catch (error) {
    res.status(/Informe|Conta|Saldo/.test(error.message || '') ? 400 : 500).json({ erro: 'Erro ao salvar conferência de saldo.', detalhes: error.message });
  }
});

app.post('/api/conferencia-saldos/analisar', verificarToken, async (req, res) => {
  try {
    const resultado = await analisarDivergenciaSaldo(req.usuario.usuario_id, req.body || {});
    res.json(resultado);
  } catch (error) {
    res.status(/Informe|Conta/.test(error.message || '') ? 400 : 500).json({ erro: 'Erro ao analisar divergência.', detalhes: error.message });
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

async function buscarContaNormalizada(usuarioId, nomeConta) {
  const contas = await listarContasUsuario(usuarioId);
  const normalizado = normalizarNomeConta(nomeConta);
  return contas.find((conta) => normalizarNomeConta(conta.nome) === normalizado)?.id || null;
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
        const conferenciaResult = await pool.query(
          `SELECT data_referencia, status, diferenca
           FROM conferencias_saldo
           WHERE conta_id = $1 AND usuario_id = $2
           ORDER BY data_referencia DESC, criado_em DESC
           LIMIT 1`,
          [conta.id, req.usuario.usuario_id]
        );

        return {
          ...conta,
          saldo: parseFloat(saldoResult.rows[0]?.saldo || 0),
          ultima_conferencia: conferenciaResult.rows[0] || null,
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
      `SELECT DISTINCT ON (COALESCE(usuario_id::text, 'padrao'), nome, tipo, COALESCE(nivel, CASE WHEN categoria_pai_id IS NULL THEN 'MACRO' ELSE 'DETALHADA' END), COALESCE(categoria_pai_id::text, 'raiz')) *
       FROM categorias
       WHERE (usuario_id = $1 OR usuario_id IS NULL) AND ($2::boolean = true OR ativa = true)
       ORDER BY COALESCE(usuario_id::text, 'padrao'), nome, tipo, COALESCE(nivel, CASE WHEN categoria_pai_id IS NULL THEN 'MACRO' ELSE 'DETALHADA' END), COALESCE(categoria_pai_id::text, 'raiz'), criado_em`,
      [req.usuario.usuario_id, req.query.incluirInativas === 'true']
    );

    const categorias = result.rows.sort((a, b) => {
      const nivelA = a.nivel || (a.categoria_pai_id ? 'DETALHADA' : 'MACRO');
      const nivelB = b.nivel || (b.categoria_pai_id ? 'DETALHADA' : 'MACRO');
      if (nivelA !== nivelB) return nivelA === 'MACRO' ? -1 : 1;
      return a.nome.localeCompare(b.nome, 'pt-BR');
    });
    res.json({ categorias });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});


app.post('/api/categorias', verificarToken, async (req, res) => {
  try {
    const { nome, tipo, emoji = '', cor = '#999999', nivel, categoria_pai_id = null } = req.body || {};
    const nomeLimpo = String(nome || '').trim();
    const tipoFinal = String(tipo || '').toUpperCase();
    const nivelFinal = String(nivel || '').toUpperCase();
    if (!nomeLimpo) return res.status(400).json({ erro: 'Nome é obrigatório.' });
    if (!['DESPESA', 'RECEITA'].includes(tipoFinal)) return res.status(400).json({ erro: 'Tipo inválido.' });
    if (!['MACRO', 'DETALHADA'].includes(nivelFinal)) return res.status(400).json({ erro: 'Nível inválido.' });
    if (nivelFinal === 'MACRO' && categoria_pai_id) return res.status(400).json({ erro: 'Categoria macro não pode ter categoria pai.' });
    if (nivelFinal === 'DETALHADA' && !categoria_pai_id) return res.status(400).json({ erro: 'Categoria detalhada exige uma categoria macro pai.' });
    if (nivelFinal === 'DETALHADA') {
      const pai = await pool.query(
        `SELECT id FROM categorias WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) AND COALESCE(nivel, CASE WHEN categoria_pai_id IS NULL THEN 'MACRO' ELSE 'DETALHADA' END) = 'MACRO' LIMIT 1`,
        [categoria_pai_id, req.usuario.usuario_id]
      );
      if (pai.rows.length === 0) return res.status(400).json({ erro: 'Categoria pai macro não encontrada.' });
    }
    const result = await pool.query(
      `INSERT INTO categorias (usuario_id, nome, tipo, emoji, cor, nivel, categoria_pai_id, ativa)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [req.usuario.usuario_id, nomeLimpo, tipoFinal, emoji || null, cor || '#999999', nivelFinal, nivelFinal === 'DETALHADA' ? categoria_pai_id : null]
    );
    res.status(201).json({ categoria: result.rows[0] });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.put('/api/categorias/:id', verificarToken, async (req, res) => {
  try {
    const { nome, tipo, emoji = '', cor = '#999999', nivel, categoria_pai_id = null } = req.body || {};
    const nomeLimpo = String(nome || '').trim();
    const tipoFinal = String(tipo || '').toUpperCase();
    const nivelFinal = String(nivel || '').toUpperCase();
    if (!nomeLimpo) return res.status(400).json({ erro: 'Nome é obrigatório.' });
    if (!['DESPESA', 'RECEITA'].includes(tipoFinal)) return res.status(400).json({ erro: 'Tipo inválido.' });
    if (!['MACRO', 'DETALHADA'].includes(nivelFinal)) return res.status(400).json({ erro: 'Nível inválido.' });
    const atual = await pool.query('SELECT * FROM categorias WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) LIMIT 1', [req.params.id, req.usuario.usuario_id]);
    if (atual.rows.length === 0) return res.status(404).json({ erro: 'Categoria não encontrada.' });
    if (nivelFinal === 'MACRO' && categoria_pai_id) return res.status(400).json({ erro: 'Categoria macro não pode ter categoria pai.' });
    if (nivelFinal === 'DETALHADA') {
      if (!categoria_pai_id) return res.status(400).json({ erro: 'Categoria detalhada exige uma categoria macro pai.' });
      if (categoria_pai_id === req.params.id) return res.status(400).json({ erro: 'Categoria pai não pode ser a própria categoria.' });
      const pai = await pool.query(
        `SELECT id FROM categorias WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) AND COALESCE(nivel, CASE WHEN categoria_pai_id IS NULL THEN 'MACRO' ELSE 'DETALHADA' END) = 'MACRO' LIMIT 1`,
        [categoria_pai_id, req.usuario.usuario_id]
      );
      if (pai.rows.length === 0) return res.status(400).json({ erro: 'Categoria pai macro não encontrada.' });
    }
    const result = await pool.query(
      `UPDATE categorias
       SET nome=$1, tipo=$2, emoji=$3, cor=$4, nivel=$5, categoria_pai_id=$6, atualizado_em=NOW()
       WHERE id=$7 AND (usuario_id=$8 OR usuario_id IS NULL)
       RETURNING *`,
      [nomeLimpo, tipoFinal, emoji || null, cor || '#999999', nivelFinal, nivelFinal === 'DETALHADA' ? categoria_pai_id : null, req.params.id, req.usuario.usuario_id]
    );
    res.json({ categoria: result.rows[0] });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/categorias/:id/desativar', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE categorias SET ativa = false, atualizado_em = NOW()
       WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL)
       RETURNING *`,
      [req.params.id, req.usuario.usuario_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Categoria não encontrada.' });
    res.json({ categoria: result.rows[0] });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.patch('/api/categorias/:id/ativar', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE categorias SET ativa = true, atualizado_em = NOW()
       WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL)
       RETURNING *`,
      [req.params.id, req.usuario.usuario_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Categoria não encontrada.' });
    res.json({ categoria: result.rows[0] });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.delete('/api/categorias/:id', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM categorias WHERE id = $1 AND usuario_id = $2 RETURNING id', [req.params.id, req.usuario.usuario_id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Categoria personalizada não encontrada ou não pode ser excluída.' });
    res.json({ sucesso: true });
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
