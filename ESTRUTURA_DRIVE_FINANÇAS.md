# 📊 Arquitetura do Google Drive para App de Finanças

## Estrutura de Pastas Recomendada

```
📁 FINANÇAS_PESSOAIS (pasta raiz)
│
├── 📁 CONTAS
│   ├── 📁 Nubank_Cartão
│   │   ├── 📁 2025
│   │   │   ├── 📁 Janeiro
│   │   │   │   └── 📄 extrato_2025-01-15.csv
│   │   │   ├── 📁 Fevereiro
│   │   │   └── 📁 Março
│   │   └── 📁 2026
│   │       ├── 📁 Janeiro
│   │       ├── 📁 Fevereiro
│   │       └── 📁 Março
│   │
│   ├── 📁 BB_Conta_Corrente
│   │   ├── 📁 2025
│   │   └── 📁 2026
│   │
│   ├── 📁 Bradesco_Poupança
│   │   └── 📁 2026
│   │
│   └── 📁 Investimentos_B3
│       └── 📁 2026
│
├── 📁 IMPORTAÇÕES_PROCESSADAS
│   └── [Histórico de arquivos já processados]
│
├── 📁 BACKUPS
│   └── [Backup automático de arquivos originais]
│
└── 📁 METADADOS
    ├── 📄 mapeamento_contas.json
    ├── 📄 configuracao_parsers.json
    └── 📄 histórico_importações.json
```

---

## Convenção de Nomes de Arquivo

```
{BANCO}_{TIPO_CONTA}_{DATA_INÍCIO}_{DATA_FIM}.csv

Exemplos:
- NUBANK_CARTÃO_2025-01-01_2025-01-31.csv
- BB_CONTA_2025-01-01_2025-01-31.csv
- BRADESCO_POUPANÇA_2025-01-01_2025-01-31.csv
- B3_INVESTIMENTOS_2025-01-01_2025-01-31.csv
```

---

## Estrutura de Dados no Drive (Metadados)

### `mapeamento_contas.json`
```json
{
  "contas": [
    {
      "id": "nubank-cartao-001",
      "nome": "Nubank Cartão",
      "banco": "Nubank",
      "tipo": "CREDIT_CARD",
      "cpf_parcial": "42122320",
      "moeda": "BRL",
      "drive_folder_id": "1xAbCD123...",
      "ativo": true,
      "color": "#9900CC"
    },
    {
      "id": "bb-conta-001",
      "nome": "Banco do Brasil",
      "banco": "BB",
      "tipo": "CHECKING",
      "agencia": "0001",
      "conta": "123456-7",
      "drive_folder_id": "1xAbCD456...",
      "ativo": true,
      "color": "#FF7800"
    },
    {
      "id": "b3-investimentos",
      "nome": "Investimentos B3",
      "banco": "B3",
      "tipo": "INVESTMENT",
      "drive_folder_id": "1xAbCD789...",
      "ativo": true,
      "color": "#1E90FF"
    }
  ]
}
```

### `configuracao_parsers.json`
```json
{
  "parsers": {
    "NUBANK": {
      "banco": "Nubank",
      "tipos": ["CREDIT_CARD", "CHECKING"],
      "csv_format": {
        "encoding": "utf-8",
        "delimiter": ",",
        "columns": [
          "data",
          "descricao",
          "categoria",
          "valor",
          "saldo"
        ]
      },
      "regex_patterns": {
        "data": "\\d{2}/\\d{2}/\\d{4}",
        "valor": "\\d+[.,]\\d{2}"
      }
    },
    "BB": {
      "banco": "Banco do Brasil",
      "tipos": ["CHECKING", "SAVINGS"],
      "csv_format": {
        "encoding": "iso-8859-1",
        "delimiter": ";",
        "columns": [
          "data_lancamento",
          "data_valor",
          "tipo_lancamento",
          "descricao",
          "valor"
        ]
      }
    },
    "BRADESCO": {
      "banco": "Bradesco",
      "tipos": ["CHECKING", "SAVINGS"],
      "csv_format": {
        "encoding": "iso-8859-1",
        "delimiter": ";",
        "columns": [
          "data",
          "operacao",
          "descricao",
          "debito",
          "credito",
          "saldo"
        ]
      }
    },
    "B3": {
      "banco": "B3",
      "tipos": ["INVESTMENT"],
      "csv_format": {
        "encoding": "utf-8",
        "delimiter": ",",
        "columns": [
          "data",
          "ativo",
          "tipo_operacao",
          "quantidade",
          "valor_unitario",
          "valor_total"
        ]
      }
    }
  }
}
```

### `histórico_importações.json`
```json
{
  "importacoes": [
    {
      "id": "imp_001",
      "data_importacao": "2025-01-15T10:30:00Z",
      "arquivo_original": "NUBANK_CARTÃO_2025-01-01_2025-01-31.csv",
      "drive_file_id": "1xAbCD...",
      "drive_file_path": "/FINANÇAS_PESSOAIS/CONTAS/Nubank_Cartão/2025/Janeiro/",
      "conta_id": "nubank-cartao-001",
      "total_linhas": 45,
      "total_linhas_importadas": 42,
      "total_duplicadas": 3,
      "status": "sucesso",
      "hash": "sha256_abc123...",
      "user_id": "user_123"
    }
  ]
}
```

---

## Como o Backend Integra com Drive

### Fluxo de Sincronização

```
1. AUTENTICAÇÃO
   └─ Usuário faz OAuth com Google
   └─ Backend guarda refresh_token

2. LEITURA DE ESTRUTURA
   └─ Backend lê pasta FINANÇAS_PESSOAIS
   └─ Identifica subpastas (Nubank, BB, etc)
   └─ Carrega mapeamento_contas.json
   └─ Carrega configuracao_parsers.json

3. MONITORAMENTO DE MUDANÇAS
   └─ Verifica novos arquivos CSV
   └─ Compara hash com histórico_importações.json
   └─ Detecta arquivos não processados

4. PROCESSAMENTO
   └─ Faz download do arquivo CSV
   └─ Identifica banco/tipo pelo nome do arquivo
   └─ Aplica parser correto (encoding, delimiter, etc)
   └─ Valida dados
   └─ Remove duplicatas (comparando com BD)
   └─ Insere no PostgreSQL

5. ORGANIZAÇÃO
   └─ Move arquivo para IMPORTAÇÕES_PROCESSADAS/[conta]/[data]/
   └─ Atualiza histórico_importações.json
   └─ Marca como processado no BD

6. BACKUP
   └─ Mantém cópia em BACKUPS/[ano]/[mês]/
```

---

## Mapeamento: Identificar o Banco Automaticamente

```javascript
// No backend - parser inteligente
function identificarBanco(nomeArquivo) {
  const patterns = {
    'NUBANK': /NU_|NUBANK/i,
    'BB': /BB_|BRASIL|BANCO\s*BRASIL/i,
    'BRADESCO': /BRADE|BRADESCO/i,
    'B3': /B3_|BOVESPA|INVESTIMENTO/i,
    'ITAU': /ITAU|ITAÚ/i,
    'CAIXA': /CAIXA|CEF/i,
  };

  for (const [banco, regex] of Object.entries(patterns)) {
    if (regex.test(nomeArquivo)) {
      return banco;
    }
  }
  return null; // Banco desconhecido
}

// Inferir tipo de conta pelo nome
function inferirTipoConta(nomeArquivo, banco) {
  const patterns = {
    'CREDIT_CARD': /CARTÃO|CARTAO|CC|CREDIT/i,
    'CHECKING': /CONTA|CORRENTE|CHECKING/i,
    'SAVINGS': /POUPANÇA|POUPANCA|SAVINGS/i,
    'INVESTMENT': /INVESTIMENTO|B3|ACAO|ACTION/i,
  };

  for (const [tipo, regex] of Object.entries(patterns)) {
    if (regex.test(nomeArquivo)) {
      return tipo;
    }
  }
  return 'CHECKING'; // Default
}
```

---

## Integração Frontend ↔ Backend ↔ Drive

### 1️⃣ Upload de Novo Extrato (Frontend)

```
Usuário seleciona arquivo CSV
       ↓
Frontend faz upload pra backend
       ↓
Backend salva em pasta Drive correspondente
       ↓
Backend processa e importa para BD
       ↓
Frontend recebe lista de transações
       ↓
Usuário categoriza
```

### 2️⃣ Sincronização Automática (Backend)

```
A cada 6 horas (cronjob):
  ├─ Conecta ao Google Drive
  ├─ Lê estrutura de pastas
  ├─ Identifica novos arquivos
  ├─ Compara com BD (via hash)
  ├─ Processa arquivos novos
  └─ Atualiza histórico
```

### 3️⃣ Relatórios Inteligentes (Frontend)

```
Dashboard agrega dados de TODAS as contas:
├─ Gastos totais (cartão + conta)
├─ Gastos por categoria (consolidado)
├─ Comparação mês a mês
├─ Investimentos vs gastos
└─ Fluxo de caixa
```

---

## Schema PostgreSQL

```sql
-- Tabela de contas
CREATE TABLE contas (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  nome VARCHAR(255),
  banco VARCHAR(100),
  tipo ENUM ('CREDIT_CARD', 'CHECKING', 'SAVINGS', 'INVESTMENT'),
  drive_folder_id VARCHAR(255),
  color VARCHAR(7),
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de transações
CREATE TABLE transacoes (
  id UUID PRIMARY KEY,
  conta_id UUID NOT NULL REFERENCES contas(id),
  data DATE,
  descricao TEXT,
  categoria_id UUID,
  valor DECIMAL(12, 2),
  tipo ENUM ('CREDITO', 'DEBITO'),
  saldo DECIMAL(12, 2),
  importacao_id VARCHAR(255),
  hash_transacao VARCHAR(64) UNIQUE, -- SHA256 pra detectar duplicatas
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conta_id) REFERENCES contas(id)
);

-- Tabela de importações (histórico)
CREATE TABLE importacoes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  conta_id UUID REFERENCES contas(id),
  arquivo_nome VARCHAR(255),
  drive_file_id VARCHAR(255),
  drive_file_path TEXT,
  total_linhas INT,
  linhas_importadas INT,
  linhas_duplicadas INT,
  status ENUM ('pendente', 'processando', 'sucesso', 'erro'),
  mensagem_erro TEXT,
  hash_arquivo VARCHAR(64),
  data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de categorias
CREATE TABLE categorias (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  nome VARCHAR(255),
  cor VARCHAR(7),
  icon VARCHAR(50),
  is_custom BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de mapeamento de descrições pra categorias (auto-categoria)
CREATE TABLE descricao_categoria_mapping (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  descricao_pattern VARCHAR(255),
  categoria_id UUID REFERENCES categorias(id),
  confianca FLOAT, -- 0.0 a 1.0
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Próximos Passos

1. **Reorganizar pastas no Drive** (usar a estrutura acima)
2. **Criar arquivo de metadados** (mapeamento_contas.json)
3. **Implementar Google Drive API** no backend
4. **Criar parsers específicos** para cada banco
5. **Implementar deduplicação** com hash
6. **Fazer cronjob** de sincronização automática
