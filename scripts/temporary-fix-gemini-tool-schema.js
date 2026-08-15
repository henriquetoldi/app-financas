const fs = require('fs');

function replaceOnce(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first === -1) throw new Error(`Trecho não encontrado: ${label}`);
  const second = text.indexOf(search, first + search.length);
  if (second !== -1) throw new Error(`Trecho duplicado inesperadamente: ${label}`);
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

let backend = fs.readFileSync('backend-server.js', 'utf8');

backend = replaceOnce(
  backend,
  `function declaracoesGeminiAssistente() {\n  return FERRAMENTAS_ASSISTENTE.map(({ name, description, parameters }) => ({\n    name,\n    description,\n    parameters,\n  }));\n}`,
  `function declaracoesGeminiAssistente(nomesPermitidos = null) {\n  const filtro = Array.isArray(nomesPermitidos) && nomesPermitidos.length > 0\n    ? new Set(nomesPermitidos)\n    : null;\n\n  return FERRAMENTAS_ASSISTENTE\n    .filter(({ name }) => !filtro || filtro.has(name))\n    .map(({ name, description, parameters }) => {\n      const declaracao = { name, description };\n      const propriedades = parameters?.properties && typeof parameters.properties === 'object'\n        ? Object.keys(parameters.properties)\n        : [];\n      if (propriedades.length > 0) declaracao.parameters = parameters;\n      return declaracao;\n    });\n}`,
  'geração das declarações Gemini'
);

backend = replaceOnce(
  backend,
  `async function chamarGeminiAssistente({ contents, instructions, toolConfig = null }) {\n  const modelo = encodeURIComponent(ASSISTENTE_GEMINI_MODEL);\n  let response;\n  try {\n    response = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/\${modelo}:generateContent\`, {\n      method: 'POST',\n      headers: {\n        'x-goog-api-key': process.env.GEMINI_API_KEY,\n        'Content-Type': 'application/json',\n      },\n      body: JSON.stringify({\n        systemInstruction: { parts: [{ text: instructions }] },\n        contents,\n        tools: [{ functionDeclarations: declaracoesGeminiAssistente() }],\n        toolConfig: toolConfig || { functionCallingConfig: { mode: 'AUTO' } },\n        generationConfig: {\n          temperature: 0.2,\n          maxOutputTokens: 1200,\n        },\n      }),\n    });\n  } catch (error) {\n    throw new Error('Não foi possível conectar ao serviço gratuito de IA.');\n  }\n\n  const data = await response.json().catch(() => ({}));\n  if (!response.ok) {\n    const erro = new Error(data?.error?.message || \`Falha no serviço Gemini (\${response.status}).\`);\n    erro.statusGemini = response.status;\n    throw erro;\n  }\n  return data;\n}`,
  `async function chamarGeminiAssistente({ contents, instructions, toolConfig = null }) {\n  const modelo = encodeURIComponent(ASSISTENTE_GEMINI_MODEL);\n  const nomesPermitidos = toolConfig?.functionCallingConfig?.allowedFunctionNames || null;\n  const functionDeclarations = declaracoesGeminiAssistente(nomesPermitidos);\n  let response;\n  try {\n    response = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/\${modelo}:generateContent\`, {\n      method: 'POST',\n      headers: {\n        'x-goog-api-key': process.env.GEMINI_API_KEY,\n        'Content-Type': 'application/json',\n      },\n      body: JSON.stringify({\n        systemInstruction: { parts: [{ text: instructions }] },\n        contents,\n        tools: [{ functionDeclarations }],\n        toolConfig: toolConfig || { functionCallingConfig: { mode: 'AUTO' } },\n        generationConfig: {\n          temperature: 0.2,\n          maxOutputTokens: 1200,\n        },\n      }),\n    });\n  } catch (error) {\n    throw new Error('Não foi possível conectar ao serviço gratuito de IA.');\n  }\n\n  const data = await response.json().catch(() => ({}));\n  if (!response.ok) {\n    const erro = new Error(data?.error?.message || \`Falha no serviço Gemini (\${response.status}).\`);\n    erro.statusGemini = response.status;\n    erro.codigoGemini = data?.error?.status || null;\n    throw erro;\n  }\n  return data;\n}`,
  'chamada ao Gemini'
);

backend = replaceOnce(
  backend,
  `  } catch (error) {\n    console.error('Erro no assistente financeiro gratuito:', error.message);\n    if (error.statusGemini === 429) {`,
  `  } catch (error) {\n    console.error('Erro no assistente financeiro gratuito:', {\n      mensagem: error.message,\n      statusGemini: error.statusGemini || null,\n      codigoGemini: error.codigoGemini || null,\n    });\n    if (error.statusGemini === 400) {\n      return res.status(502).json({\n        erro: 'O serviço de IA recusou a configuração desta solicitação. Tente novamente; se persistir, revise as ferramentas do Assistente.',\n        codigo: 'GEMINI_REQUISICAO_INVALIDA',\n      });\n    }\n    if (error.statusGemini === 429) {`,
  'tratamento de erro do assistente'
);

fs.writeFileSync('backend-server.js', backend);

const finalText = fs.readFileSync('backend-server.js', 'utf8');
const required = [
  'function declaracoesGeminiAssistente(nomesPermitidos = null)',
  'if (propriedades.length > 0) declaracao.parameters = parameters;',
  'const nomesPermitidos = toolConfig?.functionCallingConfig?.allowedFunctionNames || null;',
  'const functionDeclarations = declaracoesGeminiAssistente(nomesPermitidos);',
  "codigo: 'GEMINI_REQUISICAO_INVALIDA'",
];
for (const snippet of required) {
  if (!finalText.includes(snippet)) throw new Error(`Validação falhou: ${snippet}`);
}
if (finalText.includes("parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },\n  },\n];\n\nconst ROTULOS")) {
  // O schema interno pode continuar existindo; a declaração enviada ao Gemini é que deve omitir parameters quando vazio.
}
console.log('Hotfix do schema Gemini aplicado com sucesso.');
