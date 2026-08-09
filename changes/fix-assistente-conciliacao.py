from pathlib import Path

path = Path('backend-server.js')
text = path.read_text(encoding='utf-8')

old = "  const claramenteMelhor = melhor.analise.score >= 0.65 && (!segunda || (melhor.analise.score - segunda.analise.score) >= 0.15);\n  if (!claramenteMelhor) {\n    return {\n      encontrada: true,\n      preparada: false,\n      ambigua: true,\n      motivo: 'Encontrei mais de uma transação plausível. Peça ao usuário para indicar qual lançamento corresponde à Conta Prevista.',"
new = "  const identificacaoExplicita = Boolean(termoTransacao) && candidatas.length === 1;\n  const claramenteMelhor = identificacaoExplicita || (melhor.analise.score >= 0.65 && (!segunda || (melhor.analise.score - segunda.analise.score) >= 0.15));\n  if (!claramenteMelhor) {\n    const motivoAmbiguidade = candidatas.length === 1\n      ? 'Encontrei um candidato de baixa confiança. Peça ao usuário para confirmar a descrição desse lançamento antes de preparar a conciliação.'\n      : 'Encontrei mais de uma transação plausível. Peça ao usuário para indicar qual lançamento corresponde à Conta Prevista.';\n    return {\n      encontrada: true,\n      preparada: false,\n      ambigua: true,\n      motivo: motivoAmbiguidade,"

if new in text:
    print('Ajuste de desambiguação já aplicado.')
elif old in text:
    path.write_text(text.replace(old, new, 1), encoding='utf-8')
    print('Ajuste de desambiguação aplicado.')
else:
    raise RuntimeError('Trecho esperado da conciliação assistida não encontrado.')
