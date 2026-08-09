from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise RuntimeError(f'Trecho não encontrado: {label}')
    return text.replace(old, new, 1)


backend_path = Path('backend-server.js')
app_path = Path('App.jsx')
backend = backend_path.read_text(encoding='utf-8')
app = app_path.read_text(encoding='utf-8')

backend_functions = r'''async function ferramentaSugerirConciliacoesPendentes(usuarioId, args = {}) {
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
  const claramenteMelhor = melhor.analise.score >= 0.65 && (!segunda || (melhor.analise.score - segunda.analise.score) >= 0.15);
  if (!claramenteMelhor) {
    return {
      encontrada: true,
      preparada: false,
      ambigua: true,
      motivo: 'Encontrei mais de uma transação plausível. Peça ao usuário para indicar qual lançamento corresponde à Conta Prevista.',
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

'''

backend = replace_once(
    backend,
    'const FERRAMENTAS_ASSISTENTE = [',
    backend_functions + 'const FERRAMENTAS_ASSISTENTE = [',
    'inserção das funções do #75',
)

tool_anchor = "  {\n    type: 'function',\n    name: 'contas_previstas_por_mes',"
tool_defs = r'''  {
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
'''
backend = replace_once(backend, tool_anchor, tool_defs + tool_anchor, 'definições das ferramentas do #75')

backend = replace_once(
    backend,
    "  preparar_alteracao_conta_prevista: 'alteração de conta prevista',\n",
    "  preparar_alteracao_conta_prevista: 'alteração de conta prevista',\n  sugerir_conciliacoes_pendentes: 'sugestões de conciliação',\n  preparar_conciliacao_conta_prevista: 'conciliação de conta prevista',\n  preparar_categorizacao_transacao: 'categorização de lançamento',\n",
    'rótulos das ferramentas do #75',
)

backend = replace_once(
    backend,
    "  if (nome === 'preparar_alteracao_conta_prevista') return ferramentaPrepararAlteracaoProvisao(usuarioId, args);\n",
    "  if (nome === 'preparar_alteracao_conta_prevista') return ferramentaPrepararAlteracaoProvisao(usuarioId, args);\n  if (nome === 'sugerir_conciliacoes_pendentes') return ferramentaSugerirConciliacoesPendentes(usuarioId, args);\n  if (nome === 'preparar_conciliacao_conta_prevista') return ferramentaPrepararConciliacaoAssistente(usuarioId, args);\n  if (nome === 'preparar_categorizacao_transacao') return ferramentaPrepararCategorizacaoTransacao(usuarioId, args);\n",
    'executor das ferramentas do #75',
)

old_instruction = "Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados. Você pode preparar propostas estruturadas de criação ou alteração de Compras Programadas e Contas Previstas, mas qualquer gravação só ocorre depois de confirmação explícita do usuário na interface.\nPara perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar sobre uma compra que já está cadastrada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use comparar_cenarios_compra_programada antes de recomendar. Se ele estiver planejando uma compra nova que ainda não está cadastrada, use obrigatoriamente planejar_compra_hipotetica. Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada. Se pedir para criar uma Conta Prevista, use preparar_nova_conta_prevista. Se pedir para adiar, editar, cancelar ou marcar como realizada uma Conta Prevista existente, use preparar_alteracao_conta_prevista. Uma Conta Prevista só pode ser considerada realizada após conciliação com uma transação real; nunca contorne essa regra alterando o status diretamente. Para campos que não serão alterados nessas ferramentas, use os sentinelas indicados no schema, como string vazia, 0 ou MANTER. Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Se faltarem descrição, valor ou prazo/data limite para uma compra nova, peça esses dados antes de planejar. Na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12."
new_instruction = "Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou, conciliou ou alterou dados. Você pode preparar propostas estruturadas de criação ou alteração de Compras Programadas e Contas Previstas, categorização de lançamentos e conciliação de Contas Previstas com transações reais, mas qualquer gravação só ocorre depois de confirmação explícita do usuário na interface.\nPara perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar sobre uma compra que já está cadastrada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use comparar_cenarios_compra_programada antes de recomendar. Se ele estiver planejando uma compra nova que ainda não está cadastrada, use obrigatoriamente planejar_compra_hipotetica. Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada. Se pedir para criar uma Conta Prevista, use preparar_nova_conta_prevista. Se pedir para adiar, editar ou cancelar uma Conta Prevista existente, use preparar_alteracao_conta_prevista. Se disser que uma Conta Prevista foi paga, recebida ou realizada, use preparar_conciliacao_conta_prevista para localizar a transação real; nunca altere o status diretamente. Se perguntar se existem Contas Previstas provavelmente já realizadas, use sugerir_conciliacoes_pendentes. Se pedir para categorizar um lançamento existente, use preparar_categorizacao_transacao e nunca invente uma categoria inexistente. Só peça criação de regra automática quando o usuário solicitar explicitamente que lançamentos semelhantes sejam categorizados da mesma forma. Não edite nem exclua transações por meio do assistente neste fluxo. Para campos que não serão alterados nessas ferramentas, use os sentinelas indicados no schema, como string vazia, 0 ou MANTER. Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Se faltarem descrição, valor ou prazo/data limite para uma compra nova, peça esses dados antes de planejar. Na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12."
backend = replace_once(backend, old_instruction, new_instruction, 'instruções do assistente do #75')

# Frontend
app = replace_once(
    app,
    "    content: 'Sou o assistente financeiro do seu app. Posso consultar seus dados e preparar ações em Compras Programadas e Contas Previstas. Nenhuma mudança é aplicada sem sua confirmação explícita.',",
    "    content: 'Sou o assistente financeiro do seu app. Posso consultar seus dados e preparar ações em Compras Programadas, Contas Previstas e Transações. Categorização e conciliação só acontecem depois da sua confirmação.',",
    'boas-vindas do assistente',
)

app = replace_once(
    app,
    "    'Adicione uma conta de internet de R$ 120 para o dia 15.',\n    'Quero comprar uma TV de R$ 4.500 até novembro. Qual a melhor forma?',",
    "    'Adicione uma conta de internet de R$ 120 para o dia 15.',\n    'A conta de internet já foi paga. Procure o lançamento e concilie.',\n    'O lançamento da Smart Fit é Saúde. Categoriza pra mim.',\n    'Quero comprar uma TV de R$ 4.500 até novembro. Qual a melhor forma?',",
    'exemplos do #75',
)

function_anchor = "  return (\n    <div className=\"content-card\" style={{ background: 'white', borderRadius: '12px', padding: '24px' }}>"
frontend_functions = r'''  const confirmarConciliacaoSugerida = (acao, indice) => {
    if (!acao?.provisaoId || !acao?.transacaoId || acao.confirmada || acaoSalvandoIndice !== null) return;
    pedirConfirmacao(
      acao.rotuloAcao || 'Conciliar Conta Prevista',
      `Vincular "${acao.contaPrevista?.descricao}" ao lançamento "${acao.transacao?.descricao}" de ${formatarMoeda(acao.transacao?.valor)}?`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.post(`${API_URL}/conciliacoes/confirmar`, {
            provisaoId: acao.provisaoId,
            transacaoId: acao.transacaoId,
          }, { headers: { Authorization: `Bearer ${token}` } });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true } }
            : item));
          mostrarToast('Conta Prevista conciliada com a transação real.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível confirmar a conciliação.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: 'Confirmar conciliação', corConfirmar: '#2563eb' }
    );
  };

  const confirmarCategorizacaoSugerida = (acao, indice) => {
    if (!acao?.transacaoId || !acao?.payload || acao.confirmada || acaoSalvandoIndice !== null) return;
    pedirConfirmacao(
      acao.rotuloAcao || 'Categorizar lançamento',
      `Categorizar "${acao.transacao?.descricao}" como "${acao.categoria?.nome}"${acao.payload.criarRegra ? ' e criar uma regra para semelhantes' : ''}?`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.patch(`${API_URL}/transacoes/${acao.transacaoId}/categorizar`, acao.payload, {
            headers: { Authorization: `Bearer ${token}` },
          });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true } }
            : item));
          mostrarToast('Lançamento categorizado.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível categorizar o lançamento.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: 'Confirmar categorização', corConfirmar: '#2563eb' }
    );
  };

'''
app = replace_once(app, function_anchor, frontend_functions + function_anchor, 'funções de confirmação do #75')

cards_anchor = "              {mensagem.acaoPendente?.tipo === 'ALTERAR_PROVISAO' && (() => {\n                const acao = mensagem.acaoPendente;\n                return <div className=\"assistente-acao\">\n                  <strong>📌 {acao.rotuloAcao || 'Alteração de Conta Prevista'}</strong>\n                  <div className=\"assistente-acao-grid\">\n                    <div className=\"assistente-acao-item\"><small>Conta prevista</small><strong>{acao.provisaoDescricao}</strong></div>\n                    <div className=\"assistente-acao-item\"><small>Ação</small><strong>{acao.rotuloAcao}</strong></div>\n                  </div>\n                  <ul className=\"assistente-acao-detalhes\">{(acao.detalhes || []).map((detalhe) => <li key={detalhe}>{detalhe}</li>)}</ul>\n                  {acao.confirmada\n                    ? <span className=\"assistente-acao-confirmada\">✅ Alteração aplicada</span>\n                    : <Btn variant={acao.acao === 'CANCELAR' ? 'danger' : 'primary'} size=\"sm\" onClick={() => confirmarAlteracaoProvisaoSugerida(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Aplicando...' : (acao.rotuloAcao || 'Aplicar alteração')}</Btn>}\n                </div>;\n              })()}\n"
new_cards = cards_anchor + r'''              {mensagem.acaoPendente?.tipo === 'CONCILIAR_PROVISAO' && (() => {
                const acao = mensagem.acaoPendente;
                return <div className="assistente-acao">
                  <strong>🔗 Conciliação sugerida</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Conta prevista</small><strong>{acao.contaPrevista?.descricao}</strong><div>{formatarMoeda(acao.contaPrevista?.valor)} · {formatarData(acao.contaPrevista?.data)}</div></div>
                    <div className="assistente-acao-item"><small>Transação real</small><strong>{acao.transacao?.descricao}</strong><div>{formatarMoeda(acao.transacao?.valor)} · {formatarData(acao.transacao?.data)}</div></div>
                    <div className="assistente-acao-item"><small>Conta</small><strong>{acao.transacao?.conta || 'Não informada'}</strong></div>
                    <div className="assistente-acao-item"><small>Confiança</small><strong>{acao.confianca || 'N/D'} · {Math.round(Number(acao.score || 0) * 100)}%</strong></div>
                  </div>
                  <ul className="assistente-acao-detalhes">{(acao.detalhes || []).map((detalhe) => <li key={detalhe}>{detalhe}</li>)}</ul>
                  {acao.confirmada
                    ? <span className="assistente-acao-confirmada">✅ Conciliação confirmada</span>
                    : <Btn variant="primary" size="sm" onClick={() => confirmarConciliacaoSugerida(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Conciliando...' : 'Confirmar conciliação'}</Btn>}
                </div>;
              })()}
              {mensagem.acaoPendente?.tipo === 'CATEGORIZAR_TRANSACAO' && (() => {
                const acao = mensagem.acaoPendente;
                return <div className="assistente-acao">
                  <strong>🏷️ Categorização sugerida</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Lançamento</small><strong>{acao.transacao?.descricao}</strong><div>{formatarMoeda(acao.transacao?.valor)} · {formatarData(acao.transacao?.data)}</div></div>
                    <div className="assistente-acao-item"><small>Categoria atual</small><strong>{acao.transacao?.categoriaAtual || 'Não categorizado'}</strong></div>
                    <div className="assistente-acao-item"><small>Nova categoria</small><strong>{acao.categoria?.nome}</strong></div>
                    <div className="assistente-acao-item"><small>Regra automática</small><strong>{acao.payload?.criarRegra ? 'Sim' : 'Não'}</strong></div>
                  </div>
                  <ul className="assistente-acao-detalhes">{(acao.detalhes || []).map((detalhe) => <li key={detalhe}>{detalhe}</li>)}</ul>
                  {acao.confirmada
                    ? <span className="assistente-acao-confirmada">✅ Categorização aplicada</span>
                    : <Btn variant="primary" size="sm" onClick={() => confirmarCategorizacaoSugerida(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Categorizando...' : 'Confirmar categorização'}</Btn>}
                </div>;
              })()}
'''
app = replace_once(app, cards_anchor, new_cards, 'cards de ação do #75')

app = replace_once(
    app,
    'descricao="Pergunte sobre seus gastos, categorias, previsões e compras usando os dados reais do app."',
    'descricao="Pergunte sobre gastos, previsões, transações e conciliações usando os dados reais do app."',
    'descrição do PageHeader do assistente',
)

app = replace_once(
    app,
    'A IA consulta dados por ferramentas autorizadas e não recebe acesso direto ao banco. Ela pode preparar ações em Compras Programadas e Contas Previstas, mas nenhuma gravação ocorre automaticamente: o app só executa depois de você clicar na ação e confirmar no modal. Contas Previstas só viram realizadas por conciliação com uma transação real.',
    'A IA consulta dados por ferramentas autorizadas e não recebe acesso direto ao banco. Ela pode preparar ações em Compras Programadas, Contas Previstas e Transações, mas nenhuma gravação ocorre automaticamente: o app só executa depois de você clicar na ação e confirmar no modal. Categorização e conciliação sempre exigem sua confirmação, e Contas Previstas só viram realizadas por conciliação com uma transação real.',
    'disclaimer do #75',
)

backend_path.write_text(backend, encoding='utf-8')
app_path.write_text(app, encoding='utf-8')
print('Transformação #75 aplicada com sucesso.')
