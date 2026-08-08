import fs from 'node:fs';

const arquivo = 'App.jsx';
let conteudo = fs.readFileSync(arquivo, 'utf8');

function substituir(rotulo, antigo, novo) {
  if (!conteudo.includes(antigo)) throw new Error(`Trecho não encontrado: ${rotulo}`);
  conteudo = conteudo.replace(antigo, novo);
}

substituir(
  'estados de status e filtro',
  "  const [simulando, setSimulando] = useState(false);\n  const [opcoesSimulacao, setOpcoesSimulacao] = useState({ dataDesejada: '', formaPagamento: 'A_VISTA', parcelas: 1 });",
  "  const [simulando, setSimulando] = useState(false);\n  const [opcoesSimulacao, setOpcoesSimulacao] = useState({ dataDesejada: '', formaPagamento: 'A_VISTA', parcelas: 1 });\n  const [filtroStatusCompra, setFiltroStatusCompra] = useState('ATIVAS');\n  const [atualizandoStatusId, setAtualizandoStatusId] = useState(null);",
);

substituir(
  'funcao de status',
  "  const excluirCompra = (compra) => {",
  "  const atualizarStatusCompra = async (compra, status) => {\n    if (!compra || !status || status === compra.status) return;\n    setAtualizandoStatusId(compra.id);\n    try {\n      await axios.patch(`${API_URL}/compras-programadas/${compra.id}`, { status }, {\n        headers: { Authorization: `Bearer ${token}` },\n      });\n      if (compraSimulada?.id === compra.id && ['COMPRADA', 'CANCELADA'].includes(status)) fecharSimulacao();\n      await carregarCompras();\n      mostrarToast('Status da compra atualizado.');\n    } catch (error) {\n      mostrarToast(error.response?.data?.erro || 'Não foi possível atualizar o status da compra.', 'erro');\n    } finally {\n      setAtualizandoStatusId(null);\n    }\n  };\n\n  const excluirCompra = (compra) => {",
);

substituir(
  'derivacoes de status',
  "  const corPrioridade = {\n    BAIXA: ['#f1f5f9', '#475569'],\n    MEDIA: ['#dbeafe', '#1d4ed8'],\n    ALTA: ['#ffedd5', '#c2410c'],\n    ESSENCIAL: ['#fee2e2', '#b91c1c'],\n  };\n\n  return (",
  "  const corPrioridade = {\n    BAIXA: ['#f1f5f9', '#475569'],\n    MEDIA: ['#dbeafe', '#1d4ed8'],\n    ALTA: ['#ffedd5', '#c2410c'],\n    ESSENCIAL: ['#fee2e2', '#b91c1c'],\n  };\n  const corStatusCompra = {\n    PLANEJADA: ['#dbeafe', '#1d4ed8'],\n    ADIADA: ['#fef3c7', '#92400e'],\n    COMPRADA: ['#dcfce7', '#166534'],\n    CANCELADA: ['#e5e7eb', '#475569'],\n  };\n  const comprasFiltradas = compras.filter((compra) => {\n    if (filtroStatusCompra === 'TODAS') return true;\n    if (filtroStatusCompra === 'ATIVAS') return ['PLANEJADA', 'ADIADA'].includes(compra.status);\n    return compra.status === filtroStatusCompra;\n  });\n  const totalCompradas = compras.filter((compra) => compra.status === 'COMPRADA').length;\n\n  return (",
);

substituir(
  'quarto kpi',
  "        <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>\n          <small style={{ color: '#64748b' }}>Próximos 30 dias</small>\n          <strong style={{ display: 'block', fontSize: '24px', marginTop: '4px' }}>{proximas}</strong>\n        </div>\n      </div>",
  "        <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>\n          <small style={{ color: '#64748b' }}>Próximos 30 dias</small>\n          <strong style={{ display: 'block', fontSize: '24px', marginTop: '4px' }}>{proximas}</strong>\n        </div>\n        <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>\n          <small style={{ color: '#64748b' }}>Compras concluídas</small>\n          <strong style={{ display: 'block', fontSize: '24px', marginTop: '4px' }}>{totalCompradas}</strong>\n        </div>\n      </div>",
);

substituir(
  'cabecalho e filtro da lista',
  "      <div>\n        <h2 style={{ margin: '0 0 12px', fontSize: '20px' }}>Compras cadastradas</h2>\n        {carregando ? <Spinner texto=\"Carregando compras...\" /> : compras.length === 0 ? (",
  "      <div>\n        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>\n          <h2 style={{ margin: 0, fontSize: '20px' }}>Compras cadastradas</h2>\n          <label className=\"compras-field\" style={{ minWidth: '190px' }}>\n            <span className=\"compras-field-label\">Exibir</span>\n            <select value={filtroStatusCompra} onChange={(e) => setFiltroStatusCompra(e.target.value)}>\n              <option value=\"ATIVAS\">Ativas</option>\n              <option value=\"PLANEJADA\">Planejadas</option>\n              <option value=\"ADIADA\">Adiadas</option>\n              <option value=\"COMPRADA\">Compradas</option>\n              <option value=\"CANCELADA\">Canceladas</option>\n              <option value=\"TODAS\">Todas</option>\n            </select>\n          </label>\n        </div>\n        {carregando ? <Spinner texto=\"Carregando compras...\" /> : compras.length === 0 ? (",
);

substituir(
  'estado vazio filtrado e lista filtrada',
  "        ) : (\n          <div style={{ display: 'grid', gap: '10px' }}>\n            {compras.map((compra) => {",
  "        ) : comprasFiltradas.length === 0 ? (\n          <div style={{ border: '1px dashed #cbd5e1', borderRadius: '14px', padding: '24px', textAlign: 'center', color: '#64748b' }}>\n            Nenhuma compra encontrada para o filtro selecionado.\n          </div>\n        ) : (\n          <div style={{ display: 'grid', gap: '10px' }}>\n            {comprasFiltradas.map((compra) => {",
);

substituir(
  'cores de status no card',
  "              const cores = corPrioridade[compra.prioridade] || corPrioridade.MEDIA;\n              const categoria = compra.categoria_detalhada_nome || compra.categoria_macro_nome || 'Sem categoria';",
  "              const cores = corPrioridade[compra.prioridade] || corPrioridade.MEDIA;\n              const coresStatus = corStatusCompra[compra.status] || corStatusCompra.PLANEJADA;\n              const categoria = compra.categoria_detalhada_nome || compra.categoria_macro_nome || 'Sem categoria';",
);

substituir(
  'card com coluna de status',
  "                <div key={compra.id} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: 'white', display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) repeat(3, minmax(120px, 0.8fr)) auto', gap: '14px', alignItems: 'center' }}>",
  "                <div key={compra.id} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: 'white', display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) repeat(4, minmax(110px, 0.75fr)) auto', gap: '14px', alignItems: 'center' }}>",
);

substituir(
  'status e acoes do card',
  "                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>\n                    <Btn size=\"sm\" variant=\"primary\" onClick={() => abrirSimulacao(compra)}>Simular impacto</Btn>\n                    <Btn size=\"sm\" onClick={() => editarCompra(compra)}>Editar</Btn>\n                    <Btn size=\"sm\" onClick={() => excluirCompra(compra)}>Excluir</Btn>\n                  </div>",
  "                  <div>\n                    <small style={{ display: 'block', color: '#64748b', marginBottom: '4px' }}>Status</small>\n                    <select\n                      value={compra.status || 'PLANEJADA'}\n                      onChange={(e) => atualizarStatusCompra(compra, e.target.value)}\n                      disabled={atualizandoStatusId === compra.id}\n                      style={{ width: '100%', minWidth: '110px', border: `1px solid ${coresStatus[0]}`, borderRadius: '8px', padding: '7px 8px', background: coresStatus[0], color: coresStatus[1], fontWeight: 700 }}\n                    >\n                      <option value=\"PLANEJADA\">Planejada</option>\n                      <option value=\"ADIADA\">Adiada</option>\n                      <option value=\"COMPRADA\">Comprada</option>\n                      <option value=\"CANCELADA\">Cancelada</option>\n                    </select>\n                  </div>\n                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>\n                    {!['COMPRADA', 'CANCELADA'].includes(compra.status) && <Btn size=\"sm\" variant=\"primary\" onClick={() => abrirSimulacao(compra)}>Simular impacto</Btn>}\n                    <Btn size=\"sm\" onClick={() => editarCompra(compra)}>Editar</Btn>\n                    <Btn size=\"sm\" onClick={() => excluirCompra(compra)}>Excluir</Btn>\n                  </div>",
);

fs.writeFileSync(arquivo, conteudo);
console.log('Ciclo de vida de Compras Programadas aplicado com sucesso.');
