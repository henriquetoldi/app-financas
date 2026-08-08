import fs from 'node:fs';

const arquivo = 'App.jsx';
const original = fs.readFileSync(arquivo, 'utf8');
const inicio = original.indexOf('function TelaComprasProgramadas');
const fim = original.indexOf('\nfunction TelaPrevisoes', inicio);
if (inicio < 0 || fim < 0) throw new Error('Não foi possível delimitar TelaComprasProgramadas.');

const antes = original.slice(0, inicio);
let bloco = original.slice(inicio, fim);
const depois = original.slice(fim);

function trocar(rotulo, antigo, novo) {
  if (!bloco.includes(antigo)) throw new Error(`Trecho CSS não encontrado: ${rotulo}`);
  bloco = bloco.replace(antigo, novo);
}

trocar(
  'notebook',
  "        .compras-simulacao-notas { margin: 14px 0 0; padding-left: 18px; color: #64748b; font-size: 12px; line-height: 1.5; }\n        @media (max-width: 1100px) {",
  "        .compras-simulacao-notas { margin: 14px 0 0; padding-left: 18px; color: #64748b; font-size: 12px; line-height: 1.5; }\n        @media (max-width: 1200px) {\n          .compras-item-card { grid-template-columns: minmax(220px, 1.4fr) repeat(2, minmax(120px, 1fr)) !important; }\n          .compras-item-actions { justify-content: flex-start !important; }\n        }\n        @media (max-width: 1100px) {",
);

trocar(
  'celular',
  "          .compras-simulacao-controles, .compras-simulacao-resumo { grid-template-columns: 1fr; }\n          .compras-simulacao-controles .btn { width: 100%; }\n        }",
  "          .compras-simulacao-controles, .compras-simulacao-resumo { grid-template-columns: 1fr; }\n          .compras-simulacao-controles .btn { width: 100%; }\n          .compras-item-card { grid-template-columns: 1fr !important; }\n          .compras-item-actions { justify-content: flex-start !important; }\n          .compras-item-actions .btn { flex: 1 1 120px; }\n        }",
);

fs.writeFileSync(arquivo, antes + bloco + depois);
console.log('Responsividade do ciclo de vida aplicada.');
