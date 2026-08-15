const fs = require('fs');

function replaceOne(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first === -1) throw new Error(`Trecho não encontrado: ${label}`);
  const second = text.indexOf(search, first + search.length);
  if (second !== -1) throw new Error(`Trecho duplicado inesperadamente: ${label}`);
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

let backend = fs.readFileSync('backend-server.js', 'utf8');

backend = replaceOne(
  backend,
  "const ASSISTENTE_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';",
  "const ASSISTENTE_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';\nconst ASSISTENTE_GEMINI_MODEL_FALLBACK = 'gemini-3.1-flash-lite';",
  'modelo padrão do Assistente'
);

const antigaFuncao = `async function chamarGeminiAssistente({ contents, instructions, toolConfig = null }) {\n  const modelo = encodeURIComponent(ASSISTENTE_GEMINI_MODEL);\n  const nomesPermitidos = toolConfig?.functionCallingConfig?.allowedFunctionNames || null;\n  const functionDeclarations = declaracoesGeminiAssistente(nomesPermitidos);\n  let response;\n  try {\n    response = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/\${modelo}:generateContent\`, {\n      method: 'POST',\n      headers: {\n        'x-goog-api-key': process.env.GEMINI_API_KEY,\n        'Content-Type': 'application/json',\n      },\n      body: JSON.stringify({\n        systemInstruction: { parts: [{ text: instructions }] },\n        contents,\n        tools: [{ functionDeclarations }],\n        toolConfig: toolConfig || { functionCallingConfig: { mode: 'AUTO' } },\n        generationConfig: {\n          temperature: 0.2,\n          maxOutputTokens: 1200,\n        },\n      }),\n    });\n  } catch (error) {\n    throw new Error('Não foi possível conectar ao serviço gratuito de IA.');\n  }\n\n  const data = await response.json().catch(() => ({}));\n  if (!response.ok) {\n    const erro = new Error(data?.error?.message || \`Falha no serviço Gemini (\${response.status}).\`);\n    erro.statusGemini = response.status;\n    erro.codigoGemini = data?.error?.status || null;\n    throw erro;\n  }\n  return data;\n}`;

const novaFuncao = `function modelosGeminiAssistente() {\n  return Array.from(new Set([ASSISTENTE_GEMINI_MODEL, ASSISTENTE_GEMINI_MODEL_FALLBACK].filter(Boolean)));\n}\n\nasync function chamarGeminiAssistente({ contents, instructions, toolConfig = null }) {\n  const nomesPermitidos = toolConfig?.functionCallingConfig?.allowedFunctionNames || null;\n  const functionDeclarations = declaracoesGeminiAssistente(nomesPermitidos);\n  const modelos = modelosGeminiAssistente();\n  let ultimoErro = null;\n\n  for (let indiceModelo = 0; indiceModelo < modelos.length; indiceModelo += 1) {\n    const nomeModelo = modelos[indiceModelo];\n    const modelo = encodeURIComponent(nomeModelo);\n    let response;\n    try {\n      response = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/\${modelo}:generateContent\`, {\n        method: 'POST',\n        headers: {\n          'x-goog-api-key': process.env.GEMINI_API_KEY,\n          'Content-Type': 'application/json',\n        },\n        body: JSON.stringify({\n          systemInstruction: { parts: [{ text: instructions }] },\n          contents,\n          tools: [{ functionDeclarations }],\n          toolConfig: toolConfig || { functionCallingConfig: { mode: 'AUTO' } },\n          generationConfig: {\n            maxOutputTokens: 1200,\n          },\n        }),\n      });\n    } catch (error) {\n      throw new Error('Não foi possível conectar ao serviço gratuito de IA.');\n    }\n\n    const data = await response.json().catch(() => ({}));\n    if (response.ok) return { ...data, _modeloUsado: nomeModelo };\n\n    const erro = new Error(data?.error?.message || \`Falha no serviço Gemini (\${response.status}).\`);\n    erro.statusGemini = response.status;\n    erro.codigoGemini = data?.error?.status || null;\n    erro.modeloGemini = nomeModelo;\n    ultimoErro = erro;\n\n    const podeUsarFallback = response.status === 404 && indiceModelo < modelos.length - 1;\n    if (podeUsarFallback) {\n      console.warn('Modelo Gemini indisponível; tentando fallback compatível:', {\n        modelo: nomeModelo,\n        fallback: modelos[indiceModelo + 1],\n      });\n      continue;\n    }\n\n    throw erro;\n  }\n\n  throw ultimoErro || new Error('Nenhum modelo Gemini disponível para o Assistente.');\n}`;

backend = replaceOne(backend, antigaFuncao, novaFuncao, 'função chamarGeminiAssistente');

backend = replaceOne(
  backend,
  "          modelo: ASSISTENTE_GEMINI_MODEL,",
  "          modelo: response?._modeloUsado || ASSISTENTE_GEMINI_MODEL,",
  'modelo retornado ao frontend'
);

backend = replaceOne(
  backend,
  "      codigoGemini: error.codigoGemini || null,\n    });",
  "      codigoGemini: error.codigoGemini || null,\n      modeloGemini: error.modeloGemini || null,\n    });",
  'log do erro Gemini'
);

backend = replaceOne(
  backend,
  "    if (error.statusGemini === 429) {",
  "    if (error.statusGemini === 404) {\n      return res.status(503).json({\n        erro: 'O modelo configurado para o Assistente não está disponível. Tente novamente após atualizar a configuração do Gemini.',\n        codigo: 'GEMINI_MODELO_INDISPONIVEL',\n      });\n    }\n    if (error.statusGemini === 429) {",
  'tratamento de modelo indisponível'
);

fs.writeFileSync('backend-server.js', backend);

const final = fs.readFileSync('backend-server.js', 'utf8');
const obrigatorios = [
  "process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'",
  "const ASSISTENTE_GEMINI_MODEL_FALLBACK = 'gemini-3.1-flash-lite';",
  'function modelosGeminiAssistente()',
  'Modelo Gemini indisponível; tentando fallback compatível:',
  'response?._modeloUsado || ASSISTENTE_GEMINI_MODEL',
  "codigo: 'GEMINI_MODELO_INDISPONIVEL'",
];
for (const trecho of obrigatorios) {
  if (!final.includes(trecho)) throw new Error(`Validação falhou: ${trecho}`);
}
if (final.includes("temperature: 0.2")) throw new Error('Parâmetro temperature antigo ainda presente no request do Gemini.');
console.log('Atualização do modelo Gemini aplicada com sucesso.');
