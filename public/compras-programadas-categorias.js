(() => {
  // Este arquivo existia para transformar categoria em datalist, mas isso gerava
  // uma lista única gigante e confundia categorias de entrada e saída.
  // A partir de agora, o controle oficial fica em compras-programadas-tipo-categoria.js,
  // com Natureza da categoria e lista filtrada por Saída/Despesa ou Entrada/Receita.

  function limparDatalistAntigo() {
    const datalist = document.getElementById('cp-categorias-existentes');
    if (datalist) datalist.remove();

    document.querySelectorAll('.cp-panel input[name="categoria"]').forEach((input) => {
      input.removeAttribute('list');
      delete input.dataset.cpCategoryPatched;
    });

    document.querySelectorAll('.cp-category-actions').forEach((element) => element.remove());
  }

  function init() {
    limparDatalistAntigo();
    const observer = new MutationObserver(() => limparDatalistAntigo());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener('load', init);
  setTimeout(init, 1000);
})();
