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
app.use(express.urlencoded({ limit: '50mb' }));

// ============================================================================
// DATABASE
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 
    'postgresql://seu_usuario:sua_senha@localhost:5432/financas'
});

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
  const str = `${tx.data}|${tx.descricao}|${tx.valor}`;
  return crypto.createHash('sha256').update(str).digest('hex');
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
        return new Date(match[3], parseInt(match[2]) - 1, match[1]);
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

// ============================================================================
// ROTAS: AUTENTICAÇÃO
// ============================================================================

app.get('/api/auth/google/url', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  res.json({ url: authUrl });
});

app.post('/api/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.body;

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

    // Gerar JWT
    const jwtToken = jwt.sign(
      { usuario_id, email },
      process.env.JWT_SECRET || 'seu_secret_aqui',
      { expiresIn: '7d' }
    );

    res.json({
      token: jwtToken,
      usuario: { id: usuario_id, email, nome: name, foto: picture },
    });
  } catch (error) {
    console.error('Erro auth:', error);
    res.status(500).json({ erro: error.message });
  }
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

    // Listar pastas em FINANÇAS_PESSOAIS
    const finançasFolderId = process.env.DRIVE_FINANÇAS_FOLDER_ID;

    const res1 = await drive.files.list({
      q: `'${finançasFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
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

          inserida++;
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

// Serve static files from React build
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback: send index.html for all non-API routes (SPA)
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) {
          res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    } else {
          res.status(404).json({ erro: 'Rota nao encontrada' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server rodando na porta ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
});
