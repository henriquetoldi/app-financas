// ============================================================================
// EXEMPLO: Como usar o Finance Parser
// ============================================================================

const { processarExtratoDorive } = require('./drive-finance-parser');

// ============================================================================
// CENÁRIO 1: Importar um arquivo específico do Drive
// ============================================================================

async function importarArquivoEspecifico() {
  const accessToken = 'seu_access_token_aqui'; // Obtido via OAuth
  const userId = 'user_123';
  const fileId = '1xAbCD...'; // ID do arquivo no Drive
  const fileName = 'NUBANK_CARTÃO_2025-01-01_2025-01-31.csv';

  const resultado = await processarExtratoDorive(
    accessToken,
    userId,
    fileId,
    fileName
  );

  if (resultado.sucesso) {
    console.log(`✅ Importação bem-sucedida!`);
    console.log(`   ID: ${resultado.importacaoId}`);
    console.log(`   Inseridas: ${resultado.inseridas}`);
    console.log(`   Duplicadas: ${resultado.duplicadas}`);
  } else {
    console.error(`❌ Erro:`, resultado.erro);
  }
}

// ============================================================================
// CENÁRIO 2: Sincronizar TODAS as pastas do Drive (cronjob)
// ============================================================================

const { 
  autenticar, 
  listarArquivosNaPasta, 
  downloadArquivoDorive,
  moverArquitvoDrive 
} = require('./drive-finance-parser');

async function sincronizarTodooDrive() {
  console.log('🔄 Iniciando sincronização com Drive...');

  const accessToken = 'seu_access_token_refresh'; // Refresh token
  const userId = 'user_123';
  const finançasFolderId = process.env.DRIVE_FINANÇAS_FOLDER_ID;

  try {
    const auth = await autenticar(accessToken);

    // 1. Listar todas as subpastas (Nubank, BB, Bradesco, B3)
    const contasPastas = await listarArquivosNaPasta(auth, finançasFolderId);
    console.log(`📁 Encontradas ${contasPastas.length} pastas de contas`);

    let totalProcessado = 0;

    // 2. Para cada pasta de conta
    for (const contaPasta of contasPastas) {
      console.log(`\n📂 Processando: ${contaPasta.name}`);

      // 3. Listar arquivos CSV nesta pasta
      const arquivos = await listarArquivosNaPasta(auth, contaPasta.id);
      console.log(`   - ${arquivos.length} arquivos encontrados`);

      // 4. Processar cada arquivo
      for (const arquivo of arquivos) {
        const resultado = await processarExtratoDorive(
          accessToken,
          userId,
          arquivo.id,
          arquivo.name
        );

        if (resultado.sucesso) {
          totalProcessado++;
          // Mover arquivo para "IMPORTAÇÕES_PROCESSADAS"
          // await moverArquitvoDrive(
          //   auth,
          //   arquivo.id,
          //   process.env.DRIVE_IMPORTAÇÕES_FOLDER_ID
          // );
        }
      }
    }

    console.log(`\n✨ Sincronização completa! ${totalProcessado} arquivos processados.`);
  } catch (error) {
    console.error('❌ Erro na sincronização:', error);
  }
}

// ============================================================================
// CENÁRIO 3: Endpoint Express para receber upload
// ============================================================================

// app.post('/api/upload', async (req, res) => {
//   try {
//     const { arquivo, userId } = req.body;
//     const { accessToken } = req.session;

//     // Fazer upload pra pasta no Drive
//     const auth = await autenticar(accessToken);
//     const uploadado = await uploadParaDrive(
//       auth,
//       arquivo.name,
//       arquivo.conteudo,
//       process.env.DRIVE_FINANÇAS_FOLDER_ID
//     );

//     // Processar arquivo
//     const resultado = await processarExtratoDorive(
//       accessToken,
//       userId,
//       uploadado.id,
//       arquivo.name
//     );

//     res.json({
//       sucesso: resultado.sucesso,
//       importacaoId: resultado.importacaoId,
//       inseridas: resultado.inseridas,
//       duplicadas: resultado.duplicadas,
//     });
//   } catch (error) {
//     res.status(500).json({ erro: error.message });
//   }
// });

// ============================================================================
// CENÁRIO 4: Cronjob de sincronização automática
// ============================================================================

// const cron = require('node-cron');

// // Executar a cada 6 horas
// cron.schedule('0 */6 * * *', async () => {
//   console.log('⏰ Executando sincronização automática...');
//   await sincronizarTodooDrive();
// });

// ============================================================================
// EXECUTAR EXEMPLOS
// ============================================================================

// Descomente para testar:
// importarArquivoEspecifico();
// sincronizarTodooDrive();

module.exports = {
  importarArquivoEspecifico,
  sincronizarTodooDrive,
};
