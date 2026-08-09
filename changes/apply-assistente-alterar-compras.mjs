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

const ferramentaAlteracao = `async function ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args = {}) {
  const termo = String(args.termo || '').trim();
  const acao = String(args.acao || '').trim().toUpperCase();
  const novaDescricao = String(args.novaDescricao || '').trim();
  const novoValorEstimado = Number(args.novoValorEstimado || 0);
  const novaDataInformada = String(args.novaData || '').trim();
  const adiarMeses = Number(args.adiarMeses || 0);
  const novaPrioridade = String(args.novaPrioridade || 'MANTER').trim().toUpperCase();
  const novaFormaPagamento = String(args.novaFormaPagamento || 'MANTER').trim().toUpperCase();
  const novasParcelas = Number(args.novasParcelas || 0);
  const acoesPermitidas = ['ADIAR', 'EDITAR', 'MARCAR_COMPRADA', 'CANCELAR'];

  if (!termo) return { encontrada: false, motivo: 'Informe a descrição ou parte do nome da compra programada.' };
  if (!acoesPermitidas.includes(acao)) return { encontrada: false, motivo: 'Ação de compra programada inválida.' };

  const comprasResult = await pool.query(
    \`SELECT id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas, status, observacao
     FROM compras_programadas
     WHERE usuario_id = $1
       AND status IN ('PLANEJADA', 'ADIADA')
       AND LOWER(descricao) LIKE LOWER($2)
     ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, data_desejada ASC
     LIMIT 5\`,
    [usuarioId, \`%\${termo}%\`, termo]
  );

  if (comprasResult.rows.length === 0) {
    return { encontrada: false, motivo: \`Nenhuma compra programada ativa corresponde a "\${termo}".\` };
  }

  if (comprasResult.rows.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma compra correspondente. Peça ao usuário para indicar qual delas deseja alterar.',
      opcoes: comprasResult.rows.map((item) => ({
        descricao: item.descricao,
        valorEstimado: Number(item.valor_estimado || 0),
        dataDesejada: String(item.data_desejada || '').slice(0, 10),
        status: item.status,
      })),
    };
  }

  const compra = comprasResult.rows[0];
  const payload = {};
  const detalhes = [];
  const hoje = new Date().toISOString().slice(0, 10);
  const dataAtual = String(compra.data_desejada || '').slice(0, 10);
  const formatarDataAcao = (data) => {
    const [ano, mes, dia] = String(data || '').slice(0, 10).split('-');
    return ano && mes && dia ? \`\${dia}/\${mes}/\${ano}\` : String(data || '');
  };
  const formatarMoedaAcao = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const rotuloPagamento = (forma, parcelas) => forma === 'PARCELADO' ? \`\${Number(parcelas || 1)}x\` : 'À vista';
  const adicionarMesesData = (dataIso, quantidade) => {
    const [ano, mes, dia] = String(dataIso || '').slice(0, 10).split('-').map(Number);
    if (![ano, mes, dia].every(Number.isFinite)) return null;
    const indice = (ano * 12) + (mes - 1) + quantidade;
    const novoAno = Math.floor(indice / 12);
    const novoMes = indice % 12;
    const ultimoDia = new Date(Date.UTC(novoAno, novoMes + 1, 0)).getUTCDate();
    return \`\${novoAno}-\${String(novoMes + 1).padStart(2, '0')}-\${String(Math.min(dia, ultimoDia)).padStart(2, '0')}\`;
  };

  if (acao === 'ADIAR') {
    let novaData = novaDataInformada ? normalizarDataImportacao(novaDataInformada) : null;
    if (!novaData && Number.isInteger(adiarMeses) && adiarMeses > 0) novaData = adicionarMesesData(dataAtual || hoje, adiarMeses);
    if (!novaData) return { encontrada: true, preparada: false, motivo: 'Informe a nova data ou por quantos meses deseja adiar.' };
    if (novaData < hoje) return { encontrada: true, preparada: false, motivo: 'A nova data não pode estar no passado.' };
    if (dataAtual && novaData <= dataAtual) return { encontrada: true, preparada: false, motivo: 'Para adiar, a nova data deve ser posterior à data atual da compra.' };
    payload.dataDesejada = novaData;
    payload.status = 'ADIADA';
    detalhes.push(\`Data: \${formatarDataAcao(dataAtual)} → \${formatarDataAcao(novaData)}\`);
    if (compra.status !== 'ADIADA') detalhes.push(\`Status: \${compra.status} → ADIADA\`);
  }

  if (acao === 'MARCAR_COMPRADA') {
    payload.status = 'COMPRADA';
    detalhes.push(\`Status: \${compra.status} → COMPRADA\`);
  }

  if (acao === 'CANCELAR') {
    payload.status = 'CANCELADA';
    detalhes.push(\`Status: \${compra.status} → CANCELADA\`);
  }

  if (acao === 'EDITAR') {
    if (novaDescricao && novaDescricao !== compra.descricao) {
      payload.descricao = novaDescricao;
      detalhes.push(\`Descrição: \${compra.descricao} → \${novaDescricao}\`);
    }
    if (Number.isFinite(novoValorEstimado) && novoValorEstimado > 0 && novoValorEstimado !== Number(compra.valor_estimado || 0)) {
      payload.valorEstimado = novoValorEstimado;
      detalhes.push(\`Valor: \${formatarMoedaAcao(compra.valor_estimado)} → \${formatarMoedaAcao(novoValorEstimado)}\`);
    }
    if (novaDataInformada) {
      const novaData = normalizarDataImportacao(novaDataInformada);
      if (!novaData) return { encontrada: true, preparada: false, motivo: 'A nova data informada é inválida.' };
      if (novaData < hoje) return { encontrada: true, preparada: false, motivo: 'A nova data não pode estar no passado.' };
      if (novaData !== dataAtual) {
        payload.dataDesejada = novaData;
        detalhes.push(\`Data: \${formatarDataAcao(dataAtual)} → \${formatarDataAcao(novaData)}\`);
      }
    }
    if (novaPrioridade !== 'MANTER') {
      if (!PRIORIDADES_COMPRA.includes(novaPrioridade)) return { encontrada: true, preparada: false, motivo: 'Nova prioridade inválida.' };
      if (novaPrioridade !== compra.prioridade) {
        payload.prioridade = novaPrioridade;
        detalhes.push(\`Prioridade: \${compra.prioridade} → \${novaPrioridade}\`);
      }
    }
    if (novaFormaPagamento !== 'MANTER') {
      if (!FORMAS_PAGAMENTO_COMPRA.includes(novaFormaPagamento)) return { encontrada: true, preparada: false, motivo: 'Nova forma de pagamento inválida.' };
      if (novaFormaPagamento === 'A_VISTA') {
        if (compra.forma_pagamento !== 'A_VISTA' || Number(compra.parcelas || 1) !== 1) {
          payload.formaPagamento = 'A_VISTA';
          payload.parcelas = 1;
          detalhes.push(\`Pagamento: \${rotuloPagamento(compra.forma_pagamento, compra.parcelas)} → À vista\`);
        }
      } else {
        const parcelas = Number.isInteger(novasParcelas) && novasParcelas >= 2 ? novasParcelas : (compra.forma_pagamento === 'PARCELADO' ? Number(compra.parcelas || 0) : 0);
        if (!Number.isInteger(parcelas) || parcelas < 2 || parcelas > 60) return { encontrada: true, preparada: false, motivo: 'Informe pelo menos 2 parcelas para pagamento parcelado.' };
        if (compra.forma_pagamento !== 'PARCELADO' || Number(compra.parcelas || 1) !== parcelas) {
          payload.formaPagamento = 'PARCELADO';
          payload.parcelas = parcelas;
          detalhes.push(\`Pagamento: \${rotuloPagamento(compra.forma_pagamento, compra.parcelas)} → \${parcelas}x\`);
        }
      }
    } else if (Number.isInteger(novasParcelas) && novasParcelas > 0) {
      if (compra.forma_pagamento !== 'PARCELADO') return { encontrada: true, preparada: false, motivo: 'Para alterar parcelas de uma compra à vista, informe também a nova forma de pagamento como PARCELADO.' };
      if (novasParcelas < 2 || novasParcelas > 60) return { encontrada: true, preparada: false, motivo: 'Quantidade de parcelas inválida.' };
      if (novasParcelas !== Number(compra.parcelas || 0)) {
        payload.parcelas = novasParcelas;
        detalhes.push(\`Pagamento: \${rotuloPagamento(compra.forma_pagamento, compra.parcelas)} → \${novasParcelas}x\`);
      }
    }
    if (detalhes.length === 0) return { encontrada: true, preparada: false, motivo: 'Nenhuma alteração diferente dos dados atuais foi informada.' };
  }

  const rotulosAcao = {
    ADIAR: 'Adiar compra',
    EDITAR: 'Editar compra',
    MARCAR_COMPRADA: 'Marcar como comprada',
    CANCELAR: 'Cancelar compra',
  };

  return {
    encontrada: true,
    preparada: true,
    acao,
    rotuloAcao: rotulosAcao[acao],
    compra: {
      descricao: compra.descricao,
      valorEstimado: Number(compra.valor_estimado || 0),
      dataDesejada: dataAtual,
      prioridade: compra.prioridade,
      formaPagamento: compra.forma_pagamento,
      parcelas: Number(compra.parcelas || 1),
      status: compra.status,
    },
    alteracoes: detalhes,
    requerConfirmacao: true,
    _acaoPendente: {
      tipo: 'ALTERAR_COMPRA_PROGRAMADA',
      compraId: compra.id,
      acao,
      rotuloAcao: rotulosAcao[acao],
      compraDescricao: compra.descricao,
      payload,
      detalhes,
    },
  };
}

`;
backend = backend.slice(0, indiceFerramentas) + ferramentaAlteracao + backend.slice(indiceFerramentas);

backend = trocar(
  backend,
  'declaracao ferramenta de alteracao',
  `  {
    type: 'function',
    name: 'contas_previstas_por_mes',`,
  `  {
    type: 'function',
    name: 'preparar_alteracao_compra_programada',
    description: 'Prepara, sem gravar, uma alteração em uma Compra Programada existente. Use para adiar, editar dados, marcar como comprada ou cancelar. A alteração só será aplicada depois de confirmação explícita no frontend.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Descrição ou parte do nome da compra programada.' },
        acao: { type: 'string', enum: ['ADIAR', 'EDITAR', 'MARCAR_COMPRADA', 'CANCELAR'] },
        novaDescricao: { type: 'string', description: 'Nova descrição. Use string vazia quando não alterar.' },
        novoValorEstimado: { type: 'number', minimum: 0, description: 'Novo valor total em BRL. Use 0 quando não alterar.' },
        novaData: { type: 'string', description: 'Nova data no formato AAAA-MM-DD. Use string vazia quando não alterar ou quando usar adiarMeses.' },
        adiarMeses: { type: 'integer', minimum: 0, maximum: 12, description: 'Quantidade de meses para adiar. Use 0 quando não aplicável.' },
        novaPrioridade: { type: 'string', enum: ['MANTER', 'BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'] },
        novaFormaPagamento: { type: 'string', enum: ['MANTER', 'A_VISTA', 'PARCELADO'] },
        novasParcelas: { type: 'integer', minimum: 0, maximum: 60, description: 'Nova quantidade de parcelas. Use 0 quando não alterar.' },
      },
      required: ['termo', 'acao', 'novaDescricao', 'novoValorEstimado', 'novaData', 'adiarMeses', 'novaPrioridade', 'novaFormaPagamento', 'novasParcelas'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'contas_previstas_por_mes',`
);

backend = trocar(
  backend,
  'rotulo ferramenta alteracao',
  `  planejar_compra_hipotetica: 'planejamento de nova compra',`,
  `  planejar_compra_hipotetica: 'planejamento de nova compra',
  preparar_alteracao_compra_programada: 'alteração de compra programada',`
);

backend = trocar(
  backend,
  'dispatcher ferramenta alteracao',
  `  if (nome === 'planejar_compra_hipotetica') return ferramentaPlanejarCompraHipotetica(usuarioId, args);`,
  `  if (nome === 'planejar_compra_hipotetica') return ferramentaPlanejarCompraHipotetica(usuarioId, args);
  if (nome === 'preparar_alteracao_compra_programada') return ferramentaPrepararAlteracaoCompraProgramada(usuarioId, args);`
);

backend = trocar(
  backend,
  'instrucoes de alteracao',
  `Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados. Você pode preparar uma proposta estruturada de Compra Programada, mas a gravação só ocorre depois de confirmação explícita do usuário na interface.
Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar sobre uma compra que já está cadastrada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use comparar_cenarios_compra_programada antes de recomendar. Se ele estiver planejando uma compra nova que ainda não está cadastrada, use obrigatoriamente planejar_compra_hipotetica. Se faltarem descrição, valor ou prazo/data limite, peça esses dados antes de planejar. Na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12.`,
  `Você não pode alterar dados diretamente. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados. Você pode preparar propostas estruturadas de criação ou alteração de Compra Programada, mas qualquer gravação só ocorre depois de confirmação explícita do usuário na interface.
Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar sobre uma compra que já está cadastrada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use comparar_cenarios_compra_programada antes de recomendar. Se ele estiver planejando uma compra nova que ainda não está cadastrada, use obrigatoriamente planejar_compra_hipotetica. Se o usuário pedir para adiar, editar, marcar como comprada ou cancelar uma compra programada existente, use obrigatoriamente preparar_alteracao_compra_programada. Para campos que não serão alterados nessa ferramenta, use os sentinelas indicados no schema, como string vazia, 0 ou MANTER. Se faltarem dados indispensáveis para a alteração, peça-os antes de preparar. Se faltarem descrição, valor ou prazo/data limite para uma compra nova, peça esses dados antes de planejar. Na ausência de reserva mínima use 0, na ausência de prioridade use MEDIA e na ausência de limite de parcelas use 12.`
);

backend = trocar(
  backend,
  'sanitizacao de acao interna',
  `      for (const chamada of chamadas) {
        const resultado = await executarFerramentaAssistente(usuarioId, chamada.name, chamada.args || {});
        ferramentasUsadas.add(chamada.name);
        if (chamada.name === 'planejar_compra_hipotetica' && resultado?.propostaCadastro) {`,
  `      for (const chamada of chamadas) {
        const resultadoBruto = await executarFerramentaAssistente(usuarioId, chamada.name, chamada.args || {});
        const resultado = resultadoBruto && typeof resultadoBruto === 'object' && !Array.isArray(resultadoBruto) ? { ...resultadoBruto } : resultadoBruto;
        ferramentasUsadas.add(chamada.name);
        if (resultado?._acaoPendente) {
          acaoPendente = resultado._acaoPendente;
          delete resultado._acaoPendente;
        }
        if (chamada.name === 'planejar_compra_hipotetica' && resultado?.propostaCadastro) {`
);

fs.writeFileSync(backendPath, backend);

// ---------------- Frontend ----------------
const appPath = 'App.jsx';
let app = fs.readFileSync(appPath, 'utf8');

app = trocar(
  app,
  'boas vindas assistente',
  `    content: 'Sou o assistente financeiro do seu app. Posso consultar seus dados, comparar cenários e preparar uma Compra Programada. Nenhuma compra é criada sem sua confirmação explícita.',`,
  `    content: 'Sou o assistente financeiro do seu app. Posso consultar seus dados, comparar cenários e preparar criação ou alteração de Compras Programadas. Nenhuma mudança é aplicada sem sua confirmação explícita.',`
);

app = trocar(
  app,
  'funcao confirmar alteracao',
  `  return (
    <div className="content-card" style={{ background: 'white', borderRadius: '12px', padding: '24px' }}>`,
  `  const confirmarAlteracaoSugerida = (acao, indice) => {
    if (!acao?.compraId || !acao?.payload || acao.confirmada || acaoSalvandoIndice !== null) return;
    const ehCancelamento = acao.acao === 'CANCELAR';
    pedirConfirmacao(
      acao.rotuloAcao || 'Confirmar alteração',
      \`Aplicar em "\${acao.compraDescricao}"? \${(acao.detalhes || []).join(' • ')}\`,
      async () => {
        setAcaoSalvandoIndice(indice);
        try {
          await axios.patch(\`${'${'}API_URL}/compras-programadas/${'${'}acao.compraId}\`, acao.payload, {
            headers: { Authorization: \`Bearer ${'${'}token}\` },
          });
          setMensagens((atuais) => atuais.map((item, posicao) => posicao === indice
            ? { ...item, acaoPendente: { ...item.acaoPendente, confirmada: true } }
            : item));
          mostrarToast('Compra Programada atualizada.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível atualizar a Compra Programada.', 'erro');
        } finally {
          setAcaoSalvandoIndice(null);
        }
      },
      { labelConfirmar: acao.rotuloAcao || 'Aplicar alteração', corConfirmar: ehCancelamento ? '#dc2626' : '#2563eb' }
    );
  };

  return (
    <div className="content-card" style={{ background: 'white', borderRadius: '12px', padding: '24px' }}>`
);

app = trocar(
  app,
  'css detalhes acao',
  `        .assistente-acao-confirmada { display: inline-flex; align-items: center; gap: 6px; color: #166534; background: #dcfce7; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; }`,
  `        .assistente-acao-confirmada { display: inline-flex; align-items: center; gap: 6px; color: #166534; background: #dcfce7; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; }
        .assistente-acao-detalhes { margin: 10px 0 12px; padding-left: 18px; color: #334155; font-size: 12px; }
        .assistente-acao-detalhes li { margin: 4px 0; }`
);

app = trocar(
  app,
  'render card alteracao',
  `              {mensagem.acaoPendente?.tipo === 'CRIAR_COMPRA_PROGRAMADA' && (() => {
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
              })()}`,
  `              {mensagem.acaoPendente?.tipo === 'CRIAR_COMPRA_PROGRAMADA' && (() => {
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
              {mensagem.acaoPendente?.tipo === 'ALTERAR_COMPRA_PROGRAMADA' && (() => {
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
              })()}`
);

app = trocar(
  app,
  'disclaimer alteracoes',
  `        <div className="assistente-disclaimer">A IA consulta dados por ferramentas autorizadas e não recebe acesso direto ao banco. Ela pode preparar uma sugestão de Compra Programada, mas nenhuma gravação ocorre automaticamente: o app só cadastra após você clicar em adicionar e confirmar no modal. O assistente usa o nível gratuito do Gemini; nesse nível, o Google informa que o conteúdo enviado pode ser usado para melhorar seus produtos.</div>`,
  `        <div className="assistente-disclaimer">A IA consulta dados por ferramentas autorizadas e não recebe acesso direto ao banco. Ela pode preparar criação ou alteração de Compra Programada, mas nenhuma gravação ocorre automaticamente: o app só executa depois de você clicar na ação e confirmar no modal. O assistente usa o nível gratuito do Gemini; nesse nível, o Google informa que o conteúdo enviado pode ser usado para melhorar seus produtos.</div>`
);

fs.writeFileSync(appPath, app);
console.log('Assistente com alterações confirmadas de Compras Programadas aplicado.');
