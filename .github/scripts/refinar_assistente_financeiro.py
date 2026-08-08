from pathlib import Path

app_path = Path('App.jsx')
backend_path = Path('backend-server.js')
app = app_path.read_text(encoding='utf-8')
backend = backend_path.read_text(encoding='utf-8')

# Corrige apenas alinhamento visual da rota de Previsões.
app = app.replace("      {modo === 'assistente' && <TelaAssistenteFinanceiro token={token} onVoltar={() => setModo('home')} />}\n      {modo === 'previsoes'", "        {modo === 'assistente' && <TelaAssistenteFinanceiro token={token} onVoltar={() => setModo('home')} />}\n        {modo === 'previsoes'", 1)

# Percentual sobre o gasto total real do período, antes do LIMIT.
old_query = """    `SELECT ${expressaoCategoria} AS categoria,\n            COUNT(*)::int AS quantidade,\n            ROUND(SUM(ABS(t.valor))::numeric, 2) AS valor\n"""
new_query = """    `SELECT ${expressaoCategoria} AS categoria,\n            COUNT(*)::int AS quantidade,\n            ROUND(SUM(ABS(t.valor))::numeric, 2) AS valor,\n            ROUND(SUM(SUM(ABS(t.valor))) OVER ()::numeric, 2) AS total_geral\n"""
if old_query not in backend:
    raise SystemExit('Consulta de categorias não encontrada para refino.')
backend = backend.replace(old_query, new_query, 1)

old_total = """  const total = result.rows.reduce((soma, item) => soma + Number(item.valor || 0), 0);\n  return {\n    periodo,\n    nivel,\n    totalNasCategoriasRetornadas: Number(total.toFixed(2)),\n    categorias: result.rows.map((item) => ({\n      categoria: item.categoria,\n      quantidade: Number(item.quantidade || 0),\n      valor: Number(item.valor || 0),\n      percentualDoTotalRetornado: total ? Number(((Number(item.valor || 0) / total) * 100).toFixed(1)) : 0,\n    })),\n  };\n"""
new_total = """  const totalGastoPeriodo = Number(result.rows[0]?.total_geral || 0);\n  return {\n    periodo,\n    nivel,\n    totalGastoPeriodo: Number(totalGastoPeriodo.toFixed(2)),\n    categorias: result.rows.map((item) => ({\n      categoria: item.categoria,\n      quantidade: Number(item.quantidade || 0),\n      valor: Number(item.valor || 0),\n      percentualDoGastoPeriodo: totalGastoPeriodo ? Number(((Number(item.valor || 0) / totalGastoPeriodo) * 100).toFixed(1)) : 0,\n    })),\n  };\n"""
if old_total not in backend:
    raise SystemExit('Bloco de total de categorias não encontrado.')
backend = backend.replace(old_total, new_total, 1)

# Não enviar IDs internos à OpenAI quando eles não são necessários para a análise.
backend = backend.replace("    `SELECT t.id, t.data, t.descricao, t.tipo, t.valor, c.nome AS conta_nome\n", "    `SELECT t.data, t.descricao, t.tipo, t.valor, c.nome AS conta_nome\n", 1)
backend = backend.replace("      id: item.id,\n      data: String(item.data).slice(0, 10),\n", "      data: String(item.data).slice(0, 10),\n", 1)
backend = backend.replace("    `SELECT id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas\n", "    `SELECT descricao, valor_estimado, data_desejada, prioridade, forma_pagamento, parcelas\n", 1)
backend = backend.replace("      id: item.id,\n      descricao: item.descricao,\n", "      descricao: item.descricao,\n", 1)
backend = backend.replace("    `SELECT id, nome, banco, tipo, COALESCE(saldo_atual, saldo_inicial, 0)::numeric AS saldo\n", "    `SELECT nome, banco, tipo, COALESCE(saldo_atual, saldo_inicial, 0)::numeric AS saldo\n", 1)
backend = backend.replace("    id: item.id,\n    nome: item.nome,\n", "    nome: item.nome,\n", 1)

# Melhora o resumo dos não categorizados separando débitos e créditos.
old_resumo = """    `SELECT COUNT(*)::int AS quantidade,\n            ROUND(COALESCE(SUM(ABS(t.valor)), 0)::numeric, 2) AS valor_total\n"""
new_resumo = """    `SELECT COUNT(*)::int AS quantidade,\n            COUNT(*) FILTER (WHERE t.tipo = 'DEBITO')::int AS quantidade_debitos,\n            COUNT(*) FILTER (WHERE t.tipo = 'CREDITO')::int AS quantidade_creditos,\n            ROUND(COALESCE(SUM(ABS(t.valor)) FILTER (WHERE t.tipo = 'DEBITO'), 0)::numeric, 2) AS valor_debitos,\n            ROUND(COALESCE(SUM(ABS(t.valor)) FILTER (WHERE t.tipo = 'CREDITO'), 0)::numeric, 2) AS valor_creditos\n"""
if old_resumo not in backend:
    raise SystemExit('Resumo de não categorizados não encontrado.')
backend = backend.replace(old_resumo, new_resumo, 1)

backend = backend.replace("""    quantidade: Number(resumo.rows[0]?.quantidade || 0),\n    valorTotal: Number(resumo.rows[0]?.valor_total || 0),\n    exemplos: itens.rows.map((item) => ({\n""", """    quantidade: Number(resumo.rows[0]?.quantidade || 0),\n    debitos: {\n      quantidade: Number(resumo.rows[0]?.quantidade_debitos || 0),\n      valor: Number(resumo.rows[0]?.valor_debitos || 0),\n    },\n    creditos: {\n      quantidade: Number(resumo.rows[0]?.quantidade_creditos || 0),\n      valor: Number(resumo.rows[0]?.valor_creditos || 0),\n    },\n    exemplos: itens.rows.map((item) => ({\n""", 1)

app_path.write_text(app, encoding='utf-8')
backend_path.write_text(backend, encoding='utf-8')
print('Refinos do assistente aplicados.')
