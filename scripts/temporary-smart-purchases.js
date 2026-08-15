const fs = require('fs');

function replaceOne(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first === -1) throw new Error(`Trecho não encontrado: ${label}`);
  const second = text.indexOf(search, first + search.length);
  if (second !== -1) throw new Error(`Trecho duplicado inesperadamente: ${label}`);
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

function insertBefore(text, anchor, addition, label) {
  const index = text.indexOf(anchor);
  if (index === -1) throw new Error(`Âncora não encontrada: ${label}`);
  return text.slice(0, index) + addition + text.slice(index);
}

let backend = fs.readFileSync('backend-server.js', 'utf8');
let app = fs.readFileSync('App.jsx', 'utf8');

backend = replaceOne(
  backend,
  ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PLANEJADA', $11)",
  ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
  'status fixo no cadastro de compra'
);

backend = replaceOne(
  backend,
  `        payload.categoriaDetalhadaId || null,\n        payload.observacao || null,`,
  `        payload.categoriaDetalhadaId || null,\n        payload.status || 'PLANEJADA',\n        payload.observacao || null,`,
  'parâmetros do cadastro de compra'
);

const bulkRoute = String.raw`app.post('/api/compras-programadas/lote', verificarToken, async (req, res) => {
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

`;
backend = insertBefore(
  backend,
  "app.patch('/api/compras-programadas/:id', verificarToken, async (req, res) => {",
  bulkRoute,
  'rota PATCH de compras programadas'
);

const prepararNovasCompras = String.raw`async function ferramentaPrepararNovasCompras(usuarioId, args = {}) {
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
    const dataDesejada = dataInformada ? normalizarDataImportacao(dataInformada) : hoje;
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
    if (!dataDesejada) faltas.push('data válida');
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
    if (!dataInformada) observacoes.push(`Data não informada; usada a data atual (${hoje}) como referência.`);

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

`;
backend = insertBefore(
  backend,
  'async function ferramentaPrepararNovaProvisao(usuarioId, args = {}) {',
  prepararNovasCompras,
  'ferramenta de nova provisão'
);

const toolDefinition = String.raw`  {
    type: 'function',
    name: 'preparar_novas_compras',
    description: 'Prepara, sem gravar, uma ou várias Compras Programadas para cadastro direto. Use quando o usuário já comprou/pagou algo, quando pedir apenas para cadastrar uma compra futura sem solicitar simulação, ou quando trouxer vários itens de uma vez. Compras já realizadas devem usar status COMPRADA; compras futuras, PLANEJADA. Links, condição e método de pagamento são preservados na observação. Não use para decidir melhor data ou parcelamento: nesse caso use planejar_compra_hipotetica.',
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
              dataDesejada: { type: 'string', description: 'Data AAAA-MM-DD. Use string vazia se não informada; a ferramenta usará a data atual como referência.' },
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
`;
backend = insertBefore(
  backend,
  "  {\n    type: 'function',\n    name: 'preparar_alteracao_compra_programada',",
  toolDefinition,
  'definição da ferramenta de alteração de compra'
);

backend = replaceOne(
  backend,
  "  planejar_compra_hipotetica: 'planejamento de nova compra',\n  preparar_alteracao_compra_programada: 'alteração de compra programada',",
  "  planejar_compra_hipotetica: 'planejamento de nova compra',\n  preparar_novas_compras: 'cadastro de compras',\n  preparar_alteracao_compra_programada: 'alteração de compra programada',",
  'rótulos das ferramentas de compras'
);

backend = replaceOne(
  backend,
  "  if (nome === 'planejar_compra_hipotetica') return ferramentaPlanejarCompraHipotetica(usuarioId, args);\n  if (nome === 'preparar_alteracao_compra_programada') return ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args);",
  "  if (nome === 'planejar_compra_hipotetica') return ferramentaPlanejarCompraHipotetica(usuarioId, args);\n  if (nome === 'preparar_novas_compras') return ferramentaPrepararNovasCompras(usuarioId, args);\n  if (nome === 'preparar_alteracao_compra_programada') return ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args);",
  'executor das ferramentas de compras'
);

backend = replaceOne(
  backend,
  'Se ele estiver planejando uma compra nova que ainda não está cadastrada, use obrigatoriamente planejar_compra_hipotetica. Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada.',
  'Se o usuário estiver PEDINDO UMA DECISÃO sobre uma compra nova, como melhor data, melhor parcelamento, impacto no caixa ou se cabe no orçamento, use planejar_compra_hipotetica. Se ele apenas pedir para cadastrar/adicionar uma compra futura sem solicitar otimização, use preparar_novas_compras com status PLANEJADA. Se disser que já comprou, pagou ou adquiriu algo que ainda não estava cadastrado, use preparar_novas_compras com status COMPRADA e não simule uma compra que já aconteceu. Se trouxer várias compras na mesma mensagem, use preparar_novas_compras em lote. Quando disser que comprou algo que claramente já estava em Compras Programadas, como "a cadeira que estava na lista", use preparar_alteracao_compra_programada com MARCAR_COMPRADA para evitar duplicidade. Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada.',
  'roteamento inteligente de compras no prompt do assistente'
);

backend = replaceOne(
  backend,
  'Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Se faltarem descrição, valor ou prazo/data limite para uma compra nova, peça esses dados antes de planejar. Na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12.',
  'Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Para simulação de compra nova, se faltarem descrição, valor ou prazo/data limite, peça esses dados antes de planejar; na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12. Para cadastro direto, descrição e valor positivo são obrigatórios; se a data não vier informada, preparar_novas_compras usa a data atual como referência. Interprete PIX, débito, dinheiro e pagamento único como A_VISTA e preserve o método em metodoPagamento. Preserve URLs recebidas no campo link e informações como usado/novo em condicao.',
  'regras de dados para cadastro direto'
);

app = replaceOne(
  app,
  "    'Quero comprar uma TV de R$ 4.500 até novembro. Qual a melhor forma?',\n  ];",
  "    'Quero comprar uma TV de R$ 4.500 até novembro. Qual a melhor forma?',\n    'Comprei um micro-ondas usado por R$ 250 no PIX hoje.',\n    'Cadastre uma mesa de R$ 800 e uma cadeira de R$ 1.200 para o apartamento.',\n  ];",
  'exemplos do assistente'
);

const confirmarLote = String.raw`  const confirmarComprasLoteSugeridas = (acao, indice) => {
    const itens = Array.isArray(acao?.itens) ? acao.itens : [];
    if (itens.length === 0 || acao.confirmada || acaoSalvandoIndice !== null) return;
    const compradas = itens.filter((item) => item?.payload?.status === 'COMPRADA').length;
    const planejadas = itens.length - compradas;
    const resumo = [
      compradas ? `${compradas} já ${compradas === 1 ? 'comprada' : 'compradas'}` : null,
      planejadas ? `${planejadas} ${planejadas === 1 ? 'planejada' : 'planejadas'}` : null,
    ].filter(Boolean).join(' e ');
    pedirConfirmacao(
      acao.rotuloAcao || 'Registrar compras',
      `Cadastrar ${itens.length} ${itens.length === 1 ? 'compra' : 'compras'} (${resumo})? Você poderá revisar os itens no card antes de confirmar.`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.post(`${API_URL}/compras-programadas/lote`, {
            itens: itens.map((item) => item.payload),
          }, { headers: { Authorization: `Bearer ${token}` } });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true } }
            : item));
          mostrarToast(itens.length === 1 ? 'Compra registrada.' : `${itens.length} compras registradas.`);
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível registrar as compras.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: itens.length === 1 ? 'Registrar compra' : 'Registrar compras', corConfirmar: '#2563eb' }
    );
  };

`;
app = insertBefore(
  app,
  '  const confirmarAlteracaoSugerida = (acao, indice) => {',
  confirmarLote,
  'confirmação de alteração de compra no frontend'
);

app = replaceOne(
  app,
  "        .assistente-acao-detalhes li { margin: 4px 0; }\n        .assistente-disclaimer",
  "        .assistente-acao-detalhes li { margin: 4px 0; }\n        .assistente-lote-lista { display: grid; gap: 8px; margin: 10px 0 12px; }\n        .assistente-lote-item { background: white; border: 1px solid #dbeafe; border-radius: 10px; padding: 10px; }\n        .assistente-lote-item-topo { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }\n        .assistente-lote-item small { color: #64748b; }\n        .assistente-disclaimer",
  'estilos do lote de compras'
);

const loteCard = String.raw`              {mensagem.acaoPendente?.tipo === 'CRIAR_COMPRAS_LOTE' && (() => {
                const acao = mensagem.acaoPendente;
                const itens = Array.isArray(acao.itens) ? acao.itens : [];
                return <div className="assistente-acao">
                  <strong>🛒 {acao.quantidade === 1 ? 'Compra para registrar' : 'Compras para registrar'}</strong>
                  <div className="assistente-lote-lista">
                    {itens.map((item, itemIndice) => {
                      const payload = item.payload || {};
                      const pagamento = payload.formaPagamento === 'PARCELADO'
                        ? `${payload.parcelas}x de ${formatarMoeda(Number(payload.valorEstimado || 0) / Number(payload.parcelas || 1))}`
                        : 'À vista';
                      return <div className="assistente-lote-item" key={`${payload.descricao || 'compra'}-${itemIndice}`}>
                        <div className="assistente-lote-item-topo">
                          <strong>{payload.descricao}</strong>
                          <span>{payload.status === 'COMPRADA' ? '✅ Comprada' : '🗓️ Planejada'}</span>
                        </div>
                        <div>{formatarMoeda(payload.valorEstimado)} · {formatarData(payload.dataDesejada)} · {pagamento}</div>
                        {(item.detalhes || []).slice(4).map((detalhe) => <small key={detalhe}> · {detalhe}</small>)}
                      </div>;
                    })}
                  </div>
                  {acao.confirmada
                    ? <span className="assistente-acao-confirmada">✅ {itens.length === 1 ? 'Compra registrada' : 'Compras registradas'}</span>
                    : <Btn variant="primary" size="sm" onClick={() => confirmarComprasLoteSugeridas(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Registrando...' : (acao.rotuloAcao || 'Registrar compras')}</Btn>}
                </div>;
              })()}
`;
app = insertBefore(
  app,
  "              {mensagem.acaoPendente?.tipo === 'CRIAR_COMPRA_PROGRAMADA' && (() => {",
  loteCard,
  'card de criação única planejada'
);

fs.writeFileSync('backend-server.js', backend);
fs.writeFileSync('App.jsx', app);

const backendFinal = fs.readFileSync('backend-server.js', 'utf8');
const appFinal = fs.readFileSync('App.jsx', 'utf8');

const obrigatoriosBackend = [
  "app.post('/api/compras-programadas/lote'",
  'async function ferramentaPrepararNovasCompras',
  "name: 'preparar_novas_compras'",
  "if (nome === 'preparar_novas_compras')",
  "tipo: 'CRIAR_COMPRAS_LOTE'",
  "payload.status || 'PLANEJADA'",
];
for (const trecho of obrigatoriosBackend) {
  if (!backendFinal.includes(trecho)) throw new Error(`Validação backend falhou: ${trecho}`);
}

const inicioFerramenta = backendFinal.indexOf('async function ferramentaPrepararNovasCompras');
const fimFerramenta = backendFinal.indexOf('async function ferramentaPrepararNovaProvisao', inicioFerramenta);
const corpoFerramenta = backendFinal.slice(inicioFerramenta, fimFerramenta);
for (const proibido of ['INSERT INTO', 'UPDATE compras_programadas', 'DELETE FROM compras_programadas']) {
  if (corpoFerramenta.includes(proibido)) throw new Error(`Ferramenta Gemini contém escrita direta: ${proibido}`);
}

for (const trecho of ['confirmarComprasLoteSugeridas', "tipo === 'CRIAR_COMPRAS_LOTE'", '/compras-programadas/lote']) {
  if (!appFinal.includes(trecho)) throw new Error(`Validação frontend falhou: ${trecho}`);
}

console.log('Transformação de compras inteligentes aplicada com sucesso.');
