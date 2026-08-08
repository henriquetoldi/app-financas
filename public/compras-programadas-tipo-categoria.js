(() => {
  const STYLE_ID = 'compras-programadas-tipo-categoria-styles';
  const STATE = {
    categorias: [],
    carregando: false,
    tipoSelecionado: 'DESPESA',
    categoriaSelecionada: '',
    categoriaNova: '',
  };

  const normalizarTipo = (tipo) => {
    const value = String(tipo || '').toUpperCase();
    if (['RECEITA', 'ENTRADA', 'CREDITO', 'CRÉDITO'].includes(value)) return 'RECEITA';
    return 'DESPESA';
  };

  const labelTipo = (tipo) => normalizarTipo(tipo) === 'RECEITA' ? 'Entrada / Receita' : 'Saída / Despesa';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .cp-category-enhanced { display: grid; grid-template-columns: minmax(150px, .75fr) minmax(220px, 1.25fr); gap: 10px; align-items: end; }
      .cp-category-new { grid-column: 1 / -1; display: none; grid-template-columns: 1fr auto; gap: 10px; align-items: end; }
      .cp-category-new.is-open { display: grid; }
      .cp-category-hint { grid-column: 1 / -1; color: #64748b; font-size: 12px; margin-top: -2px; }
      @media (max-width: 760px) {
        .cp-category-enhanced, .cp-category-new { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  function getToken() {
    return localStorage.getItem('token') || '';
  }

  async function carregarCategorias() {
    if (STATE.carregando || STATE.categorias.length) return STATE.categorias;
    const token = getToken();
    if (!token) return [];
    STATE.carregando = true;
    try {
      const response = await fetch('/api/categorias', { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return [];
      const data = await response.json();
      STATE.categorias = (data.categorias || []).filter((cat) => cat.ativa !== false);
      return STATE.categorias;
    } catch {
      return [];
    } finally {
      STATE.carregando = false;
    }
  }

  function filtrarCategorias() {
    return STATE.categorias
      .filter((cat) => normalizarTipo(cat.tipo) === STATE.tipoSelecionado)
      .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  }

  function montarOpcoesCategorias() {
    const categorias = filtrarCategorias();
    const macros = categorias.filter((cat) => !cat.categoria_pai_id && (cat.nivel || 'MACRO') === 'MACRO');
    const detalhadas = categorias.filter((cat) => cat.categoria_pai_id || (cat.nivel || '') === 'DETALHADA');
    const usadas = new Set();

    const grupos = macros.map((macro) => {
      usadas.add(macro.id);
      const filhas = detalhadas.filter((cat) => cat.categoria_pai_id === macro.id);
      filhas.forEach((cat) => usadas.add(cat.id));
      const filhosHtml = filhas.map((cat) => `<option value="${escapeHtml(cat.nome)}">── ${escapeHtml(cat.nome)}</option>`).join('');
      return `<optgroup label="${escapeHtml(macro.emoji || '')} ${escapeHtml(macro.nome)}"><option value="${escapeHtml(macro.nome)}">${escapeHtml(macro.nome)} (macro)</option>${filhosHtml}</optgroup>`;
    }).join('');

    const semMacro = categorias.filter((cat) => !usadas.has(cat.id));
    const soltas = semMacro.length ? `<optgroup label="Outras categorias">${semMacro.map((cat) => `<option value="${escapeHtml(cat.nome)}">${escapeHtml(cat.nome)}</option>`).join('')}</optgroup>` : '';
    return `<option value="">Selecione uma categoria de ${STATE.tipoSelecionado === 'DESPESA' ? 'saída' : 'entrada'}</option>${grupos}${soltas}<option value="__NOVA__">+ Criar nova categoria</option>`;
  }

  function getCategoriaInput() {
    const form = document.querySelector('.cp-panel #cp-form');
    if (!form) return null;
    return form.querySelector('input[name="categoria"]');
  }

  function patchCategoriaField() {
    const input = getCategoriaInput();
    if (!input || input.dataset.cpEnhanced === '1') return;

    const label = input.closest('label');
    if (!label) return;

    input.dataset.cpEnhanced = '1';
    const valorAtual = input.value || STATE.categoriaSelecionada || '';
    STATE.categoriaSelecionada = valorAtual;

    const wrapper = document.createElement('div');
    wrapper.className = 'cp-category-enhanced';
    wrapper.innerHTML = `
      <label>Tipo
        <select id="cp-categoria-tipo">
          <option value="DESPESA" ${STATE.tipoSelecionado === 'DESPESA' ? 'selected' : ''}>Saída / Despesa</option>
          <option value="RECEITA" ${STATE.tipoSelecionado === 'RECEITA' ? 'selected' : ''}>Entrada / Receita</option>
        </select>
      </label>
      <label>Categoria
        <select id="cp-categoria-select">${montarOpcoesCategorias()}</select>
      </label>
      <div class="cp-category-new" id="cp-categoria-new-wrap">
        <label>Nova categoria
          <input id="cp-categoria-nova" placeholder="Ex.: Eletrodomésticos, Viagem, Salário" />
        </label>
        <button type="button" class="cp-btn cp-secondary" id="cp-categoria-usar-nova">Usar nova</button>
      </div>
      <div class="cp-category-hint">Compras Programadas são saídas por padrão. Use Entrada apenas para categorias de receita quando necessário.</div>
    `;

    label.replaceWith(wrapper);
    const hidden = input;
    hidden.type = 'hidden';
    hidden.name = 'categoria';
    hidden.value = valorAtual;
    document.querySelector('.cp-panel #cp-form')?.appendChild(hidden);

    bindCategoriaEvents(wrapper, hidden);
  }

  function bindCategoriaEvents(wrapper, hidden) {
    const tipoSelect = wrapper.querySelector('#cp-categoria-tipo');
    const categoriaSelect = wrapper.querySelector('#cp-categoria-select');
    const novaWrap = wrapper.querySelector('#cp-categoria-new-wrap');
    const novaInput = wrapper.querySelector('#cp-categoria-nova');
    const usarNova = wrapper.querySelector('#cp-categoria-usar-nova');

    const atualizarSelect = () => {
      categoriaSelect.innerHTML = montarOpcoesCategorias();
      const existe = Array.from(categoriaSelect.options).some((option) => option.value === STATE.categoriaSelecionada);
      categoriaSelect.value = existe ? STATE.categoriaSelecionada : '';
      hidden.value = categoriaSelect.value || STATE.categoriaSelecionada || '';
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const selecionarNova = () => {
      const valor = novaInput.value.trim();
      if (!valor) return;
      STATE.categoriaSelecionada = valor;
      hidden.value = valor;
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
      novaWrap.classList.remove('is-open');
      categoriaSelect.innerHTML = `${montarOpcoesCategorias()}<option value="${escapeHtml(valor)}">${escapeHtml(valor)} (nova)</option>`;
      categoriaSelect.value = valor;
    };

    tipoSelect.addEventListener('change', () => {
      STATE.tipoSelecionado = tipoSelect.value;
      STATE.categoriaSelecionada = '';
      hidden.value = '';
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
      atualizarSelect();
    });

    categoriaSelect.addEventListener('change', () => {
      if (categoriaSelect.value === '__NOVA__') {
        novaWrap.classList.add('is-open');
        novaInput.focus();
        return;
      }
      novaWrap.classList.remove('is-open');
      STATE.categoriaSelecionada = categoriaSelect.value;
      hidden.value = categoriaSelect.value;
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
    });

    novaInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        selecionarNova();
      }
    });
    usarNova.addEventListener('click', selecionarNova);

    atualizarSelect();
  }

  function observePanel() {
    const observer = new MutationObserver(() => patchCategoriaField());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  async function init() {
    injectStyle();
    await carregarCategorias();
    patchCategoriaField();
    observePanel();
  }

  window.addEventListener('load', init);
  setTimeout(init, 1200);
})();
