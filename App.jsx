// ============================================================================
// FRONTEND: React App
// ============================================================================

import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '/api';

// ============================================================================
// FUNÇÕES AUXILIARES
// ============================================================================

function formatarData(data) {
  return new Date(data).toLocaleDateString('pt-BR');
}

const STATUS_PROVISAO_OPCOES = ['PENDENTE', 'CONCILIADA', 'ATRASADA', 'CANCELADA', 'IGNORADA'];
const TIPOS_PROVISAO_OPCOES = ['CREDITO', 'DEBITO'];

function badgeStatusProvisao(status) {
  const cores = {
    PENDENTE: ['#fef3c7', '#92400e'],
    CONCILIADA: ['#dcfce7', '#166534'],
    ATRASADA: ['#fee2e2', '#991b1b'],
    CANCELADA: ['#e5e7eb', '#374151'],
    IGNORADA: ['#ede9fe', '#5b21b6'],
  };
  return cores[status] || ['#e5e7eb', '#374151'];
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(valor || 0));
}

function formatarPercentual(valor) {
  return `${Number(valor || 0).toFixed(1).replace('.', ',')}%`;
}

function dataLocalISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function calcularPeriodoRapido(tipo) {
  const hoje = new Date();
  const inicio = new Date(hoje);
  const fim = new Date(hoje);

  if (tipo === 'hoje') return { dataInicial: dataLocalISO(hoje), dataFinal: dataLocalISO(hoje) };
  if (tipo === '7dias') {
    inicio.setDate(hoje.getDate() - 6);
    return { dataInicial: dataLocalISO(inicio), dataFinal: dataLocalISO(fim) };
  }
  if (tipo === '30dias') {
    inicio.setDate(hoje.getDate() - 29);
    return { dataInicial: dataLocalISO(inicio), dataFinal: dataLocalISO(fim) };
  }
  if (tipo === 'mesPassado') {
    inicio.setMonth(hoje.getMonth() - 1, 1);
    fim.setMonth(hoje.getMonth(), 0);
    return { dataInicial: dataLocalISO(inicio), dataFinal: dataLocalISO(fim) };
  }
  if (tipo === 'ano') {
    inicio.setMonth(0, 1);
    return { dataInicial: dataLocalISO(inicio), dataFinal: dataLocalISO(fim) };
  }

  inicio.setDate(1);
  return { dataInicial: dataLocalISO(inicio), dataFinal: dataLocalISO(fim) };
}

function decodificarPayloadJwt(token) {
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join('')
    );

    return JSON.parse(json);
  } catch (error) {
    console.error('Erro ao decodificar token:', error);
    return null;
  }
}


function montarMensagemErroImportacao(error) {
  const status = error?.response?.status;
  const dados = error?.response?.data;

  if (status === 413) {
    return 'Não foi possível importar o arquivo porque ele é grande demais para o limite atual do servidor.\n\n' +
      'O arquivo foi validado, mas a etapa de envio ultrapassou o tamanho máximo permitido.\n\n' +
      'Tente dividir a planilha em arquivos menores, remover abas/fórmulas/imagens desnecessárias ou aguardar o ajuste do limite de upload.';
  }

  if (dados?.erro) {
    return dados.detalhes ? `${dados.erro}\n\nDetalhes: ${dados.detalhes}` : dados.erro;
  }

  if (error?.request && !error?.response) {
    return 'Não foi possível conectar ao servidor. Verifique sua internet ou tente novamente em alguns minutos.';
  }

  return 'Erro inesperado ao importar. Tente novamente ou contate o suporte.';
}


function normalizarDescricaoCategorizacao(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g, ' ')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, ' ')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sugerirTermoRegra(descricao) {
  const partes = String(descricao || '')
    .split(/\s+-\s+|\s+–\s+|\s+—\s+/)
    .map((parte) => normalizarDescricaoCategorizacao(parte))
    .filter(Boolean)
    .filter((parte) => !/^\d+$/.test(parte))
    .filter((parte) => !/^(TRANSFERENCIA|ENVIADA|RECEBIDA|PIX|PAGAMENTO|COMPRA|DEBITO|CREDITO)\b/.test(parte));

  return partes.find((parte) => /[A-Z]/.test(parte) && parte.length >= 3) || normalizarDescricaoCategorizacao(descricao);
}

function normalizarDataFiltro(data) {
  if (!data) return '';
  return String(data).slice(0, 10);
}

function criarUsuarioDoToken(token) {
  const payload = decodificarPayloadJwt(token);

  if (!payload) return null;

  return {
    id: payload.usuario_id,
    email: payload.email,
    nome: payload.nome || payload.email,
    foto_url: payload.foto_url
  };
}


function excelSerialParaData(serial) {
  const utcDays = Math.floor(Number(serial) - 25569);
  const utcValue = utcDays * 86400;
  return new Date(utcValue * 1000).toISOString().slice(0, 10);
}

function normalizarTextoColuna(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function inflarDeflateRaw(bytes) {
  if (!('DecompressionStream' in window)) {
    throw new Error('Seu navegador não suporta leitura XLSX local. Atualize o navegador ou exporte em outro computador.');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function lerArquivoZipXlsx(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let eocdOffset = -1;

  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) throw new Error('Arquivo XLSX inválido.');

  const totalEntradas = view.getUint16(eocdOffset + 10, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  const arquivos = {};
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < totalEntradas; i++) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) break;

    const metodo = view.getUint16(centralOffset + 10, true);
    const tamanhoComprimido = view.getUint32(centralOffset + 20, true);
    const tamanhoNome = view.getUint16(centralOffset + 28, true);
    const tamanhoExtra = view.getUint16(centralOffset + 30, true);
    const tamanhoComentario = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const nome = decoder.decode(bytes.slice(centralOffset + 46, centralOffset + 46 + tamanhoNome));

    const localNome = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const inicioDados = localOffset + 30 + localNome + localExtra;
    const dadosComprimidos = bytes.slice(inicioDados, inicioDados + tamanhoComprimido);
    const dados = metodo === 0 ? dadosComprimidos : await inflarDeflateRaw(dadosComprimidos);
    arquivos[nome] = decoder.decode(dados);

    centralOffset += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }

  return arquivos;
}

function textoNoXml(no) {
  return no?.textContent || '';
}

function resolverPrimeiraPlanilha(arquivos) {
  if (!arquivos['xl/workbook.xml'] || !arquivos['xl/_rels/workbook.xml.rels']) return 'xl/worksheets/sheet1.xml';

  const parser = new DOMParser();
  const workbook = parser.parseFromString(arquivos['xl/workbook.xml'], 'application/xml');
  const primeira = workbook.querySelector('sheet');
  const relId = primeira?.getAttribute('r:id');
  if (!relId) return 'xl/worksheets/sheet1.xml';

  const rels = parser.parseFromString(arquivos['xl/_rels/workbook.xml.rels'], 'application/xml');
  const rel = Array.from(rels.querySelectorAll('Relationship')).find((item) => item.getAttribute('Id') === relId);
  const target = rel?.getAttribute('Target') || 'worksheets/sheet1.xml';
  return `xl/${target.replace(/^\//, '')}`;
}

async function lerXlsxPadrao(file) {
  const arquivos = await lerArquivoZipXlsx(await file.arrayBuffer());
  const parser = new DOMParser();
  const sharedStringsXml = arquivos['xl/sharedStrings.xml'];
  const sharedStrings = sharedStringsXml
    ? Array.from(parser.parseFromString(sharedStringsXml, 'application/xml').querySelectorAll('si')).map((si) => textoNoXml(si))
    : [];
  const sheetPath = resolverPrimeiraPlanilha(arquivos);
  const sheetXml = arquivos[sheetPath] || arquivos['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('Nenhuma planilha encontrada no XLSX.');

  const sheet = parser.parseFromString(sheetXml, 'application/xml');
  const linhas = Array.from(sheet.querySelectorAll('sheetData row')).map((row) => {
    const valores = [];
    Array.from(row.querySelectorAll('c')).forEach((cell) => {
      const ref = cell.getAttribute('r') || '';
      const colLetters = ref.replace(/[0-9]/g, '');
      const colIndex = colLetters.split('').reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0) - 1;
      const tipo = cell.getAttribute('t');
      let valor = textoNoXml(cell.querySelector('v'));
      if (tipo === 's') valor = sharedStrings[Number(valor)] || '';
      if (tipo === 'inlineStr') valor = textoNoXml(cell.querySelector('is'));
      valores[colIndex] = valor;
    });
    return valores;
  });

  if (linhas.length < 2) throw new Error('A planilha precisa ter cabeçalho e ao menos uma linha de dados.');

  const cabecalho = linhas[0].map(normalizarTextoColuna);
  const indiceOpcional = (...nomes) => nomes.map((nome) => cabecalho.indexOf(nome)).find((indice) => indice !== -1) ?? -1;
  const indices = {
    id: indiceOpcional('id', 'transacao id', 'transacao_id'),
    data: indiceOpcional('data'),
    descricao: indiceOpcional('descricao', 'descrição'),
    categoria: indiceOpcional('categoria'),
    categoriaMacro: indiceOpcional('categoria macro', 'categoria_macro', 'macro'),
    categoriaDetalhada: indiceOpcional('categoria detalhada', 'categoria_detalhada', 'subcategoria', 'categoria detalhe'),
    conta: indiceOpcional('conta'),
    valor: indiceOpcional('valor'),
    tipo: indiceOpcional('tipo'),
  };
  const obrigatorias = { data: indices.data, conta: indices.conta, descricao: indices.descricao, valor: indices.valor, tipo: indices.tipo };
  const faltantes = Object.entries(obrigatorias)
    .filter(([, indice]) => indice === -1)
    .map(([coluna]) => coluna === 'descricao' ? 'Descrição' : coluna.charAt(0).toUpperCase() + coluna.slice(1));

  if (faltantes.length > 0) {
    if (faltantes.includes('Conta')) {
      throw new Error('A planilha precisa conter a coluna Conta para identificar em qual conta cada transação será importada.');
    }
    throw new Error(`Colunas obrigatórias não encontradas: ${faltantes.join(', ')}.`);
  }

  return linhas.slice(1)
    .map((linha, index) => ({ linha, numeroLinha: index + 2 }))
    .filter(({ linha }) => linha.some((valor) => String(valor || '').trim()))
    .map(({ linha, numeroLinha }) => ({
      _linha: numeroLinha,
      data: linha[indices.data],
      descricao: linha[indices.descricao],
      categoria: indices.categoria >= 0 ? linha[indices.categoria] : '',
      categoria_macro: indices.categoriaMacro >= 0 ? linha[indices.categoriaMacro] : (indices.categoria >= 0 ? linha[indices.categoria] : ''),
      categoria_detalhada: indices.categoriaDetalhada >= 0 ? linha[indices.categoriaDetalhada] : '',
      conta: indices.conta >= 0 ? linha[indices.conta] : '',
      transacao_id: indices.id >= 0 ? linha[indices.id] : '',
      valor: linha[indices.valor],
      tipo: linha[indices.tipo],
    }));
}


const CRC32_TABELA = (() => {
  const tabela = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[i] = c >>> 0;
  }
  return tabela;
})();

function calcularCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC32_TABELA[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenarUint8(partes) {
  const total = partes.reduce((soma, parte) => soma + parte.length, 0);
  const resultado = new Uint8Array(total);
  let offset = 0;
  partes.forEach((parte) => {
    resultado.set(parte, offset);
    offset += parte.length;
  });
  return resultado;
}

function uint16(valor) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, valor, true);
  return bytes;
}

function uint32(valor) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, valor >>> 0, true);
  return bytes;
}

function criarZipSemCompressao(arquivos) {
  const encoder = new TextEncoder();
  const locais = [];
  const centrais = [];
  let offset = 0;

  arquivos.forEach(({ nome, conteudo }) => {
    const nomeBytes = encoder.encode(nome);
    const dados = typeof conteudo === 'string' ? encoder.encode(conteudo) : conteudo;
    const crc = calcularCrc32(dados);

    const local = concatenarUint8([
      uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(crc),
      uint32(dados.length), uint32(dados.length), uint16(nomeBytes.length), uint16(0), nomeBytes, dados,
    ]);
    locais.push(local);

    const central = concatenarUint8([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(crc),
      uint32(dados.length), uint32(dados.length), uint16(nomeBytes.length), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(0), uint32(offset), nomeBytes,
    ]);
    centrais.push(central);
    offset += local.length;
  });

  const dadosLocais = concatenarUint8(locais);
  const dadosCentrais = concatenarUint8(centrais);
  const eocd = concatenarUint8([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(arquivos.length), uint16(arquivos.length),
    uint32(dadosCentrais.length), uint32(dadosLocais.length), uint16(0),
  ]);

  return concatenarUint8([dadosLocais, dadosCentrais, eocd]);
}

function escaparXml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colunaExcel(indice) {
  let coluna = '';
  let numero = indice + 1;
  while (numero > 0) {
    const resto = (numero - 1) % 26;
    coluna = String.fromCharCode(65 + resto) + coluna;
    numero = Math.floor((numero - 1) / 26);
  }
  return coluna;
}

function criarCelulaXlsx(valor, linha, coluna, estilo = 0) {
  const ref = `${colunaExcel(coluna)}${linha}`;
  const atributoEstilo = estilo ? ` s="${estilo}"` : '';

  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return `<c r="${ref}"${atributoEstilo}><v>${valor}</v></c>`;
  }

  return `<c r="${ref}" t="inlineStr"${atributoEstilo}><is><t>${escaparXml(valor)}</t></is></c>`;
}

function criarXlsxTransacoes(linhas) {
  const cabecalhos = [
    'Transacao_ID', 'ID', 'Data', 'Conta', 'Descrição', 'Valor', 'Saldo Acumulado', 'Tipo', 'Categoria Macro',
    'Categoria Detalhada', 'Categoria', 'É Transferência Interna', 'Grupo Transferência', 'Origem Categoria'
  ];
  const todasLinhas = [cabecalhos, ...linhas];
  const sheetRows = todasLinhas.map((linha, rowIndex) => {
    const numeroLinha = rowIndex + 1;
    const cells = linha.map((valor, colIndex) => criarCelulaXlsx(valor, numeroLinha, colIndex, rowIndex === 0 ? 1 : 0)).join('');
    return `<row r="${numeroLinha}">${cells}</row>`;
  }).join('');
  const larguraColunas = cabecalhos.map((cabecalho, index) => {
    const largura = Math.min(48, Math.max(12, ...todasLinhas.map((linha) => String(linha[index] ?? '').length + 2)));
    return `<col min="${index + 1}" max="${index + 1}" width="${largura}" customWidth="1"/>`;
  }).join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${larguraColunas}</cols>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Transações" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

  const arquivos = [
    { nome: '[Content_Types].xml', conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { nome: '_rels/.rels', conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { nome: 'xl/workbook.xml', conteudo: workbook },
    { nome: 'xl/_rels/workbook.xml.rels', conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { nome: 'xl/worksheets/sheet1.xml', conteudo: sheet },
    { nome: 'xl/styles.xml', conteudo: styles },
  ];

  return criarZipSemCompressao(arquivos);
}

function baixarArquivo(bytes, nomeArquivo, tipo) {
  const url = URL.createObjectURL(new Blob([bytes], { type: tipo }));
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatarDataExcel(data) {
  const iso = normalizarDataFiltro(data);
  if (!iso) return '';
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
}

function nomeArquivoExportacao(dataInicial, dataFinal, selecionadas = false) {
  const prefixo = selecionadas ? 'transacoes_consolidadas_selecionadas' : 'transacoes_consolidadas';
  if (dataInicial && dataFinal) return `${prefixo}_${dataInicial}_a_${dataFinal}.xlsx`;
  if (dataInicial) return `${prefixo}_a_partir_de_${dataInicial}.xlsx`;
  if (dataFinal) return `${prefixo}_ate_${dataFinal}.xlsx`;
  return `${prefixo}.xlsx`;
}

function normalizarDataLinha(valor) {
  if (typeof valor === 'number' || /^\d+(\.\d+)?$/.test(String(valor || '').trim())) {
    const numero = Number(valor);
    if (numero > 20000 && numero < 80000) return excelSerialParaData(numero);
  }

  const texto = String(valor || '').trim();
  const br = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  const data = new Date(texto);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString().slice(0, 10);
}

const LIMITE_VALOR_TRANSACAO = 9999999999.99;

function textoValorOriginal(valor) {
  if (valor === null || valor === undefined || valor === '') return 'vazio';
  return String(valor);
}

function parseValorMonetario(valorOriginal) {
  if (typeof valorOriginal === 'number') {
    return {
      valor: Number.isFinite(valorOriginal) ? valorOriginal : null,
      erro: Number.isFinite(valorOriginal) ? null : 'A célula contém um número que o app não conseguiu interpretar.',
      valorOriginal,
      interpretadoComo: Number.isFinite(valorOriginal) ? valorOriginal : null,
    };
  }

  const textoOriginal = String(valorOriginal ?? '').trim();
  if (!textoOriginal) {
    return {
      valor: null,
      erro: 'A célula de valor está vazia.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  let texto = textoOriginal
    .replace(/ /g, ' ')
    .replace(/R\$/gi, '')
    .replace(/\s+/g, '')
    .trim();

  const negativoPorParenteses = /^\(.+\)$/.test(texto);
  if (negativoPorParenteses) texto = texto.slice(1, -1);
  const negativo = negativoPorParenteses || /^-/.test(texto);
  texto = texto.replace(/^[+-]/, '');

  if (!texto || !/^[0-9.,]+$/.test(texto)) {
    return {
      valor: null,
      erro: 'A célula contém caracteres que não parecem formar um valor monetário.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  const ultimaVirgula = texto.lastIndexOf(',');
  const ultimoPonto = texto.lastIndexOf('.');
  let decimal = null;

  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    decimal = ultimaVirgula > ultimoPonto ? ',' : '.';
  } else if (ultimaVirgula >= 0) {
    const digitosDepois = texto.length - ultimaVirgula - 1;
    const ocorrencias = (texto.match(/,/g) || []).length;
    decimal = ocorrencias === 1 && digitosDepois > 0 && digitosDepois <= 2 ? ',' : null;
  } else if (ultimoPonto >= 0) {
    const digitosDepois = texto.length - ultimoPonto - 1;
    const ocorrencias = (texto.match(/\./g) || []).length;
    decimal = ocorrencias === 1 && digitosDepois > 0 && digitosDepois <= 2 ? '.' : null;
  }

  let normalizado;
  if (decimal === ',') {
    normalizado = texto.replace(/\./g, '').replace(',', '.');
  } else if (decimal === '.') {
    normalizado = texto.replace(/,/g, '');
  } else {
    normalizado = texto.replace(/[.,]/g, '');
  }

  const numero = Number(normalizado);
  const interpretadoComo = Number.isFinite(numero) ? (negativo ? -numero : numero) : null;

  return {
    valor: interpretadoComo,
    erro: Number.isFinite(interpretadoComo) ? null : 'Não foi possível converter o conteúdo da célula em número.',
    valorOriginal,
    interpretadoComo,
  };
}

function criarErroImportacaoLinha({ linha, coluna, valorOriginal = '', valorInterpretado = null, descricao = '', erro, sugestao }) {
  return { linha, coluna, valorOriginal, valorInterpretado, descricao, erro, sugestao };
}

function formatarValorInterpretado(valor) {
  return Number.isFinite(valor) ? formatarMoeda(valor) : '-';
}

function formatarErroImportacao(erro) {
  if (typeof erro === 'string') return erro;
  return [
    `Linha ${erro.linha}`,
    `Coluna: ${erro.coluna || '-'}`,
    `Valor lido: "${textoValorOriginal(erro.valorOriginal)}"`,
    `Valor interpretado: ${formatarValorInterpretado(erro.valorInterpretado)}`,
    `Descrição: "${erro.descricao || '-'}"`,
    `Problema: ${erro.erro}`,
    `Sugestão: ${erro.sugestao || 'Revise a linha na planilha e tente novamente.'}`,
  ].join('\n');
}

function validarExcelImportacao(dados) {
  const erros = [];
  const transacoes = [];

  dados.forEach((linha, index) => {
    const numeroLinha = linha._linha || index + 2;
    const data = normalizarDataLinha(linha.data);
    const descricao = String(linha.descricao || '').trim();
    const categoria = String(linha.categoria || '').trim();
    const categoriaMacro = String(linha.categoria_macro || categoria || '').trim() || 'Outros';
    const categoriaDetalhada = String(linha.categoria_detalhada || '').trim();
    const conta = String(linha.conta || '').trim();
    const valorParse = parseValorMonetario(linha.valor);
    const valor = valorParse.valor;
    const tipoTexto = normalizarTextoColuna(linha.tipo);

    if (!data) {
      erros.push(criarErroImportacaoLinha({
        linha: numeroLinha,
        coluna: 'Data',
        valorOriginal: linha.data,
        descricao,
        erro: 'A data não foi reconhecida pelo app.',
        sugestao: 'Use uma data válida, como 10/06/2026 ou 2026-06-10.',
      }));
    }
    if (!descricao) {
      erros.push(criarErroImportacaoLinha({
        linha: numeroLinha,
        coluna: 'Descrição',
        valorOriginal: linha.descricao,
        descricao,
        erro: 'A descrição da transação está vazia.',
        sugestao: 'Preencha a descrição para identificar a transação no extrato.',
      }));
    }
    if (!conta) {
      erros.push(criarErroImportacaoLinha({
        linha: numeroLinha,
        coluna: 'Conta',
        valorOriginal: linha.conta,
        descricao,
        erro: 'A coluna Conta está vazia nesta linha.',
        sugestao: 'Informe a conta dessa transação na planilha.',
      }));
    }
    if (valorParse.erro) {
      erros.push(criarErroImportacaoLinha({
        linha: numeroLinha,
        coluna: 'Valor',
        valorOriginal: valorParse.valorOriginal,
        valorInterpretado: valorParse.interpretadoComo,
        descricao,
        erro: valorParse.erro,
        sugestao: 'Informe o valor em formato brasileiro (1.234,56), americano (1,234.56) ou como número do Excel (1234.56).',
      }));
    } else if (!Number.isFinite(valor) || Math.abs(valor) <= 0) {
      erros.push(criarErroImportacaoLinha({
        linha: numeroLinha,
        coluna: 'Valor',
        valorOriginal: valorParse.valorOriginal,
        valorInterpretado: valorParse.interpretadoComo,
        descricao,
        erro: 'O valor precisa ser maior que zero após a interpretação.',
        sugestao: 'Confira se a célula não está vazia, zerada ou com sinal/formato incorreto.',
      }));
    } else if (Math.abs(valor) > LIMITE_VALOR_TRANSACAO) {
      erros.push(criarErroImportacaoLinha({
        linha: numeroLinha,
        coluna: 'Valor',
        valorOriginal: valorParse.valorOriginal,
        valorInterpretado: valorParse.interpretadoComo,
        descricao,
        erro: `O valor interpretado (${formatarMoeda(valor)}) excede o limite permitido de ${formatarMoeda(LIMITE_VALOR_TRANSACAO)}.`,
        sugestao: 'Confira se o separador de milhar e o separador decimal estão corretos na planilha.',
      }));
    }
    if (!['debito', 'credito'].includes(tipoTexto)) {
      erros.push(criarErroImportacaoLinha({
        linha: numeroLinha,
        coluna: 'Tipo',
        valorOriginal: linha.tipo,
        descricao,
        erro: 'O tipo precisa indicar se a transação é débito ou crédito.',
        sugestao: 'Use exatamente Débito ou Crédito na coluna Tipo.',
      }));
    }

    if (data && descricao && conta && Number.isFinite(valor) && Math.abs(valor) > 0 && Math.abs(valor) <= LIMITE_VALOR_TRANSACAO && ['debito', 'credito'].includes(tipoTexto)) {
      transacoes.push({
        data,
        descricao,
        categoria,
        categoria_macro: categoriaMacro,
        categoria_detalhada: categoriaDetalhada,
        conta,
        transacao_id: String(linha.transacao_id || '').trim() || null,
        valor: Math.abs(valor),
        tipo: tipoTexto === 'credito' ? 'CREDITO' : 'DEBITO',
      });
    }
  });

  return { valido: erros.length === 0, erros, transacoes };
}

function arquivoParaBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function NotificacoesBell({ token }) {
  const [aberto, setAberto] = useState(false);
  const [notificacoes, setNotificacoes] = useState([]);
  const [naoLidas, setNaoLidas] = useState(0);

  const authHeaders = { Authorization: `Bearer ${token}` };
  const nomesMesesCurtos = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  const carregarNotificacoes = async () => {
    try {
      const response = await axios.get(`${API_URL}/notificacoes`, { headers: authHeaders });
      setNotificacoes(response.data.notificacoes || []);
      setNaoLidas(response.data.naoLidas || 0);
    } catch (error) {
      console.error('Erro ao carregar notificações:', error);
    }
  };

  useEffect(() => {
    carregarNotificacoes();
    const interval = setInterval(carregarNotificacoes, 30000);
    return () => clearInterval(interval);
  }, []);

  const deletar = async (id) => {
    await axios.delete(`${API_URL}/notificacoes/${id}`, { headers: authHeaders });
    carregarNotificacoes();
  };

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setAberto(!aberto)} style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer' }}>
        🔔 {naoLidas > 0 && `(${naoLidas})`}
      </button>
      {aberto && (
        <div style={{ position: 'absolute', right: 0, top: '45px', width: '340px', background: 'white', color: '#111827', borderRadius: '12px', boxShadow: '0 20px 50px rgba(0,0,0,0.25)', zIndex: 10, overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #e5e7eb', fontWeight: 'bold' }}>🔔 Notificações</div>
          {notificacoes.length === 0 ? <p style={{ padding: '16px', color: '#6b7280' }}>Nenhuma notificação.</p> : notificacoes.map((item) => (
            <div key={item.id} style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6' }}>
              <strong>{item.titulo}</strong>
              <p style={{ margin: '6px 0', color: '#4b5563', fontSize: '14px' }}>{item.mensagem}</p>
              <button onClick={() => deletar(item.id)} style={{ background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: '6px', padding: '6px 8px', cursor: 'pointer' }}>Deletar</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportarExcel({ contas, token, onConcluida }) {
  const [arquivo, setArquivo] = useState(null);
  const [validacao, setValidacao] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapeamentoCategorias, setMapeamentoCategorias] = useState([]);
  const [mapeamentoContas, setMapeamentoContas] = useState([]);
  const [conciliacoesSelecionadas, setConciliacoesSelecionadas] = useState([]);
  const [conciliacoesIgnoradas, setConciliacoesIgnoradas] = useState([]);
  const [modalErrosAberto, setModalErrosAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };
  const nomesMesesCurtos = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  const processarArquivo = async (file) => {
    setArquivo(file);
    setValidacao(null);
    setPreview(null);
    setMapeamentoCategorias([]);
    setMapeamentoContas([]);
    setConciliacoesSelecionadas([]);
    setConciliacoesIgnoradas([]);
    setModalErrosAberto(false);
    setCarregando(true);
    try {
      const dados = await lerXlsxPadrao(file);
      setValidacao(validarExcelImportacao(dados));
    } catch (error) {
      setValidacao({
        valido: false,
        erros: [criarErroImportacaoLinha({
          linha: '-',
          coluna: 'Arquivo',
          valorOriginal: file.name,
          erro: error.message,
          sugestao: 'Verifique se o arquivo é um XLSX válido com cabeçalho e colunas obrigatórias.',
        })],
        transacoes: [],
      });
    } finally {
      setCarregando(false);
    }
  };

  const gerarPreview = async () => {
    if (!validacao?.valido) return;
    setCarregando(true);
    try {
      const response = await axios.post(`${API_URL}/importacoes/xlsx/preview`, {
        transacoes: validacao.transacoes,
        nome_arquivo: arquivo.name,
        arquivo_base64: await arquivoParaBase64(arquivo),
      }, { headers: authHeaders });
      setPreview(response.data);
      setConciliacoesSelecionadas([]);
      setConciliacoesIgnoradas([]);
      setMapeamentoContas((response.data.contasImportacao || []).map((conta) => ({
        nomePlanilha: conta.nomePlanilha,
        acao: conta.status === 'CONFIRMADA' ? 'USAR_EXISTENTE' : '',
        contaExistenteId: conta.contaEncontradaId || '',
        nomeCorrigido: conta.nomePlanilha,
      })));
      setMapeamentoCategorias((response.data.categoriasPendentes || []).map((pendencia) => ({
        tipo: pendencia.tipo,
        nomePlanilha: pendencia.nomePlanilha,
        categoriaMacroPlanilha: pendencia.categoriaMacroPlanilha || null,
        acao: '',
        categoriaExistenteId: pendencia.possiveisCorrespondencias?.[0]?.id || '',
        nomeCorrigido: pendencia.nomePlanilha,
      })));
    } catch (error) {
      alert(montarMensagemErroImportacao(error));
    } finally {
      setCarregando(false);
    }
  };

  const confirmarImportacao = async (acao) => {
    if (!preview?.tokenPreview) return;
    setCarregando(true);
    try {
      const response = await axios.post(`${API_URL}/importacoes/xlsx/confirmar`, {
        tokenPreview: preview.tokenPreview,
        acao,
        mapeamentoContas,
        mapeamentoCategorias,
        conciliacoesConfirmadas: conciliacoesSelecionadas,
        conciliacoesIgnoradas,
      }, { headers: authHeaders });
      alert(response.data.mensagem || 'Importação concluída.');
      onConcluida();
    } catch (error) {
      alert(montarMensagemErroImportacao(error));
    } finally {
      setCarregando(false);
    }
  };

  const limpar = () => {
    setArquivo(null);
    setValidacao(null);
    setPreview(null);
    setMapeamentoCategorias([]);
    setMapeamentoContas([]);
    setConciliacoesSelecionadas([]);
    setConciliacoesIgnoradas([]);
    setModalErrosAberto(false);
  };

  const atualizarMapeamentoCategoria = (chave, atualizacao) => {
    setMapeamentoCategorias((atuais) => atuais.map((item) => {
      const chaveItem = `${item.tipo}|${item.categoriaMacroPlanilha || ''}|${item.nomePlanilha}`;
      return chaveItem === chave ? { ...item, ...atualizacao } : item;
    }));
  };

  const atualizarMapeamentoConta = (nomePlanilha, atualizacao) => {
    setMapeamentoContas((atuais) => atuais.map((item) => (
      item.nomePlanilha === nomePlanilha ? { ...item, ...atualizacao } : item
    )));
  };

  const alternarConciliacaoSelecionada = (sugestao) => {
    const chave = `${sugestao.provisaoId}|${sugestao.transacaoTempId || sugestao.transacaoId}`;
    setConciliacoesIgnoradas((atuais) => atuais.filter((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` !== chave));
    setConciliacoesSelecionadas((atuais) => atuais.some((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` === chave)
      ? atuais.filter((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` !== chave)
      : [...atuais, sugestao]);
  };

  const ignorarConciliacaoPreview = (sugestao) => {
    const chave = `${sugestao.provisaoId}|${sugestao.transacaoTempId || sugestao.transacaoId}`;
    setConciliacoesSelecionadas((atuais) => atuais.filter((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` !== chave));
    setConciliacoesIgnoradas((atuais) => atuais.some((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` === chave) ? atuais : [...atuais, sugestao]);
  };

  const copiarErrosImportacao = async (erros = []) => {
    const texto = erros.map(formatarErroImportacao).join('\n\n---\n\n');
    try {
      await navigator.clipboard.writeText(texto);
      alert('Detalhes dos erros copiados para a área de transferência.');
    } catch (error) {
      console.error('Erro ao copiar detalhes:', error);
      alert('Não foi possível copiar automaticamente. Selecione e copie os detalhes exibidos no modal.');
    }
  };

  const renderErroImportacao = (erro, index = 0) => {
    const item = typeof erro === 'string'
      ? criarErroImportacaoLinha({ linha: '-', coluna: '-', valorOriginal: '', erro, sugestao: 'Revise a planilha e tente novamente.' })
      : erro;

    return (
      <div key={`${item.linha || 'linha'}-${item.coluna || 'coluna'}-${item.erro || index}-${index}`} style={{ background: 'white', border: '1px solid #fecaca', borderRadius: '10px', padding: '12px' }}>
        <strong>Linha {item.linha || '-'} · Coluna {item.coluna || '-'}</strong>
        <div style={{ display: 'grid', gap: '4px', marginTop: '8px', color: '#7f1d1d', fontSize: '13px' }}>
          <span><strong>Valor lido:</strong> "{textoValorOriginal(item.valorOriginal)}"</span>
          <span><strong>Interpretado como:</strong> {formatarValorInterpretado(item.valorInterpretado)}</span>
          <span><strong>Descrição:</strong> {item.descricao || '-'}</span>
          <span><strong>Problema:</strong> {item.erro || String(item)}</span>
          <span><strong>Como corrigir:</strong> {item.sugestao || 'Revise a linha na planilha e tente novamente.'}</span>
        </div>
      </div>
    );
  };

  const contasImportacao = preview?.contasImportacao || [];
  const contasResolvidas = contasImportacao.every((conta) => {
    const decisao = mapeamentoContas.find((item) => item.nomePlanilha === conta.nomePlanilha);
    if (!decisao?.acao) return false;
    if (decisao.acao === 'USAR_EXISTENTE') return Boolean(decisao.contaExistenteId);
    if (decisao.acao === 'CRIAR_NOVA' || decisao.acao === 'CORRIGIR_NOME') return Boolean(decisao.nomeCorrigido?.trim());
    return false;
  });
  const categoriasPendentes = preview?.categoriasPendentes || [];
  const mapeamentosResolvidos = categoriasPendentes.every((pendencia) => {
    const chavePendencia = `${pendencia.tipo}|${pendencia.categoriaMacroPlanilha || ''}|${pendencia.nomePlanilha}`;
    const decisao = mapeamentoCategorias.find((item) => `${item.tipo}|${item.categoriaMacroPlanilha || ''}|${item.nomePlanilha}` === chavePendencia);
    if (!decisao?.acao) return false;
    if (decisao.acao === 'USAR_EXISTENTE') return Boolean(decisao.categoriaExistenteId);
    if (decisao.acao === 'CORRIGIR_NOME') return Boolean(decisao.nomeCorrigido?.trim());
    return true;
  });
  const confirmacaoBloqueada = carregando || !contasResolvidas || (categoriasPendentes.length > 0 && !mapeamentosResolvidos);
  const resumo = preview?.resumo || {};

  return (
    <div>
      <h2>📊 Importar transações por planilha XLSX</h2>
      <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '14px', padding: '16px', marginTop: '12px' }}>
        <p style={{ color: '#374151', marginTop: 0 }}>
          Use esta tela para trazer para o app as transações que você organizou em uma planilha Excel.
          Se a planilha contiver transações já cadastradas, o sistema irá comparar os dados e mostrar um resumo antes de atualizar qualquer informação.
        </p>
        <p style={{ color: '#92400e', fontWeight: 'bold', marginTop: 0 }}>Nenhuma alteração será aplicada sem sua confirmação.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px' }}>
            <strong>Colunas obrigatórias</strong>
            <p style={{ color: '#6b7280', marginBottom: 0 }}>Data, Conta, Descrição, Valor e Tipo.</p>
          </div>
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px' }}>
            <strong>Colunas opcionais</strong>
            <p style={{ color: '#6b7280', marginBottom: 0 }}>ID/Transacao_ID, Categoria Macro, Categoria Detalhada ou Categoria.</p>
          </div>
        </div>
      </div>

      <div style={{ margin: '18px 0', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '14px', padding: '16px' }}>
        <strong style={{ color: '#1d4ed8' }}>Conta definida pela planilha</strong>
        <p style={{ color: '#1e40af', marginBottom: 0 }}>
          A conta de cada transação deve estar informada na coluna Conta da planilha. O sistema irá validar as contas encontradas no arquivo antes de importar.
          Ela será usada para vincular cada transação à conta correta e também participa da identificação de transações já cadastradas.
        </p>
      </div>

      <label
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files?.[0]) processarArquivo(event.dataTransfer.files[0]);
        }}
        style={{ display: 'block', border: '2px dashed #93c5fd', borderRadius: '14px', padding: '34px', textAlign: 'center', background: '#eff6ff', cursor: 'pointer' }}
      >
        <input type="file" accept=".xlsx" onChange={(event) => event.target.files?.[0] && processarArquivo(event.target.files[0])} style={{ display: 'none' }} />
        <strong>{arquivo ? `📄 ${arquivo.name}` : 'Clique aqui ou arraste sua planilha .xlsx'}</strong>
        <p style={{ color: '#2563eb', marginBottom: 0 }}>Selecione o arquivo Excel para validar e pré-visualizar antes de gravar.</p>
      </label>

      {carregando && <p>Processando...</p>}

      {validacao?.erros?.length > 0 && (
        <div style={{ background: '#fef2f2', color: '#991b1b', borderRadius: '10px', padding: '14px', marginTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>❌ Erros encontrados: {validacao.erros.length}</strong>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button onClick={() => setModalErrosAberto(true)} style={{ background: 'white', color: '#991b1b', border: '1px solid #fecaca', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Ver todos os erros</button>
              <button onClick={() => copiarErrosImportacao(validacao.erros)} style={{ background: '#991b1b', color: 'white', border: 'none', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Copiar detalhes dos erros</button>
            </div>
          </div>
          <p style={{ marginBottom: '10px' }}>Mostrando os 10 primeiros erros com contexto para correção da planilha.</p>
          <div style={{ display: 'grid', gap: '10px' }}>{validacao.erros.slice(0, 10).map(renderErroImportacao)}</div>
        </div>
      )}

      {validacao?.valido && !preview && (
        <div style={{ background: '#ecfdf5', color: '#065f46', borderRadius: '10px', padding: '14px', marginTop: '16px' }}>
          ✅ {validacao.transacoes.length} linhas validadas. Gere o preview para ver novas, iguais, alteradas e erros antes de importar.
        </div>
      )}

      {preview && (
        <div style={{ background: 'white', border: '1px solid #d1d5db', borderRadius: '14px', padding: '16px', marginTop: '18px' }}>
          <h3 style={{ marginTop: 0 }}>Preview da importação</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '14px' }}>
            <KpiCard titulo="Novas" valor={resumo.novas || 0} detalhe="Serão inseridas" cor="#059669" fundo="#ecfdf5" />
            <KpiCard titulo="Sem alteração" valor={resumo.semAlteracao || 0} detalhe="Serão ignoradas" cor="#475569" fundo="#f8fafc" />
            <KpiCard titulo="Com alteração" valor={resumo.comAlteracao || 0} detalhe="Dependem de confirmação" cor="#d97706" fundo="#fffbeb" />
            <KpiCard titulo="Com erro" valor={resumo.comErro || 0} detalhe="Não serão aplicadas" cor="#dc2626" fundo="#fef2f2" />
          </div>

          {contasImportacao.length > 0 && (
            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
              <h3 style={{ marginTop: 0 }}>Confirmar contas da importação</h3>
              <p style={{ color: '#1e40af' }}>
                Encontramos contas na planilha. Revise abaixo para quais contas as transações serão importadas antes de continuar.
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', background: 'white' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px' }}>Conta na planilha</th>
                      <th style={{ textAlign: 'left', padding: '8px' }}>Conta no sistema</th>
                      <th style={{ textAlign: 'right', padding: '8px' }}>Transações</th>
                      <th style={{ textAlign: 'left', padding: '8px' }}>Status</th>
                      <th style={{ textAlign: 'left', padding: '8px' }}>Ação</th>
                    </tr>
                  </thead>
                  <tbody>{contasImportacao.map((contaPlanilha) => {
                    const decisao = mapeamentoContas.find((item) => item.nomePlanilha === contaPlanilha.nomePlanilha) || {};
                    const contaSelecionada = contas.find((conta) => conta.id === decisao.contaExistenteId);
                    const status = decisao.acao === 'USAR_EXISTENTE' && decisao.contaExistenteId
                      ? (contaPlanilha.status === 'POSSIVEL_CORRESPONDENCIA' ? 'Possível correspondência confirmada' : 'Confirmada')
                      : decisao.acao === 'CRIAR_NOVA'
                        ? 'Criar nova conta'
                        : decisao.acao === 'CORRIGIR_NOME'
                          ? 'Nome corrigido'
                          : (contaPlanilha.status === 'NAO_ENCONTRADA' ? 'Pendente' : contaPlanilha.statusLabel || 'Pendente');

                    return (
                      <tr key={contaPlanilha.nomePlanilha} style={{ borderTop: '1px solid #dbeafe' }}>
                        <td style={{ padding: '8px', fontWeight: 'bold' }}>{contaPlanilha.nomePlanilha}</td>
                        <td style={{ padding: '8px' }}>{contaSelecionada?.nome || contaPlanilha.contaEncontradaNome || 'Não encontrada'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{contaPlanilha.quantidade}</td>
                        <td style={{ padding: '8px' }}>{status}</td>
                        <td style={{ padding: '8px' }}>
                          <div style={{ display: 'grid', gap: '6px', minWidth: '220px' }}>
                            <select value={decisao.acao || ''} onChange={(event) => atualizarMapeamentoConta(contaPlanilha.nomePlanilha, { acao: event.target.value })} style={{ padding: '8px', borderRadius: '8px', border: '1px solid #93c5fd' }}>
                              <option value="">Escolha uma ação</option>
                              <option value="USAR_EXISTENTE">Usar conta existente</option>
                              <option value="CRIAR_NOVA">Criar nova conta</option>
                              <option value="CORRIGIR_NOME">Corrigir nome manualmente</option>
                            </select>
                            {decisao.acao === 'USAR_EXISTENTE' && (
                              <select value={decisao.contaExistenteId || ''} onChange={(event) => atualizarMapeamentoConta(contaPlanilha.nomePlanilha, { contaExistenteId: event.target.value })} style={{ padding: '8px', borderRadius: '8px', border: '1px solid #93c5fd' }}>
                                <option value="">Selecione a conta</option>
                                {contas.map((conta) => <option key={conta.id} value={conta.id}>{conta.nome}</option>)}
                              </select>
                            )}
                            {(decisao.acao === 'CRIAR_NOVA' || decisao.acao === 'CORRIGIR_NOME') && (
                              <input value={decisao.nomeCorrigido || ''} onChange={(event) => atualizarMapeamentoConta(contaPlanilha.nomePlanilha, { nomeCorrigido: event.target.value })} placeholder="Nome da conta" style={{ padding: '8px', borderRadius: '8px', border: '1px solid #93c5fd' }} />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
              {!contasResolvidas && <p style={{ color: '#b45309', fontWeight: 'bold', marginBottom: 0 }}>Resolva todas as contas da planilha antes de concluir a importação.</p>}
            </div>
          )}

          {(preview.categoriasNovas || []).length > 0 && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px', padding: '12px', marginBottom: '14px' }}>
              <strong>Categorias novas sem similaridade serão criadas após confirmação</strong>
              <p style={{ margin: '6px 0 0', color: '#166534' }}>
                {(preview.categoriasNovas || []).map((cat) => `${cat.tipo === 'MACRO' ? 'Macro' : 'Detalhada'}: ${cat.nomePlanilha}`).join(' • ')}
              </p>
            </div>
          )}

          {categoriasPendentes.length > 0 && (
            <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
              <h3 style={{ marginTop: 0 }}>Revisar categorias da planilha</h3>
              <p style={{ color: '#9a3412' }}>
                Encontramos categorias na planilha que não existem no sistema, mas parecem semelhantes a categorias já cadastradas. Escolha como deseja tratar cada caso antes de importar.
              </p>
              <div style={{ display: 'grid', gap: '12px' }}>
                {categoriasPendentes.map((pendencia) => {
                  const chave = `${pendencia.tipo}|${pendencia.categoriaMacroPlanilha || ''}|${pendencia.nomePlanilha}`;
                  const decisao = mapeamentoCategorias.find((item) => `${item.tipo}|${item.categoriaMacroPlanilha || ''}|${item.nomePlanilha}` === chave) || {};

                  return (
                    <div key={pendencia.chave || chave} style={{ background: 'white', border: '1px solid #fed7aa', borderRadius: '10px', padding: '12px' }}>
                      <div style={{ display: 'grid', gap: '4px', marginBottom: '10px' }}>
                        <strong>{pendencia.tipo === 'MACRO' ? 'Categoria macro' : 'Categoria detalhada'}: {pendencia.nomePlanilha}</strong>
                        {pendencia.categoriaMacroPlanilha && <span style={{ color: '#9a3412', fontSize: '13px' }}>Macro relacionada: {pendencia.categoriaMacroPlanilha}</span>}
                        <span style={{ color: '#6b7280', fontSize: '13px' }}>
                          Possíveis correspondências: {pendencia.possiveisCorrespondencias.map((item) => `${item.nome} (${Math.round((item.similaridade || 0) * 100)}%)`).join(', ')}
                        </span>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
                        <label style={{ display: 'grid', gap: '6px', fontSize: '13px' }}>
                          Decisão
                          <select value={decisao.acao || ''} onChange={(event) => atualizarMapeamentoCategoria(chave, { acao: event.target.value })} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                            <option value="">Escolha uma ação</option>
                            <option value="USAR_EXISTENTE">Usar categoria existente</option>
                            <option value="CRIAR_NOVA">Criar nova categoria</option>
                            <option value="CORRIGIR_NOME">Corrigir nome manualmente</option>
                          </select>
                        </label>

                        {decisao.acao === 'USAR_EXISTENTE' && (
                          <label style={{ display: 'grid', gap: '6px', fontSize: '13px' }}>
                            Categoria existente
                            <select value={decisao.categoriaExistenteId || ''} onChange={(event) => atualizarMapeamentoCategoria(chave, { categoriaExistenteId: event.target.value })} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                              <option value="">Selecione</option>
                              {pendencia.possiveisCorrespondencias.map((item) => <option key={item.id} value={item.id}>{item.nome}{item.categoriaMacro ? ` (${item.categoriaMacro})` : ''}</option>)}
                            </select>
                          </label>
                        )}

                        {decisao.acao === 'CORRIGIR_NOME' && (
                          <label style={{ display: 'grid', gap: '6px', fontSize: '13px' }}>
                            Nome corrigido
                            <input value={decisao.nomeCorrigido || ''} onChange={(event) => atualizarMapeamentoCategoria(chave, { nomeCorrigido: event.target.value })} placeholder="Digite o nome correto" style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} />
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {!mapeamentosResolvidos && <p style={{ color: '#b45309', fontWeight: 'bold', marginBottom: 0 }}>Resolva as categorias pendentes antes de concluir a importação.</p>}
            </div>
          )}

          {(preview.sugestoesConciliacao || []).length > 0 && (
            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
              <h3 style={{ marginTop: 0 }}>Possíveis conciliações encontradas</h3>
              <p style={{ color: '#1d4ed8' }}>Encontramos provisões que parecem corresponder às transações importadas. Revise antes de confirmar: nada será conciliado automaticamente.</p>
              <div style={{ display: 'grid', gap: '12px' }}>
                {(preview.sugestoesConciliacao || []).map((sugestao) => {
                  const chave = `${sugestao.provisaoId}|${sugestao.transacaoTempId || sugestao.transacaoId}`;
                  const selecionada = conciliacoesSelecionadas.some((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` === chave);
                  const ignorada = conciliacoesIgnoradas.some((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` === chave);
                  return (
                    <div key={chave} style={{ background: 'white', border: selecionada ? '2px solid #2563eb' : '1px solid #bfdbfe', borderRadius: '10px', padding: '12px', opacity: ignorada ? 0.55 : 1 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '12px' }}>
                        <div>
                          <strong>Provisão</strong>
                          <p style={{ margin: '6px 0' }}>{sugestao.provisao?.descricao}</p>
                          <small>{formatarData(sugestao.provisao?.data_prevista)} • {formatarMoeda(sugestao.provisao?.valor_previsto)} • {sugestao.provisao?.tipo}</small>
                        </div>
                        <div>
                          <strong>Transação real</strong>
                          <p style={{ margin: '6px 0' }}>{sugestao.transacao?.descricao}</p>
                          <small>{formatarData(sugestao.transacao?.data)} • {formatarMoeda(sugestao.transacao?.valor)} • {sugestao.transacao?.tipo}</small>
                        </div>
                        <div>
                          <strong>Análise</strong>
                          <p style={{ margin: '6px 0' }}><span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '3px 7px', borderRadius: '999px', fontSize: '12px', fontWeight: 'bold' }}>{sugestao.confianca}</span> score {Number(sugestao.score || 0).toFixed(2)}</p>
                          <small>{(sugestao.motivos || []).join(' • ')}</small>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                        <button onClick={() => alternarConciliacaoSelecionada(sugestao)} style={{ background: selecionada ? '#1d4ed8' : 'white', color: selecionada ? 'white' : '#1d4ed8', border: '1px solid #1d4ed8', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>{selecionada ? 'Selecionada para confirmar' : 'Confirmar conciliação'}</button>
                        <button onClick={() => ignorarConciliacaoPreview(sugestao)} style={{ background: ignorada ? '#6b7280' : 'white', color: ignorada ? 'white' : '#6b7280', border: '1px solid #6b7280', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Ignorar sugestão</button>
                        <button onClick={() => setConciliacoesSelecionadas((atuais) => atuais.filter((item) => `${item.provisaoId}|${item.transacaoTempId || item.transacaoId}` !== chave))} style={{ background: 'white', color: '#92400e', border: '1px solid #f59e0b', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Manter pendente</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(preview.comAlteracao || []).length > 0 && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px', padding: '12px', marginBottom: '14px' }}>
              <strong>Encontramos transações que já existem no sistema, mas possuem alterações na planilha. Deseja atualizar os registros existentes com os novos dados?</strong>
              <div style={{ overflowX: 'auto', marginTop: '12px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead><tr><th style={{ textAlign: 'left', padding: '8px' }}>Linha</th><th style={{ textAlign: 'left', padding: '8px' }}>Descrição</th><th style={{ textAlign: 'left', padding: '8px' }}>Alterações</th></tr></thead>
                  <tbody>{preview.comAlteracao.slice(0, 8).map((item) => (
                    <tr key={`${item.transacaoId}-${item.linha}`} style={{ borderTop: '1px solid #fde68a' }}>
                      <td style={{ padding: '8px' }}>{item.linha}</td>
                      <td style={{ padding: '8px' }}>{item.descricao}</td>
                      <td style={{ padding: '8px' }}>{item.alteracoes.map((alt) => `${alt.campo}: ${alt.valorAtual || 'vazio'} → ${alt.novoValor || 'vazio'}`).join('; ')}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}

          {(preview.erros || []).length > 0 && (
            <div style={{ background: '#fef2f2', color: '#991b1b', borderRadius: '10px', padding: '12px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>Linhas com erro no preview: {preview.erros.length}</strong>
                <button onClick={() => copiarErrosImportacao(preview.erros)} style={{ background: '#991b1b', color: 'white', border: 'none', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Copiar detalhes dos erros</button>
              </div>
              <div style={{ display: 'grid', gap: '10px', marginTop: '10px' }}>{preview.erros.slice(0, 8).map(renderErroImportacao)}</div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: '18px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {!preview ? (
          <button onClick={gerarPreview} disabled={!validacao?.valido || carregando} style={{ background: '#2563eb', color: 'white', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: validacao?.valido ? 'pointer' : 'not-allowed', opacity: validacao?.valido ? 1 : 0.6 }}>Gerar preview</button>
        ) : (
          <>
            <button onClick={() => confirmarImportacao('CANCELAR')} disabled={carregando} style={{ background: '#e5e7eb', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: 'pointer' }}>Cancelar</button>
            <button onClick={() => confirmarImportacao('IMPORTAR_APENAS_NOVAS')} disabled={confirmacaoBloqueada || !resumo.novas} style={{ background: '#10b981', color: 'white', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: (!confirmacaoBloqueada && resumo.novas) ? 'pointer' : 'not-allowed', opacity: (!confirmacaoBloqueada && resumo.novas) ? 1 : 0.6 }}>Importar somente novas</button>
            <button onClick={() => confirmarImportacao('ATUALIZAR_EXISTENTES')} disabled={confirmacaoBloqueada || !resumo.comAlteracao} style={{ background: '#f59e0b', color: 'white', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: (!confirmacaoBloqueada && resumo.comAlteracao) ? 'pointer' : 'not-allowed', opacity: (!confirmacaoBloqueada && resumo.comAlteracao) ? 1 : 0.6 }}>Atualizar existentes</button>
            <button onClick={() => confirmarImportacao('IMPORTAR_NOVAS_E_ATUALIZAR_EXISTENTES')} disabled={confirmacaoBloqueada || (!resumo.novas && !resumo.comAlteracao)} style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: (!confirmacaoBloqueada && (resumo.novas || resumo.comAlteracao)) ? 'pointer' : 'not-allowed', opacity: (!confirmacaoBloqueada && (resumo.novas || resumo.comAlteracao)) ? 1 : 0.6 }}>Importar novas e atualizar existentes</button>
          </>
        )}
        <button onClick={limpar} style={{ background: '#e5e7eb', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: 'pointer' }}>LIMPAR</button>
      </div>

      {modalErrosAberto && validacao?.erros?.length > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fef2f2', borderRadius: '14px', padding: '20px', width: '92%', maxWidth: '880px', maxHeight: '85vh', overflowY: 'auto', color: '#991b1b' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
              <h3 style={{ margin: 0 }}>Todos os erros de importação ({validacao.erros.length})</h3>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button onClick={() => copiarErrosImportacao(validacao.erros)} style={{ background: '#991b1b', color: 'white', border: 'none', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Copiar detalhes dos erros</button>
                <button onClick={() => setModalErrosAberto(false)} style={{ background: 'white', color: '#991b1b', border: '1px solid #fecaca', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Fechar</button>
              </div>
            </div>
            <div style={{ display: 'grid', gap: '10px' }}>{validacao.erros.map(renderErroImportacao)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminBackups({ token }) {
  const [dados, setDados] = useState({ backups: [], stats: {} });

  useEffect(() => {
    axios.get(`${API_URL}/admin/backups`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => setDados(response.data))
      .catch((error) => console.error('Erro ao carregar backups:', error));
  }, []);

  return (
    <div>
      <h2>📊 Painel de Backups</h2>
      <p>Total: {dados.stats.total || 0} | Sucessos: {dados.stats.sucessos || 0} | Erros: {dados.stats.erros || 0} | Taxa: {dados.stats.taxaSucesso || 0}%</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left', padding: '10px' }}>Data</th><th style={{ textAlign: 'left', padding: '10px' }}>Arquivo</th><th style={{ textAlign: 'left', padding: '10px' }}>Status</th><th style={{ textAlign: 'left', padding: '10px' }}>Transações</th></tr></thead>
          <tbody>{dados.backups.map((backup) => <tr key={backup.id} style={{ borderTop: '1px solid #e5e7eb' }}><td style={{ padding: '10px' }}>{formatarData(backup.data_importacao)}</td><td style={{ padding: '10px' }}>{backup.nome_arquivo}</td><td style={{ padding: '10px' }}>{backup.status === 'sucesso' ? '✅ Sucesso' : backup.status === 'erro' ? '❌ Erro' : '⏳ Pendente'}</td><td style={{ padding: '10px' }}>{backup.total_transacoes}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// LOGIN
// ============================================================================

function Login() {
  const [carregando, setCarregando] = useState(false);

  const handleLogin = async () => {
    setCarregando(true);

    try {
      const response = await axios.get(`${API_URL}/auth/google/url`);
      window.location.href = response.data.url;
    } catch (error) {
      alert('Erro ao fazer login: ' + (error.response?.data?.erro || error.message));
      setCarregando(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
    }}>
      <div className="login-card" style={{
        background: 'white',
        borderRadius: '12px',
        padding: '40px',
        width: '90%',
        maxWidth: '400px',
        textAlign: 'center',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)'
      }}>
        <h1 style={{ marginBottom: '10px', color: '#333' }}>
          💰 App de Finanças
        </h1>

        <p style={{ color: '#666', marginBottom: '30px' }}>
          Importe seus extratos e organize suas finanças
        </p>

        <button
          onClick={handleLogin}
          disabled={carregando}
          style={{
            background: '#1f2937',
            color: 'white',
            border: 'none',
            padding: '12px 24px',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: 'bold',
            cursor: carregando ? 'not-allowed' : 'pointer',
            opacity: carregando ? 0.6 : 1,
            width: '100%'
          }}
        >
          {carregando ? 'Conectando...' : '🔐 Login com Google'}
        </button>

        <p style={{
          marginTop: '20px',
          fontSize: '12px',
          color: '#999'
        }}>
          ✓ Seguro - Você autoriza via Google<br />
          ✓ Acesso ao seu Google Drive<br />
          ✓ Dados criptografados
        </p>
      </div>
    </div>
  );
}


function KpiCard({ titulo, valor, detalhe, cor = '#2563eb', fundo = 'white' }) {
  return (
    <div style={{ background: fundo, borderRadius: '14px', padding: '18px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', border: '1px solid #eef2f7' }}>
      <p style={{ margin: '0 0 8px', color: '#64748b', fontSize: '13px', fontWeight: 600 }}>{titulo}</p>
      <p style={{ margin: 0, color: cor, fontSize: '24px', fontWeight: 800 }}>{valor}</p>
      {detalhe && <p style={{ margin: '8px 0 0', color: '#94a3b8', fontSize: '12px' }}>{detalhe}</p>}
    </div>
  );
}

function BarrasMovimentacao({ dados }) {
  const maximo = Math.max(1, ...dados.map((item) => Math.max(Number(item.receitas || 0), Number(item.despesas || 0))));
  const visiveis = dados.slice(-12);

  if (visiveis.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>Sem movimentações no período selecionado.</p>;
  }

  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'end', minHeight: '220px', overflowX: 'auto', paddingTop: '10px' }}>
      {visiveis.map((item) => (
        <div key={item.periodo} style={{ minWidth: '56px', flex: 1, display: 'grid', gap: '6px', alignItems: 'end' }}>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'end', justifyContent: 'center', height: '150px' }}>
            <div title={`Receitas: ${formatarMoeda(item.receitas)}`} style={{ width: '18px', height: `${Math.max(4, (Number(item.receitas || 0) / maximo) * 140)}px`, background: '#10b981', borderRadius: '5px 5px 0 0' }} />
            <div title={`Despesas: ${formatarMoeda(item.despesas)}`} style={{ width: '18px', height: `${Math.max(4, (Number(item.despesas || 0) / maximo) * 140)}px`, background: '#ef4444', borderRadius: '5px 5px 0 0' }} />
          </div>
          <span style={{ color: '#64748b', fontSize: '11px', textAlign: 'center' }}>{item.periodo.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function BarrasHorizontais({ dados, rotulo, valorChave = 'valor', nomeChave = 'categoriaNome', cor = '#667eea' }) {
  const maximo = Math.max(1, ...dados.map((item) => Number(item[valorChave] || 0)));

  if (dados.length === 0) {
    return <p style={{ color: '#94a3b8', margin: 0 }}>Sem dados para exibir neste período.</p>;
  }

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      {dados.map((item) => (
        <div key={item[nomeChave]}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '5px', fontSize: '13px' }}>
            <strong style={{ color: '#334155' }}>{item[nomeChave]}</strong>
            <span style={{ color: '#64748b' }}>{rotulo ? rotulo(item) : formatarMoeda(item[valorChave])}</span>
          </div>
          <div style={{ height: '10px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(3, (Number(item[valorChave] || 0) / maximo) * 100)}%`, height: '100%', background: cor, borderRadius: '999px' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CardAnalitico({ titulo, children }) {
  return (
    <div className="chart-card" style={{ background: 'white', borderRadius: '14px', padding: '20px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', border: '1px solid #eef2f7' }}>
      <h3 style={{ margin: '0 0 16px', color: '#111827' }}>{titulo}</h3>
      {children}
    </div>
  );
}

// ============================================================================
// DASHBOARD
// ============================================================================


function TelaPlanejamentoMensal({ token, onVoltar }) {
  const hoje = new Date();
  const [mes, setMes] = useState(hoje.getMonth() + 1);
  const [ano, setAno] = useState(hoje.getFullYear());
  const [planejamentos, setPlanejamentos] = useState([]);
  const [resumo, setResumo] = useState({});
  const [carregando, setCarregando] = useState(false);
  const [editandoId, setEditandoId] = useState(null);
  const formularioInicial = { descricao: '', categoria: '', tipo_despesa: 'FIXA', valor_previsto: '', dia_previsto: '', observacao: '', recorrencia_tipo: 'UNICA', recorrencia_termino: 'SEM_FIM', mes_fim: String(hoje.getMonth() + 1), ano_fim: String(hoje.getFullYear()), quantidade_parcelas: '', parcela_inicial: '1' };
  const [form, setForm] = useState(formularioInicial);

  const authHeaders = { Authorization: `Bearer ${token}` };
  const nomesMesesCurtos = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  const carregarPlanejamento = async () => {
    setCarregando(true);
    try {
      const response = await axios.get(`${API_URL}/planejamento?mes=${mes}&ano=${ano}`, { headers: authHeaders });
      setPlanejamentos(response.data.planejamentos || []);
      setResumo(response.data.resumo || {});
    } catch (error) {
      alert('Erro ao carregar planejamento: ' + (error.response?.data?.erro || error.message));
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregarPlanejamento(); }, [mes, ano]);

  const limparFormulario = () => {
    setEditandoId(null);
    setForm(formularioInicial);
  };

  const salvarPlanejamento = async (event) => {
    event.preventDefault();
    const payload = { ...form, mes: Number(mes), ano: Number(ano), valor_previsto: Number(form.valor_previsto), dia_previsto: form.dia_previsto === '' ? null : Number(form.dia_previsto), quantidade_parcelas: form.recorrencia_tipo === 'PARCELADA' ? Number(form.quantidade_parcelas) : null, parcela_inicial: form.recorrencia_tipo === 'PARCELADA' ? Number(form.parcela_inicial || 1) : null, mes_fim: form.recorrencia_tipo === 'MENSAL' && form.recorrencia_termino === 'COM_FIM' ? Number(form.mes_fim) : null, ano_fim: form.recorrencia_tipo === 'MENSAL' && form.recorrencia_termino === 'COM_FIM' ? Number(form.ano_fim) : null };
    try {
      if (editandoId) {
        await axios.put(`${API_URL}/planejamento/${editandoId}`, payload, { headers: authHeaders });
      } else {
        await axios.post(`${API_URL}/planejamento`, payload, { headers: authHeaders });
      }
      limparFormulario();
      await carregarPlanejamento();
    } catch (error) {
      alert('Não foi possível salvar: ' + (error.response?.data?.erro || error.message));
    }
  };

  const editarPlanejamento = (item) => {
    setEditandoId(item.id);
    setForm({
      descricao: item.descricao || '',
      categoria: item.categoria || '',
      tipo_despesa: item.tipo_despesa || 'FIXA',
      valor_previsto: item.valor_previsto || '',
      dia_previsto: item.dia_previsto || '',
      observacao: item.observacao || '',
      recorrencia_tipo: item.recorrencia_tipo || 'UNICA',
      recorrencia_termino: item.mes_fim && item.ano_fim ? 'COM_FIM' : 'SEM_FIM',
      mes_fim: item.mes_fim || String(mes),
      ano_fim: item.ano_fim || String(ano),
      quantidade_parcelas: item.quantidade_parcelas || '',
      parcela_inicial: item.parcela_atual || '1',
    });
    if (item.recorrencia_tipo && item.recorrencia_tipo !== 'UNICA') {
      alert('Esta despesa faz parte de uma recorrência. Nesta versão, a alteração será aplicada apenas neste lançamento.');
    }
  };

  const excluirPlanejamento = async (item) => {
    const avisoRecorrencia = item.recorrencia_tipo && item.recorrencia_tipo !== 'UNICA' ? '\n\nEsta despesa faz parte de uma recorrência. Nesta versão, apenas este lançamento será excluído.' : '';
    if (!window.confirm(`Excluir "${item.descricao}" do planejamento?${avisoRecorrencia}`)) return;
    try {
      await axios.delete(`${API_URL}/planejamento/${item.id}`, { headers: authHeaders });
      if (editandoId === item.id) limparFormulario();
      await carregarPlanejamento();
    } catch (error) {
      alert('Erro ao excluir: ' + (error.response?.data?.erro || error.message));
    }
  };

  const rotuloRecorrencia = (item) => {
    if (item.recorrencia_tipo === 'MENSAL') return item.mes_fim && item.ano_fim ? `Mensal até ${nomesMesesCurtos[Number(item.mes_fim) - 1]}/${item.ano_fim}` : 'Mensal sem fim';
    if (item.recorrencia_tipo === 'PARCELADA') return `Parcelada ${item.parcela_atual || 1}/${item.quantidade_parcelas || '?'}`;
    return 'Única';
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', padding: '20px' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <button onClick={onVoltar} style={{ background: '#e5e7eb', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: 'pointer', marginBottom: '16px' }}>← Voltar</button>
        <div style={{ background: 'white', borderRadius: '16px', padding: '22px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '18px' }}>
          <h1 style={{ margin: '0 0 8px' }}>🗓️ Planejamento Mensal</h1>
          <p style={{ color: '#64748b', marginTop: 0 }}>Cadastre aqui os gastos que você já sabe ou estima que terá no mês. Separe despesas fixas, como aluguel, internet e assinaturas, das despesas variáveis, como mercado, transporte, lazer e delivery.</p>
          <p style={{ color: '#64748b', marginTop: 0 }}>Use a recorrência para despesas que se repetem. Escolha mensal para gastos fixos como aluguel, internet e assinaturas. Escolha parcelada para dívidas ou compras divididas em vários meses.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginTop: '16px' }}>
            <KpiCard titulo="Despesas fixas" valor={formatarMoeda(resumo.totalFixas)} detalhe="Gastos recorrentes" cor="#dc2626" fundo="#fef2f2" />
            <KpiCard titulo="Despesas variáveis" valor={formatarMoeda(resumo.totalVariaveis)} detalhe="Estimativas do mês" cor="#d97706" fundo="#fffbeb" />
            <KpiCard titulo="Total previsto" valor={formatarMoeda(resumo.totalPrevisto)} detalhe="Fixas + variáveis" cor="#2563eb" fundo="#eff6ff" />
            <KpiCard titulo="Itens planejados" valor={Number(resumo.quantidade || 0)} detalhe="Despesas cadastradas" cor="#0f766e" fundo="#f0fdfa" />
            <KpiCard titulo="Realizado no mês" valor={formatarMoeda(resumo.totalRealizado)} detalhe={`Diferença: ${formatarMoeda(resumo.diferencaPrevistoRealizado)}`} cor="#7c3aed" fundo="#f5f3ff" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '18px' }}>
          <form onSubmit={salvarPlanejamento} style={{ background: 'white', borderRadius: '14px', padding: '18px', display: 'grid', gap: '12px' }}>
            <h2 style={{ margin: 0 }}>{editandoId ? 'Editar despesa planejada' : 'Adicionar despesa planejada'}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <label>Mês<select value={mes} onChange={(e) => setMes(Number(e.target.value))} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
              <label>Ano<input type="number" value={ano} onChange={(e) => setAno(Number(e.target.value))} min="1900" max="2100" required style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
            </div>
            <label>Descrição<input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} required placeholder="Ex.: Aluguel" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
            <label>Categoria<input value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })} placeholder="Ex.: Moradia" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
            <label>Tipo de despesa<select value={form.tipo_despesa} onChange={(e) => setForm({ ...form, tipo_despesa: e.target.value })} required style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}><option value="FIXA">Fixa</option><option value="VARIAVEL">Variável</option></select></label>
            <label>Recorrência<select value={form.recorrencia_tipo} onChange={(e) => setForm({ ...form, recorrencia_tipo: e.target.value })} required style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}><option value="UNICA">Única</option><option value="MENSAL">Mensal recorrente</option><option value="PARCELADA">Parcelada</option></select></label>
            {form.recorrencia_tipo === 'MENSAL' && (
              <div style={{ display: 'grid', gap: '10px', background: '#f8fafc', padding: '10px', borderRadius: '8px' }}>
                <p style={{ margin: 0, color: '#64748b' }}>Essa despesa será considerada também nos próximos meses.</p>
                <label>Quando termina?<select value={form.recorrencia_termino} onChange={(e) => setForm({ ...form, recorrencia_termino: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}><option value="SEM_FIM">Sem data de término</option><option value="COM_FIM">Termina em mês/ano específico</option></select></label>
                <p style={{ margin: 0, color: '#64748b' }}>Use uma data de término quando essa despesa tiver prazo para acabar. Exemplo: assinatura temporária, acordo, aluguel provisório ou pagamento recorrente com fim definido.</p>
                {form.recorrencia_termino === 'COM_FIM' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <label>Mês final<select value={form.mes_fim} onChange={(e) => setForm({ ...form, mes_fim: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
                    <label>Ano final<input type="number" min="1900" max="2100" value={form.ano_fim} onChange={(e) => setForm({ ...form, ano_fim: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
                  </div>
                )}
              </div>
            )}
            {form.recorrencia_tipo === 'PARCELADA' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <label>Quantidade de parcelas<input type="number" min="1" value={form.quantidade_parcelas} onChange={(e) => setForm({ ...form, quantidade_parcelas: e.target.value })} required={form.recorrencia_tipo === 'PARCELADA'} placeholder="3" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
                <label>Parcela inicial<input type="number" min="1" value={form.parcela_inicial} onChange={(e) => setForm({ ...form, parcela_inicial: e.target.value })} placeholder="1" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <label>Valor previsto<input type="number" step="0.01" min="0.01" value={form.valor_previsto} onChange={(e) => setForm({ ...form, valor_previsto: e.target.value })} required placeholder="1500" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
              <label>Dia previsto de pagamento<input type="number" min="1" max="31" value={form.dia_previsto} onChange={(e) => setForm({ ...form, dia_previsto: e.target.value })} placeholder="5" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
            </div>
            <label>Observação<textarea value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} rows="3" placeholder="Detalhes opcionais" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} /></label>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}><button type="submit" style={{ background: '#2563eb', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: 'pointer' }}>{editandoId ? 'Salvar alterações' : 'Adicionar despesa'}</button><button type="button" onClick={limparFormulario} style={{ background: '#e5e7eb', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: 'pointer' }}>Limpar formulário</button></div>
          </form>

          <div style={{ background: 'white', borderRadius: '14px', padding: '18px', overflowX: 'auto' }}>
            <h2 style={{ marginTop: 0 }}>Despesas cadastradas</h2>
            {carregando ? <p>Carregando...</p> : planejamentos.length === 0 ? <p style={{ color: '#64748b' }}>Nenhuma despesa planejada para este mês.</p> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '760px' }}>
                <thead style={{ background: '#f8fafc' }}><tr>{['Descrição','Categoria','Tipo','Recorrência','Valor previsto','Dia previsto','Observação','Ações'].map((h) => <th key={h} style={{ padding: '10px', textAlign: 'left' }}>{h}</th>)}</tr></thead>
                <tbody>{planejamentos.map((item) => <tr key={item.id} style={{ borderTop: '1px solid #e5e7eb' }}><td style={{ padding: '10px' }}>{item.descricao}</td><td style={{ padding: '10px' }}>{item.categoria || '-'}</td><td style={{ padding: '10px' }}>{item.tipo_despesa === 'FIXA' ? 'Fixa' : 'Variável'}</td><td style={{ padding: '10px' }}>{rotuloRecorrencia(item)}</td><td style={{ padding: '10px' }}>{formatarMoeda(item.valor_previsto)}</td><td style={{ padding: '10px' }}>{item.dia_previsto || '-'}</td><td style={{ padding: '10px' }}>{item.observacao || '-'}</td><td style={{ padding: '10px', display: 'flex', gap: '6px' }}><button onClick={() => editarPlanejamento(item)} style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid #2563eb', color: '#2563eb', background: 'white', cursor: 'pointer' }}>Editar</button><button onClick={() => excluirPlanejamento(item)} style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid #dc2626', color: '#dc2626', background: 'white', cursor: 'pointer' }}>Excluir</button></td></tr>)}</tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ usuario, token, onLogout }) {
  const [contas, setContas] = useState([]);
  const [pastas, setPastas] = useState([]);
  const [pastaSelecionada, setPastaSelecionada] = useState(null);
  const [arquivos, setArquivos] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [modo, setModo] = useState('home');
  const [contaSelecionada, setContaSelecionada] = useState(null);
  const [periodoRapido, setPeriodoRapido] = useState('mes');
  const [periodoDashboard, setPeriodoDashboard] = useState(calcularPeriodoRapido('mes'));
  const [resumoDashboard, setResumoDashboard] = useState(null);
  const [carregandoDashboard, setCarregandoDashboard] = useState(false);

  useEffect(() => {
    carregarContas();
  }, []);

  useEffect(() => {
    if (modo === 'home') carregarResumoDashboard();
  }, [periodoDashboard.dataInicial, periodoDashboard.dataFinal, modo]);

  const authHeaders = {
    Authorization: `Bearer ${token}`
  };

  const carregarContas = async () => {
    try {
      const response = await axios.get(`${API_URL}/contas`, {
        headers: authHeaders
      });

      setContas(response.data.contas || []);
    } catch (error) {
      console.error('Erro ao carregar contas:', error);
    }
  };

  const carregarResumoDashboard = async () => {
    setCarregandoDashboard(true);

    try {
      const params = new URLSearchParams();
      if (periodoDashboard.dataInicial) params.set('dataInicial', periodoDashboard.dataInicial);
      if (periodoDashboard.dataFinal) params.set('dataFinal', periodoDashboard.dataFinal);

      const response = await axios.get(`${API_URL}/dashboard/resumo?${params.toString()}`, {
        headers: authHeaders
      });

      setResumoDashboard(response.data);
    } catch (error) {
      console.error('Erro ao carregar dashboard:', error);
      setResumoDashboard(null);
    } finally {
      setCarregandoDashboard(false);
    }
  };

  const aplicarPeriodoRapido = (tipo) => {
    setPeriodoRapido(tipo);
    setPeriodoDashboard(calcularPeriodoRapido(tipo));
  };

  const alterarPeriodoPersonalizado = (campo, valor) => {
    setPeriodoRapido('personalizado');
    setPeriodoDashboard((atual) => ({ ...atual, [campo]: valor }));
  };

  const carregarPastas = async () => {
    setModo('importar');
    setCarregando(true);

    try {
      const response = await axios.get(`${API_URL}/drive/pastas`, {
        headers: authHeaders
      });

      setPastas(response.data.pastas || []);
    } catch (error) {
      alert('Erro ao carregar pastas: ' + (error.response?.data?.erro || error.message));
    } finally {
      setCarregando(false);
    }
  };

  const carregarArquivos = async (pasta) => {
    setPastaSelecionada(pasta);
    setCarregando(true);

    try {
      const response = await axios.get(`${API_URL}/drive/arquivos/${pasta.id}`, {
        headers: authHeaders
      });

      setArquivos(response.data.arquivos || []);
    } catch (error) {
      alert('Erro ao carregar arquivos: ' + (error.response?.data?.erro || error.message));
    } finally {
      setCarregando(false);
    }
  };

  const importarArquivo = async (arquivo) => {
    if (!pastaSelecionada) {
      alert('Selecione uma pasta primeiro.');
      return;
    }

    if (!window.confirm(`Importar "${arquivo.name}"?`)) return;

    setCarregando(true);

    try {
      const response = await axios.post(
        `${API_URL}/importar/${arquivo.id}`,
        { nomePasta: pastaSelecionada.name },
        { headers: authHeaders }
      );

      alert(
        `✅ Importação concluída!\n` +
        `${response.data.inseridas || 0} transações importadas.\n` +
        `${response.data.duplicadas || 0} duplicadas.`
      );

      await carregarContas();
      setModo('home');
      setPastaSelecionada(null);
      setArquivos([]);
    } catch (error) {
      alert(montarMensagemErroImportacao(error));
    } finally {
      setCarregando(false);
    }
  };

  if (modo === 'conferencia-saldos') {
    return <TelaConferenciaSaldos contas={contas} token={token} onVoltar={() => setModo('home')} onAtualizarContas={carregarContas} />;
  }

  if (modo === 'provisoes') {
    return <TelaProvisoes contas={contas} token={token} onVoltar={() => setModo('home')} />;
  }

  if (modo === 'planejamento') {
    return <TelaPlanejamentoMensal token={token} onVoltar={() => setModo('home')} />;
  }

  if (modo === 'transacoes' && (contaSelecionada || contas.length > 0)) {
    return (
      <TelaTransacoes
        contaInicial={contaSelecionada}
        contas={contas}
        token={token}
        onVoltar={() => setModo('home')}
        onAtualizarContas={carregarContas}
      />
    );
  }

  const kpisDashboard = resumoDashboard?.kpis || {};
  const seriesDashboard = resumoDashboard?.series || {};
  const insightsDashboard = resumoDashboard?.insights || {};
  const saldoLiquido = Number(kpisDashboard.saldoLiquido || 0);
  const provisoesDashboard = kpisDashboard.provisoes || {};
  const contasSemConferenciaRecente = contas.filter((conta) => {
    const data = conta.ultima_conferencia?.data_referencia;
    if (!data) return true;
    const dias = Math.floor((Date.now() - new Date(data).getTime()) / (1000 * 60 * 60 * 24));
    return dias > 30;
  });

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <div className="app-shell-header" style={{
        background: '#1f2937',
        color: 'white',
        padding: '20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div>
          <h1 style={{ margin: '0 0 5px' }}>💰 Finanças Pessoais</h1>
          <p style={{ margin: 0, fontSize: '14px', opacity: 0.8 }}>
            Olá, {usuario?.nome || usuario?.email}
          </p>
        </div>

        <div className="app-header-actions" style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={() => setModo('planejamento')}
            style={{
              background: 'rgba(255,255,255,0.2)',
              color: 'white',
              border: '1px solid rgba(255,255,255,0.3)',
              padding: '8px 12px',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Planejamento
          </button>
          <button
            onClick={() => setModo('backups')}
            style={{
              background: 'rgba(255,255,255,0.2)',
              color: 'white',
              border: '1px solid rgba(255,255,255,0.3)',
              padding: '8px 12px',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Backups
          </button>
          <NotificacoesBell token={token} />
        <button
          onClick={onLogout}
          style={{
            background: 'rgba(255,255,255,0.2)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.3)',
            padding: '8px 16px',
            borderRadius: '6px',
            cursor: 'pointer'
          }}
        >
          Sair
        </button>
        </div>
      </div>

      <div className="page-container" style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
        {modo === 'home' && (
          <>
            {contas.length === 0 ? (
              <div style={{
                background: 'white',
                borderRadius: '12px',
                padding: '40px',
                textAlign: 'center'
              }}>
                <h2>Nenhuma conta importada</h2>
                <p style={{ color: '#666', marginBottom: '20px' }}>
                  Clique abaixo para importar uma planilha XLSX padronizada.
                </p>

                <button
                  onClick={() => setModo('importar')}
                  style={{
                    background: '#667eea',
                    color: 'white',
                    border: 'none',
                    padding: '12px 24px',
                    borderRadius: '8px',
                    fontSize: '16px',
                    cursor: 'pointer'
                  }}
                >
                  📊 Importar XLSX
                </button>
              </div>
            ) : (
              <div>
                <div style={{ background: 'white', borderRadius: '16px', padding: '20px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '16px' }}>
                    <div>
                      <h2 style={{ margin: '0 0 6px' }}>Dashboard financeiro</h2>
                      <p style={{ margin: 0, color: '#64748b' }}>Visão executiva entre {formatarData(periodoDashboard.dataInicial)} e {formatarData(periodoDashboard.dataFinal)}.</p>
                    </div>
                    <div className="dashboard-actions" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => {
                          setContaSelecionada(null);
                          setModo('transacoes');
                        }}
                        style={{ background: '#10b981', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}
                      >
                        Ver transações consolidadas
                      </button>
                      <button
                        onClick={() => setModo('planejamento')}
                        style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer' }}
                      >
                        🗓️ Planejamento
                      </button>
                      <button
                        onClick={() => setModo('provisoes')}
                        style={{ background: '#0f766e', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer' }}
                      >
                        📌 Provisões
                      </button>
                      <button
                        onClick={() => setModo('conferencia-saldos')}
                        style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer' }}
                      >
                        🏦 Conferir saldos
                      </button>
                      <button
                        onClick={() => setModo('importar')}
                        style={{ background: '#667eea', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer' }}
                      >
                        📊 Importar XLSX
                      </button>
                    </div>
                  </div>

                  {contasSemConferenciaRecente.length > 0 && (
                    <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: '10px', padding: '12px', marginBottom: '14px', display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span>{contasSemConferenciaRecente[0].nome} {contasSemConferenciaRecente[0].ultima_conferencia ? 'não é conferida há mais de 30 dias.' : 'ainda não possui conferência de saldo.'}</span>
                      <button onClick={() => setModo('conferencia-saldos')} style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '8px', cursor: 'pointer' }}>Conferir saldos</button>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
                    {[
                      ['hoje', 'Hoje'],
                      ['7dias', 'Últimos 7 dias'],
                      ['30dias', 'Últimos 30 dias'],
                      ['mes', 'Este mês'],
                      ['mesPassado', 'Mês passado'],
                      ['ano', 'Este ano'],
                    ].map(([tipo, label]) => (
                      <button
                        key={tipo}
                        onClick={() => aplicarPeriodoRapido(tipo)}
                        style={{
                          background: periodoRapido === tipo ? '#1f2937' : '#f1f5f9',
                          color: periodoRapido === tipo ? 'white' : '#334155',
                          border: 'none',
                          padding: '8px 12px',
                          borderRadius: '999px',
                          cursor: 'pointer',
                          fontSize: '13px',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', alignItems: 'end' }}>
                    <label style={{ display: 'grid', gap: '6px', color: '#475569', fontSize: '13px' }}>
                      Data inicial
                      <input type="date" value={periodoDashboard.dataInicial} onChange={(event) => alterarPeriodoPersonalizado('dataInicial', event.target.value)} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
                    </label>
                    <label style={{ display: 'grid', gap: '6px', color: '#475569', fontSize: '13px' }}>
                      Data final
                      <input type="date" value={periodoDashboard.dataFinal} onChange={(event) => alterarPeriodoPersonalizado('dataFinal', event.target.value)} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
                    </label>
                    <button onClick={() => aplicarPeriodoRapido('mes')} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#e5e7eb', cursor: 'pointer' }}>Resetar período</button>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginBottom: '20px' }}>
                  <KpiCard titulo="Receitas no período" valor={formatarMoeda(kpisDashboard.receitas)} detalhe="Entradas confirmadas" cor="#059669" />
                  <KpiCard titulo="Despesas no período" valor={formatarMoeda(kpisDashboard.despesas)} detalhe="Saídas registradas" cor="#dc2626" />
                  <KpiCard titulo="Saldo líquido" valor={formatarMoeda(saldoLiquido)} detalhe="Receitas - despesas" cor={saldoLiquido >= 0 ? '#059669' : '#dc2626'} />
                  <KpiCard titulo="Transações" valor={Number(kpisDashboard.quantidadeTransacoes || 0)} detalhe="No período" cor="#2563eb" />
                  <KpiCard titulo="Ticket médio despesa" valor={formatarMoeda(kpisDashboard.ticketMedioDespesa)} detalhe="Média dos débitos" cor="#7c3aed" />
                  <KpiCard titulo="Categorizado" valor={formatarPercentual(kpisDashboard.percentualCategorizado)} detalhe="Transações com categoria" cor="#0f766e" />
                  <KpiCard titulo="Transferências internas" valor={Number(kpisDashboard.transferenciasInternas || 0)} detalhe="Não entram nos KPIs financeiros" cor="#0f766e" />
                </div>

                <div style={{ background: 'white', borderRadius: '14px', padding: '16px', marginBottom: '20px' }}>
                  <h3 style={{ marginTop: 0 }}>Provisões no período</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                    <KpiCard titulo="Provisionado a pagar" valor={formatarMoeda(provisoesDashboard.totalProvisionadoPagar)} detalhe="Débitos previstos" cor="#dc2626" fundo="#fef2f2" />
                    <KpiCard titulo="Provisionado a receber" valor={formatarMoeda(provisoesDashboard.totalProvisionadoReceber)} detalhe="Créditos previstos" cor="#059669" fundo="#ecfdf5" />
                    <KpiCard titulo="Realizado conciliado" valor={formatarMoeda(provisoesDashboard.totalRealizadoConciliado)} detalhe="Transações vinculadas" cor="#2563eb" fundo="#eff6ff" />
                    <KpiCard titulo="Provisões pendentes" valor={Number(provisoesDashboard.pendentes || 0)} detalhe="Aguardando conciliação" cor="#d97706" fundo="#fffbeb" />
                    <KpiCard titulo="Provisões conciliadas" valor={Number(provisoesDashboard.conciliadas || 0)} detalhe={`${formatarPercentual(provisoesDashboard.percentualConciliado)} do total`} cor="#0f766e" fundo="#f0fdfa" />
                    <KpiCard titulo="Provisões atrasadas" valor={Number(provisoesDashboard.atrasadas || 0)} detalhe="Status atrasada" cor="#b91c1c" fundo="#fef2f2" />
                  </div>
                </div>

                {carregandoDashboard ? (
                  <div style={{ background: 'white', borderRadius: '14px', padding: '24px', marginBottom: '20px', color: '#64748b' }}>Carregando indicadores...</div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginBottom: '20px' }}>
                      <CardAnalitico titulo="Evolução de receitas e despesas">
                        <div style={{ display: 'flex', gap: '14px', marginBottom: '8px', color: '#64748b', fontSize: '12px' }}>
                          <span>🟩 Receitas</span>
                          <span>🟥 Despesas</span>
                        </div>
                        <BarrasMovimentacao dados={seriesDashboard.movimentacaoPorPeriodo || []} />
                      </CardAnalitico>
                      <CardAnalitico titulo="Despesas por categoria">
                        <BarrasHorizontais dados={seriesDashboard.despesasPorCategoria || []} rotulo={(item) => `${formatarMoeda(item.valor)} • ${formatarPercentual(item.percentual)}`} cor="#ef4444" />
                      </CardAnalitico>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginBottom: '20px' }}>
                      <CardAnalitico titulo="Receitas vs despesas">
                        <BarrasHorizontais
                          dados={[
                            { nome: 'Receitas', valor: Number(kpisDashboard.receitas || 0) },
                            { nome: 'Despesas', valor: Number(kpisDashboard.despesas || 0) },
                          ]}
                          nomeChave="nome"
                          cor="#2563eb"
                        />
                      </CardAnalitico>
                      <CardAnalitico titulo="Contas com maior impacto">
                        <BarrasHorizontais dados={(seriesDashboard.movimentacaoPorConta || []).slice(0, 6)} nomeChave="contaNome" valorChave="volume" rotulo={(item) => `${formatarMoeda(item.volume)} • ${item.quantidadeTransacoes} tx`} cor="#7c3aed" />
                      </CardAnalitico>
                    </div>

                    <CardAnalitico titulo="Insights estratégicos">
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
                        <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '14px' }}>
                          <strong>Maior categoria de despesa</strong>
                          <p style={{ margin: '8px 0 0', color: '#64748b' }}>{insightsDashboard.maiorCategoriaDespesa ? `${insightsDashboard.maiorCategoriaDespesa.categoriaNome} totalizou ${formatarMoeda(insightsDashboard.maiorCategoriaDespesa.valor)}.` : 'Sem despesas categorizadas no período.'}</p>
                        </div>
                        <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '14px' }}>
                          <strong>Conta com maior volume</strong>
                          <p style={{ margin: '8px 0 0', color: '#64748b' }}>{insightsDashboard.contaMaiorMovimento ? `${insightsDashboard.contaMaiorMovimento.contaNome} movimentou ${formatarMoeda(insightsDashboard.contaMaiorMovimento.volume)}.` : 'Sem movimentação no período.'}</p>
                        </div>
                        <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '14px' }}>
                          <strong>Dia com maior gasto</strong>
                          <p style={{ margin: '8px 0 0', color: '#64748b' }}>{insightsDashboard.diaMaiorGasto ? `${formatarData(insightsDashboard.diaMaiorGasto.data)} concentrou ${formatarMoeda(insightsDashboard.diaMaiorGasto.valor)} em despesas.` : 'Sem gastos no período.'}</p>
                        </div>
                        <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '14px' }}>
                          <strong>Pendências de categorização</strong>
                          <p style={{ margin: '8px 0 0', color: '#64748b' }}>Você ainda possui {Number(insightsDashboard.transacoesSemCategoria || 0)} transação(ões) sem categoria.</p>
                        </div>
                      </div>
                    </CardAnalitico>
                  </>
                )}

                <div className="section-title-row" style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  margin: '26px 0 20px'
                }}>
                  <h2 style={{ margin: 0 }}>Suas Contas</h2>

                  <button
                    onClick={() => setModo('importar')}
                    style={{
                      background: '#667eea',
                      color: 'white',
                      border: 'none',
                      padding: '10px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    📊 Importar XLSX
                  </button>
                </div>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
                  gap: '20px'
                }}>
                  {contas.map(conta => {
                    const resumoConta = (seriesDashboard.movimentacaoPorConta || []).find((item) => item.contaId === conta.id);

                    return (
                      <div
                        key={conta.id}
                        onClick={() => {
                          setContaSelecionada(conta);
                          setModo('transacoes');
                        }}
                        style={{
                          background: 'white',
                          borderRadius: '12px',
                          padding: '20px',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                          cursor: 'pointer'
                        }}
                      >
                        <h3 style={{ margin: '0 0 10px' }}>{conta.nome}</h3>

                        <p style={{
                          fontSize: '24px',
                          fontWeight: 'bold',
                          margin: 0,
                          color: Number(conta.saldo || 0) >= 0 ? '#10b981' : '#ef4444'
                        }}>
                          {formatarMoeda(conta.saldo)}
                        </p>

                        <div style={{ display: 'grid', gap: '4px', marginTop: '14px', color: '#64748b', fontSize: '12px' }}>
                          <span>Período: {resumoConta ? `${resumoConta.quantidadeTransacoes} transação(ões)` : 'sem movimentação'}</span>
                          <span>Receitas: {formatarMoeda(resumoConta?.receitas || 0)}</span>
                          <span>Despesas: {formatarMoeda(resumoConta?.despesas || 0)}</span>
                          <span>Última conferência: {conta.ultima_conferencia ? `${formatarData(conta.ultima_conferencia.data_referencia)} • ${conta.ultima_conferencia.status}` : 'não realizada'}</span>
                        </div>

                        <p style={{ color: '#999', fontSize: '12px' }}>
                          Clique para ver transações
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {modo === 'importar' && (
          <div className="content-card" style={{
            background: 'white',
            borderRadius: '12px',
            padding: '30px'
          }}>
            <button
              onClick={() => setModo('home')}
              style={{
                background: '#e5e7eb',
                border: 'none',
                padding: '8px 12px',
                borderRadius: '6px',
                cursor: 'pointer',
                marginBottom: '20px'
              }}
            >
              ← Voltar
            </button>

            <ImportarExcel
              contas={contas}
              token={token}
              onConcluida={async () => {
                await carregarContas();
                setModo('home');
              }}
            />
          </div>
        )}

        {modo === 'backups' && (
          <div className="content-card" style={{
            background: 'white',
            borderRadius: '12px',
            padding: '30px'
          }}>
            <button
              onClick={() => setModo('home')}
              style={{
                background: '#e5e7eb',
                border: 'none',
                padding: '8px 12px',
                borderRadius: '6px',
                cursor: 'pointer',
                marginBottom: '20px'
              }}
            >
              ← Voltar
            </button>
            <AdminBackups token={token} />
          </div>
        )}
      </div>
    </div>
  );
}


// ============================================================================
// TELA DE PROVISÕES
// ============================================================================


function badgeStatusConferencia(status) {
  const mapa = {
    CONCILIADO: ['#dcfce7', '#166534'],
    DIVERGENTE: ['#fee2e2', '#991b1b'],
    PENDENTE: ['#fef3c7', '#92400e'],
    EM_ANALISE: ['#dbeafe', '#1d4ed8'],
  };
  return mapa[status] || ['#e5e7eb', '#374151'];
}

function TelaConferenciaSaldos({ contas = [], token, onVoltar, onAtualizarContas }) {
  const contaInicial = contas[0]?.id || '';
  const [contaId, setContaId] = useState(contaInicial);
  const [dataReferencia, setDataReferencia] = useState(dataLocalISO(new Date()));
  const [periodoInicial, setPeriodoInicial] = useState('');
  const [periodoFinal, setPeriodoFinal] = useState(dataLocalISO(new Date()));
  const [tolerancia, setTolerancia] = useState('0,01');
  const [saldoReal, setSaldoReal] = useState('');
  const [observacao, setObservacao] = useState('');
  const [saldoInicial, setSaldoInicial] = useState('0,00');
  const [dataSaldoInicial, setDataSaldoInicial] = useState(dataLocalISO(new Date()));
  const [calculo, setCalculo] = useState(null);
  const [conferencia, setConferencia] = useState(null);
  const [diagnostico, setDiagnostico] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [carregando, setCarregando] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };
  const nomesMesesCurtos = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const contaSelecionada = contas.find((conta) => conta.id === contaId);

  useEffect(() => {
    if (contaSelecionada) {
      setSaldoInicial(String(contaSelecionada.saldo_inicial ?? contaSelecionada.saldoInicial ?? 0).replace('.', ','));
      setDataSaldoInicial((contaSelecionada.data_saldo_inicial || contaSelecionada.dataSaldoInicial || dataLocalISO(new Date())).slice(0, 10));
      setPeriodoInicial((contaSelecionada.data_saldo_inicial || contaSelecionada.dataSaldoInicial || '').slice(0, 10));
    }
  }, [contaId, contas.length]);

  useEffect(() => {
    carregarHistorico();
  }, [contaId]);

  const numeroFormulario = (valor, fallback = 0) => {
    const parse = parseValorMonetario(valor);
    return Number.isFinite(parse.valor) ? parse.valor : fallback;
  };

  const salvarSaldoInicial = async () => {
    if (!contaId) return alert('Selecione uma conta.');
    if (!dataSaldoInicial) return alert('Informe a data do saldo inicial.');
    setCarregando(true);
    try {
      await axios.patch(`${API_URL}/contas/${contaId}/saldo-inicial`, {
        saldoInicial: numeroFormulario(saldoInicial, 0),
        dataSaldoInicial,
      }, { headers: authHeaders });
      alert('Saldo inicial salvo.');
      await onAtualizarContas?.();
      await calcularSaldo();
    } catch (error) {
      alert(error.response?.data?.detalhes || error.response?.data?.erro || error.message);
    } finally {
      setCarregando(false);
    }
  };

  const calcularSaldo = async () => {
    if (!contaId) return alert('Selecione uma conta.');
    if (!dataReferencia) return alert('Informe a data de referência.');
    setCarregando(true);
    setDiagnostico(null);
    try {
      const response = await axios.get(`${API_URL}/conferencia-saldos/calcular`, {
        headers: authHeaders,
        params: { contaId, dataReferencia },
      });
      setCalculo(response.data);
      setPeriodoInicial(response.data.dataSaldoInicial || periodoInicial);
      setPeriodoFinal(response.data.dataReferencia || dataReferencia);
    } catch (error) {
      alert(error.response?.data?.detalhes || error.response?.data?.erro || error.message);
    } finally {
      setCarregando(false);
    }
  };

  const salvarConferencia = async () => {
    if (!calculo?.saldoInicialConfigurado) return alert('Cadastre o saldo inicial antes de salvar a conferência.');
    const saldoRealNumero = numeroFormulario(saldoReal, NaN);
    if (!Number.isFinite(saldoRealNumero)) return alert('Informe um saldo real válido.');
    setCarregando(true);
    try {
      const response = await axios.post(`${API_URL}/conferencia-saldos`, {
        contaId,
        dataReferencia,
        saldoReal: saldoRealNumero,
        observacao,
        tolerancia: Math.abs(numeroFormulario(tolerancia, 0.01)),
      }, { headers: authHeaders });
      setConferencia(response.data);
      await carregarHistorico();
      if (response.data.status === 'DIVERGENTE') {
        await analisarDivergencia(response.data);
      } else {
        setDiagnostico(null);
      }
    } catch (error) {
      alert(error.response?.data?.detalhes || error.response?.data?.erro || error.message);
    } finally {
      setCarregando(false);
    }
  };

  const analisarDivergencia = async (base = conferencia) => {
    const saldoCalculado = Number(base?.saldo_calculado ?? base?.saldoCalculado ?? calculo?.saldoCalculado ?? 0);
    const saldoRealNumero = Number(base?.saldo_real ?? base?.saldoReal ?? numeroFormulario(saldoReal, 0));
    const diferenca = Number(base?.diferenca ?? (saldoRealNumero - saldoCalculado));
    setCarregando(true);
    try {
      const response = await axios.post(`${API_URL}/conferencia-saldos/analisar`, {
        contaId,
        dataReferencia,
        saldoReal: saldoRealNumero,
        saldoCalculado,
        diferenca,
      }, { headers: authHeaders });
      setDiagnostico(response.data);
    } catch (error) {
      alert(error.response?.data?.detalhes || error.response?.data?.erro || error.message);
    } finally {
      setCarregando(false);
    }
  };

  const carregarHistorico = async () => {
    if (!contaId) return;
    try {
      const response = await axios.get(`${API_URL}/conferencia-saldos/historico`, {
        headers: authHeaders,
        params: { contaId },
      });
      setHistorico(response.data.conferencias || []);
    } catch (error) {
      console.error('Erro ao carregar histórico de conferências:', error);
    }
  };

  const resultadoAtual = conferencia || (calculo && Number.isFinite(numeroFormulario(saldoReal, NaN)) ? {
    saldo_real: numeroFormulario(saldoReal, 0),
    saldo_calculado: calculo.saldoCalculado,
    diferenca: Number.isFinite(Number(calculo.saldoCalculado)) ? numeroFormulario(saldoReal, 0) - Number(calculo.saldoCalculado) : null,
    status: Math.abs((numeroFormulario(saldoReal, 0) - Number(calculo.saldoCalculado || 0))) <= Math.abs(numeroFormulario(tolerancia, 0.01)) ? 'CONCILIADO' : 'DIVERGENTE',
  } : null);

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: '20px' }}>
      <button onClick={onVoltar} style={{ background: '#e5e7eb', border: 'none', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer' }}>← Voltar</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '14px 0 4px' }}>🏦 Conferência de Saldos Bancários</h1>
          <p style={{ color: '#64748b', marginTop: 0 }}>Compare o saldo calculado pelo app com o saldo real do banco e veja diagnósticos automáticos de divergência.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px', marginBottom: '16px' }}>
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px' }}>
          <h3 style={{ marginTop: 0 }}>Filtros da conferência</h3>
          <div style={{ display: 'grid', gap: '10px' }}>
            <label>Conta<select value={contaId} onChange={(e) => { setContaId(e.target.value); setCalculo(null); setConferencia(null); setDiagnostico(null); }} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}>{contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
            <label>Data de referência<input type="date" value={dataReferencia} onChange={(e) => { setDataReferencia(e.target.value); setConferencia(null); setDiagnostico(null); }} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} /></label>
            <label>Período inicial<input type="date" value={periodoInicial} onChange={(e) => setPeriodoInicial(e.target.value)} disabled style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', background: '#f8fafc' }} /></label>
            <label>Período final<input type="date" value={periodoFinal} onChange={(e) => setPeriodoFinal(e.target.value)} disabled style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', background: '#f8fafc' }} /></label>
            <label>Tolerância de diferença<input value={tolerancia} onChange={(e) => setTolerancia(e.target.value)} placeholder="0,01" style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} /></label>
            <button onClick={calcularSaldo} disabled={carregando || !contaId} style={{ background: '#2563eb', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: 'pointer' }}>Calcular saldo</button>
          </div>
        </div>

        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px' }}>
          <h3 style={{ marginTop: 0 }}>Saldo inicial da conta</h3>
          {!contaSelecionada?.data_saldo_inicial && !contaSelecionada?.dataSaldoInicial && (
            <p style={{ background: '#fffbeb', color: '#92400e', padding: '10px', borderRadius: '8px' }}>Esta conta ainda não possui saldo inicial configurado. Cadastre um saldo inicial para permitir a conferência.</p>
          )}
          <div style={{ display: 'grid', gap: '10px' }}>
            <label>Saldo inicial<input value={saldoInicial} onChange={(e) => setSaldoInicial(e.target.value)} placeholder="0,00" style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} /></label>
            <label>Data saldo inicial<input type="date" value={dataSaldoInicial} onChange={(e) => setDataSaldoInicial(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} /></label>
            <button onClick={salvarSaldoInicial} disabled={carregando || !contaId} style={{ background: '#0f766e', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: 'pointer' }}>Salvar saldo inicial</button>
          </div>
        </div>

        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px' }}>
          <h3 style={{ marginTop: 0 }}>Saldo real do banco</h3>
          <div style={{ display: 'grid', gap: '10px' }}>
            <label>Saldo real informado<input value={saldoReal} onChange={(e) => { setSaldoReal(e.target.value); setConferencia(null); }} placeholder="-516,87" style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} /></label>
            <label>Observação<textarea value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Saldo conferido no extrato" rows={3} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} /></label>
            <button onClick={salvarConferencia} disabled={carregando || !calculo?.saldoInicialConfigurado} style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: 'pointer', opacity: calculo?.saldoInicialConfigurado ? 1 : 0.6 }}>Salvar conferência</button>
          </div>
        </div>
      </div>

      {carregando && <p>Processando...</p>}

      {calculo && !calculo.saldoInicialConfigurado && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>{calculo.mensagem}</div>
      )}

      {calculo?.saldoInicialConfigurado && (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
          <h3 style={{ marginTop: 0 }}>Resultado da conferência</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
            <KpiCard titulo="Saldo inicial" valor={formatarMoeda(calculo.saldoInicial)} detalhe={formatarData(calculo.dataSaldoInicial)} cor="#475569" fundo="#f8fafc" />
            <KpiCard titulo="Créditos no período" valor={formatarMoeda(calculo.totalCreditos)} detalhe={`${calculo.quantidadeTransacoes || 0} transação(ões)`} cor="#059669" fundo="#ecfdf5" />
            <KpiCard titulo="Débitos no período" valor={formatarMoeda(calculo.totalDebitos)} detalhe="Débitos importados" cor="#dc2626" fundo="#fef2f2" />
            <KpiCard titulo="Saldo calculado" valor={formatarMoeda(calculo.saldoCalculado)} detalhe="Saldo do app" cor="#2563eb" fundo="#eff6ff" />
            {resultadoAtual && <KpiCard titulo="Saldo real" valor={formatarMoeda(resultadoAtual.saldo_real)} detalhe="Informado pelo usuário" cor="#7c3aed" fundo="#f5f3ff" />}
            {resultadoAtual && <KpiCard titulo="Diferença" valor={formatarMoeda(resultadoAtual.diferenca)} detalhe="Real - calculado" cor={Math.abs(Number(resultadoAtual.diferenca || 0)) <= numeroFormulario(tolerancia, 0.01) ? '#059669' : '#dc2626'} fundo={Math.abs(Number(resultadoAtual.diferenca || 0)) <= numeroFormulario(tolerancia, 0.01) ? '#ecfdf5' : '#fef2f2'} />}
          </div>

          {resultadoAtual && (
            <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {(() => { const [bg, cor] = badgeStatusConferencia(resultadoAtual.status); return <span style={{ background: bg, color: cor, padding: '6px 10px', borderRadius: '999px', fontWeight: 'bold' }}>{resultadoAtual.status}</span>; })()}
              {resultadoAtual.status === 'CONCILIADO' ? <strong style={{ color: '#166534' }}>Saldo conciliado com sucesso.</strong> : <strong style={{ color: '#991b1b' }}>Saldo divergente: revise a diferença e execute a análise inteligente.</strong>}
              {resultadoAtual.status === 'DIVERGENTE' && <button onClick={() => analisarDivergencia(resultadoAtual)} style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '9px 12px', borderRadius: '8px', cursor: 'pointer' }}>Analisar divergência</button>}
            </div>
          )}
        </div>
      )}

      {diagnostico && (
        <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
          <h3 style={{ marginTop: 0 }}>Análise inteligente</h3>
          <p style={{ color: '#3730a3' }}>{diagnostico.resumoIA}</p>
          <div style={{ display: 'grid', gap: '10px' }}>
            {(diagnostico.diagnosticos || []).map((item, index) => (
              <div key={`${item.tipo}-${index}`} style={{ background: 'white', border: '1px solid #c7d2fe', borderRadius: '10px', padding: '12px' }}>
                <strong>{index + 1}. {item.tipo} · {item.severidade}</strong>
                <p style={{ margin: '6px 0', color: '#334155' }}>{item.descricao}</p>
                {(item.acoesSugeridas || []).length > 0 && <p style={{ margin: '6px 0', color: '#475569' }}><strong>Ação sugerida:</strong> {item.acoesSugeridas.join(' ')}</p>}
                {(item.transacoesRelacionadas || []).length > 0 && (
                  <div style={{ overflowX: 'auto', marginTop: '8px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                      <thead><tr><th style={{ textAlign: 'left', padding: '6px' }}>Data</th><th style={{ textAlign: 'left', padding: '6px' }}>Conta</th><th style={{ textAlign: 'left', padding: '6px' }}>Descrição</th><th style={{ textAlign: 'right', padding: '6px' }}>Valor</th><th style={{ textAlign: 'left', padding: '6px' }}>Tipo</th></tr></thead>
                      <tbody>{item.transacoesRelacionadas.map((tx, idx) => <tr key={`${tx.id || idx}-${idx}`} style={{ borderTop: '1px solid #e0e7ff' }}><td style={{ padding: '6px' }}>{formatarData(tx.data)}</td><td style={{ padding: '6px' }}>{tx.contaNome || '-'}</td><td style={{ padding: '6px' }}>{tx.descricao}</td><td style={{ padding: '6px', textAlign: 'right' }}>{formatarMoeda(tx.valor)}</td><td style={{ padding: '6px' }}>{tx.tipo}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px' }}>
        <h3 style={{ marginTop: 0 }}>Histórico de conferências</h3>
        {historico.length === 0 ? <p style={{ color: '#64748b' }}>Nenhuma conferência salva para esta conta.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr><th style={{ textAlign: 'left', padding: '8px' }}>Data referência</th><th style={{ textAlign: 'left', padding: '8px' }}>Conta</th><th style={{ textAlign: 'right', padding: '8px' }}>Saldo real</th><th style={{ textAlign: 'right', padding: '8px' }}>Saldo calculado</th><th style={{ textAlign: 'right', padding: '8px' }}>Diferença</th><th style={{ textAlign: 'left', padding: '8px' }}>Status</th><th style={{ textAlign: 'left', padding: '8px' }}>Criado em</th></tr></thead>
              <tbody>{historico.map((item) => { const [bg, cor] = badgeStatusConferencia(item.status); return <tr key={item.id} style={{ borderTop: '1px solid #e5e7eb' }}><td style={{ padding: '8px' }}>{formatarData(item.data_referencia)}</td><td style={{ padding: '8px' }}>{item.conta_nome}</td><td style={{ padding: '8px', textAlign: 'right' }}>{formatarMoeda(item.saldo_real)}</td><td style={{ padding: '8px', textAlign: 'right' }}>{formatarMoeda(item.saldo_calculado)}</td><td style={{ padding: '8px', textAlign: 'right' }}>{formatarMoeda(item.diferenca)}</td><td style={{ padding: '8px' }}><span style={{ background: bg, color: cor, padding: '4px 8px', borderRadius: '999px', fontWeight: 'bold' }}>{item.status}</span></td><td style={{ padding: '8px' }}>{formatarData(item.criado_em)}</td></tr>; })}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function TelaProvisoes({ contas = [], token, onVoltar }) {
  const [provisoes, setProvisoes] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [transacoes, setTransacoes] = useState([]);
  const [filtros, setFiltros] = useState({ dataInicial: '', dataFinal: '', status: 'todos', tipo: 'todos', contaId: 'todas', categoriaMacroId: 'todas', categoriaDetalhadaId: 'todas', busca: '' });
  const [modalAberto, setModalAberto] = useState(false);
  const [editando, setEditando] = useState(null);
  const [form, setForm] = useState({ descricao: '', valorPrevisto: '', tipo: 'DEBITO', dataPrevista: dataLocalISO(new Date()), dataVencimento: '', contaId: '', categoriaMacroId: '', categoriaDetalhadaId: '', observacao: '', recorrente: false, periodicidade: '' });
  const [sugestoes, setSugestoes] = useState([]);
  const [provisaoConciliando, setProvisaoConciliando] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const authHeaders = { Authorization: `Bearer ${token}` };
  const nomesMesesCurtos = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  const categoriasMacro = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'MACRO');
  const categoriasDetalhadas = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'DETALHADA' && (!form.categoriaMacroId || cat.categoria_pai_id === form.categoriaMacroId));
  const categoriasDetalhadasFiltro = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'DETALHADA' && (filtros.categoriaMacroId === 'todas' || cat.categoria_pai_id === filtros.categoriaMacroId));

  const carregarDados = async () => {
    setCarregando(true);
    try {
      const params = new URLSearchParams();
      Object.entries(filtros).forEach(([chave, valor]) => { if (valor && valor !== 'todos' && valor !== 'todas') params.set(chave, valor); });
      const [provisoesResponse, categoriasResponse, transacoesResponse] = await Promise.all([
        axios.get(`${API_URL}/provisoes?${params.toString()}`, { headers: authHeaders }),
        axios.get(`${API_URL}/categorias`, { headers: authHeaders }),
        axios.get(`${API_URL}/transacoes`, { headers: authHeaders }),
      ]);
      setProvisoes(provisoesResponse.data.provisoes || []);
      setCategorias(categoriasResponse.data.categorias || []);
      setTransacoes(transacoesResponse.data.transacoes || []);
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregarDados(); }, []);

  const abrirNova = () => {
    setEditando(null);
    setForm({ descricao: '', valorPrevisto: '', tipo: 'DEBITO', dataPrevista: dataLocalISO(new Date()), dataVencimento: '', contaId: '', categoriaMacroId: '', categoriaDetalhadaId: '', observacao: '', recorrente: false, periodicidade: '' });
    setModalAberto(true);
  };

  const abrirEdicao = (provisao) => {
    setEditando(provisao);
    setForm({
      descricao: provisao.descricao || '',
      valorPrevisto: provisao.valor_previsto || '',
      tipo: provisao.tipo || 'DEBITO',
      dataPrevista: normalizarDataFiltro(provisao.data_prevista),
      dataVencimento: normalizarDataFiltro(provisao.data_vencimento),
      contaId: provisao.conta_id || '',
      categoriaMacroId: provisao.categoria_macro_id || '',
      categoriaDetalhadaId: provisao.categoria_detalhada_id || '',
      observacao: provisao.observacao || '',
      recorrente: Boolean(provisao.recorrente),
      periodicidade: provisao.periodicidade || '',
    });
    setModalAberto(true);
  };

  const salvarProvisao = async () => {
    try {
      const payload = { ...form, valorPrevisto: Number(form.valorPrevisto), contaId: form.contaId || null, categoriaMacroId: form.categoriaMacroId || null, categoriaDetalhadaId: form.categoriaDetalhadaId || null, dataVencimento: form.dataVencimento || null };
      if (editando) await axios.patch(`${API_URL}/provisoes/${editando.id}`, payload, { headers: authHeaders });
      else await axios.post(`${API_URL}/provisoes`, payload, { headers: authHeaders });
      setModalAberto(false);
      await carregarDados();
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const excluirProvisao = async (provisao) => {
    if (!window.confirm(`Excluir provisão "${provisao.descricao}"?`)) return;
    try {
      await axios.delete(`${API_URL}/provisoes/${provisao.id}${provisao.status === 'CONCILIADA' ? '?confirmar=true' : ''}`, { headers: authHeaders });
      await carregarDados();
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const atualizarStatus = async (provisao, status) => {
    try {
      await axios.patch(`${API_URL}/provisoes/${provisao.id}`, { status }, { headers: authHeaders });
      await carregarDados();
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const duplicarProvisao = async (provisao) => {
    try {
      await axios.post(`${API_URL}/provisoes/${provisao.id}/duplicar`, {}, { headers: authHeaders });
      await carregarDados();
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const abrirConciliacao = async (provisao) => {
    setProvisaoConciliando(provisao);
    setSugestoes([]);
    try {
      const dataPrevista = normalizarDataFiltro(provisao.data_prevista);
      const base = new Date(`${dataPrevista}T00:00:00Z`);
      const dataInicial = new Date(base); dataInicial.setUTCDate(base.getUTCDate() - 3);
      const dataFinal = new Date(base); dataFinal.setUTCDate(base.getUTCDate() + 3);
      const response = await axios.post(`${API_URL}/conciliacoes/sugerir`, { provisaoId: provisao.id, dataInicial: dataInicial.toISOString().slice(0, 10), dataFinal: dataFinal.toISOString().slice(0, 10) }, { headers: authHeaders });
      setSugestoes(response.data.sugestoes || []);
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const confirmarConciliacao = async (sugestao) => {
    try {
      await axios.post(`${API_URL}/conciliacoes/confirmar`, { provisaoId: sugestao.provisaoId, transacaoId: sugestao.transacaoId }, { headers: authHeaders });
      setProvisaoConciliando(null);
      await carregarDados();
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const ignorarSugestao = async (sugestao) => {
    try {
      await axios.post(`${API_URL}/conciliacoes/ignorar`, { provisaoId: sugestao.provisaoId, transacaoId: sugestao.transacaoId, confianca: sugestao.confianca, score: sugestao.score, motivos: sugestao.motivos }, { headers: authHeaders });
      setSugestoes((atuais) => atuais.filter((item) => item.transacaoId !== sugestao.transacaoId));
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const desfazerConciliacao = async (provisao) => {
    if (!provisao.conciliacao_id || !window.confirm('Desfazer conciliação desta provisão?')) return;
    try {
      await axios.post(`${API_URL}/conciliacoes/desfazer`, { conciliacaoId: provisao.conciliacao_id }, { headers: authHeaders });
      await carregarDados();
    } catch (error) {
      alert(error.response?.data?.erro || error.message);
    }
  };

  const aplicarFiltros = () => carregarDados();

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <div style={{ background: '#1f2937', color: 'white', padding: '20px' }}>
        <button onClick={onVoltar} style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer' }}>← Voltar</button>
        <h1 style={{ margin: '14px 0 4px' }}>📌 Provisões</h1>
        <p style={{ margin: 0, opacity: 0.8 }}>Cadastre valores previstos e confirme conciliações com transações reais.</p>
      </div>

      <div style={{ padding: '20px', maxWidth: '1280px', margin: '0 auto' }}>
        <div style={{ background: 'white', borderRadius: '14px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <h2 style={{ margin: 0 }}>Contas provisionadas</h2>
            <button onClick={abrirNova} style={{ background: '#2563eb', color: 'white', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>+ Nova provisão</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
            <input type="date" value={filtros.dataInicial} onChange={(e) => setFiltros({ ...filtros, dataInicial: e.target.value })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
            <input type="date" value={filtros.dataFinal} onChange={(e) => setFiltros({ ...filtros, dataFinal: e.target.value })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
            <select value={filtros.status} onChange={(e) => setFiltros({ ...filtros, status: e.target.value })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="todos">Todos status</option>{STATUS_PROVISAO_OPCOES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            <select value={filtros.tipo} onChange={(e) => setFiltros({ ...filtros, tipo: e.target.value })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="todos">Todos tipos</option><option value="CREDITO">Crédito</option><option value="DEBITO">Débito</option></select>
            <select value={filtros.contaId} onChange={(e) => setFiltros({ ...filtros, contaId: e.target.value })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="todas">Todas contas</option>{contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
            <select value={filtros.categoriaMacroId} onChange={(e) => setFiltros({ ...filtros, categoriaMacroId: e.target.value, categoriaDetalhadaId: 'todas' })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="todas">Todas macros</option>{categoriasMacro.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
            <select value={filtros.categoriaDetalhadaId} onChange={(e) => setFiltros({ ...filtros, categoriaDetalhadaId: e.target.value })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="todas">Todas detalhadas</option>{categoriasDetalhadasFiltro.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
            <input value={filtros.busca} onChange={(e) => setFiltros({ ...filtros, busca: e.target.value })} placeholder="Buscar descrição" style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
            <button onClick={aplicarFiltros} style={{ background: '#111827', color: 'white', border: 'none', padding: '10px', borderRadius: '8px', cursor: 'pointer' }}>Filtrar</button>
          </div>
        </div>

        <div style={{ background: 'white', borderRadius: '14px', overflowX: 'auto' }}>
          {carregando ? <p style={{ padding: '20px' }}>Carregando provisões...</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead style={{ background: '#f8fafc' }}><tr>{['Data prevista','Vencimento','Descrição','Conta','Valor previsto','Tipo','Categoria','Status','Transação conciliada','Ações'].map((h) => <th key={h} style={{ padding: '12px', textAlign: 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {provisoes.map((p) => {
                  const [bg, cor] = badgeStatusProvisao(p.status);
                  return (
                    <tr key={p.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '12px' }}>{formatarData(p.data_prevista)}</td>
                      <td style={{ padding: '12px' }}>{p.data_vencimento ? formatarData(p.data_vencimento) : '-'}</td>
                      <td style={{ padding: '12px' }}>{p.descricao}</td>
                      <td style={{ padding: '12px' }}>{p.conta_nome || '-'}</td>
                      <td style={{ padding: '12px', fontWeight: 'bold', color: p.tipo === 'CREDITO' ? '#059669' : '#dc2626' }}>{formatarMoeda(p.valor_previsto)}</td>
                      <td style={{ padding: '12px' }}>{p.tipo}</td>
                      <td style={{ padding: '12px' }}>{p.categoria_macro_nome || 'Sem categoria'}{p.categoria_detalhada_nome ? ` › ${p.categoria_detalhada_nome}` : ''}</td>
                      <td style={{ padding: '12px' }}><span style={{ background: bg, color: cor, padding: '4px 8px', borderRadius: '999px', fontSize: '12px', fontWeight: 'bold' }}>{p.status}</span></td>
                      <td style={{ padding: '12px' }}>{p.transacao_conciliada_id ? `${p.transacao_conciliada_descricao || 'Transação'} (${formatarData(p.transacao_conciliada_data)})` : '-'}</td>
                      <td style={{ padding: '12px' }}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button onClick={() => abrirEdicao(p)} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer' }}>Editar</button>
                          <button onClick={() => excluirProvisao(p)} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #dc2626', color: '#dc2626', background: 'white', cursor: 'pointer' }}>Excluir</button>
                          <button onClick={() => abrirConciliacao(p)} disabled={!['PENDENTE','ATRASADA'].includes(p.status)} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #2563eb', color: '#2563eb', background: 'white', cursor: ['PENDENTE','ATRASADA'].includes(p.status) ? 'pointer' : 'not-allowed' }}>Conciliar</button>
                          <button onClick={() => duplicarProvisao(p)} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #6b7280', background: 'white', cursor: 'pointer' }}>Duplicar</button>
                          {p.status !== 'CANCELADA' && <button onClick={() => atualizarStatus(p, 'CANCELADA')} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #6b7280', background: 'white', cursor: 'pointer' }}>Cancelar</button>}
                          {p.status !== 'IGNORADA' && <button onClick={() => atualizarStatus(p, 'IGNORADA')} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #7c3aed', color: '#7c3aed', background: 'white', cursor: 'pointer' }}>Ignorar</button>}
                          {p.conciliacao_id && <button onClick={() => desfazerConciliacao(p)} style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid #f59e0b', color: '#92400e', background: 'white', cursor: 'pointer' }}>Desfazer</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {provisoes.length === 0 && <tr><td colSpan="11" style={{ padding: '24px', textAlign: 'center', color: '#6b7280' }}>Nenhuma provisão encontrada.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modalAberto && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '24px', width: '92%', maxWidth: '680px', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ marginTop: 0 }}>{editando ? 'Editar provisão' : 'Nova provisão'}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
              <label>Descrição<input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', boxSizing: 'border-box' }} /></label>
              <label>Valor previsto<input type="number" min="0" step="0.01" value={form.valorPrevisto} onChange={(e) => setForm({ ...form, valorPrevisto: e.target.value })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', boxSizing: 'border-box' }} /></label>
              <label>Tipo<select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}>{TIPOS_PROVISAO_OPCOES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
              <label>Data prevista<input type="date" value={form.dataPrevista} onChange={(e) => setForm({ ...form, dataPrevista: e.target.value })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', boxSizing: 'border-box' }} /></label>
              <label>Data de vencimento<input type="date" value={form.dataVencimento} onChange={(e) => setForm({ ...form, dataVencimento: e.target.value })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', boxSizing: 'border-box' }} /></label>
              <label>Conta esperada<select value={form.contaId} onChange={(e) => setForm({ ...form, contaId: e.target.value })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="">Sem conta</option>{contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
              <label>Categoria macro<select value={form.categoriaMacroId} onChange={(e) => setForm({ ...form, categoriaMacroId: e.target.value, categoriaDetalhadaId: '' })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="">Sem macro</option>{categoriasMacro.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
              <label>Categoria detalhada<select value={form.categoriaDetalhadaId} onChange={(e) => setForm({ ...form, categoriaDetalhadaId: e.target.value })} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="">Sem detalhamento</option>{categoriasDetalhadas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>
            </div>
            <label style={{ display: 'block', marginTop: '12px' }}>Observação<textarea value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} rows="3" style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px', boxSizing: 'border-box' }} /></label>
            <label style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' }}><input type="checkbox" checked={form.recorrente} onChange={(e) => setForm({ ...form, recorrente: e.target.checked })} /> Recorrente</label>
            {form.recorrente && <select value={form.periodicidade} onChange={(e) => setForm({ ...form, periodicidade: e.target.value })} style={{ marginTop: '8px', padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }}><option value="">Periodicidade</option><option value="SEMANAL">Semanal</option><option value="MENSAL">Mensal</option><option value="ANUAL">Anual</option></select>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }}>
              <button onClick={() => setModalAberto(false)} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#e5e7eb', cursor: 'pointer' }}>Cancelar</button>
              <button onClick={salvarProvisao} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer' }}>Salvar</button>
            </div>
          </div>
        </div>
      )}

      {provisaoConciliando && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '24px', width: '92%', maxWidth: '900px', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ marginTop: 0 }}>Conciliar: {provisaoConciliando.descricao}</h2>
            <p style={{ color: '#6b7280' }}>Escolha uma transação candidata. A conciliação só será aplicada após confirmação.</p>
            <div style={{ display: 'grid', gap: '10px' }}>
              {sugestoes.map((s) => (
                <div key={s.transacaoId} style={{ border: '1px solid #d1d5db', borderRadius: '10px', padding: '12px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
                    <strong>{s.transacao.descricao}</strong>
                    <span>{formatarData(s.transacao.data)} • {formatarMoeda(s.transacao.valor)}</span>
                    <span>{s.transacao.conta_nome || 'Conta'} • {s.transacao.categoria_macro_nome || 'Sem categoria'}</span>
                    <span>{s.confianca} ({Number(s.score || 0).toFixed(2)})</span>
                  </div>
                  <small style={{ color: '#6b7280' }}>{(s.motivos || []).join(' • ')}</small>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button onClick={() => confirmarConciliacao(s)} style={{ background: '#16a34a', color: 'white', border: 'none', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Confirmar conciliação</button>
                    <button onClick={() => ignorarSugestao(s)} style={{ background: 'white', color: '#6b7280', border: '1px solid #6b7280', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer' }}>Ignorar sugestão</button>
                  </div>
                </div>
              ))}
              {sugestoes.length === 0 && <p style={{ color: '#6b7280' }}>Nenhuma transação candidata encontrada pelos critérios iniciais.</p>}
            </div>
            <button onClick={() => setProvisaoConciliando(null)} style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#e5e7eb', cursor: 'pointer' }}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// TELA DE TRANSAÇÕES
// ============================================================================

function TelaTransacoes({ contaInicial, contas = [], token, onVoltar, onAtualizarContas }) {
  const [transacoes, setTransacoes] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [categoriaModalAberta, setCategoriaModalAberta] = useState(false);
  const [transacaoSelecionada, setTransacaoSelecionada] = useState(null);
  const [selecionadas, setSelecionadas] = useState([]);
  const [filtros, setFiltros] = useState({ busca: '', conta: contaInicial?.id || 'todas', categoriaMacro: 'todas', categoriaDetalhada: 'todas', status: 'todas', tipo: 'todos' });
  const [dataInicial, setDataInicial] = useState('');
  const [dataFinal, setDataFinal] = useState('');
  const [categoriaMacroEscolhida, setCategoriaMacroEscolhida] = useState('');
  const [categoriaDetalhadaEscolhida, setCategoriaDetalhadaEscolhida] = useState('');
  const [criarRegra, setCriarRegra] = useState(false);
  const [termoRegra, setTermoRegra] = useState('');
  const [salvandoCategoria, setSalvandoCategoria] = useState(false);
  const [transacaoParaExcluir, setTransacaoParaExcluir] = useState(null);
  const [modalExclusaoAberto, setModalExclusaoAberto] = useState(false);
  const [excluindoTransacao, setExcluindoTransacao] = useState(false);
  const [modalTransferenciasAberto, setModalTransferenciasAberto] = useState(false);
  const [sugestoesTransferencia, setSugestoesTransferencia] = useState([]);
  const [carregandoSugestoes, setCarregandoSugestoes] = useState(false);
  const [marcandoTransferencia, setMarcandoTransferencia] = useState(null);
  const [sortField, setSortField] = useState('data');
  const [sortDirection, setSortDirection] = useState('desc');
  const [sortIsDefault, setSortIsDefault] = useState(true);
  const [modalSaldoInicialAberto, setModalSaldoInicialAberto] = useState(false);
  const [formSaldoInicial, setFormSaldoInicial] = useState({ dataSaldoInicial: '', saldoInicial: '', observacao: '' });
  const [salvandoSaldoInicial, setSalvandoSaldoInicial] = useState(false);
  const [modalConferenciaRapidaAberto, setModalConferenciaRapidaAberto] = useState(false);
  const [saldoRealConferencia, setSaldoRealConferencia] = useState('');
  const [resultadoConferenciaRapida, setResultadoConferenciaRapida] = useState(null);
  const [salvandoConferenciaRapida, setSalvandoConferenciaRapida] = useState(false);
  const [destacarInicioBase, setDestacarInicioBase] = useState(false);
  const tabelaRef = useRef(null);

  useEffect(() => {
    carregarDados();
  }, []);

  const authHeaders = {
    Authorization: `Bearer ${token}`
  };

  const carregarDados = async () => {
    setCarregando(true);

    try {
      const [transacoesResponse, categoriasResponse] = await Promise.all([
        axios.get(`${API_URL}/transacoes`, { headers: authHeaders }),
        axios.get(`${API_URL}/categorias`, { headers: authHeaders })
      ]);

      setTransacoes(transacoesResponse.data.transacoes || []);
      const categoriasUnicas = Array.from(
        new Map((categoriasResponse.data.categorias || []).map((categoria) => [
          `${categoria.nome}-${categoria.tipo}-${categoria.nivel || (categoria.categoria_pai_id ? 'DETALHADA' : 'MACRO')}-${categoria.categoria_pai_id || 'raiz'}-${categoria.usuario_id || 'padrao'}`,
          categoria,
        ])).values()
      );
      setCategorias(categoriasUnicas);
    } catch (error) {
      alert('Erro ao carregar transações: ' + (error.response?.data?.erro || error.message));
    } finally {
      setCarregando(false);
    }
  };

  const compararCronologicoSaldo = (a, b) => {
    const dataA = normalizarDataFiltro(a.data) || '';
    const dataB = normalizarDataFiltro(b.data) || '';
    if (dataA !== dataB) return dataA.localeCompare(dataB);
    const criadoA = String(a.criado_em || a.atualizado_em || '');
    const criadoB = String(b.criado_em || b.atualizado_em || '');
    if (criadoA !== criadoB) return criadoA.localeCompare(criadoB);
    return String(a.id || '').localeCompare(String(b.id || ''));
  };

  const calcularSaldoAntesDaData = (contaId, dataCorte) => {
    const conta = contas.find((item) => item.id === contaId);
    const dataSaldoInicial = normalizarDataFiltro(conta?.data_saldo_inicial || conta?.dataSaldoInicial);
    if (!conta || !dataSaldoInicial || !dataCorte) return null;
    return transacoes
      .filter((tx) => tx.conta_id === contaId)
      .sort(compararCronologicoSaldo)
      .reduce((saldo, tx) => {
        const dataTx = normalizarDataFiltro(tx.data);
        if (!dataTx || dataTx < dataSaldoInicial || dataTx >= dataCorte) return saldo;
        return saldo + (tx.tipo === 'CREDITO' ? Number(tx.valor || 0) : -Number(tx.valor || 0));
      }, Number(conta.saldo_inicial || 0));
  };

  const transacoesComSaldo = useMemo(() => {
    const contasPorId = new Map(contas.map((conta) => [conta.id, conta]));
    const transacoesPorConta = transacoes.reduce((mapa, tx) => {
      if (!mapa.has(tx.conta_id)) mapa.set(tx.conta_id, []);
      mapa.get(tx.conta_id).push(tx);
      return mapa;
    }, new Map());
    const saldosPorTransacao = new Map();

    transacoesPorConta.forEach((items, contaId) => {
      const conta = contasPorId.get(contaId);
      const dataSaldoInicial = normalizarDataFiltro(conta?.data_saldo_inicial || conta?.dataSaldoInicial);
      if (!conta || !dataSaldoInicial) {
        items.forEach((tx) => saldosPorTransacao.set(tx.id, { configurado: false, saldo: null }));
        return;
      }

      let saldo = Number(conta.saldo_inicial || 0);
      [...items].sort(compararCronologicoSaldo).forEach((tx) => {
        const dataTx = normalizarDataFiltro(tx.data);
        if (!dataTx || dataTx < dataSaldoInicial) {
          saldosPorTransacao.set(tx.id, { configurado: true, saldo: null });
          return;
        }
        saldo += tx.tipo === 'CREDITO' ? Number(tx.valor || 0) : -Number(tx.valor || 0);
        saldosPorTransacao.set(tx.id, { configurado: true, saldo: Math.round((saldo + Number.EPSILON) * 100) / 100 });
      });
    });

    return transacoes.map((tx) => {
      const saldo = saldosPorTransacao.get(tx.id) || { configurado: false, saldo: null };
      const saldoBackend = Number(tx.saldo_acumulado);
      return {
        ...tx,
        saldo_acumulado_calculado: Number.isFinite(saldoBackend) ? saldoBackend : saldo.saldo,
        saldo_acumulado_configurado: saldo.configurado || Number.isFinite(saldoBackend),
      };
    });
  }, [transacoes, contas]);

  const transacoesFiltradas = useMemo(() => {
    const buscaNormalizada = normalizarDescricaoCategorizacao(filtros.busca);

    return transacoesComSaldo.filter((tx) => {
      const descricao = normalizarDescricaoCategorizacao(tx.descricao);
      const dataTx = normalizarDataFiltro(tx.data);
      const correspondeBusca = !buscaNormalizada || descricao.includes(buscaNormalizada);
      const correspondeConta = filtros.conta === 'todas' || tx.conta_id === filtros.conta;
      const correspondeMacro = filtros.categoriaMacro === 'todas'
        || (filtros.categoriaMacro === 'sem' && !tx.categoria_macro_id && !tx.categoria_id)
        || tx.categoria_macro_id === filtros.categoriaMacro
        || (!tx.categoria_macro_id && tx.categoria_id === filtros.categoriaMacro);
      const correspondeDetalhada = filtros.categoriaDetalhada === 'todas'
        || (filtros.categoriaDetalhada === 'sem' && !tx.categoria_detalhada_id)
        || tx.categoria_detalhada_id === filtros.categoriaDetalhada;
      const correspondeStatus = filtros.status === 'todas'
        || (filtros.status === 'sem' && !tx.categoria_macro_id && !tx.categoria_id)
        || (filtros.status === 'categorizadas' && Boolean(tx.categoria_macro_id || tx.categoria_id));
      const correspondeTipo = filtros.tipo === 'todos' || tx.tipo === filtros.tipo;
      const correspondeDataInicial = !dataInicial || dataTx >= dataInicial;
      const correspondeDataFinal = !dataFinal || dataTx <= dataFinal;

      return correspondeBusca && correspondeConta && correspondeMacro && correspondeDetalhada && correspondeStatus && correspondeTipo && correspondeDataInicial && correspondeDataFinal;
    });
  }, [transacoesComSaldo, filtros, dataInicial, dataFinal]);

  const idsFiltrados = transacoesFiltradas.map((tx) => tx.id);
  const todasFiltradasSelecionadas = idsFiltrados.length > 0 && idsFiltrados.every((id) => selecionadas.includes(id));
  const categoriasMacro = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'MACRO');
  const categoriasDetalhadasModal = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'DETALHADA' && cat.categoria_pai_id === categoriaMacroEscolhida);
  const categoriasDetalhadasFiltro = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'DETALHADA' && (filtros.categoriaMacro === 'todas' || cat.categoria_pai_id === filtros.categoriaMacro));
  const nomeCategoriaMacro = (tx) => tx.categoria_macro_nome || (!tx.categoria_detalhada_id ? tx.categoria_nome : '') || 'Sem categoria';
  const nomeCategoriaDetalhada = (tx) => tx.categoria_detalhada_nome || (tx.categoria_detalhada_id ? tx.categoria_nome : '') || '-';
  const textoStatusFlags = (tx) => [
    tx.eh_transferencia_interna ? 'Transferência interna' : '',
    tx.conciliacao_id ? 'Conciliada' : '',
  ].filter(Boolean).join(' ') || '-';
  const contaSelecionadaFiltro = filtros.conta !== 'todas' ? contas.find((conta) => conta.id === filtros.conta) : null;
  const dataAnteriorISO = (data) => {
    if (!data) return dataLocalISO(new Date());
    const d = new Date(`${normalizarDataFiltro(data)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dataLocalISO(new Date());
    d.setDate(d.getDate() - 1);
    return dataLocalISO(d);
  };
  const estiloBadgeCategoria = (origem) => ({
    background: origem === 'AUTO' ? '#dbeafe' : '#e5e7eb',
    color: origem === 'AUTO' ? '#1d4ed8' : '#374151',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    display: 'inline-block',
  });

  const valorOrdenacao = (tx, campo) => {
    if (campo === 'data') return normalizarDataFiltro(tx.data) || '';
    if (campo === 'conta') return tx.conta_nome || '';
    if (campo === 'descricao') return tx.descricao || '';
    if (campo === 'valor') return Number(tx.valor || 0);
    if (campo === 'tipo') return tx.tipo === 'CREDITO' ? 'Crédito' : 'Débito';
    if (campo === 'categoriaMacro') return nomeCategoriaMacro(tx);
    if (campo === 'categoriaDetalhada') return nomeCategoriaDetalhada(tx);
    if (campo === 'status') return textoStatusFlags(tx);
    return '';
  };

  const compararTransacoes = (a, b, campo, direcao) => {
    const valorA = valorOrdenacao(a, campo);
    const valorB = valorOrdenacao(b, campo);
    const vazioA = valorA === null || valorA === undefined || valorA === '' || valorA === '-';
    const vazioB = valorB === null || valorB === undefined || valorB === '' || valorB === '-';
    if (vazioA && vazioB) return 0;
    if (vazioA) return 1;
    if (vazioB) return -1;

    let comparacao;
    if (campo === 'valor') comparacao = Number(valorA) - Number(valorB);
    else comparacao = String(valorA).localeCompare(String(valorB), 'pt-BR', { numeric: true, sensitivity: 'base' });

    return direcao === 'desc' ? -comparacao : comparacao;
  };

  const transacoesOrdenadas = useMemo(() => {
    const campo = sortField || 'data';
    const direcao = sortDirection || 'desc';
    return [...transacoesFiltradas].sort((a, b) => compararTransacoes(a, b, campo, direcao));
  }, [transacoesFiltradas, sortField, sortDirection]);

  const resumoBase = useMemo(() => {
    if (transacoesFiltradas.length === 0) return null;
    const porDataAsc = [...transacoesFiltradas].sort((a, b) => compararTransacoes(a, b, 'data', 'asc'));
    const totalCreditos = transacoesFiltradas.filter((tx) => tx.tipo === 'CREDITO').reduce((soma, tx) => soma + Number(tx.valor || 0), 0);
    const totalDebitos = transacoesFiltradas.filter((tx) => tx.tipo === 'DEBITO').reduce((soma, tx) => soma + Number(tx.valor || 0), 0);
    const porConta = Array.from(transacoesFiltradas.reduce((mapa, tx) => {
      const chave = tx.conta_id || 'sem-conta';
      if (!mapa.has(chave)) mapa.set(chave, { contaId: tx.conta_id, contaNome: tx.conta_nome || 'Conta', transacoes: [] });
      mapa.get(chave).transacoes.push(tx);
      return mapa;
    }, new Map()).values()).map((item) => {
      const ordenadas = [...item.transacoes].sort((a, b) => compararTransacoes(a, b, 'data', 'asc'));
      const conta = contas.find((contaItem) => contaItem.id === item.contaId);
      const dataReferenciaAntes = dataInicial || normalizarDataFiltro(ordenadas[0]?.data);
      const saldoAntesPeriodo = calcularSaldoAntesDaData(item.contaId, dataReferenciaAntes);
      const ultimaComSaldo = [...ordenadas].reverse().find((tx) => Number.isFinite(tx.saldo_acumulado_calculado));
      return {
        ...item,
        conta,
        primeira: ordenadas[0],
        ultima: ordenadas[ordenadas.length - 1],
        quantidade: item.transacoes.length,
        saldoInicial: conta?.saldo_inicial ?? null,
        dataSaldoInicial: conta?.data_saldo_inicial || conta?.dataSaldoInicial || null,
        saldoAntesPeriodo,
        saldoFinalCalculado: ultimaComSaldo?.saldo_acumulado_calculado ?? saldoAntesPeriodo,
      };
    }).sort((a, b) => String(a.contaNome).localeCompare(String(b.contaNome), 'pt-BR'));
    const contaResumo = contaSelecionadaFiltro ? porConta.find((item) => item.contaId === contaSelecionadaFiltro.id) : null;
    const contasComSaldo = porConta.filter((item) => item.dataSaldoInicial);

    return {
      primeira: porDataAsc[0],
      ultima: porDataAsc[porDataAsc.length - 1],
      quantidade: transacoesFiltradas.length,
      saldoCalculadoPeriodo: totalCreditos - totalDebitos,
      saldoInicial: contaResumo?.saldoInicial ?? null,
      dataSaldoInicial: contaResumo?.dataSaldoInicial ?? null,
      saldoAntesPeriodo: contaResumo?.saldoAntesPeriodo ?? null,
      saldoFinalCalculado: contaResumo?.saldoFinalCalculado ?? null,
      saldoFinalConsolidado: contasComSaldo.reduce((total, item) => total + Number(item.saldoFinalCalculado || 0), 0),
      porConta,
    };
  }, [transacoesFiltradas, contas, dataInicial, contaSelecionadaFiltro]);

  const primeiraTransacaoBase = resumoBase?.primeira || null;

  const handleSort = (field) => {
    setDestacarInicioBase(false);
    if (sortIsDefault || sortField !== field) {
      setSortField(field);
      setSortDirection('asc');
      setSortIsDefault(false);
      return;
    }
    if (sortDirection === 'asc') {
      setSortDirection('desc');
      setSortIsDefault(false);
      return;
    }
    setSortField('data');
    setSortDirection('desc');
    setSortIsDefault(true);
  };

  const rotuloOrdenacao = (label, field) => `${label}${sortField === field ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : ''}`;
  const estiloCabecalhoOrdenavel = (align = 'left') => ({ padding: '12px', textAlign: align, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' });
  const textoSaldoAcumulado = (tx) => {
    if (!tx.saldo_acumulado_configurado) return 'Não configurado';
    return Number.isFinite(tx.saldo_acumulado_calculado) ? formatarMoeda(tx.saldo_acumulado_calculado) : '-';
  };

  const verInicioBase = () => {
    setSortField('data');
    setSortDirection('asc');
    setSortIsDefault(false);
    setDestacarInicioBase(true);
    setTimeout(() => tabelaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const abrirModalSaldoInicial = () => {
    if (!contaSelecionadaFiltro) return alert('Selecione uma conta específica para configurar o saldo inicial.');
    if (!primeiraTransacaoBase) return alert('Não há transações para sugerir o início da base desta conta.');
    setFormSaldoInicial({
      dataSaldoInicial: dataAnteriorISO(primeiraTransacaoBase.data),
      saldoInicial: String(contaSelecionadaFiltro.saldo_inicial ?? 0).replace('.', ','),
      observacao: '',
    });
    setModalSaldoInicialAberto(true);
  };

  const salvarSaldoInicialConta = async () => {
    if (!contaSelecionadaFiltro) return;
    const parse = parseValorMonetario(formSaldoInicial.saldoInicial);
    if (!Number.isFinite(parse.valor)) return alert('Informe um saldo inicial válido.');
    if (!formSaldoInicial.dataSaldoInicial) return alert('Informe a data do saldo inicial.');
    setSalvandoSaldoInicial(true);
    try {
      await axios.patch(`${API_URL}/contas/${contaSelecionadaFiltro.id}/saldo-inicial`, {
        saldoInicial: parse.valor,
        dataSaldoInicial: formSaldoInicial.dataSaldoInicial,
        observacao: formSaldoInicial.observacao,
      }, { headers: authHeaders });
      alert('Saldo inicial salvo.');
      setModalSaldoInicialAberto(false);
      await onAtualizarContas?.();
      await carregarDados();
    } catch (error) {
      alert(error.response?.data?.detalhes || error.response?.data?.erro || error.message);
    } finally {
      setSalvandoSaldoInicial(false);
    }
  };

  const salvarConferenciaRapida = async () => {
    if (!contaSelecionadaFiltro || !resumoBase) return;
    const saldoRealParse = parseValorMonetario(saldoRealConferencia);
    if (!Number.isFinite(saldoRealParse.valor)) return alert('Informe um saldo real válido.');
    setSalvandoConferenciaRapida(true);
    try {
      const response = await axios.post(`${API_URL}/conferencia-saldos`, {
        contaId: contaSelecionadaFiltro.id,
        dataReferencia: normalizarDataFiltro(dataFinal || resumoBase.ultima.data),
        saldoReal: saldoRealParse.valor,
        observacao: 'Conferência rápida pela tela de transações consolidadas',
      }, { headers: authHeaders });
      setResultadoConferenciaRapida(response.data);
      await onAtualizarContas?.();
    } catch (error) {
      alert(error.response?.data?.detalhes || error.response?.data?.erro || error.message);
    } finally {
      setSalvandoConferenciaRapida(false);
    }
  };

  const abrirModalIndividual = (tx) => {
    setTransacaoSelecionada(tx);
    setCategoriaMacroEscolhida(tx.categoria_macro_id || (tx.categoria_detalhada_id ? '' : tx.categoria_id) || '');
    setCategoriaDetalhadaEscolhida(tx.categoria_detalhada_id || '');
    setCriarRegra(false);
    setTermoRegra(sugerirTermoRegra(tx.descricao));
    setCategoriaModalAberta(true);
  };

  const abrirModalLote = () => {
    if (selecionadas.length === 0) {
      alert('Selecione ao menos uma transação.');
      return;
    }

    const primeira = transacoes.find((tx) => selecionadas.includes(tx.id));
    setTransacaoSelecionada(null);
    setCategoriaMacroEscolhida('');
    setCategoriaDetalhadaEscolhida('');
    setCriarRegra(false);
    setTermoRegra(sugerirTermoRegra(filtros.busca || primeira?.descricao || ''));
    setCategoriaModalAberta(true);
  };

  const fecharModal = () => {
    setCategoriaModalAberta(false);
    setTransacaoSelecionada(null);
    setCategoriaMacroEscolhida('');
    setCategoriaDetalhadaEscolhida('');
    setCriarRegra(false);
    setTermoRegra('');
  };

  const handleCategorizar = async () => {
    if (!categoriaMacroEscolhida) {
      alert('Escolha uma categoria macro.');
      return;
    }

    if (criarRegra && !termoRegra.trim()) {
      alert('Informe o termo da regra automática.');
      return;
    }

    setSalvandoCategoria(true);

    try {
      const payload = {
        categoriaMacroId: categoriaMacroEscolhida,
        categoriaDetalhadaId: categoriaDetalhadaEscolhida || null,
        criarRegra,
        termoRegra: criarRegra ? termoRegra : undefined,
      };

      const response = transacaoSelecionada
        ? await axios.patch(`${API_URL}/transacoes/${transacaoSelecionada.id}/categorizar`, payload, { headers: authHeaders })
        : await axios.patch(`${API_URL}/transacoes/categorizar-lote`, { ...payload, transacaoIds: selecionadas }, { headers: authHeaders });

      const atualizadas = response.data.atualizadas || 0;
      const atualizadasPorRegra = response.data.atualizadasPorRegra || 0;
      const mensagemRegra = criarRegra ? ` Regra aplicada em ${atualizadasPorRegra} transações sem categoria semelhantes.` : '';
      alert(`${atualizadas} transação(ões) categorizada(s).${mensagemRegra}`);

      fecharModal();
      setSelecionadas([]);
      await carregarDados();
    } catch (error) {
      alert('Erro ao categorizar: ' + (error.response?.data?.erro || error.message));
    } finally {
      setSalvandoCategoria(false);
    }
  };

  const alternarSelecionada = (id) => {
    setSelecionadas((atuais) => atuais.includes(id)
      ? atuais.filter((item) => item !== id)
      : [...atuais, id]);
  };

  const alternarTodasFiltradas = () => {
    setSelecionadas((atuais) => {
      if (todasFiltradasSelecionadas) return atuais.filter((id) => !idsFiltrados.includes(id));
      return Array.from(new Set([...atuais, ...idsFiltrados]));
    });
  };

  const limparFiltros = () => {
    setFiltros({ busca: '', conta: 'todas', categoriaMacro: 'todas', categoriaDetalhada: 'todas', status: 'todas', tipo: 'todos' });
    setDataInicial('');
    setDataFinal('');
  };

  const montarLinhasExportacao = (items) => items.map((tx) => [
    tx.id || '',
    tx.id || '',
    formatarDataExcel(tx.data),
    tx.conta_nome || '',
    tx.descricao || '',
    Number(tx.valor || 0),
    Number.isFinite(tx.saldo_acumulado_calculado) ? Number(tx.saldo_acumulado_calculado) : '',
    tx.tipo === 'CREDITO' ? 'Crédito' : 'Débito',
    nomeCategoriaMacro(tx) === 'Sem categoria' ? '' : nomeCategoriaMacro(tx),
    nomeCategoriaDetalhada(tx) === '-' ? '' : nomeCategoriaDetalhada(tx),
    tx.categoria_nome || nomeCategoriaMacro(tx),
    tx.eh_transferencia_interna ? 'Sim' : 'Não',
    tx.transferencia_grupo_id || '',
    tx.categoria_origem || '',
  ]);

  const exportarExcel = (apenasSelecionadas = false) => {
    const selecionadasSet = new Set(selecionadas);
    const baseExportacao = apenasSelecionadas
      ? transacoesOrdenadas.filter((tx) => selecionadasSet.has(tx.id))
      : transacoesOrdenadas;

    if (baseExportacao.length === 0) {
      alert('Não há transações para exportar com os filtros atuais.');
      return;
    }

    try {
      const linhas = montarLinhasExportacao(baseExportacao);
      const bytes = criarXlsxTransacoes(linhas);
      const nomeArquivo = nomeArquivoExportacao(dataInicial, dataFinal, apenasSelecionadas);
      baixarArquivo(bytes, nomeArquivo, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (error) {
      console.error('Erro ao exportar transações:', error);
      alert('Erro ao exportar transações. Tente novamente.');
    }
  };

  const abrirModalExclusao = (tx) => {
    setTransacaoParaExcluir(tx);
    setModalExclusaoAberto(true);
  };

  const fecharModalExclusao = () => {
    if (excluindoTransacao) return;
    setModalExclusaoAberto(false);
    setTransacaoParaExcluir(null);
  };

  const handleExcluirTransacao = async () => {
    if (!transacaoParaExcluir) return;

    try {
      setExcluindoTransacao(true);

      await axios.delete(`${API_URL}/transacoes/${transacaoParaExcluir.id}`, {
        headers: authHeaders,
      });

      setTransacoes((atuais) => atuais.filter((tx) => tx.id !== transacaoParaExcluir.id));
      setSelecionadas((atuais) => atuais.filter((id) => id !== transacaoParaExcluir.id));
      setModalExclusaoAberto(false);
      setTransacaoParaExcluir(null);
    } catch (error) {
      alert('Erro ao excluir transação: ' + (error.response?.data?.erro || error.message));
    } finally {
      setExcluindoTransacao(false);
    }
  };

  const verificarTransferenciasInternas = async () => {
    setCarregandoSugestoes(true);
    setModalTransferenciasAberto(true);

    try {
      const params = new URLSearchParams();
      if (dataInicial) params.set('dataInicial', dataInicial);
      if (dataFinal) params.set('dataFinal', dataFinal);

      const response = await axios.get(`${API_URL}/transferencias-internas/sugestoes?${params.toString()}`, { headers: authHeaders });
      setSugestoesTransferencia(response.data.sugestoes || []);
    } catch (error) {
      alert('Erro ao verificar transferências internas: ' + (error.response?.data?.erro || error.message));
      setModalTransferenciasAberto(false);
    } finally {
      setCarregandoSugestoes(false);
    }
  };

  const marcarTransferenciaInterna = async (sugestao) => {
    setMarcandoTransferencia(sugestao.id);

    try {
      await axios.post(
        `${API_URL}/transferencias-internas/marcar`,
        { debitoId: sugestao.debito.id, creditoId: sugestao.credito.id },
        { headers: authHeaders }
      );

      setSugestoesTransferencia((atuais) => atuais.filter((item) => item.id !== sugestao.id));
      await carregarDados();
    } catch (error) {
      alert('Erro ao marcar transferência interna: ' + (error.response?.data?.erro || error.message));
    } finally {
      setMarcandoTransferencia(null);
    }
  };

  const ignorarSugestaoTransferencia = (sugestaoId) => {
    setSugestoesTransferencia((atuais) => atuais.filter((item) => item.id !== sugestaoId));
  };

  const desmarcarTransferenciaInterna = async (tx) => {
    if (!window.confirm('Desmarcar esta transferência interna? O vínculo do grupo será removido.')) return;

    try {
      await axios.post(
        `${API_URL}/transferencias-internas/desmarcar`,
        { transferenciaGrupoId: tx.transferencia_grupo_id, transacaoId: tx.id },
        { headers: authHeaders }
      );
      await carregarDados();
    } catch (error) {
      alert('Erro ao desmarcar transferência interna: ' + (error.response?.data?.erro || error.message));
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <div style={{ background: '#1f2937', color: 'white', padding: '20px' }}>
        <button onClick={onVoltar} style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', marginBottom: '15px' }}>
          ← Voltar
        </button>
        <h1 style={{ margin: 0 }}>Transações consolidadas</h1>
        <p style={{ margin: '5px 0 0', opacity: 0.8 }}>Todas as contas em uma única visão</p>
      </div>

      <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
        <div style={{ background: 'white', borderRadius: '12px', padding: '16px', marginBottom: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) repeat(5, 1fr)', gap: '12px', alignItems: 'end' }}>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Pesquisar descrição
              <input value={filtros.busca} onChange={(event) => setFiltros({ ...filtros, busca: event.target.value })} placeholder="Ex.: AUTO POSTO" style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} />
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Conta
              <select value={filtros.conta} onChange={(event) => setFiltros({ ...filtros, conta: event.target.value })} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                <option value="todas">Todas as contas</option>
                {contas.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Categoria macro
              <select value={filtros.categoriaMacro} onChange={(event) => setFiltros({ ...filtros, categoriaMacro: event.target.value, categoriaDetalhada: 'todas' })} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                <option value="todas">Todas</option>
                <option value="sem">Sem categoria</option>
                {categoriasMacro.map((cat) => <option key={cat.id} value={cat.id}>{cat.emoji} {cat.nome}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Categoria detalhada
              <select value={filtros.categoriaDetalhada} onChange={(event) => setFiltros({ ...filtros, categoriaDetalhada: event.target.value })} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                <option value="todas">Todas</option>
                <option value="sem">Sem detalhamento</option>
                {categoriasDetalhadasFiltro.map((cat) => <option key={cat.id} value={cat.id}>{cat.emoji} {cat.nome}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Status
              <select value={filtros.status} onChange={(event) => setFiltros({ ...filtros, status: event.target.value })} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                <option value="todas">Todas</option>
                <option value="sem">Sem categoria</option>
                <option value="categorizadas">Categorizadas</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Tipo
              <select value={filtros.tipo} onChange={(event) => setFiltros({ ...filtros, tipo: event.target.value })} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                <option value="todos">Todos</option>
                <option value="CREDITO">Crédito</option>
                <option value="DEBITO">Débito</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', alignItems: 'end', marginTop: '14px' }}>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Data inicial
              <input type="date" value={dataInicial} onChange={(event) => setDataInicial(event.target.value)} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} />
            </label>
            <label style={{ display: 'grid', gap: '6px', fontSize: '13px', color: '#374151' }}>
              Data final
              <input type="date" value={dataFinal} onChange={(event) => setDataFinal(event.target.value)} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} />
            </label>
            <button onClick={limparFiltros} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', background: '#e5e7eb' }}>Limpar filtros</button>
            <button onClick={alternarTodasFiltradas} disabled={transacoesOrdenadas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid #d1d5db', background: 'white', cursor: transacoesOrdenadas.length === 0 ? 'not-allowed' : 'pointer' }}>
              {todasFiltradasSelecionadas ? 'Limpar seleção filtrada' : 'Selecionar todos filtrados'}
            </button>
            <button onClick={abrirModalLote} disabled={selecionadas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: selecionadas.length ? '#667eea' : '#c7d2fe', color: 'white', cursor: selecionadas.length ? 'pointer' : 'not-allowed' }}>
              Categorizar selecionadas
            </button>
            <button onClick={() => exportarExcel(false)} disabled={transacoesOrdenadas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: transacoesOrdenadas.length ? '#16a34a' : '#bbf7d0', color: 'white', cursor: transacoesOrdenadas.length ? 'pointer' : 'not-allowed' }}>
              📊 Exportar Excel
            </button>
            <button onClick={() => exportarExcel(true)} disabled={selecionadas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid #16a34a', background: selecionadas.length ? 'white' : '#f0fdf4', color: '#15803d', cursor: selecionadas.length ? 'pointer' : 'not-allowed' }}>
              Exportar selecionadas
            </button>
            <button onClick={verificarTransferenciasInternas} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#0f766e', color: 'white', cursor: 'pointer' }}>
              Verificar transferências entre contas
            </button>
            <button onClick={verInicioBase} disabled={!resumoBase} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid #1d4ed8', background: resumoBase ? 'white' : '#eff6ff', color: '#1d4ed8', cursor: resumoBase ? 'pointer' : 'not-allowed' }}>
              Ver início da base
            </button>
            <button onClick={abrirModalSaldoInicial} disabled={!contaSelecionadaFiltro || !primeiraTransacaoBase} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: contaSelecionadaFiltro && primeiraTransacaoBase ? '#7c3aed' : '#ddd6fe', color: 'white', cursor: contaSelecionadaFiltro && primeiraTransacaoBase ? 'pointer' : 'not-allowed' }}>
              Configurar saldo inicial desta conta
            </button>
          </div>

          <div style={{ marginTop: '14px' }}>
            <span style={{ color: '#4b5563', fontSize: '14px' }}>{transacoesOrdenadas.length} transação(ões) filtrada(s) • {selecionadas.length} selecionada(s)</span>
          </div>
        </div>

        {resumoBase && (
          <div style={{ background: 'white', border: '1px solid #dbeafe', borderRadius: '12px', padding: '16px', marginBottom: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: '0 0 8px' }}>{contaSelecionadaFiltro ? `Conta: ${contaSelecionadaFiltro.nome}` : 'Todas as contas'}</h3>
                {contaSelecionadaFiltro && resumoBase.dataSaldoInicial && <p style={{ margin: '4px 0', color: '#475569' }}>Saldo inicial: <strong>{formatarMoeda(resumoBase.saldoInicial)}</strong> em <strong>{formatarData(resumoBase.dataSaldoInicial)}</strong></p>}
                {contaSelecionadaFiltro && !resumoBase.dataSaldoInicial && <p style={{ margin: '4px 0', color: '#92400e' }}>Saldo inicial: <strong>não configurado</strong></p>}
                <p style={{ margin: '4px 0', color: '#475569' }}>Primeira transação importada: <strong>{formatarData(resumoBase.primeira.data)}</strong></p>
                <p style={{ margin: '4px 0', color: '#475569' }}>Última transação importada: <strong>{formatarData(resumoBase.ultima.data)}</strong></p>
                <p style={{ margin: '4px 0', color: '#475569' }}>Quantidade de transações: <strong>{resumoBase.quantidade}</strong></p>
                <p style={{ margin: '4px 0', color: '#475569' }}>Saldo calculado no período exibido: <strong>{formatarMoeda(resumoBase.saldoCalculadoPeriodo)}</strong></p>
                {contaSelecionadaFiltro && Number.isFinite(resumoBase.saldoAntesPeriodo) && <p style={{ margin: '4px 0', color: '#475569' }}>Saldo antes do período: <strong>{formatarMoeda(resumoBase.saldoAntesPeriodo)}</strong></p>}
                {contaSelecionadaFiltro && Number.isFinite(resumoBase.saldoFinalCalculado) && <p style={{ margin: '4px 0', color: '#475569' }}>Saldo final calculado: <strong>{formatarMoeda(resumoBase.saldoFinalCalculado)}</strong></p>}
                {!contaSelecionadaFiltro && <p style={{ margin: '4px 0', color: '#475569' }}>Saldo final calculado (contas configuradas): <strong>{formatarMoeda(resumoBase.saldoFinalConsolidado)}</strong></p>}
                {contaSelecionadaFiltro && Number.isFinite(resumoBase.saldoFinalCalculado) && (
                  <button onClick={() => { setResultadoConferenciaRapida(null); setSaldoRealConferencia(''); setModalConferenciaRapidaAberto(true); }} style={{ marginTop: '8px', background: '#1d4ed8', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 10px', cursor: 'pointer' }}>Conferir saldo final</button>
                )}
              </div>
              {contaSelecionadaFiltro && !contaSelecionadaFiltro.data_saldo_inicial && (
                <div style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: '10px', padding: '12px', maxWidth: '420px' }}>
                  <strong>Saldo inicial ausente</strong>
                  <p style={{ margin: '6px 0' }}>Esta conta ainda não possui saldo inicial configurado. Para conferir o saldo bancário, informe o saldo da conta no dia anterior à primeira transação importada.</p>
                  <button onClick={abrirModalSaldoInicial} style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 10px', cursor: 'pointer' }}>Configurar saldo inicial</button>
                </div>
              )}
            </div>
            {!contaSelecionadaFiltro && resumoBase.porConta.length > 1 && (
              <div style={{ marginTop: '14px', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead><tr style={{ background: '#f8fafc' }}><th style={{ textAlign: 'left', padding: '8px' }}>Conta</th><th style={{ textAlign: 'left', padding: '8px' }}>Primeira</th><th style={{ textAlign: 'left', padding: '8px' }}>Última</th><th style={{ textAlign: 'right', padding: '8px' }}>Transações</th><th style={{ textAlign: 'right', padding: '8px' }}>Saldo final</th></tr></thead>
                  <tbody>{resumoBase.porConta.map((item) => <tr key={item.contaId || item.contaNome} style={{ borderTop: '1px solid #e5e7eb' }}><td style={{ padding: '8px' }}>{item.contaNome}</td><td style={{ padding: '8px' }}>{formatarData(item.primeira.data)}</td><td style={{ padding: '8px' }}>{formatarData(item.ultima.data)}</td><td style={{ padding: '8px', textAlign: 'right' }}>{item.quantidade}</td><td style={{ padding: '8px', textAlign: 'right' }}>{Number.isFinite(item.saldoFinalCalculado) ? formatarMoeda(item.saldoFinalCalculado) : 'Não configurado'}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {carregando ? (
          <p>Carregando transações...</p>
        ) : transacoes.length === 0 ? (
          <div style={{ background: 'white', borderRadius: '12px', padding: '40px', textAlign: 'center' }}>
            <h2>Nenhuma transação encontrada</h2>
          </div>
        ) : (
          <div ref={tabelaRef} className="table-scroll" style={{ background: 'white', borderRadius: '12px', overflowX: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <table style={{ width: '100%', minWidth: '1240px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '12px', textAlign: 'center' }}>
                    <input type="checkbox" checked={todasFiltradasSelecionadas} onChange={alternarTodasFiltradas} />
                  </th>
                  <th onClick={() => handleSort('data')} style={estiloCabecalhoOrdenavel('left')}>{rotuloOrdenacao('Data', 'data')}</th>
                  <th onClick={() => handleSort('conta')} style={estiloCabecalhoOrdenavel('left')}>{rotuloOrdenacao('Conta', 'conta')}</th>
                  <th onClick={() => handleSort('descricao')} style={estiloCabecalhoOrdenavel('left')}>{rotuloOrdenacao('Descrição', 'descricao')}</th>
                  <th onClick={() => handleSort('valor')} style={estiloCabecalhoOrdenavel('right')}>{rotuloOrdenacao('Valor', 'valor')}</th>
                  <th style={{ padding: '12px', textAlign: 'right', whiteSpace: 'nowrap' }}>Saldo acumulado</th>
                  <th onClick={() => handleSort('tipo')} style={estiloCabecalhoOrdenavel('left')}>{rotuloOrdenacao('Tipo', 'tipo')}</th>
                  <th onClick={() => handleSort('categoriaMacro')} style={estiloCabecalhoOrdenavel('left')}>{rotuloOrdenacao('Categoria macro', 'categoriaMacro')}</th>
                  <th onClick={() => handleSort('categoriaDetalhada')} style={estiloCabecalhoOrdenavel('left')}>{rotuloOrdenacao('Categoria detalhada', 'categoriaDetalhada')}</th>
                  <th onClick={() => handleSort('status')} style={estiloCabecalhoOrdenavel('left')}>{rotuloOrdenacao('Status/flags', 'status')}</th>
                  <th style={{ padding: '12px', textAlign: 'center' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {transacoesOrdenadas.map((tx) => (
                  <tr key={tx.id} style={{ borderTop: '1px solid #e5e7eb', background: destacarInicioBase && primeiraTransacaoBase?.id === tx.id ? '#fef3c7' : 'white' }}>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <input type="checkbox" checked={selecionadas.includes(tx.id)} onChange={() => alternarSelecionada(tx.id)} />
                    </td>
                    <td style={{ padding: '12px' }}>{formatarData(tx.data)}</td>
                    <td style={{ padding: '12px', color: '#475569', fontSize: '13px' }}>{tx.conta_nome || 'Conta'}</td>
                    <td style={{ padding: '12px' }}>{tx.descricao}</td>
                    <td style={{ padding: '12px', textAlign: 'right', color: tx.tipo === 'CREDITO' ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                      {tx.tipo === 'CREDITO' ? '+' : '-'}{formatarMoeda(tx.valor)}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', color: Number(tx.saldo_acumulado_calculado || 0) >= 0 ? '#0f766e' : '#dc2626', fontWeight: Number.isFinite(tx.saldo_acumulado_calculado) ? 'bold' : 'normal', fontSize: tx.saldo_acumulado_configurado ? '14px' : '12px' }}>
                      {textoSaldoAcumulado(tx)}
                    </td>
                    <td style={{ padding: '12px' }}>{tx.tipo === 'CREDITO' ? 'Crédito' : 'Débito'}</td>
                    <td style={{ padding: '12px' }}>
                      <span style={estiloBadgeCategoria(tx.categoria_origem)}>{nomeCategoriaMacro(tx)}{tx.categoria_origem === 'AUTO' ? ' • auto' : ''}</span>
                    </td>
                    <td style={{ padding: '12px' }}>
                      <span style={estiloBadgeCategoria(tx.categoria_origem)}>{nomeCategoriaDetalhada(tx)}</span>
                    </td>
                    <td style={{ padding: '12px' }}>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {tx.eh_transferencia_interna && (
                          <span style={{ background: '#ccfbf1', color: '#0f766e', padding: '3px 7px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold' }}>
                            Transferência interna
                          </span>
                        )}
                        {tx.conciliacao_id && (
                          <span title={tx.provisao_conciliada_descricao ? `Provisão: ${tx.provisao_conciliada_descricao}` : 'Vinculada a provisão'} style={{ background: '#dcfce7', color: '#166534', padding: '3px 7px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold' }}>
                            Conciliada
                          </span>
                        )}
                        {!tx.eh_transferencia_interna && !tx.conciliacao_id && <span style={{ color: '#9ca3af' }}>-</span>}
                      </div>
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <button onClick={() => abrirModalIndividual(tx)} style={{ background: '#667eea', color: 'white', border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
                          Categorizar
                        </button>
                        {tx.eh_transferencia_interna && (
                          <button onClick={() => desmarcarTransferenciaInterna(tx)} style={{ background: 'white', color: '#0f766e', border: '1px solid #0f766e', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
                            Desmarcar transferência
                          </button>
                        )}
                        <button onClick={() => abrirModalExclusao(tx)} style={{ background: 'white', color: '#dc2626', border: '1px solid #dc2626', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
                          Excluir
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {transacoesOrdenadas.length === 0 && (
                  <tr><td colSpan="11" style={{ padding: '24px', textAlign: 'center', color: '#6b7280' }}>Nenhuma transação corresponde aos filtros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalConferenciaRapidaAberto && contaSelecionadaFiltro && resumoBase && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px', maxWidth: '520px', width: '92%' }}>
            <h3 style={{ marginTop: 0 }}>Conferir saldo final</h3>
            <p style={{ color: '#475569' }}>Informe o saldo real do banco em {formatarData(dataFinal || resumoBase.ultima.data)} para comparar com o saldo calculado da conta.</p>
            <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px', marginBottom: '12px' }}>
              <p style={{ margin: '4px 0' }}><strong>Conta:</strong> {contaSelecionadaFiltro.nome}</p>
              <p style={{ margin: '4px 0' }}><strong>Saldo calculado:</strong> {formatarMoeda(resumoBase.saldoFinalCalculado)}</p>
            </div>
            <label style={{ display: 'grid', gap: '6px', fontSize: '14px', marginBottom: '12px' }}>
              Saldo real no banco
              <input value={saldoRealConferencia} onChange={(event) => { setSaldoRealConferencia(event.target.value); setResultadoConferenciaRapida(null); }} placeholder="759,76" style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
            </label>
            {resultadoConferenciaRapida && (
              <div style={{ background: resultadoConferenciaRapida.status === 'CONCILIADO' ? '#ecfdf5' : '#fef2f2', color: resultadoConferenciaRapida.status === 'CONCILIADO' ? '#166534' : '#991b1b', borderRadius: '10px', padding: '12px', marginBottom: '12px' }}>
                <p style={{ margin: '4px 0' }}><strong>Saldo real:</strong> {formatarMoeda(resultadoConferenciaRapida.saldo_real)}</p>
                <p style={{ margin: '4px 0' }}><strong>Saldo calculado:</strong> {formatarMoeda(resultadoConferenciaRapida.saldo_calculado)}</p>
                <p style={{ margin: '4px 0' }}><strong>Diferença:</strong> {formatarMoeda(resultadoConferenciaRapida.diferenca)}</p>
                <p style={{ margin: '4px 0' }}><strong>Status:</strong> {resultadoConferenciaRapida.status === 'CONCILIADO' ? 'Conciliado' : 'Divergente'}</p>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
              <button onClick={() => setModalConferenciaRapidaAberto(false)} disabled={salvandoConferenciaRapida} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#e5e7eb', cursor: 'pointer' }}>Fechar</button>
              <button onClick={salvarConferenciaRapida} disabled={salvandoConferenciaRapida} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#1d4ed8', color: 'white', cursor: 'pointer' }}>{salvandoConferenciaRapida ? 'Conferindo...' : 'Conferir'}</button>
            </div>
          </div>
        </div>
      )}

      {modalSaldoInicialAberto && contaSelecionadaFiltro && primeiraTransacaoBase && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px', maxWidth: '560px', width: '92%' }}>
            <h3 style={{ marginTop: 0 }}>Configurar saldo inicial desta conta</h3>
            <p style={{ color: '#475569' }}>
              Informe o saldo real da conta no dia anterior à primeira transação importada. Assim o app conseguirá calcular o saldo corretamente a partir dos registros importados.
            </p>
            <div style={{ display: 'grid', gap: '10px', marginBottom: '14px' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px' }}>
                <p style={{ margin: '4px 0' }}><strong>Conta:</strong> {contaSelecionadaFiltro.nome}</p>
                <p style={{ margin: '4px 0' }}><strong>Primeira transação importada:</strong> {formatarData(primeiraTransacaoBase.data)} · {primeiraTransacaoBase.descricao} · {formatarMoeda(primeiraTransacaoBase.valor)}</p>
                <p style={{ margin: '4px 0' }}><strong>Data sugerida para saldo inicial:</strong> {formatarData(dataAnteriorISO(primeiraTransacaoBase.data))}</p>
              </div>
              <label style={{ display: 'grid', gap: '6px', fontSize: '14px' }}>
                Data do saldo inicial
                <input type="date" value={formSaldoInicial.dataSaldoInicial} onChange={(event) => setFormSaldoInicial({ ...formSaldoInicial, dataSaldoInicial: event.target.value })} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
              </label>
              <label style={{ display: 'grid', gap: '6px', fontSize: '14px' }}>
                Saldo inicial
                <input value={formSaldoInicial.saldoInicial} onChange={(event) => setFormSaldoInicial({ ...formSaldoInicial, saldoInicial: event.target.value })} placeholder="0,00" style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
              </label>
              <label style={{ display: 'grid', gap: '6px', fontSize: '14px' }}>
                Observação
                <textarea value={formSaldoInicial.observacao} onChange={(event) => setFormSaldoInicial({ ...formSaldoInicial, observacao: event.target.value })} placeholder="Ex.: saldo real no extrato antes do início da base" rows={3} style={{ padding: '10px', border: '1px solid #d1d5db', borderRadius: '8px' }} />
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
              <button onClick={() => setModalSaldoInicialAberto(false)} disabled={salvandoSaldoInicial} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#e5e7eb', cursor: 'pointer' }}>Cancelar</button>
              <button onClick={salvarSaldoInicialConta} disabled={salvandoSaldoInicial} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#7c3aed', color: 'white', cursor: 'pointer' }}>{salvandoSaldoInicial ? 'Salvando...' : 'Salvar saldo inicial'}</button>
            </div>
          </div>
        </div>
      )}

      {categoriaModalAberta && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '30px', maxWidth: '520px', width: '90%' }}>
            <h3 style={{ marginTop: 0 }}>{transacaoSelecionada ? `Categorizar: ${transacaoSelecionada.descricao.substring(0, 45)}` : `Categorizar ${selecionadas.length} transação(ões)`}</h3>
            {transacaoSelecionada && <p style={{ color: '#666', marginBottom: '20px' }}>{formatarMoeda(transacaoSelecionada.valor)}</p>}

            <label style={{ display: 'grid', gap: '6px', marginBottom: '14px', fontSize: '14px' }}>
              Categoria macro
              <select value={categoriaMacroEscolhida} onChange={(event) => { setCategoriaMacroEscolhida(event.target.value); setCategoriaDetalhadaEscolhida(''); }} style={{ padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db' }}>
                <option value="">Selecione uma categoria macro</option>
                {categoriasMacro.map((cat) => <option key={cat.id} value={cat.id}>{cat.emoji} {cat.nome}</option>)}
              </select>
            </label>

            <label style={{ display: 'grid', gap: '6px', marginBottom: '14px', fontSize: '14px' }}>
              Categoria detalhada
              <select value={categoriaDetalhadaEscolhida} onChange={(event) => setCategoriaDetalhadaEscolhida(event.target.value)} disabled={!categoriaMacroEscolhida} style={{ padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', background: categoriaMacroEscolhida ? 'white' : '#f3f4f6' }}>
                <option value="">Sem detalhamento</option>
                {categoriasDetalhadasModal.map((cat) => <option key={cat.id} value={cat.id}>{cat.emoji} {cat.nome}</option>)}
              </select>
              <small style={{ color: '#6b7280' }}>Você pode salvar apenas a macro e detalhar depois.</small>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', fontSize: '14px' }}>
              <input type="checkbox" checked={criarRegra} onChange={(event) => setCriarRegra(event.target.checked)} />
              {transacaoSelecionada ? 'Aplicar automaticamente para transações semelhantes desse fornecedor' : 'Criar regra para transações futuras'}
            </label>

            {criarRegra && (
              <label style={{ display: 'grid', gap: '6px', marginBottom: '18px', fontSize: '14px' }}>
                Termo da regra sugerida
                <input value={termoRegra} onChange={(event) => setTermoRegra(event.target.value)} placeholder="AUTO POSTO PRESIDENTE LTDA" style={{ padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db' }} />
                <small style={{ color: '#6b7280' }}>O backend normaliza acentos, pontuação e descrições Pix antes de comparar.</small>
              </label>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={handleCategorizar} disabled={salvandoCategoria} style={{ background: '#667eea', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: 'pointer', flex: 1 }}>
                {salvandoCategoria ? 'Salvando...' : 'Salvar categorização'}
              </button>
              <button onClick={fecharModal} disabled={salvandoCategoria} style={{ background: '#e5e7eb', border: 'none', padding: '12px', borderRadius: '8px', cursor: 'pointer', flex: 1 }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {modalExclusaoAberto && transacaoParaExcluir && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '30px', maxWidth: '520px', width: '90%' }}>
            <h3 style={{ marginTop: 0, color: '#991b1b' }}>Excluir transação</h3>
            <p style={{ color: '#374151', lineHeight: 1.5 }}>
              Tem certeza que deseja excluir esta transação? Essa ação não poderá ser desfeita.
            </p>

            <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px', margin: '18px 0' }}>
              <p style={{ margin: '0 0 8px' }}><strong>Data:</strong> {formatarData(transacaoParaExcluir.data)}</p>
              <p style={{ margin: '0 0 8px' }}><strong>Descrição:</strong> {transacaoParaExcluir.descricao}</p>
              <p style={{ margin: 0 }}><strong>Valor:</strong> {transacaoParaExcluir.tipo === 'CREDITO' ? '+' : '-'}{formatarMoeda(transacaoParaExcluir.valor)}</p>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={fecharModalExclusao} disabled={excluindoTransacao} style={{ background: '#e5e7eb', border: 'none', padding: '12px', borderRadius: '8px', cursor: excluindoTransacao ? 'not-allowed' : 'pointer', flex: 1 }}>
                Cancelar
              </button>
              <button onClick={handleExcluirTransacao} disabled={excluindoTransacao} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '12px', borderRadius: '8px', cursor: excluindoTransacao ? 'not-allowed' : 'pointer', flex: 1 }}>
                {excluindoTransacao ? 'Excluindo...' : 'Excluir transação'}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalTransferenciasAberto && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '24px', maxWidth: '900px', width: '94%', maxHeight: '86vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0 }}>Possíveis transferências internas</h3>
                <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: '14px' }}>Revise os pares sugeridos antes de marcar. Nada é aplicado automaticamente.</p>
              </div>
              <button onClick={() => setModalTransferenciasAberto(false)} style={{ border: 'none', background: '#e5e7eb', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer' }}>Fechar</button>
            </div>

            {carregandoSugestoes ? (
              <p style={{ color: '#64748b' }}>Verificando transações do período...</p>
            ) : sugestoesTransferencia.length === 0 ? (
              <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '18px', color: '#64748b' }}>Nenhuma sugestão encontrada para o período selecionado.</div>
            ) : (
              <div style={{ display: 'grid', gap: '14px' }}>
                {sugestoesTransferencia.map((sugestao, index) => (
                  <div key={sugestao.id} style={{ border: '1px solid #e5e7eb', borderRadius: '12px', padding: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
                      <strong>Caso {index + 1}</strong>
                      <span style={{ background: sugestao.confianca === 'alta' ? '#dcfce7' : sugestao.confianca === 'média' ? '#fef9c3' : '#f1f5f9', color: '#334155', padding: '4px 8px', borderRadius: '999px', fontSize: '12px' }}>Confiança {sugestao.confianca}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                      <div style={{ background: '#fef2f2', borderRadius: '10px', padding: '12px' }}>
                        <strong>Saída</strong>
                        <p style={{ margin: '8px 0 4px' }}>{sugestao.debito.conta_nome} | {formatarData(sugestao.debito.data)}</p>
                        <p style={{ margin: '0 0 4px', color: '#dc2626', fontWeight: 'bold' }}>-{formatarMoeda(sugestao.debito.valor)}</p>
                        <p style={{ margin: 0, color: '#64748b' }}>{sugestao.debito.descricao}</p>
                      </div>
                      <div style={{ background: '#f0fdf4', borderRadius: '10px', padding: '12px' }}>
                        <strong>Entrada</strong>
                        <p style={{ margin: '8px 0 4px' }}>{sugestao.credito.conta_nome} | {formatarData(sugestao.credito.data)}</p>
                        <p style={{ margin: '0 0 4px', color: '#059669', fontWeight: 'bold' }}>+{formatarMoeda(sugestao.credito.valor)}</p>
                        <p style={{ margin: 0, color: '#64748b' }}>{sugestao.credito.descricao}</p>
                      </div>
                    </div>
                    <p style={{ color: '#64748b', fontSize: '12px' }}>Motivos: {sugestao.motivos.join(', ')}</p>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button onClick={() => marcarTransferenciaInterna(sugestao)} disabled={marcandoTransferencia === sugestao.id} style={{ background: '#0f766e', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '8px', cursor: marcandoTransferencia === sugestao.id ? 'not-allowed' : 'pointer' }}>
                        {marcandoTransferencia === sugestao.id ? 'Marcando...' : 'Marcar como transferência interna'}
                      </button>
                      <button onClick={() => ignorarSugestaoTransferencia(sugestao.id)} style={{ background: '#e5e7eb', border: 'none', padding: '8px 12px', borderRadius: '8px', cursor: 'pointer' }}>Ignorar</button>
                      <button onClick={() => ignorarSugestaoTransferencia(sugestao.id)} style={{ background: 'white', color: '#dc2626', border: '1px solid #dc2626', padding: '8px 12px', borderRadius: '8px', cursor: 'pointer' }}>Não é transferência</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// APP PRINCIPAL
// ============================================================================

function App() {
  const [logado, setLogado] = useState(false);
  const [usuario, setUsuario] = useState(null);
  const [token, setToken] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenCallback = params.get('token');
    const erroCallback = params.get('auth_error');
    const code = params.get('code');

    if (erroCallback) {
      alert('Erro ao fazer login: ' + erroCallback);
      window.history.replaceState({}, document.title, '/');
      return;
    }

    if (tokenCallback) {
      const usuarioToken = criarUsuarioDoToken(tokenCallback);

      if (usuarioToken) {
        localStorage.setItem('token', tokenCallback);
        localStorage.setItem('usuario', JSON.stringify(usuarioToken));
        setToken(tokenCallback);
        setUsuario(usuarioToken);
        setLogado(true);
        window.history.replaceState({}, document.title, '/');
        return;
      }
    }

    // Verificar se tem token salvo
    const tokenSalvo = localStorage.getItem('token');
    const usuarioSalvo = localStorage.getItem('usuario');

    if (tokenSalvo && usuarioSalvo) {
      setToken(tokenSalvo);
      setUsuario(JSON.parse(usuarioSalvo));
      setLogado(true);
      return;
    }
    // Compatibilidade com callbacks antigos que chegavam no frontend com code
    if (code) {
      axios.post(`${API_URL}/auth/google/callback`, { code })
        .then(response => {
          localStorage.setItem('token', response.data.token);
          localStorage.setItem('usuario', JSON.stringify(response.data.usuario));
          setToken(response.data.token);
          setUsuario(response.data.usuario);
          setLogado(true);
          window.history.replaceState({}, document.title, '/');
        })
        .catch(error => {
          alert('Erro ao fazer login: ' + (error.response?.data?.erro || error.message));
        });
    }
  }, []);

  if (!logado) {
    return <Login />;
  }

  return (
    <Dashboard
      usuario={usuario}
      token={token}
      onLogout={() => {
        localStorage.removeItem('token');
        localStorage.removeItem('usuario');
        setLogado(false);
        setUsuario(null);
        setToken(null);
      }}
    />
  );
}

export default App;
