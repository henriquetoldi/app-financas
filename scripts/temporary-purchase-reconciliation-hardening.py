from pathlib import Path

p = Path('backend-server.js')
s = p.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise RuntimeError(f'{label}: esperado 1 trecho, encontrado {n}')
    s = s.replace(old, new, 1)


old_lookup = r'''  let compraExistente = null;
  if (termoCompraExistente) {
    const comprasResult = await pool.query(
      `SELECT * FROM compras_programadas
       WHERE usuario_id = $1
         AND status IN ('PLANEJADA', 'ADIADA', 'COMPRADA')
         AND LOWER(descricao) LIKE LOWER($2)
       ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, criado_em DESC
       LIMIT 5`,
      [usuarioId, `%${termoCompraExistente}%`, termoCompraExistente]
    );
    if (comprasResult.rows.length === 0) {
      return { encontrada: false, motivo: `Nenhuma Compra Programada corresponde a "${termoCompraExistente}".` };
    }
    if (comprasResult.rows.length > 1) {
      return {
        encontrada: false,
        ambigua: true,
        motivo: 'Há mais de uma Compra Programada correspondente. Peça ao usuário para indicar qual delas foi comprada.',
        opcoes: comprasResult.rows.map((item) => ({
          descricao: item.descricao,
          valor: Number(item.valor_estimado || 0),
          dataDesejada: String(item.data_desejada || '').slice(0, 10),
          status: item.status,
        })),
      };
    }
    compraExistente = comprasResult.rows[0];
    const jaVinculada = await pool.query(
      `SELECT id FROM conciliacoes_compras WHERE compra_id = $1 AND status = 'CONFIRMADA' LIMIT 1`,
      [compraExistente.id]
    );
    if (jaVinculada.rows.length > 0) return { encontrada: false, motivo: 'Essa compra já possui um lançamento associado.' };
  }
'''
new_lookup = r'''  let compraExistente = null;
  let comprasResult = null;
  if (termoCompraExistente) {
    comprasResult = await pool.query(
      `SELECT * FROM compras_programadas
       WHERE usuario_id = $1
         AND status IN ('PLANEJADA', 'ADIADA', 'COMPRADA')
         AND LOWER(descricao) LIKE LOWER($2)
       ORDER BY CASE WHEN LOWER(descricao) = LOWER($3) THEN 0 ELSE 1 END, criado_em DESC
       LIMIT 5`,
      [usuarioId, `%${termoCompraExistente}%`, termoCompraExistente]
    );
    if (comprasResult.rows.length === 0) {
      return { encontrada: false, motivo: `Nenhuma Compra Programada corresponde a "${termoCompraExistente}".` };
    }
  } else if (descricaoInformada) {
    const valoresCompra = [usuarioId, descricaoInformada];
    let filtroValor = '';
    if (Number.isFinite(valorInformado) && valorInformado > 0) {
      valoresCompra.push(valorInformado);
      const indiceValor = valoresCompra.length;
      filtroValor = `AND ABS(valor_estimado - $${indiceValor}::numeric) <= GREATEST(5, ABS($${indiceValor}::numeric) * 0.15)`;
    }
    comprasResult = await pool.query(
      `SELECT * FROM compras_programadas
       WHERE usuario_id = $1
         AND status IN ('PLANEJADA', 'ADIADA', 'COMPRADA')
         AND LOWER(descricao) = LOWER($2)
         ${filtroValor}
       ORDER BY criado_em DESC
       LIMIT 5`,
      valoresCompra
    );
  }

  if (comprasResult?.rows?.length > 1) {
    return {
      encontrada: false,
      ambigua: true,
      motivo: 'Há mais de uma Compra Programada correspondente. Peça ao usuário para indicar qual delas foi comprada.',
      opcoes: comprasResult.rows.map((item) => ({
        descricao: item.descricao,
        valor: Number(item.valor_estimado || 0),
        dataDesejada: String(item.data_desejada || '').slice(0, 10),
        status: item.status,
      })),
    };
  }
  if (comprasResult?.rows?.length === 1) compraExistente = comprasResult.rows[0];

  if (compraExistente) {
    const jaVinculada = await pool.query(
      `SELECT id FROM conciliacoes_compras WHERE compra_id = $1 AND status = 'CONFIRMADA' LIMIT 1`,
      [compraExistente.id]
    );
    if (jaVinculada.rows.length > 0) return { encontrada: false, motivo: 'Essa compra já possui um lançamento associado.' };
  }
'''
replace_once(old_lookup, new_lookup, 'autodetecção de compra existente')

old_insert_start = r'''    } else {
      const payload = validarPayloadCompraProgramada({
        ...compraNova,
        dataDesejada: transacao.data,
        status: 'COMPRADA',
      });
      await validarRelacionamentosCompraProgramada(usuarioId, payload);
      const insert = await client.query(
'''
new_insert_start = r'''    } else {
      const payload = validarPayloadCompraProgramada({
        ...compraNova,
        dataDesejada: transacao.data,
        status: 'COMPRADA',
      });
      await validarRelacionamentosCompraProgramada(usuarioId, payload);

      const possivelDuplicada = await client.query(
        `SELECT id, descricao, valor_estimado, status
         FROM compras_programadas
         WHERE usuario_id = $1
           AND status IN ('PLANEJADA', 'ADIADA', 'COMPRADA')
           AND LOWER(descricao) = LOWER($2)
           AND ABS(valor_estimado - $3::numeric) <= GREATEST(5, ABS($3::numeric) * 0.15)
         ORDER BY criado_em DESC
         LIMIT 1`,
        [usuarioId, payload.descricao, payload.valorEstimado]
      );
      if (possivelDuplicada.rows.length > 0) {
        throw new Error('Já existe uma Compra Programada compatível com essa descrição e valor. Associe o lançamento à compra existente em vez de criar uma duplicata.');
      }

      const insert = await client.query(
'''
replace_once(old_insert_start, new_insert_start, 'proteção de duplicidade na confirmação')

old_delete = r'''    const conciliada = await pool.query(
      `SELECT ca.id FROM conciliacoes ca
       JOIN transacoes t ON t.id = ca.transacao_id
       JOIN contas c ON c.id = t.conta_id
       WHERE ca.transacao_id = $1 AND ca.status = 'CONFIRMADA' AND c.usuario_id = $2`,
      [req.params.id, req.usuario.usuario_id]
    );
    if (conciliada.rows.length > 0 && req.query.confirmar !== 'true') {
      return res.status(409).json({ erro: 'Transação conciliada. Confirme a exclusão para remover o vínculo.' });
    }

    const result = await pool.query(
'''
new_delete = r'''    const conciliada = await pool.query(
      `SELECT ca.id FROM conciliacoes ca
       JOIN transacoes t ON t.id = ca.transacao_id
       JOIN contas c ON c.id = t.conta_id
       WHERE ca.transacao_id = $1 AND ca.status = 'CONFIRMADA' AND c.usuario_id = $2`,
      [req.params.id, req.usuario.usuario_id]
    );
    const compraVinculada = await pool.query(
      `SELECT cc.id, cp.descricao
       FROM conciliacoes_compras cc
       JOIN compras_programadas cp ON cp.id = cc.compra_id
       WHERE cc.transacao_id = $1
         AND cc.status = 'CONFIRMADA'
         AND cc.usuario_id = $2
       LIMIT 1`,
      [req.params.id, req.usuario.usuario_id]
    );
    if ((conciliada.rows.length > 0 || compraVinculada.rows.length > 0) && req.query.confirmar !== 'true') {
      const detalhes = [
        conciliada.rows.length > 0 ? 'uma Conta Prevista' : null,
        compraVinculada.rows.length > 0 ? `a compra “${compraVinculada.rows[0].descricao}”` : null,
      ].filter(Boolean).join(' e ');
      return res.status(409).json({ erro: `Transação vinculada a ${detalhes}. Confirme a exclusão para remover o vínculo.` });
    }

    const result = await pool.query(
'''
replace_once(old_delete, new_delete, 'proteção de exclusão de transação vinculada')

p.write_text(s, encoding='utf-8')

for token in [
    'let comprasResult = null;',
    "LOWER(descricao) = LOWER($2)",
    'possivelDuplicada',
    'compraVinculada',
    'Associe o lançamento à compra existente em vez de criar uma duplicata.',
]:
    if token not in s:
        raise RuntimeError(f'Validação ausente: {token}')

print('Hardening aplicado.')
