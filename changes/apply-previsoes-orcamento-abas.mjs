import fs from 'node:fs';

const arquivo = 'App.jsx';
let conteudo = fs.readFileSync(arquivo, 'utf8');

function substituir(rotulo, antigo, novo) {
  if (!conteudo.includes(antigo)) {
    throw new Error(`Trecho não encontrado: ${rotulo}`);
  }
  conteudo = conteudo.replace(antigo, novo);
}

substituir(
  'estado da aba do planejamento',
  `  const [formularioAberto, setFormularioAberto] = useState(false);\n  const formularioInicial =`,
  `  const [formularioAberto, setFormularioAberto] = useState(false);\n  const [abaPlanejamento, setAbaPlanejamento] = useState('resumo');\n  const formularioInicial =`,
);

substituir(
  'editar planejamento abre aba correta',
  `  const editarPlanejamento = (item) => {\n    setFormularioAberto(true);\n    setEditandoId(item.id);`,
  `  const editarPlanejamento = (item) => {\n    setFormularioAberto(true);\n    setAbaPlanejamento('planejamentos');\n    setEditandoId(item.id);`,
);

substituir(
  'altura e largura do planejamento',
  `    <div style={{ minHeight: '100vh', background: '#f5f5f5', padding: '20px' }}>\n      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>\n        <PageHeader icone="🗓️" titulo="Planejamento Mensal" descricao="Planeje seus gastos antes do mês acontecer." breadcrumb={<Breadcrumb atual="Planejamento Mensal" onVoltar={onVoltar} />} />`,
  `    <div style={{ minHeight: 0, background: '#f5f5f5', padding: '20px' }}>\n      <div style={{ maxWidth: '100%', margin: '0 auto' }}>\n        <PageHeader icone="🗓️" titulo="Planejamento Mensal" descricao="Planeje seus gastos antes do mês acontecer." breadcrumb={<Breadcrumb atual="Planejamento Mensal" onVoltar={onVoltar} />} />\n        <div className="admin-tabs">\n          {[['resumo', '📊 Resumo'], ['projecoes', '📈 Projeções'], ['categorias', '🏷️ Categorias'], ['planejamentos', '🧾 Planejamentos']].map(([id, label]) => <button key={id} className={abaPlanejamento === id ? 'active' : ''} onClick={() => setAbaPlanejamento(id)}>{label}</button>)}\n        </div>`,
);

substituir(
  'nome do horizonte',
  `<label>Período dos gráficos<select value={filtrosPlanejamento.periodo}`,
  `<label>Horizonte de projeção<select value={filtrosPlanejamento.periodo}`,
);

substituir(
  'titulo do resumo',
  `<h2 style={{ margin: '18px 0 12px' }}>Resumo planejado de {rotuloMesAnoSelecionado}</h2>`,
  `<h2 style={{ margin: '18px 0 12px', display: abaPlanejamento === 'resumo' ? 'block' : 'none' }}>Resumo planejado de {rotuloMesAnoSelecionado}</h2>`,
);

substituir(
  'grid de kpis do resumo',
  `<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginTop: '16px' }}>\n            <KpiCard titulo="Fixas planejadas"`,
  `<div style={{ display: abaPlanejamento === 'resumo' ? 'grid' : 'none', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginTop: '16px' }}>\n            <KpiCard titulo="Fixas planejadas"`,
);

substituir(
  'comparativo geral do resumo',
  `<div style={{ marginTop: '12px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px', color: '#64748b' }}>\n            <strong style={{ color: '#334155' }}>Comparativo com realizado:</strong>`,
  `<div style={{ display: abaPlanejamento === 'resumo' ? 'block' : 'none', marginTop: '12px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px', color: '#64748b' }}>\n            <strong style={{ color: '#334155' }}>Comparativo com realizado:</strong>`,
);

substituir(
  'comparativo por categoria',
  `<div style={{ background: 'white', borderRadius: '16px', padding: '22px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '18px' }}>\n          <h2 style={{ margin: '0 0 6px' }}>Planejado x Realizado por categoria</h2>`,
  `<div style={{ display: abaPlanejamento === 'categorias' ? 'block' : 'none', background: 'white', borderRadius: '16px', padding: '22px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '18px' }}>\n          <h2 style={{ margin: '0 0 6px' }}>Planejado x Realizado por categoria</h2>`,
);

substituir(
  'projecao mensal',
  `<div style={{ background: 'white', borderRadius: '16px', padding: '22px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '18px' }}>\n          <h2 style={{ margin: '0 0 6px' }}>Compromissos previstos para os próximos meses</h2>`,
  `<div style={{ display: abaPlanejamento === 'projecoes' ? 'block' : 'none', background: 'white', borderRadius: '16px', padding: '22px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '18px' }}>\n          <h2 style={{ margin: '0 0 6px' }}>Compromissos previstos para os próximos meses</h2>`,
);

substituir(
  'distribuicao por categoria',
  `<div style={{ background: 'white', borderRadius: '16px', padding: '22px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '18px' }}>\n          <h2 style={{ margin: '0 0 6px' }}>Distribuição planejada por categoria</h2>`,
  `<div style={{ display: abaPlanejamento === 'categorias' ? 'block' : 'none', background: 'white', borderRadius: '16px', padding: '22px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '18px' }}>\n          <h2 style={{ margin: '0 0 6px' }}>Distribuição planejada por categoria</h2>`,
);

substituir(
  'botao adicionar planejamento',
  `<div style={{ marginBottom: '14px' }}>\n          <Btn variant="primary" onClick={() => setFormularioAberto(true)}>+ Adicionar despesa planejada</Btn>\n        </div>`,
  `<div style={{ display: abaPlanejamento === 'planejamentos' ? 'block' : 'none', marginBottom: '14px' }}>\n          <Btn variant="primary" onClick={() => { setFormularioAberto(true); setAbaPlanejamento('planejamentos'); }}>+ Adicionar despesa planejada</Btn>\n        </div>`,
);

substituir(
  'grid de planejamentos',
  `<div style={{ display: 'grid', gridTemplateColumns: formularioAberto ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: '18px' }}>\n          {formularioAberto && <form onSubmit={salvarPlanejamento}`,
  `<div style={{ display: abaPlanejamento === 'planejamentos' ? 'grid' : 'none', gridTemplateColumns: formularioAberto ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: '18px' }}>\n          {formularioAberto && <form onSubmit={salvarPlanejamento}`,
);

fs.writeFileSync(arquivo, conteudo);
console.log('TelaPlanejamentoMensal reorganizada em abas internas com sucesso.');
