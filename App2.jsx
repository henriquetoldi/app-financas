diff --git a/App.jsx b/App.jsx
index ef20f8fc712e51939d393602ecf77e2e5c678efa..63a466a2ff37aa1bb452863afbb8d3ff3471923f 100644
--- a/App.jsx
+++ b/App.jsx
@@ -1,35 +1,34 @@
 // ============================================================================
 // FRONTEND: React App
 // npm create vite@latest -- --template react
-// npm install axios react-router-dom
 // ============================================================================
 
 import React, { useState, useEffect } from 'react';
 import axios from 'axios';
 
-const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
+const API_URL = import.meta.env.VITE_API_URL || '/api';
 
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
 
 // ============================================================================
 // COMPONENTES
 // ============================================================================
 
 function Login() {
   const [carregando, setCarregando] = useState(false);
 
   const handleLogin = async () => {
     setCarregando(true);
@@ -112,51 +111,51 @@ function Dashboard({ usuario, token, onLogout }) {
     try {
       const response = await axios.get(`${API_URL}/contas`, {
         headers: { Authorization: `Bearer ${token}` }
       });
       setContas(response.data.contas);
     } catch (error) {
       console.error('Erro ao carregar contas:', error);
     }
   };
 
   const handleImportar = async (contaId, nomeArquivo) => {
     if (!window.confirm(`Importar "${nomeArquivo}"?`)) return;
 
     setCarregando(true);
     try {
       const response = await axios.post(
         `${API_URL}/importar/${pastasSelecionadas}`,
         { nomePasta: nomeArquivo },
         { headers: { Authorization: `Bearer ${token}` } }
       );
 
       alert(`✅ ${response.data.inseridas} transações importadas!\n(${response.data.duplicadas} duplicadas)`);
       carregarContas();
       setModo('transacoes');
     } catch (error) {
-      alert('Erro: ' + error.response?.data?.erro || error.message);
+      alert('Erro: ' + (error.response?.data?.erro || error.message));
     } finally {
       setCarregando(false);
     }
   };
 
   if (modo === 'transacoes' && contas.length > 0) {
     return <TelaTransacoes conta={contas[0]} token={token} />;
   }
 
   return (
     <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
       {/* Header */}
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
             Olá, {usuario.nome}
           </p>
@@ -452,51 +451,51 @@ function TelaTransacoes({ conta, token }) {
 
             <button
               onClick={() => setCategoriaModalAberta(false)}
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
 
-export default function App() {
+function App() {
   const [logado, setLogado] = useState(false);
   const [usuario, setUsuario] = useState(null);
   const [token, setToken] = useState(null);
 
   useEffect(() => {
     // Verificar se tem token salvo
     const tokenSalvo = localStorage.getItem('token');
     const usuarioSalvo = localStorage.getItem('usuario');
 
     if (tokenSalvo && usuarioSalvo) {
       setToken(tokenSalvo);
       setUsuario(JSON.parse(usuarioSalvo));
       setLogado(true);
     }
 
     // Verificar callback do Google
     const params = new URLSearchParams(window.location.search);
     const code = params.get('code');
 
     if (code) {
       axios.post(`${API_URL}/auth/google/callback`, { code })
         .then(response => {
           localStorage.setItem('token', response.data.token);
           localStorage.setItem('usuario', JSON.stringify(response.data.usuario));
           setToken(response.data.token);
@@ -506,25 +505,27 @@ export default function App() {
         })
         .catch(error => {
           alert('Erro ao fazer login: ' + error.message);
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
+
+export default App;
