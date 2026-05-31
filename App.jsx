// ============================================================================
// FRONTEND: React App
// npm create vite@latest -- --template react
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
  }).format(valor);
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
// COMPONENTES
// ============================================================================

function Login() {
  const [carregando, setCarregando] = useState(false);

  const handleLogin = async () => {
    setCarregando(true);
    try {
      const response = await axios.get(`${API_URL}/auth/google/url`);
      window.location.href = response.data.url;
    } catch (error) {
      alert('Erro ao fazer login: ' + error.message);
      setCarregando(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
@@ -457,75 +488,98 @@ function TelaTransacoes({ conta, token }) {
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
