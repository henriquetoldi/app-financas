from pathlib import Path

app_path = Path("App.jsx")
backend_path = Path("backend-server.js")

app = app_path.read_text(encoding="utf-8")
backend = backend_path.read_text(encoding="utf-8")

component_anchor = "\nfunction TelaPrevisoes({ contas = [], token, onVoltar }) {"
if component_anchor not in app:
    raise SystemExit("Âncora TelaPrevisoes não encontrada.")

component = r'''
function TelaComprasProgramadas({ contas = [], token }) {
  const formularioVazio = () => ({
    descricao: '',
    valorEstimado: '',
    dataDesejada: '',
    prioridade: 'MEDIA',
    formaPagamento: 'A_VISTA',
    parcelas: 1,
    contaId: '',
    categoriaMacroId: '',
    categoriaDetalhadaId: '',
    observacao: '',
  });

  const [compras, setCompras] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [form, setForm] = useState(formularioVazio);
  const [editandoId, setEditandoId] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);

  const categoriasAgrupadas = useMemo(
    () => agruparCategorias(categorias).filter((categoria) => (categoria.tipo || 'DESPESA') === 'DESPESA'),
    [categorias]
  );
  const macroSelecionada = categoriasAgrupadas.find((categoria) => categoria.id === form.categoriaMacroId);

  const carregarCompras = async () => {
    const response = await axios.get(`${API_URL}/compras-programadas`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    setCompras(response.data.compras || []);
  };

  const carregarCategorias = async () => {
    const response = await axios.get(`${API_URL}/categorias`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    setCategorias(response.data.categorias || []);
  };

  useEffect(() => {
    let ativa = true;
    setCarregando(true);
    Promise.all([carregarCompras(), carregarCategorias()])
      .catch((error) => {
        if (ativa) mostrarToast(error.response?.data?.erro || 'Não foi possível carregar as compras programadas.', 'erro');
      })
      .finally(() => {
        if (ativa) setCarregando(false);
      });
    return () => { ativa = false; };
  }, [token]);

  const limparFormulario = () => {
    setForm(formularioVazio());
    setEditandoId(null);
  };

  const salvarCompra = async (event) => {
    event.preventDefault();
    const valor = Number(form.valorEstimado);
    if (!form.descricao.trim()) return mostrarToast('Informe o que você pretende comprar.', 'aviso');
    if (!Number.isFinite(valor) || valor <= 0) return mostrarToast('Informe um valor estimado válido.', 'aviso');
    if (!form.dataDesejada) return mostrarToast('Informe a data desejada para a compra.', 'aviso');
    if (form.formaPagamento === 'PARCELADO' && (!Number.isInteger(Number(form.parcelas)) || Number(form.parcelas) < 2)) {
      return mostrarToast('Informe pelo menos 2 parcelas.', 'aviso');
    }

    const payload = {
      descricao: form.descricao.trim(),
      valorEstimado: valor,
      dataDesejada: form.dataDesejada,
      prioridade: form.prioridade,
      formaPagamento: form.formaPagamento,
      parcelas: form.formaPagamento === 'PARCELADO' ? Number(form.parcelas) : 1,
      contaId: form.contaId || null,
      categoriaMacroId: form.categoriaMacroId || null,
      categoriaDetalhadaId: form.categoriaDetalhadaId || null,
      observacao: form.observacao.trim() || null,
    };

    setSalvando(true);
    try {
      if (editandoId) {
        await axios.patch(`${API_URL}/compras-programadas/${editandoId}`, payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
        mostrarToast('Compra programada atualizada.');
      } else {
        await axios.post(`${API_URL}/compras-programadas`, payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
        mostrarToast('Compra programada cadastrada.');
      }
      limparFormulario();
      await carregarCompras();
    } catch (error) {
      mostrarToast(error.response?.data?.erro || 'Não foi possível salvar a compra programada.', 'erro');
    } finally {
      setSalvando(false);
    }
  };

  const editarCompra = (compra) => {
    setEditandoId(compra.id);
    setForm({
      descricao: compra.descricao || '',
      valorEstimado: compra.valor_estimado || '',
      dataDesejada: String(compra.data_desejada || '').slice(0, 10),
      prioridade: compra.prioridade || 'MEDIA',
      formaPagamento: compra.forma_pagamento || 'A_VISTA',
      parcelas: compra.parcelas || 1,
      contaId: compra.conta_id || '',
      categoriaMacroId: compra.categoria_macro_id || '',
      categoriaDetalhadaId: compra.categoria_detalhada_id || '',
      observacao: compra.observacao || '',
    });
    document.getElementById('form-compra-programada')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const excluirCompra = (compra) => {
    pedirConfirmacao(
      'Excluir compra programada',
      `Deseja excluir "${compra.descricao}"?`,
      async () => {
        try {
          await axios.delete(`${API_URL}/compras-programadas/${compra.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (editandoId === compra.id) limparFormulario();
          await carregarCompras();
          mostrarToast('Compra programada excluída.');
        } catch (error) {
          mostrarToast(error.response?.data?.erro || 'Não foi possível excluir a compra.', 'erro');
        }
      },
      { labelConfirmar: 'Excluir', corConfirmar: '#dc2626' }
    );
  };

  const formatarDataCompra = (valor) => {
    if (!valor) return 'Sem data';
    const data = String(valor).slice(0, 10);
    const [ano, mes, dia] = data.split('-');
    return ano && mes && dia ? `${dia}/${mes}/${ano}` : data;
  };

  const totalPlanejado = compras
    .filter((compra) => compra.status === 'PLANEJADA')
    .reduce((total, compra) => total + Number(compra.valor_estimado || 0), 0);

  const proximas = compras.filter((compra) => {
    if (!compra.data_desejada || compra.status !== 'PLANEJADA') return false;
    const hoje = new Date();
    const limite = new Date();
    limite.setDate(limite.getDate() + 30);
    const data = new Date(`${String(compra.data_desejada).slice(0, 10)}T12:00:00`);
    return data >= new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) && data <= limite;
  }).length;

  const corPrioridade = {
    BAIXA: ['#f1f5f9', '#475569'],
    MEDIA: ['#dbeafe', '#1d4ed8'],
    ALTA: ['#ffedd5', '#c2410c'],
    ESSENCIAL: ['#fee2e2', '#b91c1c'],
  };

  return (
    <section>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '18px' }}>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>
          <small style={{ color: '#64748b' }}>Compras planejadas</small>
          <strong style={{ display: 'block', fontSize: '24px', marginTop: '4px' }}>{compras.filter((item) => item.status === 'PLANEJADA').length}</strong>
        </div>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>
          <small style={{ color: '#64748b' }}>Valor total estimado</small>
          <strong style={{ display: 'block', fontSize: '24px', marginTop: '4px' }}>{formatarMoeda(totalPlanejado)}</strong>
        </div>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>
          <small style={{ color: '#64748b' }}>Próximos 30 dias</small>
          <strong style={{ display: 'block', fontSize: '24px', marginTop: '4px' }}>{proximas}</strong>
        </div>
      </div>

      <form id="form-compra-programada" onSubmit={salvarCompra} style={{ border: '1px solid #e2e8f0', borderRadius: '14px', padding: '18px', background: '#f8fafc', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '20px' }}>{editandoId ? '✏️ Editar compra programada' : '🛒 Nova compra programada'}</h2>
            <p style={{ margin: '4px 0 0', color: '#64748b' }}>Cadastre a intenção de compra. A análise de impacto no caixa será adicionada na próxima etapa.</p>
          </div>
          {editandoId && <Btn type="button" onClick={limparFormulario}>Cancelar edição</Btn>}
        </div>

        <div className="filter-grid">
          <label>O que você quer comprar? *<input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} placeholder="Ex.: notebook, TV, viagem..." /></label>
          <label>Valor estimado *<input type="number" min="0.01" step="0.01" value={form.valorEstimado} onChange={(e) => setForm({ ...form, valorEstimado: e.target.value })} placeholder="0,00" /></label>
          <label>Data desejada *<input type="date" value={form.dataDesejada} onChange={(e) => setForm({ ...form, dataDesejada: e.target.value })} /></label>
          <label>Prioridade *<select value={form.prioridade} onChange={(e) => setForm({ ...form, prioridade: e.target.value })}><option value="BAIXA">Baixa</option><option value="MEDIA">Média</option><option value="ALTA">Alta</option><option value="ESSENCIAL">Essencial</option></select></label>
          <label>Forma de pagamento *<select value={form.formaPagamento} onChange={(e) => setForm({ ...form, formaPagamento: e.target.value, parcelas: e.target.value === 'A_VISTA' ? 1 : Math.max(2, Number(form.parcelas) || 2) })}><option value="A_VISTA">À vista</option><option value="PARCELADO">Parcelado</option></select></label>
          {form.formaPagamento === 'PARCELADO' && <label>Parcelas *<input type="number" min="2" max="60" value={form.parcelas} onChange={(e) => setForm({ ...form, parcelas: e.target.value })} /></label>}
          <label>Conta pretendida<select value={form.contaId} onChange={(e) => setForm({ ...form, contaId: e.target.value })}><option value="">Ainda não definida</option>{contas.filter((conta) => conta.ativo !== false).map((conta) => <option key={conta.id} value={conta.id}>{conta.nome}</option>)}</select></label>
          <label>Categoria macro<select value={form.categoriaMacroId} onChange={(e) => setForm({ ...form, categoriaMacroId: e.target.value, categoriaDetalhadaId: '' })}><option value="">Sem categoria</option>{categoriasAgrupadas.map((categoria) => <option key={categoria.id} value={categoria.id}>{categoria.emoji || ''} {categoria.nome}</option>)}</select></label>
          <label>Categoria detalhada<select value={form.categoriaDetalhadaId} onChange={(e) => setForm({ ...form, categoriaDetalhadaId: e.target.value })} disabled={!form.categoriaMacroId}><option value="">Sem detalhamento</option>{(macroSelecionada?.filhas || []).map((categoria) => <option key={categoria.id} value={categoria.id}>{categoria.emoji || ''} {categoria.nome}</option>)}</select></label>
        </div>

        <label style={{ display: 'block', marginTop: '12px' }}>Observações<textarea value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} rows="3" placeholder="Ex.: modelo desejado, motivo da compra, condição mínima..." style={{ width: '100%', marginTop: '6px', resize: 'vertical' }} /></label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
          <Btn type="submit" variant="primary" disabled={salvando}>{salvando ? 'Salvando...' : editandoId ? 'Salvar alterações' : 'Cadastrar compra'}</Btn>
        </div>
      </form>

      <div>
        <h2 style={{ margin: '0 0 12px', fontSize: '20px' }}>Compras cadastradas</h2>
        {carregando ? <Spinner texto="Carregando compras..." /> : compras.length === 0 ? (
          <div style={{ border: '1px dashed #cbd5e1', borderRadius: '14px', padding: '28px', textAlign: 'center', color: '#64748b' }}>
            Nenhuma compra programada ainda. Cadastre a primeira acima.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '10px' }}>
            {compras.map((compra) => {
              const cores = corPrioridade[compra.prioridade] || corPrioridade.MEDIA;
              const categoria = compra.categoria_detalhada_nome || compra.categoria_macro_nome || 'Sem categoria';
              return (
                <div key={compra.id} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: 'white', display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) repeat(3, minmax(120px, 0.8fr)) auto', gap: '14px', alignItems: 'center' }}>
                  <div>
                    <strong style={{ display: 'block', fontSize: '16px' }}>{compra.descricao}</strong>
                    <small style={{ color: '#64748b' }}>{categoria}{compra.conta_nome ? ` · ${compra.conta_nome}` : ''}</small>
                  </div>
                  <div><small style={{ display: 'block', color: '#64748b' }}>Valor</small><strong>{formatarMoeda(compra.valor_estimado)}</strong></div>
                  <div><small style={{ display: 'block', color: '#64748b' }}>Quando</small><strong>{formatarDataCompra(compra.data_desejada)}</strong></div>
                  <div>
                    <small style={{ display: 'block', color: '#64748b', marginBottom: '4px' }}>Prioridade</small>
                    <span style={{ background: cores[0], color: cores[1], borderRadius: '999px', padding: '4px 8px', fontSize: '12px', fontWeight: 700 }}>{compra.prioridade}</span>
                    <small style={{ display: 'block', color: '#64748b', marginTop: '5px' }}>{compra.forma_pagamento === 'PARCELADO' ? `${compra.parcelas}x` : 'À vista'}</small>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <Btn size="sm" onClick={() => editarCompra(compra)}>Editar</Btn>
                    <Btn size="sm" onClick={() => excluirCompra(compra)}>Excluir</Btn>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

'''

if "function TelaComprasProgramadas(" not in app:
    app = app.replace(component_anchor, "\n" + component + component_anchor.lstrip("\n"), 1)

tela_inicio = app.index("function TelaPrevisoes({ contas = [], token, onVoltar }) {")
compras_inicio = app.index("      {aba === 'compras' && (", tela_inicio)
tela_fim = app.index("\n    </div>\n  );\n}\n\nconst emojisCategorias", compras_inicio)
app = app[:compras_inicio] + "      {aba === 'compras' && <TelaComprasProgramadas contas={contas} token={token} />}" + app[tela_fim:]

table_anchor = '''  await pool.query(`
    CREATE TABLE IF NOT EXISTS conciliacoes ('''
if table_anchor not in backend:
    raise SystemExit("Âncora da tabela conciliacoes não encontrada.")

table_block = r'''  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras_programadas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      descricao TEXT NOT NULL,
      valor_estimado DECIMAL(12, 2) NOT NULL,
      data_desejada DATE NOT NULL,
      prioridade VARCHAR(20) NOT NULL DEFAULT 'MEDIA',
      forma_pagamento VARCHAR(20) NOT NULL DEFAULT 'A_VISTA',
      parcelas INT NOT NULL DEFAULT 1,
      conta_id UUID REFERENCES contas(id) ON DELETE SET NULL,
      categoria_macro_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      categoria_detalhada_id UUID REFERENCES categorias(id) ON DELETE SET NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PLANEJADA',
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_compras_programadas_usuario_data ON compras_programadas(usuario_id, data_desejada)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_compras_programadas_usuario_status ON compras_programadas(usuario_id, status)');

'''

if "CREATE TABLE IF NOT EXISTS compras_programadas" not in backend:
    backend = backend.replace(table_anchor, table_block + table_anchor, 1)

routes_anchor = '''// ============================================================================
// ROTAS: PROVISÕES E CONCILIAÇÕES
// ============================================================================'''
if routes_anchor not in backend:
    raise SystemExit("Âncora das rotas de provisões não encontrada.")

routes_block = r'''// ============================================================================
// ROTAS: COMPRAS PROGRAMADAS
// ============================================================================

const PRIORIDADES_COMPRA = ['BAIXA', 'MEDIA', 'ALTA', 'ESSENCIAL'];
const FORMAS_PAGAMENTO_COMPRA = ['A_VISTA', 'PARCELADO'];
const STATUS_COMPRA = ['PLANEJADA', 'ADIADA', 'COMPRADA', 'CANCELADA'];

function validarPayloadCompraProgramada(body = {}, parcial = false) {
  const payload = {};

  if (!parcial || body.descricao !== undefined) {
    payload.descricao = String(body.descricao || '').trim();
    if (!payload.descricao) throw new Error('Descrição da compra é obrigatória.');
  }

  if (!parcial || body.valorEstimado !== undefined || body.valor_estimado !== undefined) {
    payload.valorEstimado = Number(body.valorEstimado ?? body.valor_estimado);
    if (!Number.isFinite(payload.valorEstimado) || payload.valorEstimado <= 0) throw new Error('Valor estimado deve ser positivo.');
  }

  if (!parcial || body.dataDesejada !== undefined || body.data_desejada !== undefined) {
    payload.dataDesejada = normalizarDataImportacao(body.dataDesejada ?? body.data_desejada);
    if (!payload.dataDesejada) throw new Error('Data desejada é obrigatória.');
  }

  if (!parcial || body.prioridade !== undefined) {
    payload.prioridade = String(body.prioridade || 'MEDIA').toUpperCase();
    if (!PRIORIDADES_COMPRA.includes(payload.prioridade)) throw new Error('Prioridade inválida.');
  }

  if (!parcial || body.formaPagamento !== undefined || body.forma_pagamento !== undefined) {
    payload.formaPagamento = String(body.formaPagamento ?? body.forma_pagamento ?? 'A_VISTA').toUpperCase();
    if (!FORMAS_PAGAMENTO_COMPRA.includes(payload.formaPagamento)) throw new Error('Forma de pagamento inválida.');
  }

  if (!parcial || body.parcelas !== undefined) {
    payload.parcelas = Number(body.parcelas ?? 1);
    if (!Number.isInteger(payload.parcelas) || payload.parcelas < 1 || payload.parcelas > 60) throw new Error('Quantidade de parcelas inválida.');
    if ((payload.formaPagamento || body.formaPagamento || body.forma_pagamento) === 'A_VISTA') payload.parcelas = 1;
    if ((payload.formaPagamento || body.formaPagamento || body.forma_pagamento) === 'PARCELADO' && payload.parcelas < 2) throw new Error('Compra parcelada deve ter pelo menos 2 parcelas.');
  }

  if (body.contaId !== undefined || body.conta_id !== undefined) payload.contaId = body.contaId || body.conta_id || null;
  if (body.categoriaMacroId !== undefined || body.categoria_macro_id !== undefined) payload.categoriaMacroId = body.categoriaMacroId || body.categoria_macro_id || null;
  if (body.categoriaDetalhadaId !== undefined || body.categoria_detalhada_id !== undefined) payload.categoriaDetalhadaId = body.categoriaDetalhadaId || body.categoria_detalhada_id || null;

  if (body.status !== undefined) {
    payload.status = String(body.status || '').toUpperCase();
    if (!STATUS_COMPRA.includes(payload.status)) throw new Error('Status da compra inválido.');
  }

  if (body.observacao !== undefined) payload.observacao = body.observacao || null;
  return payload;
}

async function validarRelacionamentosCompraProgramada(usuarioId, payload) {
  if (payload.contaId) {
    const conta = await pool.query(
      'SELECT id FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = true',
      [payload.contaId, usuarioId]
    );
    if (conta.rows.length === 0) throw new Error('Conta não encontrada para este usuário.');
  }

  for (const [campo, id] of [['categoriaMacroId', payload.categoriaMacroId], ['categoriaDetalhadaId', payload.categoriaDetalhadaId]]) {
    if (!id) continue;
    const categoria = await pool.query(
      'SELECT id FROM categorias WHERE id = $1 AND (usuario_id = $2 OR usuario_id IS NULL) AND ativa = true',
      [id, usuarioId]
    );
    if (categoria.rows.length === 0) throw new Error(`${campo} inválida para este usuário.`);
  }

  if (payload.categoriaMacroId && payload.categoriaDetalhadaId) {
    const relacao = await pool.query(
      'SELECT id FROM categorias WHERE id = $1 AND categoria_pai_id = $2 AND (usuario_id = $3 OR usuario_id IS NULL) AND ativa = true',
      [payload.categoriaDetalhadaId, payload.categoriaMacroId, usuarioId]
    );
    if (relacao.rows.length === 0) throw new Error('Categoria detalhada não pertence à categoria macro selecionada.');
  }
}

app.get('/api/compras-programadas', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cp.*,
              c.nome AS conta_nome,
              cm.nome AS categoria_macro_nome,
              cd.nome AS categoria_detalhada_nome
       FROM compras_programadas cp
       LEFT JOIN contas c ON c.id = cp.conta_id
       LEFT JOIN categorias cm ON cm.id = cp.categoria_macro_id
       LEFT JOIN categorias cd ON cd.id = cp.categoria_detalhada_id
       WHERE cp.usuario_id = $1
       ORDER BY
         CASE cp.status WHEN 'PLANEJADA' THEN 0 WHEN 'ADIADA' THEN 1 WHEN 'COMPRADA' THEN 2 ELSE 3 END,
         cp.data_desejada ASC,
         cp.criado_em DESC`,
      [req.usuario.usuario_id]
    );
    res.json({ compras: result.rows });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

app.post('/api/compras-programadas', verificarToken, async (req, res) => {
  try {
    const payload = validarPayloadCompraProgramada(req.body);
    await validarRelacionamentosCompraProgramada(req.usuario.usuario_id, payload);
    const result = await pool.query(
      `INSERT INTO compras_programadas (
        usuario_id, descricao, valor_estimado, data_desejada, prioridade, forma_pagamento,
        parcelas, conta_id, categoria_macro_id, categoria_detalhada_id, status, observacao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PLANEJADA', $11)
      RETURNING *`,
      [
        req.usuario.usuario_id,
        payload.descricao,
        payload.valorEstimado,
        payload.dataDesejada,
        payload.prioridade,
        payload.formaPagamento,
        payload.parcelas,
        payload.contaId || null,
        payload.categoriaMacroId || null,
        payload.categoriaDetalhadaId || null,
        payload.observacao || null,
      ]
    );
    res.status(201).json({ compra: result.rows[0] });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.patch('/api/compras-programadas/:id', verificarToken, async (req, res) => {
  try {
    const existente = await pool.query(
      'SELECT id FROM compras_programadas WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.usuario_id]
    );
    if (existente.rows.length === 0) return res.status(404).json({ erro: 'Compra programada não encontrada.' });

    const payload = validarPayloadCompraProgramada(req.body, true);
    await validarRelacionamentosCompraProgramada(req.usuario.usuario_id, payload);

    const mapa = {
      descricao: 'descricao',
      valorEstimado: 'valor_estimado',
      dataDesejada: 'data_desejada',
      prioridade: 'prioridade',
      formaPagamento: 'forma_pagamento',
      parcelas: 'parcelas',
      contaId: 'conta_id',
      categoriaMacroId: 'categoria_macro_id',
      categoriaDetalhadaId: 'categoria_detalhada_id',
      status: 'status',
      observacao: 'observacao',
    };

    const sets = [];
    const valores = [];
    for (const [campo, coluna] of Object.entries(mapa)) {
      if (payload[campo] === undefined) continue;
      valores.push(payload[campo]);
      sets.push(`${coluna} = $${valores.length}`);
    }

    if (sets.length === 0) return res.status(400).json({ erro: 'Nenhum campo válido para atualizar.' });
    valores.push(req.params.id, req.usuario.usuario_id);

    const result = await pool.query(
      `UPDATE compras_programadas
       SET ${sets.join(', ')}, atualizado_em = NOW()
       WHERE id = $${valores.length - 1} AND usuario_id = $${valores.length}
       RETURNING *`,
      valores
    );
    res.json({ compra: result.rows[0] });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});

app.delete('/api/compras-programadas/:id', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM compras_programadas WHERE id = $1 AND usuario_id = $2 RETURNING id',
      [req.params.id, req.usuario.usuario_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Compra programada não encontrada.' });
    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});


'''

if "app.get('/api/compras-programadas'" not in backend:
    backend = backend.replace(routes_anchor, routes_block + routes_anchor, 1)

app_path.write_text(app, encoding="utf-8")
backend_path.write_text(backend, encoding="utf-8")
