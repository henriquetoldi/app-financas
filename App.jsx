// ============================================================================
// FRONTEND: React App
// ============================================================================

import React, { useState, useEffect } from 'react';
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
  const indices = {
    data: cabecalho.indexOf('data'),
    descricao: cabecalho.indexOf('descricao'),
    categoria: cabecalho.indexOf('categoria'),
    valor: cabecalho.indexOf('valor'),
    tipo: cabecalho.indexOf('tipo'),
  };
  const faltantes = Object.entries(indices)
    .filter(([, indice]) => indice === -1)
    .map(([coluna]) => coluna === 'descricao' ? 'Descrição' : coluna.charAt(0).toUpperCase() + coluna.slice(1));

  if (faltantes.length > 0) {
    throw new Error(`Colunas obrigatórias não encontradas: ${faltantes.join(', ')}.`);
  }

  return linhas.slice(1).filter((linha) => linha.some((valor) => String(valor || '').trim())).map((linha) => ({
    data: linha[indices.data],
    descricao: linha[indices.descricao],
    categoria: linha[indices.categoria],
    valor: linha[indices.valor],
    tipo: linha[indices.tipo],
  }));
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
    const categoria = String(linha.categoria || '').trim() || 'Outros';
    const valor = normalizarValorLinha(linha.valor);
    const tipoTexto = normalizarTextoColuna(linha.tipo);

    if (!data) erros.push(`Linha ${numeroLinha}: Data inválida.`);
    if (!descricao) erros.push(`Linha ${numeroLinha}: Descrição obrigatória.`);
    if (!Number.isFinite(valor) || valor <= 0) erros.push(`Linha ${numeroLinha}: Valor inválido.`);
    if (!['debito', 'credito'].includes(tipoTexto)) erros.push(`Linha ${numeroLinha}: Tipo deve ser Débito ou Crédito.`);

    if (data && descricao && Number.isFinite(valor) && valor > 0 && ['debito', 'credito'].includes(tipoTexto)) {
      transacoes.push({
        data,
        descricao,
        categoria,
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
  const [carregando, setCarregando] = useState(false);

  const processarArquivo = async (file) => {
    setArquivo(file);
    setValidacao(null);
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

  const importar = async () => {
    if (!validacao?.valido) return;
    setCarregando(true);
    try {
      const response = await axios.post(`${API_URL}/importar`, {
        conta_id: contaId || undefined,
        conta_nome: contaId ? undefined : novaConta,
        transacoes: validacao.transacoes,
        nome_arquivo: arquivo.name,
        arquivo_base64: await arquivoParaBase64(arquivo),
      }, { headers: { Authorization: `Bearer ${token}` } });

      alert(`${response.data.mensagem}\n${response.data.duplicadas || 0} duplicadas ignoradas.`);
      onConcluida();
    } catch (error) {
      alert(montarMensagemErroImportacao(error));
    } finally {
      setCarregando(false);
    }
  };

  return (
    <div>
      <h2>📊 Importar transações por planilha XLSX</h2>
      <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '14px', padding: '16px', marginTop: '12px' }}>
        <p style={{ color: '#374151', marginTop: 0 }}>
          Use esta tela para trazer para o app as transações que você organizou em uma planilha Excel.
          Antes de enviar, o sistema confere se os dados estão no formato esperado.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px' }}>
            <strong>Colunas obrigatórias</strong>
            <p style={{ color: '#6b7280', marginBottom: 0 }}>Data, Descrição, Categoria, Valor e Tipo.</p>
          </div>
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px' }}>
            <strong>Exemplo de linha válida</strong>
            <p style={{ color: '#6b7280', marginBottom: 0 }}>2026-01-15 | Supermercado | Alimentação | 150,50 | Débito</p>
          </div>
        </div>
      </div>

      <div style={{ margin: '18px 0', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '14px', padding: '16px' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '8px' }}>Conta de destino</label>
        <p style={{ color: '#92400e', marginTop: 0 }}>
          Conta de destino é a conta, cartão ou carteira onde essas movimentações serão registradas.
          Todas as transações importadas deste arquivo serão vinculadas à conta escolhida abaixo.
        </p>
        {contas.length > 0 && (
          <select value={contaId} onChange={(event) => setContaId(event.target.value)} style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db', marginRight: '10px' }}>
            {contas.map((conta) => <option key={conta.id} value={conta.id}>{conta.nome}</option>)}
            <option value="">+ Criar nova conta</option>
          </select>
        )}
        {(!contaId || contas.length === 0) && (
          <input value={novaConta} onChange={(event) => setNovaConta(event.target.value)} placeholder="Nome da nova conta" style={{ padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db' }} />
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
        <p style={{ color: '#2563eb', marginBottom: 0 }}>Selecione o arquivo Excel no formato explicado acima.</p>
      </label>

      {carregando && <p>Processando...</p>}

      {validacao?.erros?.length > 0 && (
        <div style={{ background: '#fef2f2', color: '#991b1b', borderRadius: '10px', padding: '14px', marginTop: '16px' }}>
          <strong>❌ Erros encontrados:</strong>
          <ul>{validacao.erros.slice(0, 10).map((erro) => <li key={erro}>{erro}</li>)}</ul>
          {validacao.erros.length > 10 && <p>...e mais {validacao.erros.length - 10} erros.</p>}
        </div>
      )}

      {validacao?.valido && (
        <div style={{ background: '#ecfdf5', color: '#065f46', borderRadius: '10px', padding: '14px', marginTop: '16px' }}>
          ✅ {validacao.transacoes.length} linhas validadas e prontas para importar na conta selecionada.
        </div>
      )}

      <div style={{ marginTop: '18px', display: 'flex', gap: '10px' }}>
        <button onClick={importar} disabled={!validacao?.valido || carregando} style={{ background: '#10b981', color: 'white', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: validacao?.valido ? 'pointer' : 'not-allowed', opacity: validacao?.valido ? 1 : 0.6 }}>Importar transações</button>
        <button onClick={() => { setArquivo(null); setValidacao(null); }} style={{ background: '#e5e7eb', border: 'none', padding: '12px 18px', borderRadius: '8px', cursor: 'pointer' }}>LIMPAR</button>
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

  useEffect(() => {
    carregarContas();
  }, []);

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

  if (modo === 'transacoes' && contas.length > 0) {
    return (
      <TelaTransacoes
        conta={contas[0]}
        token={token}
        onVoltar={() => setModo('home')}
      />
    );
  }

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
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '20px'
                }}>
                  <h2>Suas Contas</h2>

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
                  {contas.map(conta => (
                    <div
                      key={conta.id}
                      onClick={() => setModo('transacoes')}
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

                      <p style={{ color: '#999', fontSize: '12px' }}>
                        Clique para ver transações
                      </p>
                    </div>
                  ))}
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

function TelaTransacoes({ conta, token, onVoltar }) {
  const [transacoes, setTransacoes] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [categoriaModalAberta, setCategoriaModalAberta] = useState(false);
  const [transacaoSelecionada, setTransacaoSelecionada] = useState(null);

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
        axios.get(`${API_URL}/transacoes/${conta.id}`, { headers: authHeaders }),
        axios.get(`${API_URL}/categorias`, { headers: authHeaders })
      ]);

      setTransacoes(transacoesResponse.data.transacoes || []);
      setCategorias(categoriasResponse.data.categorias || []);
    } catch (error) {
      alert('Erro ao carregar transações: ' + (error.response?.data?.erro || error.message));
    } finally {
      setCarregando(false);
    }
  };

  const handleCategorizar = async (categoriaId) => {
    if (!transacaoSelecionada) return;

    try {
      await axios.patch(
        `${API_URL}/transacoes/${transacaoSelecionada.id}/categorizar`,
        { categoriaId },
        { headers: authHeaders }
      );

      setCategoriaModalAberta(false);
      setTransacaoSelecionada(null);
      await carregarDados();
    } catch (error) {
      alert('Erro ao categorizar: ' + (error.response?.data?.erro || error.message));
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <div style={{
        background: '#1f2937',
        color: 'white',
        padding: '20px'
      }}>
        <button
          onClick={onVoltar}
          style={{
            background: 'rgba(255,255,255,0.2)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.3)',
            padding: '8px 16px',
            borderRadius: '6px',
            cursor: 'pointer',
            marginBottom: '15px'
          }}
        >
          ← Voltar
        </button>

        <h1 style={{ margin: 0 }}>{conta.nome}</h1>
        <p style={{ margin: '5px 0 0', opacity: 0.8 }}>
          Saldo: {formatarMoeda(conta.saldo)}
        </p>
      </div>

      <div style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
        {carregando ? (
          <p>Carregando transações...</p>
        ) : transacoes.length === 0 ? (
          <div style={{
            background: 'white',
            borderRadius: '12px',
            padding: '40px',
            textAlign: 'center'
          }}>
            <h2>Nenhuma transação encontrada</h2>
          </div>
        ) : (
          <div style={{
            background: 'white',
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
          }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse'
            }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Data</th>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Descrição</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>Valor</th>
                  <th style={{ padding: '12px', textAlign: 'left' }}>Categoria</th>
                  <th style={{ padding: '12px', textAlign: 'center' }}>Ações</th>
                </tr>
              </thead>

              <tbody>
                {transacoes.map(tx => (
                  <tr key={tx.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                    <td style={{ padding: '12px' }}>{formatarData(tx.data)}</td>

                    <td style={{ padding: '12px' }}>{tx.descricao}</td>

                    <td style={{
                      padding: '12px',
                      textAlign: 'right',
                      color: tx.tipo === 'CREDITO' ? '#10b981' : '#ef4444',
                      fontWeight: 'bold'
                    }}>
                      {tx.tipo === 'CREDITO' ? '+' : '-'}
                      {formatarMoeda(tx.valor)}
                    </td>

                    <td style={{ padding: '12px' }}>
                      <span style={{
                        background: '#e5e7eb',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '12px'
                      }}>
                        {tx.categoria_nome || 'Sem categoria'}
                      </span>
                    </td>

                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <button
                        onClick={() => {
                          setTransacaoSelecionada(tx);
                          setCategoriaModalAberta(true);
                        }}
                        style={{
                          background: '#667eea',
                          color: 'white',
                          border: 'none',
                          padding: '4px 12px',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        Categorizar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {categoriaModalAberta && transacaoSelecionada && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'white',
            borderRadius: '12px',
            padding: '30px',
            maxWidth: '400px',
            width: '90%'
          }}>
            <h3>
              Categorizar: {transacaoSelecionada.descricao.substring(0, 30)}
            </h3>

            <p style={{ color: '#666', marginBottom: '20px' }}>
              {formatarMoeda(transacaoSelecionada.valor)}
            </p>

            <div style={{ display: 'grid', gap: '10px', marginBottom: '20px' }}>
              {categorias.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => handleCategorizar(cat.id)}
                  style={{
                    background: '#f3f4f6',
                    border: '1px solid #e5e7eb',
                    padding: '12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '14px'
                  }}
                >
                  {cat.emoji} {cat.nome}
                </button>
              ))}
            </div>

            <button
              onClick={() => {
                setCategoriaModalAberta(false);
                setTransacaoSelecionada(null);
              }}
              style={{
                background: '#e5e7eb',
                border: 'none',
                padding: '12px',
                borderRadius: '8px',
                cursor: 'pointer',
                width: '100%'
              }}
            >
              Cancelar
            </button>
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