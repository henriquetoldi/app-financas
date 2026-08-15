const fs = require('fs');

const path = 'backend-server.js';
let text = fs.readFileSync(path, 'utf8');

const antigo = `function declaracoesGeminiAssistente(nomesPermitidos = null) {
  const filtro = Array.isArray(nomesPermitidos) && nomesPermitidos.length > 0
    ? new Set(nomesPermitidos)
    : null;

  return FERRAMENTAS_ASSISTENTE
    .filter(({ name }) => !filtro || filtro.has(name))
    .map(({ name, description, parameters }) => {
      const declaracao = { name, description };
      const propriedades = parameters?.properties && typeof parameters.properties === 'object'
        ? Object.keys(parameters.properties)
        : [];
      if (propriedades.length > 0) declaracao.parameters = parameters;
      return declaracao;
    });
}`;

const novo = `function sanitizarSchemaFunctionCallingGemini(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;

  const sanitizado = {};
  if (schema.type) sanitizado.type = schema.type;
  if (schema.description) sanitizado.description = schema.description;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) sanitizado.enum = schema.enum;

  if (schema.properties && typeof schema.properties === 'object') {
    sanitizado.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([nome, propriedade]) => [
        nome,
        sanitizarSchemaFunctionCallingGemini(propriedade),
      ])
    );
  }

  if (schema.items && typeof schema.items === 'object') {
    sanitizado.items = sanitizarSchemaFunctionCallingGemini(schema.items);
  }

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const nomesValidos = sanitizado.properties ? new Set(Object.keys(sanitizado.properties)) : null;
    const required = nomesValidos ? schema.required.filter((nome) => nomesValidos.has(nome)) : [];
    if (required.length > 0) sanitizado.required = required;
  }

  return sanitizado;
}

function declaracoesGeminiAssistente(nomesPermitidos = null) {
  const filtro = Array.isArray(nomesPermitidos) && nomesPermitidos.length > 0
    ? new Set(nomesPermitidos)
    : null;

  return FERRAMENTAS_ASSISTENTE
    .filter(({ name }) => !filtro || filtro.has(name))
    .map(({ name, description, parameters }) => {
      const declaracao = { name, description };
      const propriedades = parameters?.properties && typeof parameters.properties === 'object'
        ? Object.keys(parameters.properties)
        : [];
      if (propriedades.length > 0) {
        declaracao.parameters = sanitizarSchemaFunctionCallingGemini(parameters);
      }
      return declaracao;
    });
}`;

if (!text.includes(antigo)) {
  throw new Error('Bloco declaracoesGeminiAssistente esperado não encontrado.');
}

text = text.replace(antigo, novo);
fs.writeFileSync(path, text);

const final = fs.readFileSync(path, 'utf8');
if (!final.includes('function sanitizarSchemaFunctionCallingGemini(schema)')) throw new Error('Sanitizador não foi inserido.');
if (!final.includes('declaracao.parameters = sanitizarSchemaFunctionCallingGemini(parameters);')) throw new Error('Declarações ainda não usam o sanitizador.');
console.log('Sanitização do schema Gemini aplicada.');
