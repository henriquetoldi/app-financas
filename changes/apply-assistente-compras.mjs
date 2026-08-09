import fs from 'node:fs';

const arquivo = 'backend-server.js';
let conteudo = fs.readFileSync(arquivo, 'utf8');

function trocar(rotulo, antigo, novo) {
  if (!conteudo.includes(antigo)) throw new Error(`Trecho não encontrado: ${rotulo}`);
  conteudo = conteudo.replace(antigo, novo);
}

const inicioRota = conteudo.indexOf("app.post('/api/compras-programadas/:id/simular', verificarToken, async (req, res) => {");
const fimRota = conteudo.indexOf('\n\n\n// ============================================================================\n// ASSISTENTE FINANCEIRO', inicioRota);
if (inicioRota < 0 || fimRota < 0) throw new Error('Não foi possível localizar o endpoint de simulação de compras.');

const rotaAtual = conteudo.slice(inicioRota, fimRota);
const inicioCompra = rotaAtual.indexOf('    const compraResult = await pool.query(');
const fimSucesso = rotaAtual.lastIndexOf('    res.json({');
const inicioCatch = rotaAtual.lastIndexOf('  } catch (error) {');
if (inicioCompra < 0 || fimSucesso < 0 || inicioCatch < 0) throw new Error('Estrutura do endpoint de simulação inesperada.');

const corpoAntesResposta = rotaAtual.slice(inicioCompra, fimSucesso)
  .replaceAll('req.params.id', 'compraId')
  .replaceAll('req.usuario.usuario_id', 'usuarioId')
  .replaceAll('req.body?.', 'parametros?.');

const blocoRes = rotaAtual.slice(fimSucesso, inicioCatch);
const inicioObjeto = blocoRes.indexOf('{');
const fimObjeto = blocoRes.lastIndexOf('});');
if (inicioObjeto < 0 || fimObjeto < 0) throw new Error('Resposta JSON do simulador não reconhecida.');
const objetoResposta = blocoRes.slice(inicioObjeto, fimObjeto + 1);

let helper = `async function simularCompraProgramada(usuarioId, compraId, parametros = {}) {\n${corpoAntesResposta}    return ${objetoResposta};\n}\n\napp.post('/api/compras-programadas/:id/simular', verificarToken, async (req, res) => {\n  try {\n    const resultado = await simularCompraProgramada(req.usuario.usuario_id, req.params.id, req.body || {});\n    res.json(resultado);\n  } catch (error) {\n    const status = error.message === 'Compra programada não encontrada.' ? 404 : 400;\n    res.status(status).json({ erro: error.message });\n  }\n});`;
helper = helper.replace(
  /return res\.status\((?:400|404)\)\.json\(\{ erro: '([^']+)' \}\);/g,
  (_, mensagem) => `throw new Error('${mensagem}');`
);
conteudo = conteudo.slice(0, inicioRota) + helper + conteudo.slice(fimRota);

const marcadorFerramentas = 'const FERRAMENTAS_ASSISTENTE = [';
const indiceFerramentas = conteudo.indexOf(marcadorFerramentas);
if (indiceFerramentas < 0) throw new Error('Bloco de ferramentas do assistente não encontrado.');

const novaFerramenta = `async function ferramentaCompararCompraProgramada(usuarioId, args = {}) {\n  const termo = String(args.termo || '').trim();\n  const reservaMinima = Math.max(0, Number(args.reservaMinima || 0));\n  if (!termo) return { encontrada: false, motivo: 'Informe uma descrição ou parte do nome da compra programada.' };\n\n  const comprasResult = await pool.query(\n    \`SELECT id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas, status\n     FROM compras_programadas\n     WHERE usuario_id = $1\n       AND status IN ('PLANEJADA', 'ADIADA')\n       AND LOWER(descricao) LIKE LOWER($2)\n     ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, data_desejada ASC\n     LIMIT 5\`,\n    [usuarioId, \`%\${termo}%\`, termo]\n  );\n\n  if (comprasResult.rows.length === 0) {\n    return { encontrada: false, motivo: \`Nenhuma compra programada ativa corresponde a "\${termo}".\` };\n  }\n\n  if (comprasResult.rows.length > 1) {\n    return {\n      encontrada: false,\n      ambigua: true,\n      motivo: 'Há mais de uma compra correspondente. Peça ao usuário para indicar qual delas deseja analisar.',\n      opcoes: comprasResult.rows.map((item) => ({\n        descricao: item.descricao,\n        valorEstimado: Number(item.valor_estimado || 0),\n        dataDesejada: String(item.data_desejada).slice(0, 10),\n        status: item.status,\n      })),\n    };\n  }\n\n  const compra = comprasResult.rows[0];\n  const hoje = new Date().toISOString().slice(0, 10);\n  const dataOriginal = String(compra.data_desejada || '').slice(0, 10);\n  const dataBase = dataOriginal && dataOriginal > hoje ? dataOriginal : hoje;\n  const adicionarMeses = (dataIso, quantidade) => {\n    const [ano, mes, dia] = dataIso.split('-').map(Number);\n    const indice = (ano * 12) + (mes - 1) + quantidade;\n    const novoAno = Math.floor(indice / 12);\n    const novoMes = indice % 12;\n    const ultimoDia = new Date(Date.UTC(novoAno, novoMes + 1, 0)).getUTCDate();\n    return \`\${novoAno}-\${String(novoMes + 1).padStart(2, '0')}-\${String(Math.min(dia, ultimoDia)).padStart(2, '0')}\`;\n  };\n\n  const parcelasAtuais = Number(compra.parcelas || 1);\n  const opcoesParcelas = Array.from(new Set([1, 3, 6, 10, 12, parcelasAtuais]))\n    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 12)\n    .sort((a, b) => a - b);\n  const parametrosCenarios = [];\n  for (let adiamentoMeses = 0; adiamentoMeses <= 2; adiamentoMeses += 1) {\n    const dataDesejada = adicionarMeses(dataBase, adiamentoMeses);\n    for (const parcelas of opcoesParcelas) {\n      parametrosCenarios.push({ dataDesejada, adiamentoMeses, parcelas });\n    }\n  }\n\n  const cenarios = [];\n  for (let indice = 0; indice < parametrosCenarios.length; indice += 3) {\n    const lote = parametrosCenarios.slice(indice, indice + 3);\n    const resultados = await Promise.all(lote.map(async (cenario) => {\n      const simulacao = await simularCompraProgramada(usuarioId, compra.id, {\n        dataDesejada: cenario.dataDesejada,\n        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',\n        parcelas: cenario.parcelas,\n        horizonteMeses: 18,\n      });\n      return {\n        ...cenario,\n        formaPagamento: cenario.parcelas === 1 ? 'A_VISTA' : 'PARCELADO',\n        valorParcela: Number(simulacao.parametros.valorParcela || 0),\n        menorSaldoComCompra: Number(simulacao.resumo.menorSaldoComCompra || 0),\n        menorSaldoSemCompra: Number(simulacao.resumo.menorSaldoSemCompra || 0),\n        mesesNegativos: simulacao.resumo.mesesNegativos || [],\n        atendeReserva: Number(simulacao.resumo.menorSaldoComCompra || 0) >= reservaMinima,\n      };\n    }));\n    cenarios.push(...resultados);\n  }\n\n  cenarios.sort((a, b) => {\n    if (a.atendeReserva !== b.atendeReserva) return a.atendeReserva ? -1 : 1;\n    if (a.atendeReserva && b.atendeReserva) {\n      if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;\n      if (a.parcelas !== b.parcelas) return a.parcelas - b.parcelas;\n      return b.menorSaldoComCompra - a.menorSaldoComCompra;\n    }\n    if (a.menorSaldoComCompra !== b.menorSaldoComCompra) return b.menorSaldoComCompra - a.menorSaldoComCompra;\n    if (a.mesesNegativos.length !== b.mesesNegativos.length) return a.mesesNegativos.length - b.mesesNegativos.length;\n    if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;\n    return a.parcelas - b.parcelas;\n  });\n\n  const melhor = cenarios[0] || null;\n  return {\n    encontrada: true,\n    compra: {\n      descricao: compra.descricao,\n      valorEstimado: Number(compra.valor_estimado || 0),\n      dataDesejadaOriginal: dataOriginal,\n      prioridade: compra.prioridade,\n      status: compra.status,\n    },\n    reservaMinima,\n    criterio: melhor?.atendeReserva\n      ? 'Prioriza a data mais próxima que preserva a reserva e, depois, o menor número de parcelas.'\n      : 'Nenhum cenário preserva a reserva; prioriza o maior saldo mínimo projetado e menor exposição a meses negativos.',\n    melhorCenario: melhor,\n    melhoresAlternativas: cenarios.slice(0, 5),\n    premissas: [\n      'Horizonte de projeção de 18 meses.',\n      'Compara a data desejada e os dois meses seguintes.',\n      'Compara à vista e parcelamentos de até 12x sem estimar juros, taxas ou descontos.',\n      'Usa o mesmo motor financeiro da tela de Compras Programadas.',\n    ],\n  };\n}\n\n`;
conteudo = conteudo.slice(0, indiceFerramentas) + novaFerramenta + conteudo.slice(indiceFerramentas);

trocar(
  'declaracao compras programadas',
  `  {\n    type: 'function',\n    name: 'compras_programadas_por_mes',\n    description: 'Consulta compras programadas planejadas e distribui o impacto à vista ou parcelado nos próximos meses.',\n    strict: true,\n    parameters: {\n      type: 'object',\n      properties: { meses: { type: 'integer', minimum: 1, maximum: 24 } },\n      required: ['meses'],\n      additionalProperties: false,\n    },\n  },`,
  `  {\n    type: 'function',\n    name: 'compras_programadas_por_mes',\n    description: 'Consulta compras programadas planejadas e distribui o impacto à vista ou parcelado nos próximos meses.',\n    strict: true,\n    parameters: {\n      type: 'object',\n      properties: { meses: { type: 'integer', minimum: 1, maximum: 24 } },\n      required: ['meses'],\n      additionalProperties: false,\n    },\n  },\n  {\n    type: 'function',\n    name: 'comparar_cenarios_compra_programada',\n    description: 'Analisa uma compra programada específica e compara datas e parcelamentos usando o mesmo motor financeiro do simulador. Use quando o usuário perguntar se pode comprar algo, quando comprar, em quantas parcelas ou qual opção preserva melhor o caixa.',\n    strict: true,\n    parameters: {\n      type: 'object',\n      properties: {\n        termo: { type: 'string', description: 'Descrição ou parte do nome da compra programada a analisar.' },\n        reservaMinima: { type: 'number', minimum: 0, description: 'Saldo mínimo em BRL que o usuário deseja preservar. Use 0 se ele não informar uma reserva.' },\n      },\n      required: ['termo', 'reservaMinima'],\n      additionalProperties: false,\n    },\n  },`
);

trocar(
  'rotulo compras programadas',
  "  compras_programadas_por_mes: 'compras programadas',",
  "  compras_programadas_por_mes: 'compras programadas',\n  comparar_cenarios_compra_programada: 'comparação de cenários de compra',"
);
trocar(
  'dispatcher compras programadas',
  "  if (nome === 'compras_programadas_por_mes') return ferramentaComprasProgramadas(usuarioId, args);",
  "  if (nome === 'compras_programadas_por_mes') return ferramentaComprasProgramadas(usuarioId, args);\n  if (nome === 'comparar_cenarios_compra_programada') return ferramentaCompararCompraProgramada(usuarioId, args);"
);

trocar(
  'instrucao sobre ferramentas',
  'Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos.',
  'Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos. Se o usuário perguntar se pode realizar uma compra programada, quando comprar, qual parcelamento escolher ou qual cenário preserva melhor o caixa, use obrigatoriamente a ferramenta comparar_cenarios_compra_programada antes de recomendar.'
);
trocar(
  'instrucao fatos e sugestoes',
  'Valores são em BRL. Diferencie fatos encontrados nos dados de interpretações ou sugestões.',
  'Valores são em BRL. Diferencie fatos encontrados nos dados de interpretações ou sugestões. Ao explicar uma compra, cite a data, forma de pagamento, menor saldo projetado e se a reserva informada é preservada. Não trate o ranking como garantia de liquidez futura.'
);

fs.writeFileSync(arquivo, conteudo);
console.log('Integração Assistente + Compras Programadas aplicada.');
