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
  'formatacao de datas sem deslocamento de fuso',
  "function formatarData(data) {\n  if (!data) return '-';\n  const valor = new Date(data);\n  if (Number.isNaN(valor.getTime())) return '-';\n  return valor.toLocaleDateString('pt-BR');\n}",
  "function formatarData(data) {\n  if (!data) return '-';\n\n  const texto = String(data).trim();\n  const dataCalendario = texto.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);\n  if (dataCalendario) {\n    const [, ano, mes, dia] = dataCalendario;\n    return dia + '/' + mes + '/' + ano;\n  }\n\n  const valor = new Date(data);\n  if (Number.isNaN(valor.getTime())) return '-';\n  return valor.toLocaleDateString('pt-BR');\n}",
);

substituir(
  'largura de transacoes alinhada ao design system',
  "<div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>\n        <PageHeader icone=\"💸\" titulo=\"Transações consolidadas\"",
  "<div style={{ padding: '20px', maxWidth: '100%', margin: '0 auto' }}>\n        <PageHeader icone=\"💸\" titulo=\"Transações consolidadas\"",
);

substituir(
  'altura e largura de contas previstas alinhadas ao container pai',
  "<div style={{ minHeight: '100vh', background: '#f5f5f5' }}>\n      <div style={{ padding: '20px', maxWidth: '1280px', margin: '0 auto' }}>\n        <PageHeader icone=\"📌\" titulo=\"Contas previstas\"",
  "<div style={{ minHeight: 0, background: '#f5f5f5' }}>\n      <div style={{ padding: '20px', maxWidth: '100%', margin: '0 auto' }}>\n        <PageHeader icone=\"📌\" titulo=\"Contas previstas\"",
);

fs.writeFileSync(arquivo, conteudo);
console.log('Auditoria pós-refatoração aplicada com sucesso.');
