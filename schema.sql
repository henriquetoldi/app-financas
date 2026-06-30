-- ============================================================================
-- SCHEMA: APP DE FINANÇAS PESSOAIS
-- Banco: PostgreSQL
-- ============================================================================

-- ============================================================================
-- 1. TABELAS DE USUÁRIOS
-- ============================================================================

CREATE TABLE usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  nome VARCHAR(255),
  foto_url TEXT,
  google_id VARCHAR(255) UNIQUE,
  moeda_padrao VARCHAR(3) DEFAULT 'BRL',
  timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo',
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ativo BOOLEAN DEFAULT true
);

CREATE INDEX idx_usuarios_email ON usuarios(email);
CREATE INDEX idx_usuarios_google_id ON usuarios(google_id);

-- ============================================================================
-- 2. TABELAS DE CONTAS/CARTÕES
-- ============================================================================

CREATE TABLE contas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  banco VARCHAR(100) NOT NULL,
  tipo ENUM (
    'CREDIT_CARD',
    'CHECKING',
    'SAVINGS',
    'INVESTMENT'
  ) NOT NULL,
  
  -- Informações específicas
  cpf_parcial VARCHAR(11),
  agencia VARCHAR(10),
  numero_conta VARCHAR(20),
  digito_verificador VARCHAR(2),
  
  -- Google Drive
  drive_folder_id VARCHAR(255),
  
  -- Estilo
  cor VARCHAR(7) DEFAULT '#1E90FF',
  icon VARCHAR(50),
  
  -- Status
  ativo BOOLEAN DEFAULT true,
  saldo_inicial DECIMAL(12, 2) DEFAULT 0,
  data_saldo_inicial DATE,
  saldo_atual DECIMAL(12, 2),
  
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contas_usuario ON contas(usuario_id);
CREATE INDEX idx_contas_banco_tipo ON contas(banco, tipo);
CREATE INDEX idx_contas_ativo ON contas(ativo);

-- ============================================================================
-- 3. TABELAS DE TRANSAÇÕES
-- ============================================================================

CREATE TABLE transacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id UUID NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  
  -- Informações principais
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  valor DECIMAL(12, 2) NOT NULL,
  tipo ENUM('CREDITO', 'DEBITO') NOT NULL,
  
  -- Categorização
  categoria_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
  categoria_macro_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
  categoria_detalhada_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
  categoria_origem VARCHAR(20),
  regra_categorizacao_id UUID,
  eh_transferencia_interna BOOLEAN DEFAULT false,
  transferencia_grupo_id UUID,
  subcategoria VARCHAR(255),
  
  -- Metadados
  saldo DECIMAL(12, 2),
  referencia_banco VARCHAR(50),
  nota_usuario TEXT,
  
  -- Importação
  importacao_id UUID REFERENCES importacoes(id) ON DELETE SET NULL,
  hash_transacao VARCHAR(64) UNIQUE, -- Para deduplicação
  
  -- Audit
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deletado_em TIMESTAMP
);

CREATE INDEX idx_transacoes_conta ON transacoes(conta_id);
CREATE INDEX idx_transacoes_categoria ON transacoes(categoria_id);
CREATE INDEX idx_transacoes_categoria_macro ON transacoes(categoria_macro_id);
CREATE INDEX idx_transacoes_categoria_detalhada ON transacoes(categoria_detalhada_id);
CREATE INDEX idx_transacoes_categoria_origem ON transacoes(categoria_origem);
CREATE INDEX idx_transacoes_transferencia_interna ON transacoes(eh_transferencia_interna, transferencia_grupo_id);
CREATE INDEX idx_transacoes_data ON transacoes(data);
CREATE INDEX idx_transacoes_tipo ON transacoes(tipo);
CREATE INDEX idx_transacoes_hash ON transacoes(hash_transacao);
CREATE INDEX idx_transacoes_importacao ON transacoes(importacao_id);
CREATE INDEX idx_transacoes_conta_data ON transacoes(conta_id, data);

-- ============================================================================
-- 3.1. TABELA DE CONFERÊNCIAS DE SALDO
-- ============================================================================

CREATE TABLE conferencias_saldo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  conta_id UUID NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  data_referencia DATE NOT NULL,
  saldo_real DECIMAL(12, 2) NOT NULL,
  saldo_calculado DECIMAL(12, 2) NOT NULL,
  diferenca DECIMAL(12, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('CONCILIADO', 'DIVERGENTE', 'PENDENTE', 'EM_ANALISE')),
  observacao TEXT,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conferencias_saldo_usuario ON conferencias_saldo(usuario_id);
CREATE INDEX idx_conferencias_saldo_conta_data ON conferencias_saldo(conta_id, data_referencia DESC);
CREATE INDEX idx_conferencias_saldo_status ON conferencias_saldo(status);

-- ============================================================================
-- 4. TABELAS DE CATEGORIAS
-- ============================================================================

CREATE TABLE categorias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  cor VARCHAR(7) DEFAULT '#999999',
  icon VARCHAR(50),
  emoji VARCHAR(5),
  
  -- Hierarchy
  categoria_pai_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
  nivel VARCHAR(20) DEFAULT 'MACRO',
  
  -- Tipo
  tipo ENUM('DESPESA', 'RECEITA', 'TRANSFERENCIA', 'INVESTIMENTO') DEFAULT 'DESPESA',
  
  -- Controle
  customizada BOOLEAN DEFAULT true,
  ativa BOOLEAN DEFAULT true,
  
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_categorias_usuario ON categorias(usuario_id);
CREATE INDEX idx_categorias_pai ON categorias(categoria_pai_id);
CREATE INDEX idx_categorias_ativa ON categorias(ativa);
CREATE UNIQUE INDEX idx_categorias_padrao_nome_tipo_unique
  ON categorias(nome, tipo)
  WHERE usuario_id IS NULL;

CREATE TABLE regras_categorizacao (
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
);

ALTER TABLE transacoes
  ADD CONSTRAINT fk_transacoes_regra_categorizacao
  FOREIGN KEY (regra_categorizacao_id)
  REFERENCES regras_categorizacao(id)
  ON DELETE SET NULL;

CREATE INDEX idx_regras_categorizacao_usuario ON regras_categorizacao(usuario_id, ativo);
CREATE INDEX idx_regras_categorizacao_termo ON regras_categorizacao(termo_normalizado);
CREATE UNIQUE INDEX idx_regras_categorizacao_unique
  ON regras_categorizacao(usuario_id, categoria_id, termo_normalizado, tipo_match);

-- ============================================================================
-- 5. TABELAS DE IMPORTAÇÃO
-- ============================================================================

CREATE TABLE importacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  conta_id UUID REFERENCES contas(id) ON DELETE SET NULL,
  
  -- Arquivo
  arquivo_nome VARCHAR(500) NOT NULL,
  drive_file_id VARCHAR(255) UNIQUE,
  drive_file_path TEXT,
  
  -- Processamento
  status ENUM('PENDENTE', 'PROCESSANDO', 'SUCESSO', 'ERRO') DEFAULT 'PENDENTE',
  mensagem_erro TEXT,
  
  -- Estatísticas
  total_linhas INT DEFAULT 0,
  linhas_importadas INT DEFAULT 0,
  linhas_duplicadas INT DEFAULT 0,
  linhas_erro INT DEFAULT 0,
  
  -- Integridade
  hash_arquivo VARCHAR(64),
  
  -- Audit
  iniciado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finalizado_em TIMESTAMP,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_importacoes_usuario ON importacoes(usuario_id);
CREATE INDEX idx_importacoes_conta ON importacoes(conta_id);
CREATE INDEX idx_importacoes_status ON importacoes(status);
CREATE INDEX idx_importacoes_data ON importacoes(criado_em);

CREATE TABLE backups_drive (
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
);

CREATE INDEX idx_backups_drive_usuario ON backups_drive(usuario_id);
CREATE INDEX idx_backups_drive_status ON backups_drive(status);
CREATE UNIQUE INDEX idx_backups_drive_usuario_hash ON backups_drive(usuario_id, arquivo_hash);

CREATE TABLE notificacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo VARCHAR(50) NOT NULL,
  titulo VARCHAR(255) NOT NULL,
  mensagem TEXT NOT NULL,
  prioridade VARCHAR(20) DEFAULT 'normal',
  lida BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}'::jsonb,
  criada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notificacoes_usuario ON notificacoes(usuario_id);
CREATE INDEX idx_notificacoes_lida ON notificacoes(lida);

CREATE TABLE preferencias_notificacoes (
  usuario_id UUID PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  email_backup_sucesso BOOLEAN DEFAULT false,
  email_backup_erro BOOLEAN DEFAULT true,
  app_backup_sucesso BOOLEAN DEFAULT true,
  app_backup_erro BOOLEAN DEFAULT true,
  frequencia_resumo VARCHAR(20) DEFAULT 'diaria',
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 6. TABELAS DE MAPEAMENTO AUTOMÁTICO
-- ============================================================================

CREATE TABLE descricao_categoria_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  
  -- Pattern matching
  descricao_pattern VARCHAR(500) NOT NULL,
  is_regex BOOLEAN DEFAULT false,
  
  -- Resultado
  categoria_id UUID NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
  
  -- Confiança
  confianca FLOAT DEFAULT 0.5, -- 0.0 a 1.0
  vezes_usado INT DEFAULT 0,
  vezes_aceito INT DEFAULT 0,
  
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_mapping_usuario ON descricao_categoria_mapping(usuario_id);
CREATE INDEX idx_mapping_categoria ON descricao_categoria_mapping(categoria_id);

-- ============================================================================
-- 7. TABELAS DE ORÇAMENTO
-- ============================================================================

CREATE TABLE orcamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  
  -- Período
  data_inicio DATE NOT NULL,
  data_fim DATE NOT NULL,
  periodo ENUM('MENSAL', 'TRIMESTRAL', 'ANUAL') DEFAULT 'MENSAL',
  
  -- Categoria e limite
  categoria_id UUID REFERENCES categorias(id) ON DELETE CASCADE,
  limite DECIMAL(12, 2) NOT NULL,
  
  -- Status
  ativo BOOLEAN DEFAULT true,
  
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orcamentos_usuario ON orcamentos(usuario_id);
CREATE INDEX idx_orcamentos_categoria ON orcamentos(categoria_id);

-- ============================================================================
-- 8. TABELAS DE METAS
-- ============================================================================

CREATE TABLE metas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  tipo ENUM('ECONOMIA', 'INVESTIMENTO', 'PAGAMENTO_DIVIDA') DEFAULT 'ECONOMIA',
  
  -- Valores
  valor_alvo DECIMAL(12, 2) NOT NULL,
  valor_atual DECIMAL(12, 2) DEFAULT 0,
  
  -- Datas
  data_inicio DATE,
  data_alvo DATE NOT NULL,
  
  -- Status
  ativa BOOLEAN DEFAULT true,
  concluida BOOLEAN DEFAULT false,
  data_conclusao TIMESTAMP,
  
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_metas_usuario ON metas(usuario_id);
CREATE INDEX idx_metas_ativa ON metas(ativa);

-- ============================================================================
-- 9. TABELAS DE RELATÓRIOS
-- ============================================================================

CREATE TABLE relatorios_salvos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  
  nome VARCHAR(255) NOT NULL,
  descricao TEXT,
  tipo VARCHAR(50), -- 'MENSAL', 'ANUAL', 'POR_CATEGORIA', etc
  
  -- Configuração
  data_inicio DATE,
  data_fim DATE,
  contas_ids UUID[],
  categorias_ids UUID[],
  
  -- Resultado armazenado
  dados_json JSONB,
  
  -- Automação
  agendado BOOLEAN DEFAULT false,
  frequencia VARCHAR(50), -- 'MENSAL', 'SEMANAL', etc
  email_destino VARCHAR(255),
  
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_relatorios_usuario ON relatorios_salvos(usuario_id);

-- ============================================================================
-- 10. TABELAS DE SINCRONIZAÇÃO
-- ============================================================================

CREATE TABLE sincronizacao_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  
  tipo ENUM('DRIVE_SYNC', 'MANUAL_UPLOAD', 'AUTO_CATEGORIZE') DEFAULT 'DRIVE_SYNC',
  status ENUM('INICIADO', 'PROCESSANDO', 'SUCESSO', 'ERRO') DEFAULT 'INICIADO',
  
  mensagem TEXT,
  detalhes_json JSONB,
  
  iniciado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finalizado_em TIMESTAMP
);

CREATE INDEX idx_sincronizacao_usuario ON sincronizacao_log(usuario_id);
CREATE INDEX idx_sincronizacao_status ON sincronizacao_log(status);

-- ============================================================================
-- 11. TRIGGER PARA ATUALIZAR UPDATED_AT
-- ============================================================================

CREATE OR REPLACE FUNCTION atualizar_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_usuarios_updated_at
  BEFORE UPDATE ON usuarios
  FOR EACH ROW
  EXECUTE FUNCTION atualizar_updated_at();

CREATE TRIGGER trigger_contas_updated_at
  BEFORE UPDATE ON contas
  FOR EACH ROW
  EXECUTE FUNCTION atualizar_updated_at();

CREATE TRIGGER trigger_transacoes_updated_at
  BEFORE UPDATE ON transacoes
  FOR EACH ROW
  EXECUTE FUNCTION atualizar_updated_at();

CREATE TRIGGER trigger_categorias_updated_at
  BEFORE UPDATE ON categorias
  FOR EACH ROW
  EXECUTE FUNCTION atualizar_updated_at();

-- ============================================================================
-- 12. CATEGORIAS PADRÃO (PARA NOVO USUÁRIO)
-- ============================================================================

CREATE TABLE categoria_template (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  tipo ENUM('DESPESA', 'RECEITA', 'TRANSFERENCIA', 'INVESTIMENTO'),
  icon VARCHAR(50),
  emoji VARCHAR(5),
  ordem INT
);

INSERT INTO categoria_template (nome, tipo, icon, emoji, ordem) VALUES
-- DESPESAS
('Alimentação', 'DESPESA', 'ti-utensils', '🍔', 1),
('Transporte', 'DESPESA', 'ti-car', '🚗', 2),
('Saúde', 'DESPESA', 'ti-heart', '❤️', 3),
('Educação', 'DESPESA', 'ti-book', '📚', 4),
('Moradia', 'DESPESA', 'ti-home', '🏠', 5),
('Diversão', 'DESPESA', 'ti-theater', '🎭', 6),
('Vestuário', 'DESPESA', 'ti-shirt', '👕', 7),
('Utilidades', 'DESPESA', 'ti-plug', '🔌', 8),
('Assinaturas', 'DESPESA', 'ti-credit-card', '💳', 9),
('Viagem', 'DESPESA', 'ti-plane', '✈️', 10),
('Outros', 'DESPESA', 'ti-dots', '•••', 11),
-- RECEITAS
('Salário', 'RECEITA', 'ti-briefcase', '💼', 1),
('Freelance', 'RECEITA', 'ti-code', '💻', 2),
('Investimentos', 'RECEITA', 'ti-chart-line', '📈', 3),
('Bônus', 'RECEITA', 'ti-gift', '🎁', 4),
('Outros', 'RECEITA', 'ti-dots', '•••', 5),
-- TRANSFERÊNCIAS
('Transferência Enviada', 'TRANSFERENCIA', 'ti-arrow-right', '→', 1),
('Transferência Recebida', 'TRANSFERENCIA', 'ti-arrow-left', '←', 2),
-- INVESTIMENTOS
('Compra de Ações', 'INVESTIMENTO', 'ti-trending-up', '📈', 1),
('Venda de Ações', 'INVESTIMENTO', 'ti-trending-down', '📉', 2),
('Dividendos', 'INVESTIMENTO', 'ti-coin', '💰', 3);

-- ============================================================================
-- 13. VIEWS ÚTEIS
-- ============================================================================

-- Resumo de transações por mês
CREATE VIEW transacoes_por_mes AS
SELECT
  DATE_TRUNC('month', t.data)::date AS mes,
  c.id AS conta_id,
  c.nome AS conta_nome,
  cat.id AS categoria_id,
  cat.nome AS categoria_nome,
  t.tipo,
  SUM(t.valor) AS total,
  COUNT(*) AS quantidade
FROM transacoes t
JOIN contas c ON t.conta_id = c.id
LEFT JOIN categorias cat ON t.categoria_id = cat.id
WHERE t.deletado_em IS NULL
GROUP BY DATE_TRUNC('month', t.data), c.id, c.nome, cat.id, cat.nome, t.tipo;

-- Saldo atual por conta
CREATE VIEW saldo_contas AS
SELECT
  c.id,
  c.usuario_id,
  c.nome,
  c.banco,
  c.tipo,
  COALESCE(SUM(CASE WHEN t.tipo = 'CREDITO' THEN t.valor ELSE -t.valor END), 0) AS saldo
FROM contas c
LEFT JOIN transacoes t ON c.id = t.conta_id AND t.deletado_em IS NULL
WHERE c.ativo = true
GROUP BY c.id, c.usuario_id, c.nome, c.banco, c.tipo;

-- ============================================================================
-- FIM DO SCHEMA
-- ============================================================================

-- ============================================================================
-- PROVISÕES E CONCILIAÇÕES
-- ============================================================================

CREATE TABLE provisoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL,
  valor_previsto DECIMAL(12, 2) NOT NULL CHECK (valor_previsto > 0),
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('CREDITO', 'DEBITO')),
  data_prevista DATE NOT NULL,
  data_vencimento DATE,
  conta_id UUID REFERENCES contas(id) ON DELETE SET NULL,
  categoria_macro_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
  categoria_detalhada_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'CONCILIADA', 'ATRASADA', 'CANCELADA', 'IGNORADA')),
  observacao TEXT,
  recorrente BOOLEAN DEFAULT false,
  periodicidade VARCHAR(20),
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_provisoes_usuario_status ON provisoes(usuario_id, status);
CREATE INDEX idx_provisoes_datas ON provisoes(data_prevista, data_vencimento);
CREATE INDEX idx_provisoes_conta ON provisoes(conta_id);

CREATE TABLE conciliacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  provisao_id UUID NOT NULL REFERENCES provisoes(id) ON DELETE CASCADE,
  transacao_id UUID NOT NULL REFERENCES transacoes(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'SUGERIDA' CHECK (status IN ('SUGERIDA', 'CONFIRMADA', 'IGNORADA', 'DESFEITA')),
  confianca VARCHAR(20) CHECK (confianca IN ('ALTA', 'MEDIA', 'BAIXA')),
  score DECIMAL(5, 2),
  motivos JSONB DEFAULT '[]'::jsonb,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmado_em TIMESTAMP,
  ignorado_em TIMESTAMP
);

CREATE INDEX idx_conciliacoes_usuario_status ON conciliacoes(usuario_id, status);
CREATE INDEX idx_conciliacoes_provisao ON conciliacoes(provisao_id);
CREATE INDEX idx_conciliacoes_transacao ON conciliacoes(transacao_id);
CREATE UNIQUE INDEX idx_conciliacoes_provisao_ativa ON conciliacoes(provisao_id) WHERE status = 'CONFIRMADA';
CREATE UNIQUE INDEX idx_conciliacoes_transacao_ativa ON conciliacoes(transacao_id) WHERE status = 'CONFIRMADA';

-- ============================================================================
-- PLANEJAMENTO MENSAL
-- ============================================================================
-- Planejamento é orçamento/previsão por mês e categoria. Ele não é conciliado
-- diretamente com transações; a comparação com realizado é agregada por categoria.

CREATE TABLE planejamentos_mensais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  mes INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  ano INT NOT NULL CHECK (ano BETWEEN 1900 AND 2100),
  descricao TEXT NOT NULL,
  categoria TEXT,
  categoria_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
  tipo_despesa VARCHAR(20) NOT NULL CHECK (tipo_despesa IN ('FIXA', 'VARIAVEL')),
  valor_previsto DECIMAL(12, 2) NOT NULL CHECK (valor_previsto > 0),
  dia_previsto INT CHECK (dia_previsto IS NULL OR dia_previsto BETWEEN 1 AND 31),
  observacao TEXT,
  recorrencia_tipo VARCHAR(20) NOT NULL DEFAULT 'UNICA' CHECK (recorrencia_tipo IN ('UNICA', 'MENSAL', 'PARCELADA')),
  recorrencia_id UUID,
  quantidade_parcelas INT CHECK (quantidade_parcelas IS NULL OR quantidade_parcelas > 0),
  parcela_atual INT CHECK (parcela_atual IS NULL OR parcela_atual > 0),
  mes_inicio INT,
  ano_inicio INT,
  mes_fim INT CHECK (mes_fim IS NULL OR mes_fim BETWEEN 1 AND 12),
  ano_fim INT CHECK (ano_fim IS NULL OR ano_fim BETWEEN 1900 AND 2100),
  ativa BOOLEAN DEFAULT true,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_planejamentos_usuario_mes_ano ON planejamentos_mensais(usuario_id, ano, mes);
CREATE INDEX idx_planejamentos_recorrencia ON planejamentos_mensais(usuario_id, recorrencia_id);
CREATE INDEX idx_planejamentos_categoria ON planejamentos_mensais(usuario_id, categoria_id);
