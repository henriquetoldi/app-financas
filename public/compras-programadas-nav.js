(() => {
  const STYLE_ID = 'compras-programadas-nav-fix-styles';
  const MENU_ID = 'compras-programadas-menu-link';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      body.cp-open { overflow: hidden !important; }
      body.cp-open .cp-panel { overflow-y: auto !important; }
      .cp-panel { position: fixed !important; inset: 0 !important; height: 100vh !important; max-height: 100vh !important; overflow-y: auto !important; }
      .cp-trigger { display: none !important; }
      .cp-menu-link { width: calc(100% - 28px); margin: 4px 14px; display: flex; align-items: center; gap: 12px; border: 0; border-radius: 10px; padding: 14px 16px; background: transparent; color: #cbd5e1; font: inherit; font-size: 15px; text-align: left; cursor: pointer; }
      .cp-menu-link:hover { background: rgba(255,255,255,.08); color: white; }
      .cp-menu-link span:first-child { width: 22px; text-align: center; }
    `;
    document.head.appendChild(style);
  }

  function openComprasProgramadas() {
    const trigger = document.querySelector('.cp-trigger');
    if (trigger) trigger.click();
    setTimeout(() => {
      if (document.querySelector('.cp-panel')) document.body.classList.add('cp-open');
    }, 50);
  }

  function patchCloseHandler() {
    document.addEventListener('click', (event) => {
      const close = event.target?.closest?.('#cp-close');
      if (!close) return;
      setTimeout(() => document.body.classList.remove('cp-open'), 80);
    });
  }

  function ensureMenuLink() {
    if (document.getElementById(MENU_ID)) return;
    const sidebar = document.querySelector('.sidebar') || document.querySelector('aside') || document.querySelector('nav');
    if (!sidebar) return;

    const existingText = Array.from(sidebar.querySelectorAll('button, a, div, span'))
      .find((node) => /Compras Programadas/i.test(node.textContent || ''));
    if (existingText) return;

    const reference = Array.from(sidebar.querySelectorAll('button, a'))
      .find((node) => /Planejamento/i.test(node.textContent || ''));

    const button = document.createElement('button');
    button.id = MENU_ID;
    button.type = 'button';
    button.className = 'cp-menu-link';
    button.innerHTML = '<span>🛒</span><span>Compras Programadas</span>';
    button.addEventListener('click', openComprasProgramadas);

    if (reference?.parentElement) {
      reference.parentElement.insertBefore(button, reference.nextSibling);
    } else {
      sidebar.appendChild(button);
    }
  }

  function init() {
    injectStyle();
    patchCloseHandler();
    ensureMenuLink();
    const observer = new MutationObserver(() => ensureMenuLink());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener('load', init);
  setTimeout(init, 800);
})();
