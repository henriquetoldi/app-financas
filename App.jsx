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
      alert('Erro ao importar: ' + (error.response?.data?.erro || error.message));
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
                  Clique abaixo para importar seus extratos do Google Drive.
                </p>

                <button
                  onClick={carregarPastas}
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
                  📁 Importar Extratos
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
                    onClick={carregarPastas}
                    style={{
                      background: '#667eea',
                      color: 'white',
                      border: 'none',
                      padding: '10px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    📁 Importar Mais
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
              onClick={() => {
                setModo('home');
                setPastaSelecionada(null);
                setArquivos([]);
              }}
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

            <h2>Importar Extratos</h2>

            {carregando && <p>Carregando...</p>}

            {!pastaSelecionada && (
              <>
                <h3>Escolha uma pasta</h3>

                <div style={{ display: 'grid', gap: '10px' }}>
                  {pastas.map(pasta => (
                    <button
                      key={pasta.id}
                      onClick={() => carregarArquivos(pasta)}
                      style={{
                        background: '#f3f4f6',
                        border: '1px solid #e5e7eb',
                        padding: '12px',
                        borderRadius: '8px',
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}
                    >
                      📁 {pasta.name}
                    </button>
                  ))}
                </div>

                {!carregando && pastas.length === 0 && (
                  <p style={{ color: '#666' }}>
                    Nenhuma pasta encontrada no Google Drive.
                  </p>
                )}
              </>
            )}

            {pastaSelecionada && (
              <>
                <h3>Arquivos em: {pastaSelecionada.name}</h3>

                <button
                  onClick={() => {
                    setPastaSelecionada(null);
                    setArquivos([]);
                  }}
                  style={{
                    background: '#e5e7eb',
                    border: 'none',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    marginBottom: '15px'
                  }}
                >
                  Escolher outra pasta
                </button>

                <div style={{ display: 'grid', gap: '10px' }}>
                  {arquivos.map(arquivo => (
                    <button
                      key={arquivo.id}
                      onClick={() => importarArquivo(arquivo)}
                      disabled={carregando}
                      style={{
                        background: '#f3f4f6',
                        border: '1px solid #e5e7eb',
                        padding: '12px',
                        borderRadius: '8px',
                        textAlign: 'left',
                        cursor: carregando ? 'not-allowed' : 'pointer'
                      }}
                    >
                      📄 {arquivo.name}
                    </button>
                  ))}
                </div>

                {!carregando && arquivos.length === 0 && (
                  <p style={{ color: '#666' }}>
                    Nenhum arquivo CSV encontrado nesta pasta.
                  </p>
                )}
              </>
            )}
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
    const tokenSalvo = localStorage.getItem('token');
    const usuarioSalvo = localStorage.getItem('usuario');

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
    }    if (code) {
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
