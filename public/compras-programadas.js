(() => {
  const STORAGE_PREFIX = 'app-financas:compras-programadas:v1';
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const STATUS = ['IDEIA', 'PESQUISANDO', 'EM_ANALISE', 'PLANEJADA', 'APROVADA', 'COMPRADA', 'ADIADA', 'CANCELADA'];
  const PRIORIDADES = ['BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'];
  const FORMAS = ['A_VISTA', 'PARCELADO', 'CARTAO', 'BOLETO', 'PIX', 'INDEFINIDO'];
  const FLEXIBILIDADES = ['AGORA', 'PODE_ESPERAR', 'SE_COUBER', 'ESSENCIAL'];

  const labels = {
    IDEIA: 'Ideia', PESQUISANDO: 'Pesquisando', EM_ANALISE: 'Em análise', PLANEJADA: 'Planejada', APROVADA: 'Aprovada', COMPRADA: 'Comprada', ADIADA: 'Adiada', CANCELADA: 'Cancelada',
    BAIXA: 'Baixa', MEDIA: 'Média', ALTA: 'Alta', ESSENCIAL: 'Essencial',
    A_VISTA: 'À vista', PARCELADO: 'Parcelado', CARTAO: 'Cartão de crédito', BOLETO: 'Boleto', PIX: 'Pix', INDEFINIDO: 'Ainda não definido',
    AGORA: 'Posso comprar agora', PODE_ESPERAR: 'Posso esperar alguns meses', SE_COUBER: 'Só quero se couber no orçamento',
    COMPRAR_AGORA: 'Comprar agora', MELHOR_ADIAR: 'Melhor adiar', MELHOR_PARCELAR: 'Melhor parcelar', NAO_RECOMENDADO: 'Não recomendado', FALTA_INFORMACAO: 'Falta informação',
    BAIXO: 'Baixo', MEDIO: 'Médio', ALTO: 'Alto'
  };

  const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
  const currentDate = new Date();
  const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function getUserKey() {
    try {
      const usuario = JSON.parse(localStorage.getItem('usuario') || '{}');
      return `${STORAGE_PREFIX}:${usuario.id || usuario.email || 'local'}`;
    } catch {
      return `${STORAGE_PREFIX}:local`;
    }
  }

  function readItems() {
    try {
      return JSON.parse(localStorage.getItem(getUserKey()) || '[]');
    } catch {
      return [];
    }
  }

  function writeItems(items) {
    localStorage.setItem(getUserKey(), JSON.stringify(items));
  }

  function normalizeNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const text = String(value || '').trim().replace(/R\$/gi, '').replace(/\s/g, '');
    if (!text) return 0;
    const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }

  function addMonths(mes, ano, offset) {
    const date = new Date(Number(ano), Number(mes) - 1 + offset, 1);
    return { mes: date.getMonth() + 1, ano: date.getFullYear(), label: `${MESES[date.getMonth()]}/${String(date.getFullYear()).slice(2)}` };
  }

  function monthKey(mes, ano) {
    return `${ano}-${String(mes).padStart(2, '0')}`;
  }

  function paymentImpact(item, startMes = Number(item.mes_desejado), startAno = Number(item.ano_desejado)) {
    const value = normalizeNumber(item.valor_estimado);
    const entrada = Math.max(0, normalizeNumber(item.valor_entrada));
    const juros = Math.max(0, normalizeNumber(item.juros_percentual));
    const parcelas = Math.max(1, Number(item.quantidade_parcelas || 1));
    const total = Math.max(0, value - entrada) * (1 + juros / 100);
    const impact = new Map();
    const forma = item.forma_pagamento || 'INDEFINIDO';

    if (entrada > 0) impact.set(monthKey(startMes, startAno), entrada);

    if (forma === 'PARCELADO' || forma === 'CARTAO') {
      const parcela = total / parcelas;
      for (let i = 0; i < parcelas; i += 1) {
        const m = addMonths(startMes, startAno, i);
        const key = monthKey(m.mes, m.ano);
        impact.set(key, (impact.get(key) || 0) + parcela);
      }
    } else {
      const key = monthKey(startMes, startAno);
      impact.set(key, (impact.get(key) || 0) + total);
    }

    return impact;
  }

  async function loadPlanningSummary(mes, ano, quantidadeMeses = 12) {
    const token = localStorage.getItem('token');
    if (!token) return [];
    try {
      const response = await fetch(`/api/planejamento/resumo-mensal?mesInicio=${mes}&anoInicio=${ano}&quantidadeMeses=${quantidadeMeses}&tipo=TODOS&recorrencia=TODAS&categoria=`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.meses || [];
    } catch {
      return [];
    }
  }

  function analyzeItem(item, planejamento = []) {
    const value = normalizeNumber(item.valor_estimado);
    if (!item.descricao || !value || !item.mes_desejado || !item.ano_desejado) {
      return {
        recomendacao_status: 'FALTA_INFORMACAO',
        risco: 'MEDIO',
        texto: 'Cadastre descrição, valor estimado e mês desejado para uma análise mais segura.',
        melhor_mes_sugerido: item.mes_desejado || currentDate.getMonth() + 1,
        melhor_ano_sugerido: item.ano_desejado || currentDate.getFullYear(),
        impacto_mensal_estimado: 0
      };
    }

    const meses = planejamento.length > 0
      ? planejamento.map((m) => ({ mes: Number(m.mes), ano: Number(m.ano), label: m.label || `${MESES[Number(m.mes) - 1]}/${String(m.ano).slice(2)}`, planejado: Number(m.total_previsto || 0) }))
      : Array.from({ length: 12 }, (_, i) => ({ ...addMonths(Number(item.mes_desejado), Number(item.ano_desejado), i), planejado: 0 }));

    const media = meses.reduce((sum, m) => sum + m.planejado, 0) / Math.max(1, meses.length);
    let melhor = null;

    meses.forEach((candidate) => {
      const impact = paymentImpact(item, candidate.mes, candidate.ano);
      const totalImpacto = Array.from(impact.values()).reduce((sum, v) => sum + v, 0);
      const mesesImpactados = meses.map((m) => {
        const inc = impact.get(monthKey(m.mes, m.ano)) || 0;
        return { ...m, impacto: inc, novoTotal: m.planejado + inc };
      });
      const pico = Math.max(...mesesImpactados.map((m) => m.novoTotal), 0);
      const score = pico + totalImpacto * 0.05 + candidate.planejado * 0.1;
      if (!melhor || score < melhor.score) melhor = { ...candidate, score, totalImpacto, mesesImpactados };
    });

    const desejadoImpact = paymentImpact(item);
    const desiredKey = monthKey(item.mes_desejado, item.ano_desejado);
    const desiredMonth = meses.find((m) => monthKey(m.mes, m.ano) === desiredKey) || { planejado: 0, label: `${MESES[Number(item.mes_desejado) - 1]}/${String(item.ano_desejado).slice(2)}` };
    const impactoDesejado = desejadoImpact.get(desiredKey) || Array.from(desejadoImpact.values())[0] || 0;
    const novoTotalDesejado = desiredMonth.planejado + impactoDesejado;

    const essential = item.prioridade === 'ESSENCIAL' || item.flexibilidade === 'ESSENCIAL';
    const canWait = item.flexibilidade === 'PODE_ESPERAR' || item.flexibilidade === 'SE_COUBER' || item.prioridade === 'BAIXA';
    const formaParcelada = item.forma_pagamento === 'PARCELADO' || item.forma_pagamento === 'CARTAO';
    const impactoRelativo = media > 0 ? novoTotalDesejado / Math.max(media, 1) : (impactoDesejado > 0 ? 1.5 : 0);

    let status = 'COMPRAR_AGORA';
    let risco = 'BAIXO';
    let texto = `Compra parece viável no mês desejado (${desiredMonth.label}). Impacto estimado: ${money(impactoDesejado)}.`;

    if (!essential && canWait && impactoRelativo > 1.25 && melhor) {
      status = 'MELHOR_ADIAR';
      risco = impactoRelativo > 1.6 ? 'ALTO' : 'MEDIO';
      texto = `Melhor adiar. O mês desejado fica pesado com a compra. Sugestão: ${melhor.label}, que apresenta menor pressão no planejamento atual.`;
    } else if (!formaParcelada && value > Math.max(800, media * 0.35) && item.forma_pagamento !== 'PIX') {
      status = 'MELHOR_PARCELAR';
      risco = 'MEDIO';
      texto = `Compra possível, mas o valor é relevante para o fluxo. Avalie parcelar para reduzir o impacto mensal.`;
    } else if (!essential && impactoRelativo > 1.6) {
      status = 'NAO_RECOMENDADO';
      risco = 'ALTO';
      texto = `Não recomendado comprar no mês desejado. O impacto pode pressionar seu fluxo de caixa. Sugestão: revisar prioridade, parcelamento ou adiar.`;
    }

    if (essential && impactoRelativo > 1.35) {
      status = formaParcelada ? 'MELHOR_PARCELAR' : 'COMPRAR_AGORA';
      risco = 'MEDIO';
      texto = `Compra essencial. Cabe tratar como prioridade, mas com atenção ao impacto de ${money(impactoDesejado)} no mês desejado.`;
    }

    const parcelaSugerida = formaParcelada ? (Math.max(0, value - normalizeNumber(item.valor_entrada)) * (1 + normalizeNumber(item.juros_percentual) / 100)) / Math.max(1, Number(item.quantidade_parcelas || 1)) : impactoDesejado;

    return {
      recomendacao_status: status,
      risco,
      texto,
      melhor_mes_sugerido: melhor?.mes || Number(item.mes_desejado),
      melhor_ano_sugerido: melhor?.ano || Number(item.ano_desejado),
      melhor_forma_pagamento: status === 'MELHOR_PARCELAR' ? 'PARCELADO' : item.forma_pagamento,
      parcela_sugerida: parcelaSugerida,
      impacto_mensal_estimado: impactoDesejado,
      simulacao: (melhor?.mesesImpactados || meses.map((m) => ({ ...m, impacto: desiredKey === monthKey(m.mes, m.ano) ? impactoDesejado : 0, novoTotal: m.planejado + (desiredKey === monthKey(m.mes, m.ano) ? impactoDesejado : 0) }))).slice(0, 12)
    };
  }

  function injectStyles() {
    if (document.getElementById('compras-programadas-styles')) return;
    const style = document.createElement('style');
    style.id = 'compras-programadas-styles';
    style.textContent = `
      .cp-trigger { position: fixed; right: 22px; bottom: 22px; z-index: 900; border: none; border-radius: 999px; padding: 13px 18px; background: #111827; color: white; font-weight: 800; box-shadow: 0 18px 40px rgba(15,23,42,.28); cursor: pointer; }
      .cp-panel { position: fixed; inset: 0; z-index: 1200; background: #f8fafc; color: #0f172a; overflow: auto; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .cp-wrap { max-width: 1220px; margin: 0 auto; padding: 24px; }
      .cp-header { background: linear-gradient(135deg, #111827, #2563eb); color: white; border-radius: 24px; padding: 26px; box-shadow: 0 20px 60px rgba(15,23,42,.18); display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .cp-header h1 { margin: 0; font-size: 30px; }
      .cp-header p { margin: 8px 0 0; color: #dbeafe; max-width: 760px; }
      .cp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
      .cp-card { background: white; border: 1px solid #e2e8f0; border-radius: 18px; padding: 18px; box-shadow: 0 8px 30px rgba(15,23,42,.06); }
      .cp-card h2, .cp-card h3 { margin-top: 0; }
      .cp-kpi strong { display: block; font-size: 24px; margin-top: 6px; }
      .cp-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
      .cp-form label, .cp-filter label { display: grid; gap: 6px; color: #475569; font-size: 13px; font-weight: 700; }
      .cp-form input, .cp-form select, .cp-form textarea, .cp-filter input, .cp-filter select { border: 1px solid #cbd5e1; border-radius: 10px; padding: 11px; font: inherit; background: white; }
      .cp-btn { border: none; border-radius: 10px; padding: 10px 13px; font-weight: 800; cursor: pointer; }
      .cp-primary { background: #2563eb; color: white; }
      .cp-secondary { background: #e2e8f0; color: #0f172a; }
      .cp-danger { background: #fee2e2; color: #991b1b; }
      .cp-table-wrap { overflow-x: auto; }
      .cp-table { width: 100%; border-collapse: collapse; min-width: 920px; }
      .cp-table th { text-align: left; background: #f1f5f9; color: #475569; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
      .cp-table th, .cp-table td { padding: 11px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
      .cp-pill { display: inline-flex; border-radius: 999px; padding: 4px 8px; font-size: 12px; font-weight: 800; background: #eff6ff; color: #1d4ed8; }
      .cp-risk-BAIXO { background: #dcfce7; color: #166534; } .cp-risk-MEDIO { background: #fef3c7; color: #92400e; } .cp-risk-ALTO { background: #fee2e2; color: #991b1b; }
      .cp-sim-row { display: grid; grid-template-columns: 90px 1fr 1fr 1fr; gap: 8px; align-items: center; font-size: 13px; }
      .cp-bar { height: 8px; border-radius: 999px; background: #e2e8f0; overflow: hidden; } .cp-bar span { display: block; height: 100%; background: #2563eb; }
      @media (max-width: 720px) { .cp-wrap { padding: 14px; } .cp-header h1 { font-size: 24px; } .cp-trigger { left: 14px; right: 14px; bottom: 14px; } }
    `;
    document.head.appendChild(style);
  }

  function render() {
    injectStyles();
    let panel = document.getElementById('compras-programadas-panel');
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'compras-programadas-panel';
    panel.className = 'cp-panel';
    document.body.appendChild(panel);

    const state = { items: readItems(), filtros: { status: '', prioridade: '', categoria: '', mes: '', ano: '', forma: '', flexibilidade: '' }, editingId: null, planejamento: [] };

    const initialForm = () => ({
      descricao: '', categoria: '', valor_estimado: '', mes_desejado: String(currentDate.getMonth() + 1), ano_desejado: String(currentDate.getFullYear()), prioridade: 'MEDIA', status: 'IDEIA', forma_pagamento: 'INDEFINIDO', quantidade_parcelas: '', valor_entrada: '', juros_percentual: '', flexibilidade: 'SE_COUBER', observacao: ''
    });
    let form = initialForm();

    const setFormFromItem = (item) => {
      form = { ...initialForm(), ...item, valor_estimado: String(item.valor_estimado || ''), quantidade_parcelas: item.quantidade_parcelas || '', valor_entrada: item.valor_entrada || '', juros_percentual: item.juros_percentual || '' };
      state.editingId = item.id;
      draw();
      panel.querySelector('#cp-form-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const save = async (event) => {
      event.preventDefault();
      const payload = {
        ...form,
        id: state.editingId || uid(),
        valor_estimado: normalizeNumber(form.valor_estimado),
        quantidade_parcelas: form.quantidade_parcelas ? Number(form.quantidade_parcelas) : null,
        valor_entrada: normalizeNumber(form.valor_entrada),
        juros_percentual: normalizeNumber(form.juros_percentual),
        atualizado_em: new Date().toISOString(),
        criado_em: state.editingId ? (state.items.find((i) => i.id === state.editingId)?.criado_em || new Date().toISOString()) : new Date().toISOString()
      };
      if (!payload.descricao || payload.valor_estimado <= 0) {
        alert('Informe descrição e valor estimado maior que zero.');
        return;
      }
      payload.analise = analyzeItem(payload, state.planejamento);
      state.items = state.editingId ? state.items.map((item) => item.id === state.editingId ? payload : item) : [payload, ...state.items];
      writeItems(state.items);
      state.editingId = null;
      form = initialForm();
      draw();
    };

    const runAnalysis = async (item) => {
      const base = await loadPlanningSummary(Number(item.mes_desejado), Number(item.ano_desejado), 12);
      state.planejamento = base;
      const analyzed = { ...item, analise: analyzeItem(item, base), status: item.status === 'IDEIA' ? 'EM_ANALISE' : item.status, atualizado_em: new Date().toISOString() };
      state.items = state.items.map((i) => i.id === item.id ? analyzed : i);
      writeItems(state.items);
      draw();
    };

    const filteredItems = () => state.items.filter((item) => {
      const f = state.filtros;
      return (!f.status || item.status === f.status) && (!f.prioridade || item.prioridade === f.prioridade) && (!f.categoria || String(item.categoria || '').toLowerCase().includes(f.categoria.toLowerCase())) && (!f.mes || Number(item.mes_desejado) === Number(f.mes)) && (!f.ano || Number(item.ano_desejado) === Number(f.ano)) && (!f.forma || item.forma_pagamento === f.forma) && (!f.flexibilidade || item.flexibilidade === f.flexibilidade);
    });

    const field = (key, value) => { form[key] = value; };
    const filter = (key, value) => { state.filtros[key] = value; draw(); };

    function draw() {
      const items = filteredItems();
      const total = items.filter((i) => !['CANCELADA', 'COMPRADA'].includes(i.status)).reduce((sum, item) => sum + normalizeNumber(item.valor_estimado), 0);
      const alta = items.filter((i) => ['ALTA', 'ESSENCIAL'].includes(i.prioridade) && !['CANCELADA', 'COMPRADA'].includes(i.status)).length;
      const emAnalise = items.filter((i) => ['PESQUISANDO', 'EM_ANALISE'].includes(i.status)).length;
      const adiadas = items.filter((i) => i.status === 'ADIADA').length;
      const mesAtual = currentDate.getMonth() + 1;
      const anoAtual = currentDate.getFullYear();
      const desteMes = items.filter((i) => Number(i.mes_desejado) === mesAtual && Number(i.ano_desejado) === anoAtual).length;

      panel.innerHTML = `
        <div class="cp-wrap">
          <div class="cp-header">
            <div><h1>🛒 Compras Programadas</h1><p>Cadastre compras futuras e analise melhor momento, forma de pagamento e impacto no fluxo de caixa antes de assumir o gasto.</p></div>
            <button class="cp-btn cp-secondary" id="cp-close">Voltar ao app</button>
          </div>

          <div class="cp-grid" style="margin: 18px 0;">
            <div class="cp-card cp-kpi">Total estimado<strong>${money(total)}</strong></div>
            <div class="cp-card cp-kpi">Alta prioridade<strong>${alta}</strong></div>
            <div class="cp-card cp-kpi">Este mês<strong>${desteMes}</strong></div>
            <div class="cp-card cp-kpi">Em análise<strong>${emAnalise}</strong></div>
            <div class="cp-card cp-kpi">Adiadas<strong>${adiadas}</strong></div>
          </div>

          <div class="cp-card" id="cp-form-card">
            <h2>${state.editingId ? 'Editar compra programada' : 'Nova compra programada'}</h2>
            <form id="cp-form" class="cp-form">
              <label>Descrição<input name="descricao" value="${escapeHtml(form.descricao)}" placeholder="Ex.: Notebook, celular, passagem" required></label>
              <label>Categoria<input name="categoria" value="${escapeHtml(form.categoria)}" placeholder="Ex.: Tecnologia, Viagem"></label>
              <label>Valor estimado<input name="valor_estimado" value="${escapeHtml(form.valor_estimado)}" placeholder="2500,00" required></label>
              <label>Mês desejado<select name="mes_desejado">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${Number(form.mes_desejado) === i + 1 ? 'selected' : ''}>${i + 1} - ${MESES[i]}</option>`).join('')}</select></label>
              <label>Ano desejado<input name="ano_desejado" type="number" value="${escapeHtml(form.ano_desejado)}" min="2020" max="2100"></label>
              <label>Prioridade<select name="prioridade">${PRIORIDADES.map((value) => `<option value="${value}" ${form.prioridade === value ? 'selected' : ''}>${labels[value]}</option>`).join('')}</select></label>
              <label>Status<select name="status">${STATUS.map((value) => `<option value="${value}" ${form.status === value ? 'selected' : ''}>${labels[value]}</option>`).join('')}</select></label>
              <label>Forma de pagamento<select name="forma_pagamento">${FORMAS.map((value) => `<option value="${value}" ${form.forma_pagamento === value ? 'selected' : ''}>${labels[value]}</option>`).join('')}</select></label>
              <label>Parcelas<input name="quantidade_parcelas" type="number" min="1" value="${escapeHtml(form.quantidade_parcelas || '')}" placeholder="Opcional"></label>
              <label>Entrada<input name="valor_entrada" value="${escapeHtml(form.valor_entrada || '')}" placeholder="Opcional"></label>
              <label>Juros/acréscimo %<input name="juros_percentual" value="${escapeHtml(form.juros_percentual || '')}" placeholder="Opcional"></label>
              <label>Flexibilidade<select name="flexibilidade">${FLEXIBILIDADES.map((value) => `<option value="${value}" ${form.flexibilidade === value ? 'selected' : ''}>${labels[value]}</option>`).join('')}</select></label>
              <label style="grid-column: 1 / -1;">Observação<textarea name="observacao" rows="3">${escapeHtml(form.observacao || '')}</textarea></label>
              <div style="grid-column: 1 / -1; display: flex; gap: 10px; flex-wrap: wrap;"><button class="cp-btn cp-primary" type="submit">${state.editingId ? 'Salvar alterações' : 'Cadastrar compra'}</button><button class="cp-btn cp-secondary" type="button" id="cp-reset">Limpar</button></div>
            </form>
          </div>

          <div class="cp-card cp-filter" style="margin-top: 18px;">
            <h2>Filtros</h2>
            <div class="cp-grid">
              <label>Status<select id="cp-filter-status"><option value="">Todos</option>${STATUS.map((v) => `<option value="${v}" ${state.filtros.status === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label>
              <label>Prioridade<select id="cp-filter-prioridade"><option value="">Todas</option>${PRIORIDADES.map((v) => `<option value="${v}" ${state.filtros.prioridade === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label>
              <label>Categoria<input id="cp-filter-categoria" value="${escapeHtml(state.filtros.categoria)}" placeholder="Buscar categoria"></label>
              <label>Mês<input id="cp-filter-mes" type="number" min="1" max="12" value="${escapeHtml(state.filtros.mes)}"></label>
              <label>Ano<input id="cp-filter-ano" type="number" value="${escapeHtml(state.filtros.ano)}"></label>
              <label>Pagamento<select id="cp-filter-forma"><option value="">Todas</option>${FORMAS.map((v) => `<option value="${v}" ${state.filtros.forma === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label>
              <label>Flexibilidade<select id="cp-filter-flex"><option value="">Todas</option>${FLEXIBILIDADES.map((v) => `<option value="${v}" ${state.filtros.flexibilidade === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label>
            </div>
            <button class="cp-btn cp-secondary" id="cp-clear-filters" style="margin-top: 12px;">Limpar filtros</button>
          </div>

          <div class="cp-card" style="margin-top: 18px;">
            <h2>Lista de compras</h2>
            ${items.length === 0 ? '<p style="color:#64748b;">Nenhuma compra programada encontrada para os filtros atuais.</p>' : renderTable(items)}
          </div>
        </div>
      `;

      bindEvents();
    }

    function renderTable(items) {
      return `<div class="cp-table-wrap"><table class="cp-table"><thead><tr><th>Compra</th><th>Valor</th><th>Previsão</th><th>Prioridade</th><th>Status</th><th>Pagamento</th><th>Recomendação</th><th>Ações</th></tr></thead><tbody>${items.map((item) => {
        const analise = item.analise || analyzeItem(item, state.planejamento);
        return `<tr>
          <td><strong>${escapeHtml(item.descricao)}</strong><br><small>${escapeHtml(item.categoria || 'Sem categoria')}</small>${item.observacao ? `<br><small>${escapeHtml(item.observacao)}</small>` : ''}</td>
          <td>${money(item.valor_estimado)}${item.valor_entrada ? `<br><small>Entrada: ${money(item.valor_entrada)}</small>` : ''}</td>
          <td>${MESES[Number(item.mes_desejado) - 1]}/${item.ano_desejado}</td>
          <td><span class="cp-pill">${labels[item.prioridade] || item.prioridade}</span></td>
          <td>${labels[item.status] || item.status}</td>
          <td>${labels[item.forma_pagamento] || item.forma_pagamento}${item.quantidade_parcelas ? `<br><small>${item.quantidade_parcelas}x de aprox. ${money(analise.parcela_sugerida)}</small>` : ''}</td>
          <td><span class="cp-pill cp-risk-${analise.risco}">${labels[analise.recomendacao_status] || analise.recomendacao_status} · risco ${labels[analise.risco]}</span><br><small>${escapeHtml(analise.texto)}</small>${renderSimulation(analise)}</td>
          <td><div style="display:grid;gap:6px;"><button class="cp-btn cp-primary" data-action="analyze" data-id="${item.id}">Analisar</button><button class="cp-btn cp-secondary" data-action="edit" data-id="${item.id}">Editar</button><button class="cp-btn cp-secondary" data-action="status" data-status="COMPRADA" data-id="${item.id}">Comprada</button><button class="cp-btn cp-secondary" data-action="status" data-status="ADIADA" data-id="${item.id}">Adiar</button><button class="cp-btn cp-danger" data-action="delete" data-id="${item.id}">Excluir</button></div></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
    }

    function renderSimulation(analise) {
      const rows = (analise.simulacao || []).filter((m) => Number(m.impacto || 0) > 0).slice(0, 4);
      if (!rows.length) return '';
      const max = Math.max(...rows.map((m) => Number(m.novoTotal || 0)), 1);
      return `<div style="margin-top:8px;display:grid;gap:5px;">${rows.map((m) => `<div class="cp-sim-row"><strong>${m.label}</strong><span>${money(m.planejado)}</span><span>+ ${money(m.impacto)}</span><div class="cp-bar" title="Novo total: ${money(m.novoTotal)}"><span style="width:${Math.max(4, (Number(m.novoTotal || 0) / max) * 100)}%"></span></div></div>`).join('')}</div>`;
    }

    function bindEvents() {
      panel.querySelector('#cp-close').onclick = () => panel.remove();
      panel.querySelector('#cp-reset').onclick = () => { state.editingId = null; form = initialForm(); draw(); };
      panel.querySelector('#cp-form').onsubmit = save;
      panel.querySelectorAll('#cp-form [name]').forEach((input) => input.addEventListener('input', (event) => field(event.target.name, event.target.value)));
      panel.querySelectorAll('#cp-form select').forEach((input) => input.addEventListener('change', (event) => field(event.target.name, event.target.value)));
      panel.querySelector('#cp-filter-status').onchange = (e) => filter('status', e.target.value);
      panel.querySelector('#cp-filter-prioridade').onchange = (e) => filter('prioridade', e.target.value);
      panel.querySelector('#cp-filter-categoria').oninput = (e) => filter('categoria', e.target.value);
      panel.querySelector('#cp-filter-mes').oninput = (e) => filter('mes', e.target.value);
      panel.querySelector('#cp-filter-ano').oninput = (e) => filter('ano', e.target.value);
      panel.querySelector('#cp-filter-forma').onchange = (e) => filter('forma', e.target.value);
      panel.querySelector('#cp-filter-flex').onchange = (e) => filter('flexibilidade', e.target.value);
      panel.querySelector('#cp-clear-filters').onclick = () => { state.filtros = { status: '', prioridade: '', categoria: '', mes: '', ano: '', forma: '', flexibilidade: '' }; draw(); };
      panel.querySelectorAll('[data-action]').forEach((button) => {
        button.onclick = async () => {
          const id = button.getAttribute('data-id');
          const item = state.items.find((i) => i.id === id);
          if (!item) return;
          const action = button.getAttribute('data-action');
          if (action === 'edit') return setFormFromItem(item);
          if (action === 'delete') {
            if (confirm(`Excluir "${item.descricao}"?`)) {
              state.items = state.items.filter((i) => i.id !== id);
              writeItems(state.items);
              draw();
            }
            return;
          }
          if (action === 'status') {
            const status = button.getAttribute('data-status');
            state.items = state.items.map((i) => i.id === id ? { ...i, status, atualizado_em: new Date().toISOString() } : i);
            writeItems(state.items);
            draw();
            return;
          }
          if (action === 'analyze') await runAnalysis(item);
        };
      });
    }

    draw();
    loadPlanningSummary(currentDate.getMonth() + 1, currentDate.getFullYear(), 12).then((data) => { state.planejamento = data; draw(); });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  }

  function ensureTrigger() {
    if (document.getElementById('compras-programadas-trigger')) return;
    injectStyles();
    const button = document.createElement('button');
    button.id = 'compras-programadas-trigger';
    button.className = 'cp-trigger';
    button.type = 'button';
    button.textContent = '🛒 Compras Programadas';
    button.onclick = render;
    document.body.appendChild(button);
  }

  function init() {
    const hasRoot = document.getElementById('root');
    if (!hasRoot) return;
    ensureTrigger();
  }

  window.addEventListener('load', init);
  setTimeout(init, 1200);
})();
