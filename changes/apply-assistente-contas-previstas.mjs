import fs from 'node:fs';

function trocar(conteudo, rotulo, antigo, novo) {
  if (!conteudo.includes(antigo)) throw new Error(`Trecho não encontrado: ${rotulo}`);
  return conteudo.replace(antigo, novo);
}

// ---------------- Backend ----------------
const backendPath = 'backend-server.js';
let backend = fs.readFileSync(backendPath, 'utf8');

const marcadorFerramentas = 'const FERRAMENTAS_ASSISTENTE = [';
const indiceFerramentas = backend.indexOf(marcadorFerramentas);
if (indiceFerramentas < 0) throw new Error('Bloco de ferramentas do assistente não encontrado.');

const ferramentasProvisoes = `async function ferramentaPrepararNovaProvisao(usuarioId, args = {}) {
  const descricao = String(args.descricao || '').trim();
  const valorPrevisto = Number(args.valorPrevisto);
  const tipo = String(args.tipo || '').trim().toUpperCase();
  const dataPrevista = normalizarDataImportacao(args.dataPrevista);
  const dataVencimentoInformada = String(args.dataVencimento || '').trim();
  const dataVencimento = dataVencimentoInformada ? normalizarDataImportacao(dataVencimentoInformada) : null;
  const observacao = String(args.observacao || '').trim();

  if (!descricao) return { preparada: false, motivo: 'Informe a descrição da conta prevista.' };
  if (!Number.isFinite(valorPrevisto) || valorPrevisto <= 0) return { preparada: false, motivo: 'Informe um valor previsto positivo.' };
  if (!TIPOS_PROVISAO.includes(tipo)) return { preparada: false, motivo: 'Informe se a conta prevista é um crédito ou débito.' };
  if (!dataPrevista) return { preparada: false, motivo: 'Informe uma data prevista válida.' };
  if (dataVencimentoInformada && !dataVencimento) return { preparada: false, motivo: 'A data de vencimento informada é inválida.' };

  const payload = {
    descricao,
    valorPrevisto: Number(valorPrevisto.toFixed(2)),
    tipo,
    dataPrevista,
    status: 'PENDENTE',
    recorrente: false,
  };
  if (dataVencimento) payload.dataVencimento = dataVencimento;
  if (observacao) payload.observacao = observacao;

  const detalhes = [
    `Tipo: ${tipo === 'CREDITO' ? 'A receber' : 'A pagar'}`,
    `Valor: ${Number(valorPrevisto).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    `Data prevista: ${dataPrevista.split('-').reverse().join('/')}`,
  ];
  if (dataVencimento) detalhes.push(`Vencimento: ${dataVencimento.split('-').reverse().join('/')}`);

  return {
    preparada: true,
    contaPrevista: { descricao, valorPrevisto: Number(valorPrevisto.toFixed(2)), tipo, dataPrevista, dataVencimento },
    detalhes,
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'CRIAR_PROVISAO',
      rotuloAcao: 'Adicionar conta prevista',
      payload,
      detalhes,
    },
  };
}

async function ferramentaPrepararAlteracaoProvisao(usuarioId, args = {}) {
  const termo = String(args.termo || '').trim();
  const acao = String(args.acao || '').trim().toUpperCase();
  const novaDescricao = String(args.novaDescricao || '').trim();
  const novoValorPrevisto = Number(args.novoValorPrevisto || 0);
  const novoTipo = String(args.novoTipo || 'MANTER').trim().toUpperCase();
  const novaDataPrevistaInformada = String(args.novaDataPrevista || '').trim();
  const novaDataVencimentoInformada = String(args.novaDataVencimento || '').trim();
  const adiarMeses = Number(args.adiarMeses || 0);
  const novaObservacao = String(args.novaObservacao || '').trim();
  const acoesPermitidas = ['ADIAR', 'EDITAR', 'CANCELAR', 'MARCAR_REALIZADA'];

  if (!termo) return { encontrada: false, motivo: 'Informe a descrição ou parte do nome da conta prevista.' };
  if (!acoesPermitidas.includes(acao)) return { encontrada: false, motivo: 'Ação de conta prevista inválida.' };

  const result = await pool.query(
    `SELECT id, descricao, valor_previsto, tipo, data_prevista, data_vencimento, status, observacao
     FROM provisoes
     WHERE usuario_id = $1
       AND status IN ('PENDENTE', 'ATRASADA')
       AND LOWER(descricao) LIKE LOWER($2)
     ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, data_prevista ASC
     LIMIT 5`,
    [usuarioId, `%${termo}%`, termo]
  );

  if (result.rows.length === 0) return { encontrada: false, motivo: `Nenhuma conta prevista ativa corresponde a "${termo}".` };
  if (result.rows.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma conta prevista correspondente. Peça ao usuário para indicar qual deseja alterar.',
      opcoes: result.rows.map((item) => ({
        descricao: item.descricao,
        valorPrevisto: Number(item.valor_previsto || 0),
        tipo: item.tipo,
        dataPrevista: String(item.data_prevista || '').slice(0, 10),
        status: item.status,
      })),
    };
  }

  const provisao = result.rows[0];
  if (acao === 'MARCAR_REALIZADA') {
    return {
      encontrada: true,
      preparada: false,
      requerConciliacao: true,
      contaPrevista: {
        descricao: provisao.descricao,
        valorPrevisto: Number(provisao.valor_previsto || 0),
        tipo: provisao.tipo,
        dataPrevista: String(provisao.data_prevista || '').slice(0, 10),
        status: provisao.status,
      },
      motivo: 'Uma Conta Prevista só deve ser marcada como realizada por meio da conciliação com uma transação real. Não altere o status diretamente. Oriente o usuário a localizar ou importar a transação correspondente para confirmar a conciliação.',
    };
  }

  const payload = {};
  const detalhes = [];
  const hoje = new Date().toISOString().slice(0, 10);
  const dataAtual = String(provisao.data_prevista || '').slice(0, 10);
  const formatarData = (data) => String(data || '').slice(0, 10).split('-').reverse().join('/');
  const formatarMoeda = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const adicionarMeses = (dataIso, quantidade) => {
    const [ano, mes, dia] = String(dataIso || '').slice(0, 10).split('-').map(Number);
    if (![ano, mes, dia].every(Number.isFinite)) return null;
    const indice = (ano * 12) + (mes - 1) + quantidade;
    const novoAno = Math.floor(indice / 12);
    const novoMes = indice % 12;
    const ultimoDia = new Date(Date.UTC(novoAno, novoMes + 1, 0)).getUTCDate();
    return `${novoAno}-${String(novoMes + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
  };

  if (acao === 'ADIAR') {
    let novaData = novaDataPrevistaInformada ? normalizarDataImportacao(novaDataPrevistaInformada) : null;
    if (!novaData && Number.isInteger(adiarMeses) && adiarMeses > 0) novaData = adicionarMeses(dataAtual || hoje, adiarMeses);
    if (!novaData) return { encontrada: true, preparada: false, motivo: 'Informe a nova data ou por quantos meses deseja adiar.' };
    if (novaData < hoje) return { encontrada: true, preparada: false, motivo: 'A nova data não pode estar no passado.' };
    if (dataAtual && novaData <= dataAtual) return { encontrada: true, preparada: false, motivo: 'Para adiar, a nova data deve ser posterior à data atual.' };
    payload.dataPrevista = novaData;
    payload.status = 'PENDENTE';
    detalhes.push(`Data prevista: ${formatarData(dataAtual)} → ${formatarData(novaData)}`);
    if (provisao.status !== 'PENDENTE') detalhes.push(`Status: ${provisao.status} → PENDENTE`);
  }

  if (acao === 'CANCELAR') {
    payload.status = 'CANCELADA';
    detalhes.push(`Status: ${provisao.status} → CANCELADA`);
  }

  if (acao === 'EDITAR') {
    if (novaDescricao && novaDescricao !== provisao.descricao) {
      payload.descricao = novaDescricao;
      detalhes.push(`Descrição: ${provisao.descricao} → ${novaDescricao}`);
    }
    if (Number.isFinite(novoValorPrevisto) && novoValorPrevisto > 0 && novoValorPrevisto !== Number(provisao.valor_previsto || 0)) {
      payload.valorPrevisto = novoValorPrevisto;
      detalhes.push(`Valor: ${formatarMoeda(provisao.valor_previsto)} → ${formatarMoeda(novoValorPrevisto)}`);
    }
    if (novoTipo !== 'MANTER') {
      if (!TIPOS_PROVISAO.includes(novoTipo)) return { encontrada: true, preparada: false, motivo: 'Novo tipo inválido. Use CREDITO ou DEBITO.' };
      if (novoTipo !== provisao.tipo) {
        payload.tipo = novoTipo;
        detalhes.push(`Tipo: ${provisao.tipo} → ${novoTipo}`);
      }
    }
    if (novaDataPrevistaInformada) {
      const novaData = normalizarDataImportacao(novaDataPrevistaInformada);
      if (!novaData) return { encontrada: true, preparada: false, motivo: 'A nova data prevista é inválida.' };
      if (novaData !== dataAtual) {
        payload.dataPrevista = novaData;
        detalhes.push(`Data prevista: ${formatarData(dataAtual)} → ${formatarData(novaData)}`);
      }
    }
    if (novaDataVencimentoInformada) {
      const novaDataVencimento = normalizarDataImportacao(novaDataVencimentoInformada);
      if (!novaDataVencimento) return { encontrada: true, preparada: false, motivo: 'A nova data de vencimento é inválida.' };
      const atualVencimento = String(provisao.data_vencimento || '').slice(0, 10);
      if (novaDataVencimento !== atualVencimento) {
        payload.dataVencimento = novaDataVencimento;
        detalhes.push(`Vencimento: ${atualVencimento ? formatarData(atualVencimento) : 'não informado'} → ${formatarData(novaDataVencimento)}`);
      }
    }
    if (novaObservacao && novaObservacao !== String(provisao.observacao || '').trim()) {
      payload.observacao = novaObservacao;
      detalhes.push('Observação atualizada');
    }
    if (detalhes.length === 0) return { encontrada: true, preparada: false, motivo: 'Nenhuma alteração diferente dos dados atuais foi informada.' };
  }

  const rotulos = { ADIAR: 'Adiar conta prevista', EDITAR: 'Editar conta prevista', CANCELAR: 'Cancelar conta prevista' };
  return {
    encontrada: true,
    preparada: true,
    acao,
    rotuloAcao: rotulos[acao],
    contaPrevista: {
      descricao: provisao.descricao,
      valorPrevisto: Number(provisao.valor_previsto || 0),
      tipo: provisao.tipo,
      dataPrevista: dataAtual,
      status: provisao.status,
    },
    alteracoes: detalhes,
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'ALTERAR_PROVISAO',
      provisaoId: provisao.id,
      acao,
      rotuloAcao: rotulos[acao],
      provisaoDescricao: provisao.descricao,
      payload,
      detalhes,
    },
  };
}

`;
backend = backend.slice(0, indiceFerramentas) + ferramentasProvisoes + backend.slice(indiceFerramentas);

backend = trocar(
  backend,
  'declaracoes de ferramentas de provisoes',
  `  {
    type: 'function',
    name: 'contas_previstas_por_mes',`,
  `  {
    type: 'function',
    name: 'preparar_nova_conta_prevista',
    description: 'Prepara, sem gravar, uma nova Conta Prevista (provisão) a pagar ou receber. Use quando o usuário pedir para cadastrar uma conta futura. A criação só ocorre após confirmação explícita no frontend.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'Descrição da conta prevista.' },
        valorPrevisto: { type: 'number', minimum: 0.01, description: 'Valor previsto em BRL.' },
        tipo: { type: 'string', enum: ['CREDITO', 'DEBITO'], description: 'CREDITO para valor a receber e DEBITO para valor a pagar.' },
        dataPrevista: { type: 'string', description: 'Data prevista no formato AAAA-MM-DD.' },
        dataVencimento: { type: 'string', description: 'Data de vencimento AAAA-MM-DD ou string vazia se não informada.' },
        observacao: { type: 'string', description: 'Observação ou string vazia se não informada.' },
      },
      required: ['descricao', 'valorPrevisto', 'tipo', 'dataPrevista', 'dataVencimento', 'observacao'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'preparar_alteracao_conta_prevista',
    description: 'Prepara, sem gravar, uma alteração em Conta Prevista existente. Use para adiar, editar ou cancelar. Se o usuário disser que a conta foi paga/recebida/realizada, use MARCAR_REALIZADA para informar que é necessária conciliação com uma transação real.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Descrição ou parte do nome da conta prevista.' },
        acao: { type: 'string', enum: ['ADIAR', 'EDITAR', 'CANCELAR', 'MARCAR_REALIZADA'] },
        novaDescricao: { type: 'string', description: 'Nova descrição ou string vazia para manter.' },
        novoValorPrevisto: { type: 'number', minimum: 0, description: 'Novo valor ou 0 para manter.' },
        novoTipo: { type: 'string', enum: ['MANTER', 'CREDITO', 'DEBITO'] },
        novaDataPrevista: { type: 'string', description: 'Nova data AAAA-MM-DD ou string vazia.' },
        novaDataVencimento: { type: 'string', description: 'Novo vencimento AAAA-MM-DD ou string vazia.' },
        adiarMeses: { type: 'integer', minimum: 0, maximum: 24, description: 'Meses para adiar ou 0.' },
        novaObservacao: { type: 'string', description: 'Nova observação ou string vazia para manter.' },
      },
      required: ['termo', 'acao', 'novaDescricao', 'novoValorPrevisto', 'novoTipo', 'novaDataPrevista', 'novaDataVencimento', 'adiarMeses', 'novaObservacao'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'contas_previstas_por_mes',`
);

backend = trocar(
  backend,
  'rotulos de provisoes',
  `  preparar_alteracao_compra_programada: 'alteração de compra programada',
  contas_previstas_por_mes: 'contas previstas',`,
  `  preparar_alteracao_compra_programada: 'alteração de compra programada',
  preparar_nova_conta_prevista: 'nova conta prevista',
  preparar_alteracao_conta_prevista: 'alteração de conta prevista',
  contas_previstas_por_mes: 'contas previstas',`
);

backend = trocar(
  backend,
  'dispatcher provisoes',
  `  if (nome === 'preparar_alteracao_compra_programada') return ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args);
  if (nome === 'contas_previstas_por_mes') return ferramentaContasPrevistas(usuarioId, args);`,
  `  if (nome === 'preparar_alteracao_compra_programada') return ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args);
  if (nome === 'preparar_nova_conta_prevista') return ferramentaPrepararNovaProvisao(usuarioId, args);
  if (nome === 'preparar_alteracao_conta_prevista') return ferramentaPrepararAlteracaoProvisao(usuarioId, args);
  if (nome === 'contas_previstas_por_mes') return ferramentaContasPrevistas(usuarioId, args);`
);

backend = trocar(
  backend,
  'instrucoes gerais de escrita',
  `Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados. Você pode preparar propostas estruturadas de criação ou alteração de Compra Programada, mas qualquer gravação só ocorre depois de confirmação explícita do usuário na interface.`,
  `Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados. Você pode preparar propostas estruturadas de criação ou alteração de Compras Programadas e Contas Previstas, mas qualquer gravação só ocorre depois de confirmação explícita do usuário na interface.`
);

backend = trocar(
  backend,
  'instrucoes de ferramentas para previsoes',
  `Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada. Para campos que não serão alterados nessa ferramenta, use os sentinelas indicados no schema, como string vazia, 0 ou MANTER. Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Se faltarem descrição, valor ou prazo/data limite para uma compra nova, peça esses dados antes de planejar.`,
  `Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada. Se pedir para criar uma Conta Prevista, use preparar_nova_conta_prevista. Se pedir para adiar, editar, cancelar ou marcar como realizada uma Conta Prevista existente, use preparar_alteracao_conta_prevista. Uma Conta Prevista só pode ser considerada realizada após conciliação com uma transação real; nunca contorne essa regra alterando o status diretamente. Para campos que não serão alterados nessas ferramentas, use os sentinelas indicados no schema, como string vazia, 0 ou MANTER. Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Se faltarem descrição, valor ou prazo/data limite para uma compra nova, peça esses dados antes de planejar.`
);

fs.writeFileSync(backendPath, backend);

// ---------------- Frontend ----------------
const appPath = 'App.jsx';
let app = fs.readFileSync(appPath, 'utf8');

app = trocar(
  app,
  'boas vindas do assistente',
  `content: 'Sou o assistente financeiro do seu app. Posso consultar seus dados, comparar cenários e preparar criação ou alteração de Compras Programadas. Nenhuma mudança é aplicada sem sua confirmação explícita.',`,
  `content: 'Sou o assistente financeiro do seu app. Posso consultar seus dados e preparar ações em Compras Programadas e Contas Previstas. Nenhuma mudança é aplicada sem sua confirmação explícita.',`
);

app = trocar(
  app,
  'exemplo de conta prevista',
  `    'Como estão minhas contas previstas nos próximos 3 meses?',
    'Quero comprar uma TV de R$ 4.500 até novembro. Qual a melhor forma?',`,
  `    'Como estão minhas contas previstas nos próximos 3 meses?',
    'Adicione uma conta de internet de R$ 120 para o dia 15.',
    'Quero comprar uma TV de R$ 4.500 até novembro. Qual a melhor forma?',`
);

const marcadorReturnAssistente = `  return (\n    <div className="content-card" style={{ background: 'white', borderRadius: '12px', padding: '24px' }}>`;
const indiceReturn = app.indexOf(marcadorReturnAssistente, app.indexOf('function TelaAssistenteFinanceiro'));
if (indiceReturn < 0) throw new Error('Return do Assistente não encontrado.');
const funcoesProvisao = `  const confirmarNovaProvisaoSugerida = (acao, indice) => {
    if (!acao?.payload || acao.confirmada || acaoSalvandoIndice !== null) return;
    const payload = acao.payload;
    pedirConfirmacao(
      acao.rotuloAcao || 'Adicionar conta prevista',
      `Cadastrar "${payload.descricao}" por ${formatarMoeda(payload.valorPrevisto)}, para ${formatarData(payload.dataPrevista)}?`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.post(`${API_URL}/provisoes`, payload, { headers: { Authorization: `Bearer ${token}` } });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true } }
            : item));
          mostrarToast('Conta Prevista adicionada.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível adicionar a Conta Prevista.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: 'Adicionar conta prevista', corConfirmar: '#2563eb' }
    );
  };

  const confirmarAlteracaoProvisaoSugerida = (acao, indice) => {
    if (!acao?.provisaoId || !acao?.payload || acao.confirmada || acaoSalvandoIndice !== null) return;
    pedirConfirmacao(
      acao.rotuloAcao || 'Confirmar alteração',
      `Aplicar em "${acao.provisaoDescricao}"? ${(acao.detalhes || []).join(' • ')}`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.patch(`${API_URL}/provisoes/${acao.provisaoId}`, acao.payload, { headers: { Authorization: `Bearer ${token}` } });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true } }
            : item));
          mostrarToast('Conta Prevista atualizada.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível atualizar a Conta Prevista.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: acao.rotuloAcao || 'Aplicar alteração', corConfirmar: acao.acao === 'CANCELAR' ? '#dc2626' : '#2563eb' }
    );
  };

`;
app = app.slice(0, indiceReturn) + funcoesProvisao + app.slice(indiceReturn);

app = trocar(
  app,
  'cards de provisoes',
  `              {mensagem.acaoPendente?.tipo === 'ALTERAR_COMPRA_PROGRAMADA' && (() => {
                const acao = mensagem.acaoPendente;
                return <div className="assistente-acao">
                  <strong>✏️ {acao.rotuloAcao || 'Alteração proposta'}</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Compra</small><strong>{acao.compraDescricao}</strong></div>
                    <div className="assistente-acao-item"><small>Ação</small><strong>{acao.rotuloAcao}</strong></div>
                  </div>
                  <ul className="assistente-acao-detalhes">{(acao.detalhes || []).map((detalhe) => <li key={detalhe}>{detalhe}</li>)}</ul>
                  {acao.confirmada
                    ? <span className="assistente-acao-confirmada">✅ Alteração aplicada</span>
                    : <Btn variant={acao.acao === 'CANCELAR' ? 'danger' : 'primary'} size="sm" onClick={() => confirmarAlteracaoSugerida(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Aplicando...' : (acao.rotuloAcao || 'Aplicar alteração')}</Btn>}
                </div>;
              })()}`,
  `              {mensagem.acaoPendente?.tipo === 'ALTERAR_COMPRA_PROGRAMADA' && (() => {
                const acao = mensagem.acaoPendente;
                return <div className="assistente-acao">
                  <strong>✏️ {acao.rotuloAcao || 'Alteração proposta'}</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Compra</small><strong>{acao.compraDescricao}</strong></div>
                    <div className="assistente-acao-item"><small>Ação</small><strong>{acao.rotuloAcao}</strong></div>
                  </div>
                  <ul className="assistente-acao-detalhes">{(acao.detalhes || []).map((detalhe) => <li key={detalhe}>{detalhe}</li>)}</ul>
                  {acao.confirmada
                    ? <span className="assistente-acao-confirmada">✅ Alteração aplicada</span>
                    : <Btn variant={acao.acao === 'CANCELAR' ? 'danger' : 'primary'} size="sm" onClick={() => confirmarAlteracaoSugerida(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Aplicando...' : (acao.rotuloAcao || 'Aplicar alteração')}</Btn>}
                </div>;
              })()}
              {mensagem.acaoPendente?.tipo === 'CRIAR_PROVISAO' && (() => {
                const acao = mensagem.acaoPendente;
                const payload = acao.payload || {};
                return <div className="assistente-acao">
                  <strong>📌 Nova Conta Prevista</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Descrição</small><strong>{payload.descricao}</strong></div>
                    <div className="assistente-acao-item"><small>Tipo</small><strong>{payload.tipo === 'CREDITO' ? 'A receber' : 'A pagar'}</strong></div>
                    <div className="assistente-acao-item"><small>Valor</small><strong>{formatarMoeda(payload.valorPrevisto)}</strong></div>
                    <div className="assistente-acao-item"><small>Data prevista</small><strong>{formatarData(payload.dataPrevista)}</strong></div>
                  </div>
                  {acao.confirmada
                    ? <span className="assistente-acao-confirmada">✅ Adicionada às Contas Previstas</span>
                    : <Btn variant="primary" size="sm" onClick={() => confirmarNovaProvisaoSugerida(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Adicionando...' : 'Adicionar às Contas Previstas'}</Btn>}
                </div>;
              })()}
              {mensagem.acaoPendente?.tipo === 'ALTERAR_PROVISAO' && (() => {
                const acao = mensagem.acaoPendente;
                return <div className="assistente-acao">
                  <strong>📌 {acao.rotuloAcao || 'Alteração de Conta Prevista'}</strong>
                  <div className="assistente-acao-grid">
                    <div className="assistente-acao-item"><small>Conta prevista</small><strong>{acao.provisaoDescricao}</strong></div>
                    <div className="assistente-acao-item"><small>Ação</small><strong>{acao.rotuloAcao}</strong></div>
                  </div>
                  <ul className="assistente-acao-detalhes">{(acao.detalhes || []).map((detalhe) => <li key={detalhe}>{detalhe}</li>)}</ul>
                  {acao.confirmada
                    ? <span className="assistente-acao-confirmada">✅ Alteração aplicada</span>
                    : <Btn variant={acao.acao === 'CANCELAR' ? 'danger' : 'primary'} size="sm" onClick={() => confirmarAlteracaoProvisaoSugerida(acao, indice)} disabled={acaoSalvandoIndice !== null}>{acaoSalvandoIndice === indice ? 'Aplicando...' : (acao.rotuloAcao || 'Aplicar alteração')}</Btn>}
                </div>;
              })()}`
);

app = trocar(
  app,
  'disclaimer previsoes',
  `A IA consulta dados por ferramentas autorizadas e não recebe acesso direto ao banco. Ela pode preparar criação ou alteração de Compra Programada, mas nenhuma gravação ocorre automaticamente: o app só executa depois de você clicar na ação e confirmar no modal.`,
  `A IA consulta dados por ferramentas autorizadas e não recebe acesso direto ao banco. Ela pode preparar ações em Compras Programadas e Contas Previstas, mas nenhuma gravação ocorre automaticamente: o app só executa depois de você clicar na ação e confirmar no modal. Contas Previstas só viram realizadas por conciliação com uma transação real.`
);

fs.writeFileSync(appPath, app);
console.log('Transformação do Assistente para Contas Previstas aplicada.');
