import fs from 'node:fs';

function trocar(conteudo, rotulo, antigo, novo) {
  if (!conteudo.includes(antigo)) throw new Error(`Trecho não encontrado: ${rotulo}`);
  return conteudo.replace(antigo, novo);
}

// ---------------- Backend ----------------
const backendPath = 'backend-server.js';
let backend = fs.readFileSync(backendPath, 'utf8');

backend = trocar(
  backend,
  'simulador aceitar compra virtual',
  `async function simularCompraProgramada(usuarioId, compraId, parametros = {}) {
    const compraResult = await pool.query(
      'SELECT * FROM compras_programadas WHERE id = $1 AND usuario_id = $2',
      [compraId, usuarioId]
    );
    if (compraResult.rows.length === 0) throw new Error('Compra programada não encontrada.');

    const compra = compraResult.rows[0];`,
  `async function simularCompraProgramada(usuarioId, compraId, parametros = {}, compraVirtual = null) {
    let compra = compraVirtual;
    if (!compra) {
      const compraResult = await pool.query(
        'SELECT * FROM compras_programadas WHERE id = $1 AND usuario_id = $2',
        [compraId, usuarioId]
      );
      if (compraResult.rows.length === 0) throw new Error('Compra programada não encontrada.');
      compra = compraResult.rows[0];
    }`
);

backend = trocar(
  backend,
  'outras compras para simulacao virtual',
  `    const outrasComprasResult = await pool.query(
      \`SELECT id, valor_estimado, data_desejada, forma_pagamento, parcelas
       FROM compras_programadas
       WHERE usuario_id = $1
         AND status = 'PLANEJADA'
         AND id <> $2\`,
      [usuarioId, compra.id]
    );`,
  `    const outrasComprasResult = compra.id
      ? await pool.query(
        \`SELECT id, valor_estimado, data_desejada, forma_pagamento, parcelas
         FROM compras_programadas
         WHERE usuario_id = $1
           AND status = 'PLANEJADA'
           AND id <> $2\`,
        [usuarioId, compra.id]
      )
      : await pool.query(
        \`SELECT id, valor_estimado, data_desejada, forma_pagamento, parcelas
         FROM compras_programadas
         WHERE usuario_id = $1
           AND status = 'PLANEJADA'\`,
        [usuarioId]
      );`
);

const marcadorFerramentas = 'const FERRAMENTAS_ASSISTENTE = [';
const indiceFerramentas = backend.indexOf(marcadorFerramentas);
if (indiceFerramentas < 0) throw new Error('Bloco de ferramentas do assistente não encontrado.');

const ferramentaHipotetica = `async function ferramentaPlanejarCompraHipotetica(usuarioId, args = {}) {
  const descricao = String(args.descricao || '').trim();
  const valorEstimado = Number(args.valorEstimado);
  const dataLimite = normalizarDataImportacao(args.dataLimite);
  const reservaMinima = Math.max(0, Number(args.reservaMinima || 0));
  const prioridade = String(args.prioridade || 'MEDIA').toUpperCase();
  const maxParcelasBruto = Number(args.maxParcelas || 12);
  const maxParcelas = Number.isInteger(maxParcelasBruto) ? Math.min(12, Math.max(1, maxParcelasBruto)) : 12;

  if (!descricao) return { planejada: false, motivo: 'Informe o que deseja comprar.' };
  if (!Number.isFinite(valorEstimado) || valorEstimado <= 0) return { planejada: false, motivo: 'Informe um valor estimado positivo.' };
  if (!dataLimite) return { planejada: false, motivo: 'Informe uma data limite válida para a compra.' };
  if (!PRIORIDADES_COMPRA.includes(prioridade)) return { planejada: false, motivo: 'Prioridade inválida.' };

  const hoje = new Date().toISOString().slice(0, 10);
  if (dataLimite < hoje) return { planejada: false, motivo: 'A data limite da compra não pode estar no passado.' };

  const mesAtual = chaveMesCompra(hoje);
  const mesLimite = chaveMesCompra(dataLimite);
  const mesesAteLimite = diferencaMesesCompra(mesAtual, mesLimite);
  if (!Number.isInteger(mesesAteLimite) || mesesAteLimite < 0) return { planejada: false, motivo: 'Data limite inválida.' };
  if (mesesAteLimite > 12) return { planejada: false, motivo: 'Para manter a projeção objetiva, informe um prazo de até 12 meses.' };

  const diaAlvo = Math.max(1, Math.min(31, Number(String(dataLimite).slice(8, 10)) || 1));
  const dataNoMes = (chave) => {
    const [ano, mes] = String(chave).split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const data = \`${'${'}chave}-${'${'}String(Math.min(diaAlvo, ultimoDia)).padStart(2, '0')}\`;
    return data < hoje ? hoje : data;
  };

  const datasCandidatas = [];
  for (let indice = 0; indice <= mesesAteLimite; indice += 1) {
    const data = dataNoMes(somarMesesChaveCompra(mesAtual, indice));
    if (data <= dataLimite && !datasCandidatas.includes(data)) datasCandidatas.push(data);
  }
  if (!datasCandidatas.includes(dataLimite)) datasCandidatas.push(dataLimite);

  const opcoesParcelas = Array.from(new Set([1, 3, 6, 10, 12, maxParcelas]))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= maxParcelas)
    .sort((a, b) => a - b);

  const compraVirtual = {
    id: null,
    descricao,
    valor_estimado: valorEstimado,
    data_desejada: dataLimite,
    prioridade,
    forma_pagamento: 'A_VISTA',
    parcelas: 1,
    status: 'PLANEJADA',
  };

  const parametrosCenarios = datasCandidatas.flatMap((dataDesejada, indiceData) => opcoesParcelas.map((parcelas) => ({
    dataDesejada,
    adiamentoMeses: indiceData,
    parcelas,
  })));

  const cenarios = [];
  for (let indice = 0; indice < parametrosCenarios.length; indice += 3) {
    const lote = parametrosCenarios.slice(indice, indice + 3);
    const resultados = await Promise.all(lote.map(async (cenario) => {
      const simulacao = await simularCompraProgramada(usuarioId, null, {
        dataDesejada: cenario.dataDesejada,
        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',
        parcelas: cenario.parcelas,
        horizonteMeses: 18,
      }, compraVirtual);
      return {
        ...cenario,
        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',
        valorParcela: Number(simulacao.parametros.valorParcela || 0),
        menorSaldoComCompra: Number(simulacao.resumo.menorSaldoComCompra || 0),
        menorSaldoSemCompra: Number(simulacao.resumo.menorSaldoSemCompra || 0),
        mesesNegativos: simulacao.resumo.mesesNegativos || [],
        atendeReserva: Number(simulacao.resumo.menorSaldoComCompra || 0) >= reservaMinima,
      };
    }));
    cenarios.push(...resultados);
  }

  cenarios.sort((a, b) => {
    if (a.atendeReserva !== b.atendeReserva) return a.atendeReserva ? -1 : 1;
    if (a.atendeReserva && b.atendeReserva) {
      if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
      if (a.parcelas !== b.parcelas) return a.parcelas - b.parcelas;
      return b.menorSaldoComCompra - a.menorSaldoComCompra;
    }
    if (a.menorSaldoComCompra !== b.menorSaldoComCompra) return b.menorSaldoComCompra - a.menorSaldoComCompra;
    if (a.mesesNegativos.length !== b.mesesNegativos.length) return a.mesesNegativos.length - b.mesesNegativos.length;
    if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
    return a.parcelas - b.parcelas;
  });

  const melhor = cenarios[0] || null;
  const criterio = melhor?.atendeReserva
    ? 'Prioriza a data mais próxima que preserva a reserva e, depois, o menor número de parcelas.'
    : 'Nenhum cenário preserva a reserva; prioriza o maior saldo mínimo projetado e menor exposição a meses negativos.';
  const propostaCadastro = melhor ? {
    descricao,
    valorEstimado: Number(valorEstimado.toFixed(2)),
    dataDesejada: melhor.dataDesejada,
    prioridade,
    formaPagamento: melhor.formaPagamento,
    parcelas: melhor.parcelas,
    contaId: null,
    categoriaMacroId: null,
    categoriaDetalhadaId: null,
    observacao: \`Planejada com o Assistente Financeiro. Reserva mínima considerada: R$ ${'${'}reservaMinima.toFixed(2)}.\`,
  } : null;

  return {
    planejada: Boolean(melhor),
    compra: { descricao, valorEstimado: Number(valorEstimado.toFixed(2)), dataLimite, prioridade, maxParcelas },
    reservaMinima,
    criterio,
    melhorCenario: melhor,
    melhoresAlternativas: cenarios.slice(0, 5),
    propostaCadastro,
    premissas: [
      'A compra ainda não foi cadastrada; estes cenários são apenas uma simulação.',
      'O horizonte financeiro de cada cenário é de 18 meses.',
      'São comparados meses até a data limite informada e parcelamentos de até 12x.',
      'Não são estimados juros, taxas ou descontos.',
      'A gravação da compra exige confirmação explícita do usuário na interface.',
    ],
  };
}

`;
backend = backend.slice(0, indiceFerramentas) + ferramentaHipotetica + backend.slice(indiceFerramentas);

backend = trocar(
  backend,
  'declaracao ferramenta hipotetica',
  `  {
    type: 'function',
    name: 'contas_previstas_por_mes',`,
  `  {
    type: 'function',
    name: 'planejar_compra_hipotetica',
    description: 'Planeja uma compra que ainda não está cadastrada. Compara datas até o prazo informado e parcelamentos usando o mesmo motor financeiro das Compras Programadas, sem gravar nada. Use quando o usuário disser que quer comprar algo novo e pedir a melhor data, parcelamento ou impacto no caixa.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'Nome claro do item ou objetivo de compra.' },
        valorEstimado: { type: 'number', minimum: 0.01, description: 'Valor total estimado da compra em BRL.' },
        dataLimite: { type: 'string', description: 'Data limite no formato AAAA-MM-DD.' },
        reservaMinima: { type: 'number', minimum: 0, description: 'Saldo mínimo em BRL que o usuário deseja preservar. Use 0 apenas se ele não informar.' },
        prioridade: { type: 'string', enum: ['BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'], description: 'Prioridade da compra. Use MEDIA se o usuário não informar.' },
        maxParcelas: { type: 'integer', minimum: 1, maximum: 12, description: 'Máximo de parcelas a considerar. Use 12 se o usuário não informar.' },
      },
      required: ['descricao', 'valorEstimado', 'dataLimite', 'reservaMinima', 'prioridade', 'maxParcelas'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'contas_previstas_por_mes',`
);

backend = trocar(
  backend,
  'rotulo ferramenta hipotetica',
  `  comparar_cenarios_compra_programada: 'comparação de cenários de compra',`,
  `  comparar_cenarios_compra_programada: 'comparação de cenários de compra',
  planejar_compra_hipotetica: 'planejamento de nova compra',`
);

backend = trocar(
  backend,
  'dispatcher ferramenta hipotetica',
  `  if (nome === 'comparar_cenarios_compra_programada') return ferramentaCompararCompraProgramada(usuarioId, args);`,
  `  if (nome === 'comparar_cenarios_compra_programada') return ferramentaCompararCompraProgramada(usuarioId, args);
  if (nome === 'planejar_compra_hipotetica') return ferramentaPlanejarCompraHipotetica(usuarioId, args);`
);

backend = trocar(
  backend,
  'estado acao pendente',
  `  const ferramentasUsadas = new Set();`,
  `  const ferramentasUsadas = new Set();
  let acaoPendente = null;`
);

backend = trocar(
  backend,
  'captura acao pendente',
  `        const resultado = await executarFerramentaAssistente(usuarioId, chamada.name, chamada.args || {});
        ferramentasUsadas.add(chamada.name);`,
  `        const resultado = await executarFerramentaAssistente(usuarioId, chamada.name, chamada.args || {});
        ferramentasUsadas.add(chamada.name);
        if (chamada.name === 'planejar_compra_hipotetica' && resultado?.propostaCadastro) {
          acaoPendente = {
            tipo: 'CRIAR_COMPRA_PROGRAMADA',
            payload: resultado.propostaCadastro,
            analise: {
              reservaMinima: resultado.reservaMinima,
              criterio: resultado.criterio,
              melhorCenario: resultado.melhorCenario,
              melhoresAlternativas: resultado.melhoresAlternativas,
            },
          };
        }`
);

backend = trocar(
  backend,
  'retorno acao pendente',
  `          consultas: Array.from(ferramentasUsadas).map((nome) => ROTULOS_FERRAMENTAS_ASSISTENTE[nome] || nome),
        });`,
  `          consultas: Array.from(ferramentasUsadas).map((nome) => ROTULOS_FERRAMENTAS_ASSISTENTE[nome] || nome),
          acaoPendente,
        });`
);

backend = trocar(
  backend,
  'instrucoes planejamento hipotetico',
  `Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar se pode realizar uma compra programada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use obrigatoriamente a ferramenta comparar_cenarios_compra_programada antes de recomendar.`,
  `Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar sobre uma compra que já está cadastrada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use comparar_cenarios_compra_programada antes de recomendar. Se ele estiver planejando uma compra nova que ainda não está cadastrada, use obrigatoriamente planejar_compra_hipotetica. Se faltarem descrição, valor ou prazo/data limite, peça esses dados antes de planejar. Na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12.`
);

backend = trocar(
  backend,
  'instrucao confirmacao explicita',
  `Você está em MODO SOMENTE LEITURA. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados.`,
  `Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados. Você pode preparar uma proposta estruturada de Compra Programada, mas a gravação só ocorre depois de confirmação explícita do usuário na interface.`
);

fs.writeFileSync(backendPath, backend);

// ---------------- Frontend ----------------
const appPath = 'App.jsx';
let app = fs.readFileSync(appPath, 'utf8');

app = trocar(
  app,
  'boas vindas assistente',
  `    content: 'Sou o assistente financeiro do seu app. Nesta primeira versão eu posso consultar seus dados e responder perguntas, mas não altero nenhum lançamento, categoria ou previsão.',`,
  `    content: 'Sou o assistente financeiro do seu app. Posso consultar seus dados, comparar cenários e preparar uma Compra Programada. Nenhuma compra é criada sem sua confirmação explícita.',`
);

app = trocar(
  app,
  'exemplo planejamento compra',
  `    'Como estão minhas contas previstas nos próximos 3 meses?',`,
  `    'Como estão minhas contas previstas nos próximos 3 meses?',
    'Quero comprar uma TV de R$ 4.500 até novembro. Qual a melhor forma?',`
);

app = trocar(
  app,
  'estado salvando acao',
  `  const [enviando, setEnviando] = useState(false);
  const fimRef = useRef(null);`,
  `  const [enviando, setEnviando] = useState(false);
  const [acaoSalvandoIndice, setAcaoSalvandoIndice] = useState(null);
  const fimRef = useRef(null);`
);

app = trocar(
  app,
  'armazenar acao pendente',
  `        consultas: response.data.consultas || [],
      }]);`,
  `        consultas: response.data.consultas || [],
        acaoPendente: response.data.acaoPendente || null,
      }]);`
);

const marcadorReturnAssistente = `  return (
    <div className="content-card" style={{ background: 'white', borderRadius: '12px', padding: '24px' }}>`;
const indiceReturnAssistente = app.indexOf(marcadorReturnAssistente, app.indexOf('function TelaAssistenteFinanceiro'));
if (indiceReturnAssistente < 0) throw new Error('Return do Assistente não encontrado.');
const confirmarAcao = `  const confirmarCompraSugerida = (acao, indice) => {
    if (!acao?.payload || acao.confirmada || acaoSalvandoIndice !== null) return;
    const payload = acao.payload;
    const pagamento = payload.formaPagamento === 'PARCELADO' ? \`${'${'}payload.parcelas}x de ${'${'}formatarMoeda(Number(payload.valorEstimado || 0) / Number(payload.parcelas || 1))}\` : 'à vista';
    pedirConfirmacao(
      'Adicionar compra programada',
      \`Cadastrar "${'${'}payload.descricao}" por ${'${'}formatarMoeda(payload.valorEstimado)}, para ${'${'}formatarData(payload.dataDesejada)}, ${'${'}pagamento}?\`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.post(\`${'${'}API_URL}/compras-programadas\`, payload, {
            headers: { Authorization: \`Bearer ${'${'}token}\` },
          });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true } }
            : item));
          mostrarToast('Compra adicionada às Compras Programadas.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível adicionar a compra programada.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: 'Adicionar compra', corConfirmar: '#2563eb' }
    );
  };

`;
app = app.slice(0, indiceReturnAssistente) + confirmarAcao + app.slice(indiceReturnAssistente);

app = trocar(
  app,
  'estilos acao assistente',
  `        .assistente-disclaimer { margin-top: 9px; color: #64748b; font-size: 11px; line-height: 1.4; }`,
  `        .assistente-acao { margin-top: 12px; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 12px; padding: 12px; white-space: normal; }
        .assistente-acao-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; margin: 10px 0; }
        .assistente-acao-item { background: white; border: 1px solid #dbeafe; border-radius: 9px; padding: 8px; }
        .assistente-acao-item small { display: block; color: #64748b; font-size: 10px; margin-bottom: 3px; }
        .assistente-acao-confirmada { display: inline-flex; align-items: center; gap: 6px; color: #166534; background: #dcfce7; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; }
        .assistente-disclaimer { margin-top: 9px; color: #64748b; font-size: 11px; line-height: 1.4; }`
);

app = trocar(
  app,
  'status assistente',
  `          action={<span className="assistente-status">🆓 Free tier · somente leitura</span>}`,
  `          action={<span className="assistente-status">🆓 Free tier · ações com confirmação</span>}`
);

app = trocar(
  app,
  'renderizar acao pendente',
  `              {mensagem.consultas?.length > 0 && <div className="assistente-consultas">{mensagem.consultas.map((consulta) => <span key={consulta} className="assistente-consulta">Consultou: {consulta}</span>)}</div>}
            </div>`,
  `              {mensagem.consultas?.length > 0 && <div className="assistente-consultas">{mensagem.consultas.map((consulta) => <span key={consulta} className="assistente-consulta">Consultou: {consulta}</span>)}</div>}
              {mensagem.acaoPendente?.tipo === 'CRIAR_COMPRA_PROGRAMADA' && (() => {
                const payload = mensagem.acaoPendente.payload || {};
                const cenario = mensagem.acaoPendente.analise?.melhorCenario || {};
                return <div className="assistente-acao">
                  <strong>🛒 Proposta de Compra Programada</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Compra</small><strong>{payload.descricao}</strong></div>
                    <div className="assistente-acao-item"><small>Valor</small><strong>{formatarMoeda(payload.valorEstimado)}</strong></div>
                    <div className="assistente-acao-item"><small>Data sugerida</small><strong>{formatarData(payload.dataDesejada)}</strong></div>
                    <div className="assistente-acao-item"><small>Pagamento</small><strong>{payload.formaPagamento === 'PARCELADO' ? \`${'${'}payload.parcelas}x de ${'${'}formatarMoeda(Number(payload.valorEstimado || 0) / Number(payload.parcelas || 1))}\` : 'À vista'}</strong></div>
                    <div className="assistente-acao-item"><small>Menor saldo projetado</small><strong>{formatarMoeda(cenario.menorSaldoComCompra)}</strong></div>
                    <div className="assistente-acao-item"><small>Reserva mínima</small><strong>{formatarMoeda(mensagem.acaoPendente.analise?.reservaMinima || 0)}</strong></div>
                  </div>
                  {mensagem.acaoPendente.confirmada
                    ? <span className="assistente-acao-confirmada">✅ Adicionada às Compras Programadas</span>
                    : <Btn variant="primary" size="sm" onClick={() => confirmarCompraSugerida(mensagem.acaoPendente, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Adicionando...' : 'Adicionar às Compras Programadas'}</Btn>}
                </div>;
              })()}
            </div>`
);

app = trocar(
  app,
  'disclaimer assistente',
  `        <div className="assistente-disclaimer">A IA só acessa consultas de leitura autorizadas pelo backend e nunca recebe acesso direto ao banco. O assistente usa o nível gratuito do Gemini; nesse nível, o Google informa que o conteúdo enviado pode ser usado para melhorar seus produtos. Nesta etapa a IA não pode alterar seus dados.</div>`,
  `        <div className="assistente-disclaimer">A IA consulta dados por ferramentas autorizadas e não recebe acesso direto ao banco. Ela pode preparar uma sugestão de Compra Programada, mas nenhuma gravação ocorre automaticamente: o app só cadastra após você clicar em adicionar e confirmar no modal. O assistente usa o nível gratuito do Gemini; nesse nível, o Google informa que o conteúdo enviado pode ser usado para melhorar seus produtos.</div>`
);

fs.writeFileSync(appPath, app);
console.log('Planejamento assistido de nova compra aplicado com confirmação explícita.');
