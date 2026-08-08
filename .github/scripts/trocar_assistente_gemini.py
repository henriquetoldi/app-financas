from pathlib import Path

backend_path = Path('backend-server.js')
app_path = Path('App.jsx')
backend = backend_path.read_text(encoding='utf-8')
app = app_path.read_text(encoding='utf-8')

backend = backend.replace(
    "const ASSISTENTE_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';",
    "const ASSISTENTE_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';"
)

helper_start = backend.index('function extrairTextoRespostaAssistente(response) {')
helper_end = backend.index('function normalizarHistoricoAssistente(historico) {', helper_start)
new_helpers = r'''function declaracoesGeminiAssistente() {
  return FERRAMENTAS_ASSISTENTE.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

function extrairTextoRespostaAssistente(response) {
  const partes = response?.candidates?.[0]?.content?.parts || [];
  return partes
    .filter((parte) => typeof parte?.text === 'string')
    .map((parte) => parte.text)
    .join('\n')
    .trim();
}

function extrairChamadasGeminiAssistente(response) {
  const partes = response?.candidates?.[0]?.content?.parts || [];
  return partes
    .filter((parte) => parte?.functionCall?.name)
    .map((parte) => ({
      name: parte.functionCall.name,
      args: parte.functionCall.args || {},
      id: parte.functionCall.id || null,
    }));
}

async function chamarGeminiAssistente({ contents, instructions }) {
  const modelo = encodeURIComponent(ASSISTENTE_GEMINI_MODEL);
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents,
        tools: [{ functionDeclarations: declaracoesGeminiAssistente() }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200,
        },
      }),
    });
  } catch (error) {
    throw new Error('Não foi possível conectar ao serviço gratuito de IA.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const erro = new Error(data?.error?.message || `Falha no serviço Gemini (${response.status}).`);
    erro.statusGemini = response.status;
    throw erro;
  }
  return data;
}

'''
backend = backend[:helper_start] + new_helpers + backend[helper_end:]

route_start = backend.index("app.post('/api/assistente', verificarToken, async (req, res) => {")
route_end = backend.index('\n// ============================================================================\n// ROTAS: PROVISÕES E CONCILIAÇÕES', route_start)
new_route = r'''app.post('/api/assistente', verificarToken, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      erro: 'Assistente financeiro gratuito ainda não configurado no servidor.',
      codigo: 'GEMINI_API_KEY_AUSENTE',
    });
  }

  const mensagem = String(req.body?.mensagem || '').trim().slice(0, ASSISTENTE_MAX_MENSAGEM);
  if (!mensagem) return res.status(400).json({ erro: 'Escreva uma pergunta para o assistente.' });

  const usuarioId = req.usuario.usuario_id;
  const historico = normalizarHistoricoAssistente(req.body?.historico);
  const contents = historico.map((item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: mensagem }] });

  const ferramentasUsadas = new Set();
  const hoje = new Date().toISOString().slice(0, 10);
  const instructions = `Você é o Assistente Financeiro de um aplicativo de finanças pessoais. Data atual do servidor: ${hoje}.
Responda em português do Brasil, de forma direta, clara e útil.
Você está em MODO SOMENTE LEITURA. Nunca afirme que criou, editou, excluiu, categorizou ou alterou dados.
Para perguntas sobre dados financeiros do usuário, use as ferramentas disponíveis. Não invente números, categorias, saldos ou lançamentos.
Se os dados disponíveis não forem suficientes para responder, diga exatamente o que falta.
Valores são em BRL. Diferencie fatos encontrados nos dados de interpretações ou sugestões.
Não exponha IDs internos, SQL, tokens, chaves ou detalhes técnicos do banco.
Não use tabelas Markdown complexas; prefira conclusão curta, números principais e bullets quando ajudarem.
As ferramentas disponíveis são exclusivamente de consulta e já estão limitadas ao usuário autenticado.`;

  try {
    let response = null;
    for (let rodada = 0; rodada < 5; rodada += 1) {
      response = await chamarGeminiAssistente({ contents, instructions });

      const conteudoModelo = response?.candidates?.[0]?.content;
      if (!conteudoModelo?.parts?.length) {
        const motivo = response?.candidates?.[0]?.finishReason;
        throw new Error(motivo ? `A IA não retornou conteúdo (${motivo}).` : 'A IA não retornou conteúdo.');
      }

      contents.push({
        role: conteudoModelo.role || 'model',
        parts: conteudoModelo.parts,
      });

      const chamadas = extrairChamadasGeminiAssistente(response);
      if (chamadas.length === 0) {
        const resposta = extrairTextoRespostaAssistente(response);
        if (!resposta) throw new Error('A IA não retornou uma resposta em texto.');
        return res.json({
          resposta,
          modelo: ASSISTENTE_GEMINI_MODEL,
          provedor: 'gemini-free-tier',
          consultas: Array.from(ferramentasUsadas).map((nome) => ROTULOS_FERRAMENTAS_ASSISTENTE[nome] || nome),
        });
      }

      const partesRespostaFerramentas = [];
      for (const chamada of chamadas) {
        const resultado = await executarFerramentaAssistente(usuarioId, chamada.name, chamada.args || {});
        ferramentasUsadas.add(chamada.name);
        const functionResponse = {
          name: chamada.name,
          response: resultado,
        };
        if (chamada.id) functionResponse.id = chamada.id;
        partesRespostaFerramentas.push({ functionResponse });
      }

      contents.push({ role: 'user', parts: partesRespostaFerramentas });
    }

    return res.status(502).json({ erro: 'A análise exigiu chamadas demais. Tente fazer uma pergunta mais específica.' });
  } catch (error) {
    console.error('Erro no assistente financeiro gratuito:', error.message);
    if (error.statusGemini === 429) {
      return res.status(503).json({
        erro: 'A cota gratuita da IA foi atingida por enquanto. Nenhuma cobrança será feita. Tente novamente depois.',
        codigo: 'GEMINI_COTA_GRATUITA_ATINGIDA',
      });
    }
    if (error.statusGemini === 401 || error.statusGemini === 403) {
      return res.status(503).json({
        erro: 'A chave gratuita do Gemini precisa ser revisada.',
        codigo: 'GEMINI_CONFIG_INVALIDA',
      });
    }
    return res.status(500).json({ erro: 'Não foi possível concluir a análise agora. Tente novamente.' });
  }
});

'''
backend = backend[:route_start] + new_route + backend[route_end:]

app = app.replace("codigo === 'OPENAI_API_KEY_AUSENTE'", "codigo === 'GEMINI_API_KEY_AUSENTE'")
app = app.replace(
    "O Assistente já está instalado, mas ainda falta configurar a chave da IA no servidor. Adicione OPENAI_API_KEY nas variáveis do Railway para ativá-lo.",
    "O Assistente já está instalado e não exige API paga. Falta apenas configurar uma chave gratuita do Gemini no servidor. Adicione GEMINI_API_KEY nas variáveis do Railway para ativá-lo."
)
app = app.replace(
    '<span className="assistente-status">🔒 Somente leitura</span>',
    '<span className="assistente-status">🆓 Free tier · somente leitura</span>'
)
app = app.replace(
    'A IA só acessa consultas de leitura autorizadas pelo backend e nunca recebe acesso direto ao banco. Nesta etapa ela não pode alterar seus dados.',
    'A IA só acessa consultas de leitura autorizadas pelo backend e nunca recebe acesso direto ao banco. O assistente usa o nível gratuito do Gemini; nesse nível, o Google informa que o conteúdo enviado pode ser usado para melhorar seus produtos. Nesta etapa a IA não pode alterar seus dados.'
)

if 'OPENAI_API_KEY' in backend or 'OPENAI_MODEL' in backend or 'ASSISTENTE_OPENAI_MODEL' in backend:
    raise SystemExit('Ainda existem referências à OpenAI no backend do assistente.')
if 'OPENAI_API_KEY' in app:
    raise SystemExit('Ainda existem referências à chave da OpenAI no frontend.')
if 'GEMINI_API_KEY' not in backend or 'ASSISTENTE_GEMINI_MODEL' not in backend:
    raise SystemExit('Migração para Gemini não foi aplicada corretamente.')

backend_path.write_text(backend, encoding='utf-8')
app_path.write_text(app, encoding='utf-8')

# push de disparo do workflow
