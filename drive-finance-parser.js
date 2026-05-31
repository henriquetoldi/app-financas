// ============================================================================
// SCRIPT: Google Drive Finance Organizer + Parser
// Propósito: Ler extratos do Drive, organizar por conta e importar para BD
// ============================================================================

// npm install googleapis dotenv pg csv-parser crypto

const { google } = require('googleapis');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// ============================================================================
// 1. CONFIGURAÇÃO
// ============================================================================

const drive = google.drive({ version: 'v3' });
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const FINANÇAS_FOLDER_ID = process.env.DRIVE_FINANÇAS_FOLDER_ID;
const IMPORTAÇÕES_FOLDER_ID = process.env.DRIVE_IMPORTAÇÕES_FOLDER_ID;

// ============================================================================
// 2. PARSERS POR BANCO
// ============================================================================

/**
 * Parser para extratos Nubank (cartão e conta)
 * Formato esperado: data, descricao, categoria, valor, saldo
 */
function parseNubank(csvContent, tipoConta) {
  const linhas = csvContent.split('\n').filter(l => l.trim());
  const transacoes = [];

  // Pula header se existir
  const inicio = linhas[0].includes('data') ? 1 : 0;

  for (let i = inicio; i < linhas.length; i++) {
    const [data, descricao, categoria, valor, saldo] = linhas[i].split(',').map(v => v.trim());

    if (!data || !descricao || !valor) continue;

    const tipo = parseFloat(valor.replace(/[.,]/g, (m, i) => m === ',' ? '.' : m)) < 0 
      ? 'DEBITO' 
      : 'CREDITO';

    transacoes.push({
      data: parseDate(data),
      descricao: descricao.trim(),
      categoria: categoria?.trim() || null,
      valor: Math.abs(parseFloat(valor.replace(/[.,]/g, (m, i) => m === ',' ? '.' : m))),
      tipo,
      saldo: saldo ? parseFloat(saldo.replace(/[.,]/g, (m, i) => m === ',' ? '.' : m)) : null,
    });
  }

  return transacoes;
}

/**
 * Parser para Banco do Brasil (ISO-8859-1, delimiter ;)
 */
function parseBoB(csvContent) {
  const linhas = csvContent.split('\n').filter(l => l.trim());
  const transacoes = [];

  const inicio = linhas[0].includes('data') ? 1 : 0;

  for (let i = inicio; i < linhas.length; i++) {
    const campos = linhas[i].split(';').map(v => v.trim());
    const [dataLancamento, dataValor, tipoLancamento, descricao, valor] = campos;

    if (!dataValor || !valor) continue;

    transacoes.push({
      data: parseDate(dataValor),
      descricao: descricao || tipoLancamento,
      valor: parseFloat(valor.replace(/[.,]/g, (m, i) => m === ',' ? '.' : m)),
      tipo: valor.includes('-') ? 'DEBITO' : 'CREDITO',
    });
  }

  return transacoes;
}

/**
 * Parser para Bradesco (ISO-8859-1, delimiter ;)
 */
function parseBradesco(csvContent) {
  const linhas = csvContent.split('\n').filter(l => l.trim());
  const transacoes = [];

  const inicio = linhas[0].includes('data') ? 1 : 0;

  for (let i = inicio; i < linhas.length; i++) {
    const [data, operacao, descricao, debito, credito, saldo] = linhas[i]
      .split(';')
      .map(v => v.trim());

    if (!data) continue;

    const valor = debito || credito;
    const tipo = debito ? 'DEBITO' : 'CREDITO';

    transacoes.push({
      data: parseDate(data),
      descricao: descricao || operacao,
      valor: parseFloat(valor.replace(/[.,]/g, (m, i) => m === ',' ? '.' : m)),
      tipo,
      saldo: saldo ? parseFloat(saldo.replace(/[.,]/g, (m, i) => m === ',' ? '.' : m)) : null,
    });
  }

  return transacoes;
}

/**
 * Parser para B3/Investimentos
 */
function parseB3(csvContent) {
  const linhas = csvContent.split('\n').filter(l => l.trim());
  const transacoes = [];

  const inicio = 1; // Pula header

  for (let i = inicio; i < linhas.length; i++) {
    const [data, ativo, tipoOper, qtd, valorUnit, valorTotal] = linhas[i]
      .split(',')
      .map(v => v.trim());

    if (!data) continue;

    transacoes.push({
      data: parseDate(data),
      descricao: `${tipoOper} - ${ativo} (${qtd} @ ${valorUnit})`,
      valor: parseFloat(valorTotal.replace(/[.,]/g, (m, i) => m === ',' ? '.' : m)),
      tipo: tipoOper.includes('Compra') ? 'DEBITO' : 'CREDITO',
      ativo,
      quantidade: parseInt(qtd),
    });
  }

  return transacoes;
}

// ============================================================================
// 3. FUNÇÕES AUXILIARES
// ============================================================================

/**
 * Identificar banco pelo nome do arquivo
 */
function identificarBanco(nomeArquivo) {
  const patterns = {
    'NUBANK': /NU_|NUBANK/i,
    'BB': /BB_|BRASIL|BANCO\s*DO\s*BRASIL/i,
    'BRADESCO': /BRADE|BRADESCO/i,
    'B3': /B3_|BOVESPA|INVESTIMENTO/i,
    'ITAU': /ITAU|ITAÚ/i,
  };

  for (const [banco, regex] of Object.entries(patterns)) {
    if (regex.test(nomeArquivo)) return banco;
  }
  return null;
}

/**
 * Inferir tipo de conta pelo nome
 */
function inferirTipoConta(nomeArquivo, banco) {
  const patterns = {
    'CREDIT_CARD': /CARTÃO|CARTAO|CC|CREDIT/i,
    'CHECKING': /CONTA|CORRENTE|CHECKING/i,
    'SAVINGS': /POUPANÇA|POUPANCA|SAVINGS/i,
    'INVESTMENT': /INVESTIMENTO|B3|ACAO|ACTION/i,
  };

  for (const [tipo, regex] of Object.entries(patterns)) {
    if (regex.test(nomeArquivo)) return tipo;
  }

  // Default por banco
  if (banco === 'B3') return 'INVESTMENT';
  return 'CHECKING';
}

/**
 * Parse flexível de data (DD/MM/YYYY, YYYY-MM-DD, etc)
 */
function parseDate(dateStr) {
  const formats = [
    /(\d{2})\/(\d{2})\/(\d{4})/, // DD/MM/YYYY
    /(\d{4})-(\d{2})-(\d{2})/,   // YYYY-MM-DD
    /(\d{2})-(\d{2})-(\d{4})/,   // DD-MM-YYYY
  ];

  for (const regex of formats) {
    const match = dateStr.match(regex);
    if (!match) continue;

    if (match[3].length === 4) {
      // Ano está em posição 3
      if (match[0].match(/^\d{2}[/-]/)) {
        // DD/MM/YYYY ou DD-MM-YYYY
        return new Date(match[3], match[2] - 1, match[1]);
      } else {
        // YYYY-MM-DD
        return new Date(match[1], match[2] - 1, match[3]);
      }
    }
  }

  return new Date(dateStr);
}

/**
 * Gerar hash SHA256 para deduplicação
 */
function gerarHashTransacao(transacao) {
  const str = `${transacao.data}|${transacao.descricao}|${transacao.valor}|${transacao.tipo}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Gerar hash do arquivo
 */
function gerarHashArquivo(conteudo) {
  return crypto.createHash('sha256').update(conteudo).digest('hex');
}

// ============================================================================
// 4. INTEGRAÇÃO COM GOOGLE DRIVE
// ============================================================================

/**
 * Autenticar com Google Drive
 */
async function autenticar(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/**
 * Listar arquivos em uma pasta do Drive
 */
async function listarArquivosNaPasta(auth, folderId) {
  try {
    const res = await drive.files.list({
      auth,
      q: `'${folderId}' in parents and mimeType='text/csv'`,
      fields: 'files(id, name, modifiedTime, parents)',
      pageSize: 100,
    });

    return res.data.files || [];
  } catch (error) {
    console.error('Erro ao listar arquivos:', error);
    return [];
  }
}

/**
 * Fazer download de arquivo do Drive
 */
async function downloadArquivoDorive(auth, fileId, encoding = 'utf-8') {
  try {
    const res = await drive.files.get(
      { auth, fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      let data = '';
      res.data.on('data', chunk => {
        data += chunk.toString(encoding);
      });
      res.data.on('end', () => resolve(data));
      res.data.on('error', reject);
    });
  } catch (error) {
    console.error('Erro ao fazer download:', error);
    return null;
  }
}

/**
 * Fazer upload de arquivo para o Drive
 */
async function uploadParaDrive(auth, nomeArquivo, conteudo, folderParentId) {
  try {
    const res = await drive.files.create({
      auth,
      requestBody: {
        name: nomeArquivo,
        parents: [folderParentId],
      },
      media: {
        mimeType: 'text/csv',
        body: conteudo,
      },
    });

    return res.data;
  } catch (error) {
    console.error('Erro ao fazer upload:', error);
    return null;
  }
}

/**
 * Mover arquivo no Drive
 */
async function moverArquitvoDrive(auth, fileId, novoFolderId) {
  try {
    const res = await drive.files.update({
      auth,
      fileId,
      addParents: novoFolderId,
      removeParents: (await drive.files.get({ auth, fileId, fields: 'parents' }))
        .data.parents.join(','),
    });

    return res.data;
  } catch (error) {
    console.error('Erro ao mover arquivo:', error);
    return null;
  }
}

// ============================================================================
// 5. IMPORTAÇÃO PARA BANCO DE DADOS
// ============================================================================

/**
 * Inserir transações no BD
 */
async function inserirTransacoes(contaId, transacoes, importacaoId) {
  const client = await pgPool.connect();
  let inseridas = 0;
  let duplicadas = 0;

  try {
    await client.query('BEGIN');

    for (const tx of transacoes) {
      const hash = gerarHashTransacao(tx);

      // Verificar se já existe (deduplicação)
      const existe = await client.query(
        'SELECT id FROM transacoes WHERE hash_transacao = $1 AND conta_id = $2',
        [hash, contaId]
      );

      if (existe.rows.length > 0) {
        duplicadas++;
        continue;
      }

      // Inserir nova transação
      await client.query(
        `INSERT INTO transacoes 
         (id, conta_id, data, descricao, valor, tipo, saldo, importacao_id, hash_transacao, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          crypto.randomUUID(),
          contaId,
          tx.data,
          tx.descricao,
          tx.valor,
          tx.tipo,
          tx.saldo || null,
          importacaoId,
          hash,
        ]
      );

      inseridas++;
    }

    await client.query('COMMIT');
    return { inseridas, duplicadas };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao inserir transações:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Criar registro de importação
 */
async function criarRegistroImportacao(userId, contaId, dados) {
  const query = `
    INSERT INTO importacoes 
    (id, user_id, conta_id, arquivo_nome, drive_file_id, drive_file_path, 
     total_linhas, linhas_importadas, linhas_duplicadas, status, hash_arquivo, data_importacao)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    RETURNING id
  `;

  const result = await pgPool.query(query, [
    crypto.randomUUID(),
    userId,
    contaId,
    dados.arquivo_nome,
    dados.drive_file_id,
    dados.drive_file_path,
    dados.total_linhas,
    dados.linhas_importadas,
    dados.linhas_duplicadas,
    dados.status,
    dados.hash_arquivo,
  ]);

  return result.rows[0].id;
}

// ============================================================================
// 6. FLUXO PRINCIPAL
// ============================================================================

async function processarExtratoDorive(accessToken, userId, fileId, fileName) {
  console.log(`\n📥 Processando: ${fileName}`);

  try {
    const auth = await autenticar(accessToken);

    // 1. Identificar banco
    const banco = identificarBanco(fileName);
    const tipoConta = inferirTipoConta(fileName, banco);

    if (!banco) {
      throw new Error(`Não consegui identificar o banco: ${fileName}`);
    }

    console.log(`🏦 Banco: ${banco} | Tipo: ${tipoConta}`);

    // 2. Baixar arquivo (com encoding correto)
    const encoding = ['BB', 'BRADESCO'].includes(banco) ? 'iso-8859-1' : 'utf-8';
    const conteudo = await downloadArquivoDorive(auth, fileId, encoding);

    if (!conteudo) {
      throw new Error('Não consegui fazer download do arquivo');
    }

    console.log(`📦 Arquivo baixado (${conteudo.length} bytes)`);

    // 3. Parser adequado
    let transacoes;
    switch (banco) {
      case 'NUBANK':
        transacoes = parseNubank(conteudo, tipoConta);
        break;
      case 'BB':
        transacoes = parseBoB(conteudo);
        break;
      case 'BRADESCO':
        transacoes = parseBradesco(conteudo);
        break;
      case 'B3':
        transacoes = parseB3(conteudo);
        break;
      default:
        throw new Error(`Parser não implementado para ${banco}`);
    }

    console.log(`✅ Parseado: ${transacoes.length} transações`);

    // 4. Buscar/criar conta no BD
    let contaId = await buscarContaBD(banco, tipoConta, userId);
    if (!contaId) {
      contaId = await criarContaBD(userId, banco, tipoConta);
      console.log(`🆕 Conta criada: ${contaId}`);
    }

    // 5. Inserir transações e detectar duplicatas
    const { inseridas, duplicadas } = await inserirTransacoes(contaId, transacoes, fileId);

    // 6. Registrar importação
    const hashArquivo = gerarHashArquivo(conteudo);
    const importacaoId = await criarRegistroImportacao(userId, contaId, {
      arquivo_nome: fileName,
      drive_file_id: fileId,
      drive_file_path: `/${banco}/${tipoConta}/`,
      total_linhas: transacoes.length,
      linhas_importadas: inseridas,
      linhas_duplicadas: duplicadas,
      status: 'sucesso',
      hash_arquivo: hashArquivo,
    });

    console.log(`✨ Importação #${importacaoId}:`);
    console.log(`   - Inseridas: ${inseridas}`);
    console.log(`   - Duplicadas: ${duplicadas}`);

    return { sucesso: true, importacaoId, inseridas, duplicadas };
  } catch (error) {
    console.error(`❌ Erro ao processar ${fileName}:`, error.message);
    return { sucesso: false, erro: error.message };
  }
}

// ============================================================================
// 7. FUNÇÕES DE BANCO DE DADOS
// ============================================================================

async function buscarContaBD(banco, tipo, userId) {
  const result = await pgPool.query(
    'SELECT id FROM contas WHERE banco = $1 AND tipo = $2 AND user_id = $3 LIMIT 1',
    [banco, tipo, userId]
  );

  return result.rows[0]?.id || null;
}

async function criarContaBD(userId, banco, tipo) {
  const nomes = {
    NUBANK_CREDIT_CARD: 'Nubank Cartão',
    NUBANK_CHECKING: 'Nubank Conta',
    BB_CHECKING: 'Banco do Brasil',
    BRADESCO_CHECKING: 'Bradesco Conta',
    B3_INVESTMENT: 'Investimentos B3',
  };

  const id = crypto.randomUUID();
  const nome = nomes[`${banco}_${tipo}`] || `${banco} ${tipo}`;

  await pgPool.query(
    `INSERT INTO contas (id, user_id, nome, banco, tipo, ativo, created_at)
     VALUES ($1, $2, $3, $4, $5, true, NOW())`,
    [id, userId, nome, banco, tipo]
  );

  return id;
}

// ============================================================================
// 8. EXPORTAR PARA USO
// ============================================================================

module.exports = {
  processarExtratoDorive,
  identificarBanco,
  inferirTipoConta,
  parseNubank,
  parseBoB,
  parseBradesco,
  parseB3,
  autenticar,
  listarArquivosNaPasta,
  downloadArquivoDorive,
  uploadParaDrive,
  moverArquitvoDrive,
};
