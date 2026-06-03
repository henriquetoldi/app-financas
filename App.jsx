// ============================================================================
// FRONTEND: React App
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '/api';

// ============================================================================
// FUNÇÕES AUXILIARES
// ============================================================================

function formatarData(data) {
  return new Date(data).toLocaleDateString('pt-BR');
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
    conta: indiceOpcional('conta', 'conta destino'),
    valor: indiceOpcional('valor'),
    tipo: indiceOpcional('tipo'),
  };
  const obrigatorias = { data: indices.data, descricao: indices.descricao, valor: indices.valor, tipo: indices.tipo };
  const faltantes = Object.entries(obrigatorias)
    .filter(([, indice]) => indice === -1)
    .map(([coluna]) => coluna === 'descricao' ? 'Descrição' : coluna.charAt(0).toUpperCase() + coluna.slice(1));

  if (faltantes.length > 0) {
    throw new Error(`Colunas obrigatórias não encontradas: ${faltantes.join(', ')}.`);
  }

  return linhas.slice(1).filter((linha) => linha.some((valor) => String(valor || '').trim())).map((linha) => ({
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
    'Transacao_ID', 'ID', 'Data', 'Conta', 'Descrição', 'Valor', 'Tipo', 'Categoria Macro',
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

function normalizarValorLinha(valor) {
  if (typeof valor === 'number') return valor;
  return Number(String(valor || '').replace(/R\$/g, '').replace(/\./g, '').replace(',', '.').trim());
}

function validarExcelImportacao(dados) {
  const erros = [];
  const transacoes = [];

  dados.forEach((linha, index) => {
    const numeroLinha = index + 2;
    const data = normalizarDataLinha(linha.data);
    const descricao = String(linha.descricao || '').trim();
    const categoria = String(linha.categoria || '').trim();
    const categoriaMacro = String(linha.categoria_macro || categoria || '').trim() || 'Outros';
    const categoriaDetalhada = String(linha.categoria_detalhada || '').trim();
    const valor = normalizarValorLinha(linha.valor);
    const tipoTexto = normalizarTextoColuna(linha.tipo);

    if (!data) erros.push(`Linha ${numeroLinha}: Data inválida.`);
    if (!descricao) erros.push(`Linha ${numeroLinha}: Descrição obrigatória.`);
    if (!Number.isFinite(valor) || valor <= 0) erros.push(`Linha ${numeroLinha}: Valor inválido.`);
    if (Number.isFinite(valor) && Math.abs(valor) >= 10000000000) erros.push(`Linha ${numeroLinha}: Valor excede o limite suportado de 9.999.999.999,99.`);
    if (!['debito', 'credito'].includes(tipoTexto)) erros.push(`Linha ${numeroLinha}: Tipo deve ser Débito ou Crédito.`);

    if (data && descricao && Number.isFinite(valor) && valor > 0 && ['debito', 'credito'].includes(tipoTexto)) {
      transacoes.push({
        data,
        descricao,
        categoria,
        categoria_macro: categoriaMacro,
        categoria_detalhada: categoriaDetalhada,
        conta: String(linha.conta || '').trim() || null,
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
  const [contaId, setContaId] = useState(contas[0]?.id || '');
  const [novaConta, setNovaConta] = useState('Importação XLSX');
  const [validacao, setValidacao] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapeamentoCategorias, setMapeamentoCategorias] = useState([]);
  const [carregando, setCarregando] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const processarArquivo = async (file) => {
    setArquivo(file);
    setValidacao(null);
    setPreview(null);
    setMapeamentoCategorias([]);
    setCarregando(true);
    try {
      const dados = await lerXlsxPadrao(file);
      setValidacao(validarExcelImportacao(dados));
    } catch (error) {
      setValidacao({ valido: false, erros: [error.message], transacoes: [] });
    } finally {
      setCarregando(false);
    }
  };

  const gerarPreview = async () => {
    if (!validacao?.valido) return;
    setCarregando(true);
    try {
      const response = await axios.post(`${API_URL}/importacoes/xlsx/preview`, {
        conta_id: contaId || undefined,
        conta_nome: contaId ? undefined : novaConta,
        transacoes: validacao.transacoes,
        nome_arquivo: arquivo.name,
        arquivo_base64: await arquivoParaBase64(arquivo),
      }, { headers: authHeaders });
      setPreview(response.data);
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
        mapeamentoCategorias,
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
  };

  const atualizarMapeamentoCategoria = (chave, atualizacao) => {
    setMapeamentoCategorias((atuais) => atuais.map((item) => {
      const chaveItem = `${item.tipo}|${item.categoriaMacroPlanilha || ''}|${item.nomePlanilha}`;
      return chaveItem === chave ? { ...item, ...atualizacao } : item;
    }));
  };

  const categoriasPendentes = preview?.categoriasPendentes || [];
  const mapeamentosResolvidos = categoriasPendentes.every((pendencia) => {
    const chavePendencia = `${pendencia.tipo}|${pendencia.categoriaMacroPlanilha || ''}|${pendencia.nomePlanilha}`;
    const decisao = mapeamentoCategorias.find((item) => `${item.tipo}|${item.categoriaMacroPlanilha || ''}|${item.nomePlanilha}` === chavePendencia);
    if (!decisao?.acao) return false;
    if (decisao.acao === 'USAR_EXISTENTE') return Boolean(decisao.categoriaExistenteId);
    if (decisao.acao === 'CORRIGIR_NOME') return Boolean(decisao.nomeCorrigido?.trim());
    return true;
  });
  const confirmacaoBloqueada = carregando || (categoriasPendentes.length > 0 && !mapeamentosResolvidos);
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
            <p style={{ color: '#6b7280', marginBottom: 0 }}>Data, Descrição, Valor e Tipo.</p>
          </div>
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px' }}>
            <strong>Colunas opcionais</strong>
            <p style={{ color: '#6b7280', marginBottom: 0 }}>ID/Transacao_ID, Conta, Categoria Macro, Categoria Detalhada ou Categoria.</p>
          </div>
        </div>
      </div>

      <div style={{ margin: '18px 0', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '14px', padding: '16px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Conta de destino</label>
        <p style={{ color: '#92400e', marginTop: 0 }}>
          A conta de destino participa da chave de identificação da transação quando a planilha não traz ID interno.
        </p>
        {contas.length > 0 && (
          <select value={contaId} onChange={(event) => { setContaId(event.target.value); setPreview(null); }} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db', marginRight: '10px' }}>
            {contas.map((conta) => <option key={conta.id} value={conta.id}>{conta.nome}</option>)}
            <option value="">+ Criar nova conta</option>
          </select>
        )}
        {(!contaId || contas.length === 0) && (
          <input value={novaConta} onChange={(event) => { setNovaConta(event.target.value); setPreview(null); }} placeholder="Nome da nova conta" style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} />
        )}
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
          <strong>❌ Erros encontrados:</strong>
          <ul>{validacao.erros.slice(0, 10).map((erro) => <li key={erro}>{erro}</li>)}</ul>
          {validacao.erros.length > 10 && <p>...e mais {validacao.erros.length - 10} erros.</p>}
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
              <strong>Linhas com erro</strong>
              <ul>{preview.erros.slice(0, 8).map((erro) => <li key={`${erro.linha}-${erro.erro}`}>Linha {erro.linha}: {erro.erro}</li>)}</ul>
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
      <div style={{
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
    <div style={{ background: 'white', borderRadius: '14px', padding: '20px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', border: '1px solid #eef2f7' }}>
      <h3 style={{ margin: '0 0 16px', color: '#111827' }}>{titulo}</h3>
      {children}
    </div>
  );
}

// ============================================================================
// DASHBOARD
// ============================================================================

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

  if (modo === 'transacoes' && (contaSelecionada || contas.length > 0)) {
    return (
      <TelaTransacoes
        contaInicial={contaSelecionada}
        contas={contas}
        token={token}
        onVoltar={() => setModo('home')}
      />
    );
  }

  const kpisDashboard = resumoDashboard?.kpis || {};
  const seriesDashboard = resumoDashboard?.series || {};
  const insightsDashboard = resumoDashboard?.insights || {};
  const saldoLiquido = Number(kpisDashboard.saldoLiquido || 0);

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <div style={{
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

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
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

      <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
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
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
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
                        onClick={() => setModo('importar')}
                        style={{ background: '#667eea', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer' }}
                      >
                        📊 Importar XLSX
                      </button>
                    </div>
                  </div>

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

                <div style={{
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
          <div style={{
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
          <div style={{
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
// TELA DE TRANSAÇÕES
// ============================================================================

function TelaTransacoes({ contaInicial, contas = [], token, onVoltar }) {
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

  const transacoesFiltradas = useMemo(() => {
    const buscaNormalizada = normalizarDescricaoCategorizacao(filtros.busca);

    return transacoes.filter((tx) => {
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
  }, [transacoes, filtros, dataInicial, dataFinal]);

  const idsFiltrados = transacoesFiltradas.map((tx) => tx.id);
  const todasFiltradasSelecionadas = idsFiltrados.length > 0 && idsFiltrados.every((id) => selecionadas.includes(id));
  const categoriasMacro = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'MACRO');
  const categoriasDetalhadasModal = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'DETALHADA' && cat.categoria_pai_id === categoriaMacroEscolhida);
  const categoriasDetalhadasFiltro = categorias.filter((cat) => (cat.nivel || (cat.categoria_pai_id ? 'DETALHADA' : 'MACRO')) === 'DETALHADA' && (filtros.categoriaMacro === 'todas' || cat.categoria_pai_id === filtros.categoriaMacro));

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
    tx.tipo === 'CREDITO' ? 'Crédito' : 'Débito',
    tx.categoria_macro_nome || tx.categoria_nome || '',
    tx.categoria_detalhada_nome || '',
    tx.categoria_nome || tx.categoria_macro_nome || '',
    tx.eh_transferencia_interna ? 'Sim' : 'Não',
    tx.transferencia_grupo_id || '',
    tx.categoria_origem || '',
  ]);

  const exportarExcel = (apenasSelecionadas = false) => {
    const selecionadasSet = new Set(selecionadas);
    const baseExportacao = apenasSelecionadas
      ? transacoesFiltradas.filter((tx) => selecionadasSet.has(tx.id))
      : transacoesFiltradas;

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
            <button onClick={alternarTodasFiltradas} disabled={transacoesFiltradas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid #d1d5db', background: 'white', cursor: transacoesFiltradas.length === 0 ? 'not-allowed' : 'pointer' }}>
              {todasFiltradasSelecionadas ? 'Limpar seleção filtrada' : 'Selecionar todos filtrados'}
            </button>
            <button onClick={abrirModalLote} disabled={selecionadas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: selecionadas.length ? '#667eea' : '#c7d2fe', color: 'white', cursor: selecionadas.length ? 'pointer' : 'not-allowed' }}>
              Categorizar selecionadas
            </button>
            <button onClick={() => exportarExcel(false)} disabled={transacoesFiltradas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: transacoesFiltradas.length ? '#16a34a' : '#bbf7d0', color: 'white', cursor: transacoesFiltradas.length ? 'pointer' : 'not-allowed' }}>
              📊 Exportar Excel
            </button>
            <button onClick={() => exportarExcel(true)} disabled={selecionadas.length === 0} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid #16a34a', background: selecionadas.length ? 'white' : '#f0fdf4', color: '#15803d', cursor: selecionadas.length ? 'pointer' : 'not-allowed' }}>
              Exportar selecionadas
            </button>
            <button onClick={verificarTransferenciasInternas} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#0f766e', color: 'white', cursor: 'pointer' }}>
              Verificar transferências entre contas
            </button>
          </div>

          <div style={{ marginTop: '14px' }}>
            <span style={{ color: '#4b5563', fontSize: '14px' }}>{transacoesFiltradas.length} transação(ões) filtrada(s) • {selecionadas.length} selecionada(s)</span>
          </div>
        </div>

        {carregando ? (
          <p>Carregando transações...</p>
        ) : transacoes.length === 0 ? (
          <div style={{ background: 'white', borderRadius: '12px', padding: '40px', textAlign: 'center' }}>
            <h2>Nenhuma transação encontrada</h2>
          </div>
        ) : (
          <div style={{ background: 'white', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '12px', textAlign: 'center' }}>
                    <input type="checkbox" checked={todasFiltradasSelecionadas} onChange={alternarTodasFiltradas} />
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Data</th>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Conta</th>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Descrição</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>Valor</th>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Tipo</th>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Categoria</th>
                  <th style={{ padding: '12px', textAlign: 'center' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {transacoesFiltradas.map((tx) => (
                  <tr key={tx.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <input type="checkbox" checked={selecionadas.includes(tx.id)} onChange={() => alternarSelecionada(tx.id)} />
                    </td>
                    <td style={{ padding: '12px' }}>{formatarData(tx.data)}</td>
                    <td style={{ padding: '12px', color: '#475569', fontSize: '13px' }}>{tx.conta_nome || 'Conta'}</td>
                    <td style={{ padding: '12px' }}>
                      {tx.descricao}
                      {tx.eh_transferencia_interna && (
                        <span style={{ marginLeft: '8px', background: '#ccfbf1', color: '#0f766e', padding: '3px 7px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold' }}>
                          Transferência interna
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '12px', textAlign: 'right', color: tx.tipo === 'CREDITO' ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                      {tx.tipo === 'CREDITO' ? '+' : '-'}{formatarMoeda(tx.valor)}
                    </td>
                    <td style={{ padding: '12px' }}>{tx.tipo === 'CREDITO' ? 'Crédito' : 'Débito'}</td>
                    <td style={{ padding: '12px' }}>
                      <span style={{ background: tx.categoria_origem === 'AUTO' ? '#dbeafe' : '#e5e7eb', padding: '4px 8px', borderRadius: '4px', fontSize: '12px' }}>
                        {tx.categoria_macro_nome || tx.categoria_nome || 'Sem categoria'}{tx.categoria_detalhada_nome ? ` › ${tx.categoria_detalhada_nome}` : ''}{tx.categoria_origem === 'AUTO' ? ' • auto' : ''}
                      </span>
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
                {transacoesFiltradas.length === 0 && (
                  <tr><td colSpan="8" style={{ padding: '24px', textAlign: 'center', color: '#6b7280' }}>Nenhuma transação corresponde aos filtros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
