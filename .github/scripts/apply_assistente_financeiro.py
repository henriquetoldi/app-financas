from pathlib import Path

app_path = Path('App.jsx')
backend_path = Path('backend-server.js')
app = app_path.read_text(encoding='utf-8')
backend = backend_path.read_text(encoding='utf-8')

if "function TelaAssistenteFinanceiro" in app or "/api/assistente'" in backend:
    raise SystemExit('Assistente financeiro já parece estar aplicado; abortando para evitar duplicidade.')

# 1) Sidebar
sidebar_anchor = "    ['previsoes', '🔮', 'Previsões'],\n"
if sidebar_anchor not in app:
    raise SystemExit('Âncora da sidebar não encontrada.')
app = app.replace(sidebar_anchor, sidebar_anchor + "    ['assistente', '✨', 'Assistente'],\n", 1)

# 2) Componente nativo do assistente
component_anchor = "function TelaComprasProgramadas({ contas = [], token }) {"
if component_anchor not in app:
    raise SystemExit('Âncora de TelaComprasProgramadas não encontrada.')

component = r'''function TelaAssistenteFinanceiro({ token, onVoltar }) {
  const boasVindas = {
    role: 'assistant',
    content: 'Sou o assistente financeiro do seu app. Nesta primeira versão eu posso consultar seus dados e responder perguntas, mas não altero nenhum lançamento, categoria ou previsão.',
    consultas: [],
  };
  const exemplos = [
    'Qual categoria eu mais gastei nos últimos 6 meses?',
    'Tenho lançamentos não categorizados?',
    'Qual a projeção das compras programadas nos próximos 6 meses?',
    'Como estão minhas contas previstas nos próximos 3 meses?',
  ];
  const [mensagens, setMensagens] = useState([boasVindas]);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const fimRef = useRef(null);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [mensagens, enviando]);

  const enviarPergunta = async (perguntaForcada) => {
    const pergunta = String(perguntaForcada ?? texto).trim();
    if (!pergunta || enviando) return;

    const historico = mensagens
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .slice(-10)
      .map((item) => ({ role: item.role, content: item.content }));

    setMensagens((atuais) => [...atuais, { role: 'user', content: pergunta, consultas: [] }]);
    setTexto('');
    setEnviando(true);

    try {
      const response = await axios.post(`${API_URL}/assistente`, {
        mensagem: pergunta,
        historico,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setMensagens((atuais) => [...atuais, {
        role: 'assistant',
        content: response.data.resposta || 'Não consegui montar uma resposta.',
        consultas: response.data.consultas || [],
      }]);
    } catch (error) {
      const codigo = error.response?.data?.codigo;
      const mensagem = codigo === 'OPENAI_API_KEY_AUSENTE'
        ? 'O Assistente já está instalado, mas ainda falta configurar a chave da IA no servidor. Adicione OPENAI_API_KEY nas variáveis do Railway para ativá-lo.'
        : (error.response?.data?.erro || 'Não foi possível consultar o assistente agora.');
      setMensagens((atuais) => [...atuais, { role: 'assistant', content: mensagem, consultas: [], erro: true }]);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="content-card" style={{ background: 'white', borderRadius: '12px', padding: '24px' }}>
      <style>{`
        .assistente-shell { max-width: 980px; margin: 0 auto; }
        .assistente-status { display: inline-flex; align-items: center; gap: 6px; background: #ecfdf5; color: #166534; border: 1px solid #bbf7d0; padding: 6px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
        .assistente-chat { border: 1px solid #e2e8f0; background: #f8fafc; border-radius: 16px; min-height: 430px; max-height: 58vh; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
        .assistente-msg { max-width: 82%; border-radius: 14px; padding: 12px 14px; line-height: 1.5; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
        .assistente-msg-user { align-self: flex-end; background: #2563eb; color: white; border-bottom-right-radius: 5px; }
        .assistente-msg-assistant { align-self: flex-start; background: white; color: #0f172a; border: 1px solid #e2e8f0; border-bottom-left-radius: 5px; }
        .assistente-msg-error { border-color: #fecaca; background: #fef2f2; color: #991b1b; }
        .assistente-consultas { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
        .assistente-consulta { background: #eff6ff; color: #1d4ed8; border-radius: 999px; padding: 3px 7px; font-size: 10px; font-weight: 700; }
        .assistente-exemplos { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
        .assistente-exemplo { border: 1px solid #cbd5e1; background: white; color: #334155; border-radius: 999px; padding: 8px 11px; font-size: 12px; cursor: pointer; }
        .assistente-exemplo:hover { border-color: #3b82f6; color: #1d4ed8; background: #eff6ff; }
        .assistente-composer { margin-top: 12px; border: 1px solid #cbd5e1; border-radius: 14px; padding: 10px; background: white; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
        .assistente-composer textarea { width: 100%; min-height: 54px; max-height: 150px; resize: vertical; border: 0; outline: none; padding: 8px; font: inherit; font-size: 14px; box-sizing: border-box; }
        .assistente-disclaimer { margin-top: 9px; color: #64748b; font-size: 11px; line-height: 1.4; }
        @media (max-width: 720px) {
          .assistente-msg { max-width: 94%; }
          .assistente-chat { max-height: 55vh; padding: 12px; }
          .assistente-composer { grid-template-columns: 1fr; }
          .assistente-composer .btn { width: 100%; }
        }
      `}</style>
      <div className="assistente-shell">
        <PageHeader
          icone="✨"
          titulo="Assistente Financeiro"
          descricao="Pergunte sobre seus gastos, categorias, previsões e compras usando os dados reais do app."
          breadcrumb={<Breadcrumb atual="Assistente" onVoltar={onVoltar} />}
          action={<span className="assistente-status">🔒 Somente leitura</span>}
        />

        <div className="assistente-exemplos">
          {exemplos.map((exemplo) => <button key={exemplo} type="button" className="assistente-exemplo" onClick={() => enviarPergunta(exemplo)} disabled={enviando}>{exemplo}</button>)}
        </div>

        <div className="assistente-chat">
          {mensagens.map((mensagem, indice) => (
            <div key={`${mensagem.role}-${indice}`} className={`assistente-msg ${mensagem.role === 'user' ? 'assistente-msg-user' : 'assistente-msg-assistant'} ${mensagem.erro ? 'assistente-msg-error' : ''}`}>
              {mensagem.content}
              {mensagem.consultas?.length > 0 && <div className="assistente-consultas">{mensagem.consultas.map((consulta) => <span key={consulta} className="assistente-consulta">Consultou: {consulta}</span>)}</div>}
            </div>
          ))}
          {enviando && <div className="assistente-msg assistente-msg-assistant"><Spinner texto="Consultando seus dados..." /></div>}
          <div ref={fimRef} />
        </div>

        <div className="assistente-composer">
          <textarea
            value={texto}
            onChange={(event) => setTexto(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                enviarPergunta();
              }
            }}
            maxLength={2000}
            placeholder="Ex.: Em qual categoria eu mais gastei nos últimos 6 meses?"
            disabled={enviando}
          />
          <Btn variant="primary" onClick={() => enviarPergunta()} disabled={enviando || !texto.trim()}>{enviando ? 'Analisando...' : 'Enviar'}</Btn>
        </div>
        <div className="assistente-disclaimer">A IA só acessa consultas de leitura autorizadas pelo backend e nunca recebe acesso direto ao banco. Nesta etapa ela não pode alterar seus dados.</div>
      </div>
    </div>
  );
}

'''
app = app.replace(component_anchor, component + component_anchor, 1)

# 3) Rota de renderização do modo assistente
render_anchor = "      {modo === 'previsoes' && <TelaPrevisoes"
render_index = app.find(render_anchor)
if render_index < 0:
    raise SystemExit('Âncora de renderização de Previsões não encontrada.')
app = app[:render_index] + "      {modo === 'assistente' && <TelaAssistenteFinanceiro token={token} onVoltar={() => setModo('home')} />}\n" + app[render_index:]

# 4) Backend somente leitura + integração Responses API
backend_marker = "// ============================================================================\n// ROTAS: PROVISÕES E CONCILIAÇÕES"
if backend_marker not in backend:
    raise SystemExit('Marcador do backend não encontrado.')

backend_code = r'''// ============================================================================
// ASSISTENTE FINANCEIRO — SOMENTE LEITURA
// ============================================================================

const ASSISTENTE_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
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
            ROUND(SUM(ABS(t.valor))::numeric, 2) AS valor
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
  const total = result.rows.reduce((soma, item) => soma + Number(item.valor || 0), 0);
  return {
    periodo,
    nivel,
    totalNasCategoriasRetornadas: Number(total.toFixed(2)),
    categorias: result.rows.map((item) => ({
      categoria: item.categoria,
      quantidade: Number(item.quantidade || 0),
      valor: Number(item.valor || 0),
      percentualDoTotalRetornado: total ? Number(((Number(item.valor || 0) / total) * 100).toFixed(1)) : 0,
    })),
  };
}

async function ferramentaNaoCategorizados(usuarioId, args = {}) {
  const periodo = periodoPassadoAssistente(args.meses);
  const limite = inteiroAssistente(args.limite, 1, 50, 20);
  const resumo = await pool.query(
    `SELECT COUNT(*)::int AS quantidade,
            ROUND(COALESCE(SUM(ABS(t.valor)), 0)::numeric, 2) AS valor_total
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
    `SELECT t.id, t.data, t.descricao, t.tipo, t.valor, c.nome AS conta_nome
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
    valorTotal: Number(resumo.rows[0]?.valor_total || 0),
    exemplos: itens.rows.map((item) => ({
      id: item.id,
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
    `SELECT id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas
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
      id: item.id,
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
    `SELECT id, nome, banco, tipo, COALESCE(saldo_atual, saldo_inicial, 0)::numeric AS saldo
     FROM contas
     WHERE usuario_id = $1 AND ativo = true
     ORDER BY nome ASC`,
    [usuarioId]
  );
  const contas = result.rows.map((item) => ({
    id: item.id,
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
  contas_previstas_por_mes: 'contas previstas',
  saldos_das_contas: 'saldos das contas',
};

async function executarFerramentaAssistente(usuarioId, nome, args) {
  if (nome === 'gastos_por_categoria') return ferramentaGastosPorCategoria(usuarioId, args);
  if (nome === 'lancamentos_nao_categorizados') return ferramentaNaoCategorizados(usuarioId, args);
  if (nome === 'compras_programadas_por_mes') return ferramentaComprasProgramadas(usuarioId, args);
  if (nome === 'contas_previstas_por_mes') return ferramentaContasPrevistas(usuarioId, args);
  if (nome === 'saldos_das_contas') return ferramentaSaldos(usuarioId);
  throw new Error('Ferramenta não autorizada para o assistente.');
}

function extrairTextoRespostaAssistente(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  return (response?.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((conteudo) => conteudo.type === 'output_text' && typeof conteudo.text === 'string')
    .map((conteudo) => conteudo.text)
    .join('\n')
    .trim();
}

async function chamarOpenAIAssistente(payload) {
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error('Não foi possível conectar ao serviço de IA.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const erro = new Error(data?.error?.message || `Falha no serviço de IA (${response.status}).`);
    erro.statusOpenAI = response.status;
    throw erro;
  }
  return data;
}

function normalizarHistoricoAssistente(historico) {
  if (!Array.isArray(historico)) return [];
  return historico
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    .slice(-ASSISTENTE_MAX_HISTORICO)
    .map((item) => ({ role: item.role, content: item.content.slice(0, ASSISTENTE_MAX_MENSAGEM) }));
}

app.post('/api/assistente', verificarToken, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      erro: 'Assistente financeiro ainda não configurado no servidor.',
      codigo: 'OPENAI_API_KEY_AUSENTE',
    });
  }

  const mensagem = String(req.body?.mensagem || '').trim().slice(0, ASSISTENTE_MAX_MENSAGEM);
  if (!mensagem) return res.status(400).json({ erro: 'Escreva uma pergunta para o assistente.' });

  const usuarioId = req.usuario.usuario_id;
  const historico = normalizarHistoricoAssistente(req.body?.historico);
  const input = [...historico, { role: 'user', content: mensagem }];
  const ferramentasUsadas = new Set();
  const safetyIdentifier = crypto.createHash('sha256').update(String(usuarioId)).digest('hex').slice(0, 32);
  const hoje = new Date().toISOString().slice(0, 10);
  const instructions = `Você é o Assistente Financeiro de um aplicativo de finanças pessoais. Data atual do servidor: ${hoje}.
Responda em português do Brasil, de forma direta, clara e útil.
Você está em MODO SOMENTE LEITURA. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados.
Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos.
Se os dados disponíveis não forem suficientes para responder, diga exatamente o que falta.
Valores são em BRL. Diferencie fatos encontrados nos dados de interpretações ou sugestões.
Não exponha IDs internos, SQL, tokens, chaves ou detalhes técnicos do banco.
Não use tabelas Markdown complexas; prefira conclusão curta, números principais e bullets quando ajudarem.
As ferramentas disponíveis são exclusivamente de consulta e já estão limitadas ao usuário autenticado.`;

  try {
    let response = null;
    for (let rodada = 0; rodada < 5; rodada += 1) {
      response = await chamarOpenAIAssistente({
        model: ASSISTENTE_OPENAI_MODEL,
        instructions,
        input,
        tools: FERRAMENTAS_ASSISTENTE,
        tool_choice: 'auto',
        reasoning: { effort: 'low' },
        text: { verbosity: 'medium' },
        safety_identifier: safetyIdentifier,
        store: false,
      });

      input.push(...(response.output || []));
      const chamadas = (response.output || []).filter((item) => item.type === 'function_call');
      if (chamadas.length === 0) {
        const resposta = extrairTextoRespostaAssistente(response);
        if (!resposta) throw new Error('A IA não retornou uma resposta em texto.');
        return res.json({
          resposta,
          modelo: response.model || ASSISTENTE_OPENAI_MODEL,
          consultas: Array.from(ferramentasUsadas).map((nome) => ROTULOS_FERRAMENTAS_ASSISTENTE[nome] || nome),
        });
      }

      for (const chamada of chamadas) {
        let args = {};
        try { args = JSON.parse(chamada.arguments || '{}'); } catch { args = {}; }
        const resultado = await executarFerramentaAssistente(usuarioId, chamada.name, args);
        ferramentasUsadas.add(chamada.name);
        input.push({
          type: 'function_call_output',
          call_id: chamada.call_id,
          output: JSON.stringify(resultado),
        });
      }
    }

    return res.status(502).json({ erro: 'A análise exigiu chamadas demais. Tente fazer uma pergunta mais específica.' });
  } catch (error) {
    console.error('Erro no assistente financeiro:', error.message);
    if (error.statusOpenAI === 429) return res.status(503).json({ erro: 'O limite temporário do serviço de IA foi atingido. Tente novamente em alguns instantes.' });
    if (error.statusOpenAI === 401 || error.statusOpenAI === 403) return res.status(503).json({ erro: 'A configuração da IA no servidor precisa ser revisada.', codigo: 'OPENAI_CONFIG_INVALIDA' });
    return res.status(500).json({ erro: 'Não foi possível concluir a análise agora. Tente novamente.' });
  }
});

'''
backend = backend.replace(backend_marker, backend_code + backend_marker, 1)

app_path.write_text(app, encoding='utf-8')
backend_path.write_text(backend, encoding='utf-8')
print('Assistente financeiro de leitura aplicado em App.jsx e backend-server.js')
