diff --git a/backend-server.js b/backend-server.js
index 368903e84a6feb7d93c98a31a65e343acd8f4874..28285d7e2ef06d4463e45d7a4bb72601b4485257 100644
--- a/backend-server.js
+++ b/backend-server.js
@@ -1,57 +1,59 @@
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
+const fs = require('fs');
+const crypto = require('crypto');
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
-app.use(express.urlencoded({ limit: '50mb' }));
+app.use(express.urlencoded({ extended: true, limit: '50mb' }));
 
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
@@ -322,51 +324,51 @@ app.post('/api/importar/:arquivoId', verificarToken, async (req, res) => {
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
 
-          inserida++;
+          inseridas++;
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
@@ -468,42 +470,51 @@ app.get('/api/categorias', verificarToken, async (req, res) => {
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
 
+const distPath = path.join(__dirname, 'dist');
+const indexPath = path.join(distPath, 'index.html');
+
 // Serve static files from React build
-app.use(express.static(path.join(__dirname, 'dist')));
+app.use(express.static(distPath));
 
 // Fallback: send index.html for all non-API routes (SPA)
 app.get('*', (req, res) => {
-    if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) {
-          res.sendFile(path.join(__dirname, 'dist', 'index.html'));
-    } else {
-          res.status(404).json({ erro: 'Rota nao encontrada' });
-    }
+  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
+    return res.status(404).json({ erro: 'Rota nao encontrada' });
+  }
+
+  if (!fs.existsSync(indexPath)) {
+    return res.status(503).send(
+      'Frontend build not found. Run `npm run build` before starting the server.'
+    );
+  }
+
+  return res.sendFile(indexPath);
 });
 
 const PORT = process.env.PORT || 3000;
 app.listen(PORT, () => {
   console.log(`✅ Server rodando na porta ${PORT}`);
   console.log(`📍 http://localhost:${PORT}`);
 });
