const fs = require('fs');

const path = 'scripts/temporary-smart-purchases.js';
let text = fs.readFileSync(path, 'utf8');

if (!text.includes('function block(fn)')) {
  text = text.replace(
    "const fs = require('fs');\n",
    "const fs = require('fs');\n\nfunction block(fn) {\n  const source = fn.toString();\n  const start = source.indexOf('/*');\n  const end = source.lastIndexOf('*/');\n  if (start < 0 || end < start) throw new Error('Bloco de código inválido.');\n  return source.slice(start + 2, end);\n}\n"
  );
}

function convertRawBlock(name, nextAnchor) {
  const token = `const ${name} = String.raw\``;
  const start = text.indexOf(token);
  if (start < 0) return;
  const anchor = text.indexOf(nextAnchor, start);
  if (anchor < 0) throw new Error(`Âncora final não encontrada para ${name}`);
  const region = text.slice(start, anchor);
  if (!region.endsWith('`;')) throw new Error(`Final inesperado para ${name}`);
  const body = region.slice(token.length, -2);
  const replacement = `const ${name} = block(function(){/*${body}*/});`;
  text = text.slice(0, start) + replacement + text.slice(anchor);
}

convertRawBlock('bulkRoute', "\nbackend = insertBefore(\n  backend,\n  \"app.patch('/api/compras-programadas/:id'");
convertRawBlock('prepararNovasCompras', "\nbackend = insertBefore(\n  backend,\n  'async function ferramentaPrepararNovaProvisao");
convertRawBlock('toolDefinition', "\nbackend = insertBefore(\n  backend,\n  \"  {\\n    type: 'function',\\n    name: 'preparar_alteracao_compra_programada',\"");
convertRawBlock('confirmarLote', "\napp = insertBefore(\n  app,\n  '  const confirmarAlteracaoSugerida");
convertRawBlock('loteCard', "\napp = insertBefore(\n  app,\n  \"              {mensagem.acaoPendente?.tipo === 'CRIAR_COMPRA_PROGRAMADA'");

fs.writeFileSync(path, text);
console.log('Transformador temporário corrigido.');
