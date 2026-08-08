import fs from 'node:fs';

const arquivo = 'App.jsx';
let conteudo = fs.readFileSync(arquivo, 'utf8');

function substituir(rotulo, antigo, novo) {
  if (!conteudo.includes(antigo)) throw new Error(`Trecho não encontrado: ${rotulo}`);
  conteudo = conteudo.replace(antigo, novo);
}

substituir(
  'classe responsiva do card',
  "<div key={compra.id} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: 'white', display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) repeat(4, minmax(110px, 0.75fr)) auto', gap: '14px', alignItems: 'center' }}>",
  "<div key={compra.id} className=\"compras-item-card\" style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: 'white', display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) repeat(4, minmax(110px, 0.75fr)) auto', gap: '14px', alignItems: 'center' }}>",
);

substituir(
  'classe responsiva das acoes',
  "<div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>\n                    {!['COMPRADA', 'CANCELADA'].includes(compra.status)",
  "<div className=\"compras-item-actions\" style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>\n                    {!['COMPRADA', 'CANCELADA'].includes(compra.status)",
);

substituir(
  'regra responsiva notebook',
  "        .compras-simulacao-notas { margin: 14px 0 0; padding-left: 18px; color: #64748b; font-size: 12px; line-height: 1.5; }\n        @media (max-width: 1100px) {",
  "        .compras-simulacao-notas { margin: 14px 0 0; padding-left: 18px; color: #64748b; font-size: 12px; line-height: 1.5; }\n        @media (max-width: 1200px) {\n          .compras-item-card { grid-template-columns: minmax(220px, 1.4fr) repeat(2, minmax(120px, 1fr)) !important; }\n          .compras-item-actions { justify-content: flex-start !important; }\n        }\n        @media (max-width: 1100px) {",
);

substituir(
  'regra responsiva celular',
  "          .compras-simulacao-controles, .compras-simulacao-resumo { grid-template-columns: 1fr; }\n          .compras-simulacao-controles .btn { width: 100%; }\n        }",
  "          .compras-simulacao-controles, .compras-simulacao-resumo { grid-template-columns: 1fr; }\n          .compras-simulacao-controles .btn { width: 100%; }\n          .compras-item-card { grid-template-columns: 1fr !important; }\n          .compras-item-actions { justify-content: flex-start !important; }\n          .compras-item-actions .btn { flex: 1 1 120px; }\n        }",
);

fs.writeFileSync(arquivo, conteudo);
console.log('Responsividade do ciclo de vida de compras aplicada com sucesso.');
