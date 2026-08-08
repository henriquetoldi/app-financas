(() => {
  const STYLE_ID = 'compras-programadas-categorias-styles';
  let categoriasCache = [];
  let carregandoCategorias = false;

  function token() {
    return localStorage.getItem('token') || '';
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .cp-category-tools { display: grid; gap: 6px; }
      .cp-category-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .cp-category-actions button { border: 0; border-radius: 8px; padding: 7px 9px; font-weight: 800; cursor: pointer; background: #e0f2fe; color: #075985; }
      .cp-category-actions small { color: #64748b; }
    `;
    document.head.appendChild(style);
  }

  async function carregarCategorias() {
    if (carregandoCategorias) return categoriasCache;
    const auth = token();
    if (!auth) return categoriasCache;
    carregandoCategorias = true;
    try {
      const response = await fetch('/api/categorias', { headers: { Authorization: `Bearer ${auth}` } });
      if (!response.ok) return categoriasCache;
      const data = await response.json();
      categoriasCache = (data.categorias || [])
        .filter((cat) => cat.ativa !== false)
        .map((cat) => ({
          id: cat.id,
          nome: cat.nome,
          label: `${cat.emoji || ''} ${cat.nome}${cat.nivel === 'DETALHADA' && cat.categoria_pai_nome ? ` (${cat.categoria_pai_nome})` : ''}`.trim(),
        }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    } catch (error) {
      console.warn('Não foi possível carregar categorias para Compras Programadas:', error);
    } finally {
      carregandoCategorias = false;
    }
    return categoriasCache;
  }

  async function criarCategoria(nome) {
    const auth = token();
    const texto = String(nome || '').trim();
    if (!auth || !texto) return null;
    try {
      const response = await fetch('/api/categorias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ nome: texto, tipo: 'DESPESA', nivel: 'MACRO', customizada: true, ativa: true }),
      });
      if (!response.ok) throw new Error(await response.text());
      categoriasCache = [];
      await carregarCategorias();
      return texto;
    } catch (error) {
      console.warn('Não foi possível criar categoria no app. Ela ficará apenas no texto da compra:', error);
      return texto;
    }
  }

  function dispatchInput(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function patchCategoria() {
    const panel = document.querySelector('.cp-panel');
    if (!panel) return;
    const input = panel.querySelector('input[name="categoria"]');
    if (!input || input.dataset.cpCategoryPatched === '1') return;
    input.dataset.cpCategoryPatched = '1';

    const listId = 'cp-categorias-existentes';
    let datalist = document.getElementById(listId);
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = listId;
      document.body.appendChild(datalist);
    }
    input.setAttribute('list', listId);
    input.placeholder = 'Selecione uma categoria ou digite uma nova';

    const helper = document.createElement('div');
    helper.className = 'cp-category-actions';
    helper.innerHTML = '<button type="button" data-cp-create-category>Criar categoria</button><small>Use uma categoria existente ou crie uma nova para reaproveitar depois.</small>';
    input.insertAdjacentElement('afterend', helper);

    function refreshDatalist() {
      datalist.innerHTML = categoriasCache.map((cat) => `<option value="${escapeHtml(cat.nome)}">${escapeHtml(cat.label)}</option>`).join('');
    }

    carregarCategorias().then(() => refreshDatalist());

    helper.querySelector('[data-cp-create-category]').addEventListener('click', async () => {
      const nome = input.value.trim();
      if (!nome) {
        alert('Digite o nome da nova categoria primeiro.');
        return;
      }
      const existente = categoriasCache.find((cat) => cat.nome.toLowerCase() === nome.toLowerCase());
      if (existente) {
        input.value = existente.nome;
        dispatchInput(input);
        alert('Categoria já existe. Ela foi selecionada.');
        return;
      }
      await criarCategoria(nome);
      refreshDatalist();
      input.value = nome;
      dispatchInput(input);
      alert('Categoria adicionada à lista.');
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function init() {
    injectStyle();
    const observer = new MutationObserver(() => patchCategoria());
    observer.observe(document.body, { childList: true, subtree: true });
    patchCategoria();
  }

  window.addEventListener('load', init);
  setTimeout(init, 1000);
})();
