from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: esperado 1 trecho, encontrado {count}')
    return text.replace(old, new, 1)


def insert_before(text, anchor, addition, label):
    if anchor not in text:
        raise RuntimeError(f'{label}: âncora não encontrada')
    return text.replace(anchor, addition + anchor, 1)


backend_path = Path('backend-server.js')
app_path = Path('App.jsx')
backend = backend_path.read_text(encoding='utf-8')
app = app_path.read_text(encoding='utf-8')

# ---------------------------------------------------------------------------
# 1) Banco: dados realizados + vínculo Compra Programada x Transação
# ---------------------------------------------------------------------------
schema_anchor = """  await pool.query('CREATE INDEX IF NOT EXISTS idx_compras_programadas_usuario_data ON compras_programadas(usuario_id, data_desejada)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_compras_programadas_usuario_status ON compras_programadas(usuario_id, status)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conciliacoes (
"""
schema_replacement = """  await pool.query(`
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
"""
backend = replace_once(backend, schema_anchor, schema_replacement, 'schema de compras')

# ---------------------------------------------------------------------------
# 2) GET Compras Programadas: expor dados realizados e lançamento vinculado
# ---------------------------------------------------------------------------
get_old = """      `SELECT cp.*,
              c.nome AS conta_nome,
              cm.nome AS categoria_macro_nome,
              cd.nome AS categoria_detalhada_nome
       FROM compras_programadas cp
       LEFT JOIN contas c ON c.id = cp.conta_id
       LEFT JOIN categorias cm ON cm.id = cp.categoria_macro_id
       LEFT JOIN categorias cd ON cd.id = cp.categoria_detalhada_id
       WHERE cp.usuario_id = $1
"""
get_new = """      `SELECT cp.*,
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
"""
backend = replace_once(backend, get_old, get_new, 'consulta de compras programadas')

# ---------------------------------------------------------------------------
# 3) Motor determinístico de busca e endpoint de confirmação
# ---------------------------------------------------------------------------
patch_anchor = """app.patch('/api/compras-programadas/:id', verificarToken, async (req, res) => {
"""
reconciliation_code = r"""
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

"""
backend = insert_before(backend, patch_anchor, reconciliation_code, 'endpoint de conciliação de compra')

# ---------------------------------------------------------------------------
# 4) Compra realizada sem data: nunca assumir hoje
# ---------------------------------------------------------------------------
backend = replace_once(
    backend,
    """    const dataInformada = String(item.dataDesejada || '').trim();
    const dataDesejada = dataInformada ? normalizarDataImportacao(dataInformada) : hoje;
""",
    """    const dataInformada = String(item.dataDesejada || '').trim();
    const dataDesejada = dataInformada ? normalizarDataImportacao(dataInformada) : null;
""",
    'data de compra no cadastro direto',
)

backend = replace_once(
    backend,
    """    if (!dataDesejada) faltas.push('data válida');
""",
    """    if (!dataDesejada) {
      faltas.push(status === 'COMPRADA'
        ? 'data da compra ou associação com um lançamento real'
        : 'data desejada');
    }
""",
    'validação de data no cadastro direto',
)

backend = replace_once(
    backend,
    """    if (!dataInformada) observacoes.push(`Data não informada; usada a data atual (${hoje}) como referência.`);
""",
    """",
    'remoção da data inventada',
)

# ---------------------------------------------------------------------------
# 5) Ferramenta do Assistente para procurar lançamento real
# ---------------------------------------------------------------------------
new_tool_function_anchor = """async function ferramentaPrepararNovasCompras(usuarioId, args = {}) {
"""
new_tool_function = r"""async function ferramentaBuscarTransacoesCompraRealizada(usuarioId, args = {}) {
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
  if (termoCompraExistente) {
    const comprasResult = await pool.query(
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
    if (comprasResult.rows.length > 1) {
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
    compraExistente = comprasResult.rows[0];
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

"""
backend = insert_before(backend, new_tool_function_anchor, new_tool_function, 'ferramenta de busca de transação para compra')

# Atualizar descrição da ferramenta de cadastro direto e schema de data
backend = replace_once(
    backend,
    """    description: 'Prepara, sem gravar, uma ou várias Compras Programadas para cadastro direto. Use quando o usuário já comprou/pagou algo, quando pedir apenas para cadastrar uma compra futura sem solicitar simulação, ou quando trouxer vários itens de uma vez. Compras já realizadas devem usar status COMPRADA; compras futuras, PLANEJADA. Links, condição e método de pagamento são preservados na observação. Não use para decidir melhor data ou parcelamento: nesse caso use planejar_compra_hipotetica.',
""",
    """    description: 'Prepara, sem gravar, uma ou várias Compras Programadas para cadastro direto quando a data da compra já é conhecida ou quando se trata de compra futura com data desejada informada. Não invente a data atual. Para compra já realizada sem data conhecida ou quando o usuário quiser associar ao extrato, use buscar_transacoes_para_compra_realizada.',
""",
    'descrição de preparar_novas_compras',
)
backend = replace_once(
    backend,
    """              dataDesejada: { type: 'string', description: 'Data AAAA-MM-DD. Use string vazia se não informada; a ferramenta usará a data atual como referência.' },
""",
    """              dataDesejada: { type: 'string', description: 'Data AAAA-MM-DD. Use string vazia se não informada; a ferramenta não deve inventar uma data.' },
""",
    'schema da data no cadastro direto',
)

# Definição da nova ferramenta antes da ferramenta preparar_novas_compras
new_tool_definition_anchor = """  {
    type: 'function',
    name: 'preparar_novas_compras',
"""
new_tool_definition = """  {
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
"""
backend = insert_before(backend, new_tool_definition_anchor, new_tool_definition, 'definição da ferramenta de busca de compra')

backend = replace_once(
    backend,
    """  preparar_novas_compras: 'cadastro de compras',
""",
    """  buscar_transacoes_para_compra_realizada: 'busca de lançamento para compra realizada',
  preparar_novas_compras: 'cadastro de compras',
""",
    'rótulo da nova ferramenta',
)
backend = replace_once(
    backend,
    """  if (nome === 'preparar_novas_compras') return ferramentaPrepararNovasCompras(usuarioId, args);
""",
    """  if (nome === 'buscar_transacoes_para_compra_realizada') return ferramentaBuscarTransacoesCompraRealizada(usuarioId, args);
  if (nome === 'preparar_novas_compras') return ferramentaPrepararNovasCompras(usuarioId, args);
""",
    'executor da nova ferramenta',
)

# ---------------------------------------------------------------------------
# 6) Roteamento operacional: ações claras não podem virar resposta genérica
# ---------------------------------------------------------------------------
backend = replace_once(
    backend,
    """async function chamarGeminiAssistente({ contents, instructions }) {
""",
    """async function chamarGeminiAssistente({ contents, instructions, toolConfig = null }) {
""",
    'assinatura chamarGeminiAssistente',
)
backend = replace_once(
    backend,
    """        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
""",
    """        toolConfig: toolConfig || { functionCallingConfig: { mode: 'AUTO' } },
""",
    'toolConfig do Gemini',
)

router_anchor = """app.post('/api/assistente', verificarToken, async (req, res) => {
"""
router_code = r"""function normalizarIntencaoAssistente(texto) {
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

"""
backend = insert_before(backend, router_anchor, router_code, 'roteador operacional')

# Atualizar instruções centrais
old_instruction = """Se o usuário estiver PEDINDO UMA DECISÃO sobre uma compra nova, como melhor data, melhor parcelamento, impacto no caixa ou se cabe no orçamento, use planejar_compra_hipotetica. Se ele apenas pedir para cadastrar/adicionar uma compra futura sem solicitar otimização, use preparar_novas_compras com status PLANEJADA. Se disser que já comprou, pagou ou adquiriu algo que ainda não estava cadastrado, use preparar_novas_compras com status COMPRADA e não simule uma compra que já aconteceu. Se trouxer várias compras na mesma mensagem, use preparar_novas_compras em lote. Quando disser que comprou algo que claramente já estava em Compras Programadas, como \"a cadeira que estava na lista\", use preparar_alteracao_compra_programada com MARCAR_COMPRADA para evitar duplicidade. Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada."""
new_instruction = """Se o usuário estiver PEDINDO UMA DECISÃO sobre uma compra nova, como melhor data, melhor parcelamento, impacto no caixa ou se cabe no orçamento, use planejar_compra_hipotetica. Se ele apenas pedir para cadastrar/adicionar uma compra futura sem solicitar otimização, use preparar_novas_compras com status PLANEJADA e exija data desejada. Se disser que já comprou, pagou ou adquiriu algo e a data real NÃO estiver clara, ou se pedir para localizar/associar o pagamento no extrato, use obrigatoriamente buscar_transacoes_para_compra_realizada; NUNCA assuma que foi hoje. Se a compra realizada já estiver em Compras Programadas, informe termoCompraExistente para a ferramenta localizar a compra antes de buscar o lançamento. Se a data real estiver explicitamente informada e não houver pedido de associação ao extrato, preparar_novas_compras pode ser usado com status COMPRADA. Se trouxer várias compras futuras na mesma mensagem, use preparar_novas_compras em lote. Se o usuário pedir para adiar, editar ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada. Comandos operacionais claros como cadastrar, adicionar, marcar, associar, conciliar, cancelar ou adiar devem resultar em chamada de ferramenta; não responda apenas com instruções genéricas sobre como o usuário poderia fazer isso manualmente."""
backend = replace_once(backend, old_instruction, new_instruction, 'instrução de compras do Assistente')
backend = replace_once(
    backend,
    """Para cadastro direto, descrição e valor positivo são obrigatórios; se a data não vier informada, preparar_novas_compras usa a data atual como referência. Interprete PIX, débito, dinheiro e pagamento único como A_VISTA e preserve o método em metodoPagamento.""",
    """Para cadastro direto, descrição, valor positivo e data são obrigatórios. Se uma compra já realizada não tiver data conhecida, não invente data: procure uma transação real com buscar_transacoes_para_compra_realizada. Interprete PIX, débito, dinheiro e pagamento único como A_VISTA e preserve o método em metodoPagamento.""",
    'regra de data desconhecida no prompt',
)

backend = replace_once(
    backend,
    """  const ferramentasUsadas = new Set();
  let acaoPendente = null;
  const hoje = new Date().toISOString().slice(0, 10);
""",
    """  const ferramentasUsadas = new Set();
  let acaoPendente = null;
  const roteamentoOperacional = detectarRoteamentoOperacionalAssistente(mensagem);
  const hoje = new Date().toISOString().slice(0, 10);
""",
    'estado do roteamento operacional',
)
backend = replace_once(
    backend,
    """      response = await chamarGeminiAssistente({ contents, instructions });
""",
    """      response = await chamarGeminiAssistente({
        contents,
        instructions,
        toolConfig: rodada === 0 ? roteamentoOperacional : null,
      });
""",
    'chamada Gemini com roteamento',
)

# ---------------------------------------------------------------------------
# 7) Frontend: card de candidatos e confirmação de associação
# ---------------------------------------------------------------------------
confirm_anchor = """  const confirmarAlteracaoSugerida = (acao, indice) => {
"""
confirm_code = r"""  const confirmarConciliacaoCompraSugerida = (acao, candidato, indice) => {
    if (!acao || !candidato || acao.confirmada || acaoSalvandoIndice !== null) return;
    pedirConfirmacao(
      acao.compraId ? 'Associar compra ao lançamento' : 'Registrar compra pelo lançamento',
      `Usar ${candidato.descricao} · ${formatarMoeda(candidato.valor)} · ${formatarData(candidato.data)} como pagamento de ${acao.compra?.descricao}?`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.post(`${API_URL}/compras-programadas/conciliar-transacao`, {
            compraId: acao.compraId || null,
            compra: acao.compraNova || null,
            transacaoId: candidato.transacaoId,
          }, { headers: { Authorization: `Bearer ${token}` } });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true, candidatoConfirmado: candidato } }
            : item));
          mostrarToast(acao.compraId ? 'Compra associada ao lançamento.' : 'Compra registrada e associada ao lançamento.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível associar a compra ao lançamento.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: 'Confirmar associação', corConfirmar: '#2563eb' }
    );
  };

"""
app = insert_before(app, confirm_anchor, confirm_code, 'confirmação de conciliação de compra')

style_anchor = """        .assistente-disclaimer"""
styles = """        .assistente-candidatos { display: grid; gap: 8px; margin: 10px 0 12px; }
        .assistente-candidato { background: white; border: 1px solid #dbeafe; border-radius: 10px; padding: 10px; }
        .assistente-candidato-topo { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
        .assistente-candidato-motivos { color: #64748b; font-size: 12px; margin: 5px 0 8px; }
"""
app = insert_before(app, style_anchor, styles, 'estilos dos candidatos de compra')

render_anchor = """              {mensagem.acaoPendente?.tipo === 'CRIAR_COMPRAS_LOTE' && (() => {
"""
render_code = r"""              {mensagem.acaoPendente?.tipo === 'CONCILIAR_COMPRA_TRANSACAO' && (() => {
                const acao = mensagem.acaoPendente;
                const candidatos = Array.isArray(acao.candidatos) ? acao.candidatos : [];
                return <div className="assistente-acao">
                  <strong>🔎 {acao.compraId ? 'Associar compra a um lançamento' : 'Encontrei possíveis pagamentos'}</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Compra</small><strong>{acao.compra?.descricao}</strong><div>{formatarMoeda(acao.compra?.valor)}</div></div>
                    <div className="assistente-acao-item"><small>Candidatos</small><strong>{candidatos.length}</strong><div>Escolha o lançamento correto</div></div>
                  </div>
                  <div className="assistente-candidatos">
                    {candidatos.map((candidato) => <div className="assistente-candidato" key={candidato.transacaoId}>
                      <div className="assistente-candidato-topo">
                        <div><strong>{candidato.descricao}</strong><div>{formatarMoeda(candidato.valor)} · {formatarData(candidato.data)} · {candidato.conta || '-'}</div></div>
                        <span>{candidato.confianca === 'ALTA' ? '🟢' : candidato.confianca === 'MEDIA' ? '🟡' : '⚪'} {candidato.confianca}</span>
                      </div>
                      <div className="assistente-candidato-motivos">{(candidato.motivos || []).join(' · ')}</div>
                      {!acao.confirmada && <Btn variant="secondary" size="sm" onClick={() => confirmarConciliacaoCompraSugerida(acao, candidato, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Associando...' : 'Usar este lançamento'}</Btn>}
                    </div>)}
                  </div>
                  {acao.confirmada && <span className="assistente-acao-confirmada">✅ Compra associada a {acao.candidatoConfirmado?.descricao || 'lançamento confirmado'}</span>}
                </div>;
              })()}
"""
app = insert_before(app, render_anchor, render_code, 'card de candidatos para compra')

# ---------------------------------------------------------------------------
# Validações do transformador
# ---------------------------------------------------------------------------
backend_path.write_text(backend, encoding='utf-8')
app_path.write_text(app, encoding='utf-8')

backend_final = backend_path.read_text(encoding='utf-8')
app_final = app_path.read_text(encoding='utf-8')

required_backend = [
    'CREATE TABLE IF NOT EXISTS conciliacoes_compras',
    'ADD COLUMN IF NOT EXISTS valor_realizado',
    "app.post('/api/compras-programadas/conciliar-transacao'",
    'async function ferramentaBuscarTransacoesCompraRealizada',
    "name: 'buscar_transacoes_para_compra_realizada'",
    "mode: 'ANY', allowedFunctionNames: ['buscar_transacoes_para_compra_realizada']",
    'detectarRoteamentoOperacionalAssistente',
    'NUNCA assuma que foi hoje',
]
for token in required_backend:
    if token not in backend_final:
        raise RuntimeError(f'Validação backend ausente: {token}')

required_app = [
    'confirmarConciliacaoCompraSugerida',
    "tipo === 'CONCILIAR_COMPRA_TRANSACAO'",
    '/compras-programadas/conciliar-transacao',
    'Usar este lançamento',
]
for token in required_app:
    if token not in app_final:
        raise RuntimeError(f'Validação frontend ausente: {token}')

# A ferramenta Gemini só consulta; escrita fica no endpoint após confirmação.
start = backend_final.index('async function ferramentaBuscarTransacoesCompraRealizada')
end = backend_final.index('async function ferramentaPrepararNovasCompras', start)
tool_body = backend_final[start:end]
for forbidden in ['INSERT INTO compras_programadas', 'UPDATE compras_programadas', 'DELETE FROM compras_programadas', 'INSERT INTO conciliacoes_compras']:
    if forbidden in tool_body:
        raise RuntimeError(f'Ferramenta do Gemini contém escrita direta: {forbidden}')

if 'Data não informada; usada a data atual' in backend_final:
    raise RuntimeError('Ainda existe fallback que inventa a data atual para compra sem data.')

print('Transformação de conciliação de compras aplicada com sucesso.')
