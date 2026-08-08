from pathlib import Path

app_path = Path('App.jsx')
backend_path = Path('backend-server.js')
app = app_path.read_text(encoding='utf-8')
backend = backend_path.read_text(encoding='utf-8')

backend_anchor = "app.delete('/api/compras-programadas/:id', verificarToken, async (req, res) => {\n  try {\n    const result = await pool.query(\n      'DELETE FROM compras_programadas WHERE id = $1 AND usuario_id = $2 RETURNING id',\n      [req.params.id, req.usuario.usuario_id]\n    );\n    if (result.rows.length === 0) return res.status(404).json({ erro: 'Compra programada não encontrada.' });\n    res.json({ sucesso: true });\n  } catch (error) {\n    res.status(500).json({ erro: error.message });\n  }\n});\n"

backend_insert = r'''app.delete('/api/compras-programadas/:id', verificarToken, async (req, res) => {
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

function chaveMesCompra(data) {
  const texto = String(data || '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})/.exec(texto);
  return match ? `${match[1]}-${match[2]}` : null;
}

function somarMesesChaveCompra(chave, incremento) {
  const [ano, mes] = String(chave).split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1 + incremento, 1));
  return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
}

function diferencaMesesCompra(inicio, fim) {
  const [anoInicio, mesInicio] = String(inicio).split('-').map(Number);
  const [anoFim, mesFim] = String(fim).split('-').map(Number);
  return (anoFim * 12 + mesFim) - (anoInicio * 12 + mesInicio);
}

function distribuirCompraEmMeses({ valor, formaPagamento, parcelas, mesInicio }) {
  const total = Math.round(Number(valor || 0) * 100);
  const qtd = formaPagamento === 'PARCELADO' ? Math.max(2, Number(parcelas || 2)) : 1;
  const base = Math.floor(total / qtd);
  const resto = total - (base * qtd);
  const impactos = new Map();

  for (let i = 0; i < qtd; i += 1) {
    const centavos = base + (i === qtd - 1 ? resto : 0);
    const chave = somarMesesChaveCompra(mesInicio, i);
    impactos.set(chave, (impactos.get(chave) || 0) + (centavos / 100));
  }
  return impactos;
}

function adicionarImpactosCompra(destino, origem) {
  for (const [mes, valor] of origem.entries()) destino.set(mes, (destino.get(mes) || 0) + Number(valor || 0));
}

app.post('/api/compras-programadas/:id/simular', verificarToken, async (req, res) => {
  try {
    const compraResult = await pool.query(
      'SELECT * FROM compras_programadas WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.usuario_id]
    );
    if (compraResult.rows.length === 0) return res.status(404).json({ erro: 'Compra programada não encontrada.' });

    const compra = compraResult.rows[0];
    const dataDesejada = normalizarDataImportacao(req.body?.dataDesejada ?? req.body?.data_desejada ?? compra.data_desejada);
    const formaPagamento = String(req.body?.formaPagamento ?? req.body?.forma_pagamento ?? compra.forma_pagamento ?? 'A_VISTA').toUpperCase();
    const parcelas = formaPagamento === 'PARCELADO' ? Number(req.body?.parcelas ?? compra.parcelas ?? 2) : 1;

    if (!dataDesejada) return res.status(400).json({ erro: 'Data simulada inválida.' });
    if (!FORMAS_PAGAMENTO_COMPRA.includes(formaPagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 60) return res.status(400).json({ erro: 'Quantidade de parcelas inválida.' });
    if (formaPagamento === 'PARCELADO' && parcelas < 2) return res.status(400).json({ erro: 'Compra parcelada deve ter pelo menos 2 parcelas.' });

    const hoje = new Date().toISOString().slice(0, 10);
    const mesAtual = chaveMesCompra(hoje);
    const mesDesejadoOriginal = chaveMesCompra(dataDesejada);
    const mesCompra = diferencaMesesCompra(mesAtual, mesDesejadoOriginal) < 0 ? mesAtual : mesDesejadoOriginal;
    const mesesAteCompra = Math.max(0, diferencaMesesCompra(mesAtual, mesCompra));
    const horizonteSolicitado = Number(req.body?.horizonteMeses || 0);
    const horizonteAuto = Math.max(6, mesesAteCompra + parcelas + 2);
    const horizonteMeses = Math.min(36, Math.max(3, Number.isInteger(horizonteSolicitado) && horizonteSolicitado > 0 ? horizonteSolicitado : horizonteAuto));
    const ultimoMes = somarMesesChaveCompra(mesAtual, horizonteMeses - 1);
    const dataLimite = `${ultimoMes}-31`;

    const saldoResult = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(saldo_atual, saldo_inicial, 0)), 0)::numeric AS saldo
       FROM contas
       WHERE usuario_id = $1 AND ativo = true`,
      [req.usuario.usuario_id]
    );
    const saldoInicial = Number(saldoResult.rows[0]?.saldo || 0);

    const provisoesResult = await pool.query(
      `SELECT id, tipo, valor_previsto, data_prevista, status
       FROM provisoes
       WHERE usuario_id = $1
         AND status IN ('PENDENTE', 'ATRASADA')
         AND data_prevista <= $2::date
       ORDER BY data_prevista ASC`,
      [req.usuario.usuario_id, dataLimite]
    );

    const outrasComprasResult = await pool.query(
      `SELECT id, valor_estimado, data_desejada, forma_pagamento, parcelas
       FROM compras_programadas
       WHERE usuario_id = $1
         AND status = 'PLANEJADA'
         AND id <> $2`,
      [req.usuario.usuario_id, compra.id]
    );

    const entradasPorMes = new Map();
    const saidasPorMes = new Map();
    const outrasComprasPorMes = new Map();

    for (const provisao of provisoesResult.rows) {
      let mes = chaveMesCompra(provisao.data_prevista);
      if (!mes) continue;
      if (diferencaMesesCompra(mesAtual, mes) < 0) mes = mesAtual;
      const valor = Number(provisao.valor_previsto || 0);
      if (provisao.tipo === 'CREDITO') entradasPorMes.set(mes, (entradasPorMes.get(mes) || 0) + valor);
      else if (provisao.tipo === 'DEBITO') saidasPorMes.set(mes, (saidasPorMes.get(mes) || 0) + valor);
    }

    for (const outra of outrasComprasResult.rows) {
      let inicio = chaveMesCompra(outra.data_desejada);
      if (!inicio) continue;
      if (diferencaMesesCompra(mesAtual, inicio) < 0) inicio = mesAtual;
      adicionarImpactosCompra(outrasComprasPorMes, distribuirCompraEmMeses({
        valor: outra.valor_estimado,
        formaPagamento: outra.forma_pagamento,
        parcelas: outra.parcelas,
        mesInicio: inicio,
      }));
    }

    const impactoCompra = distribuirCompraEmMeses({
      valor: compra.valor_estimado,
      formaPagamento,
      parcelas,
      mesInicio: mesCompra,
    });

    let saldoSemCompra = saldoInicial;
    let saldoComCompra = saldoInicial;
    const meses = [];

    for (let i = 0; i < horizonteMeses; i += 1) {
      const mes = somarMesesChaveCompra(mesAtual, i);
      const entradasPrevistas = Number(entradasPorMes.get(mes) || 0);
      const saidasPrevistas = Number(saidasPorMes.get(mes) || 0);
      const outrasCompras = Number(outrasComprasPorMes.get(mes) || 0);
      const impacto = Number(impactoCompra.get(mes) || 0);

      saldoSemCompra += entradasPrevistas - saidasPrevistas - outrasCompras;
      saldoComCompra += entradasPrevistas - saidasPrevistas - outrasCompras - impacto;

      meses.push({
        mes,
        entradasPrevistas: Number(entradasPrevistas.toFixed(2)),
        saidasPrevistas: Number(saidasPrevistas.toFixed(2)),
        outrasCompras: Number(outrasCompras.toFixed(2)),
        impactoCompra: Number(impacto.toFixed(2)),
        saldoSemCompra: Number(saldoSemCompra.toFixed(2)),
        saldoComCompra: Number(saldoComCompra.toFixed(2)),
      });
    }

    const menorSaldoSemCompra = Math.min(saldoInicial, ...meses.map((item) => item.saldoSemCompra));
    const menorSaldoComCompra = Math.min(saldoInicial, ...meses.map((item) => item.saldoComCompra));
    const mesesNegativos = meses.filter((item) => item.saldoComCompra < 0).map((item) => item.mes);
    const primeiroMesNegativo = mesesNegativos[0] || null;
    const valorParcela = formaPagamento === 'PARCELADO' ? Number((Number(compra.valor_estimado) / parcelas).toFixed(2)) : Number(compra.valor_estimado);

    res.json({
      compra: { id: compra.id, descricao: compra.descricao, valorEstimado: Number(compra.valor_estimado), dataOriginal: String(compra.data_desejada).slice(0, 10) },
      parametros: { dataDesejada, formaPagamento, parcelas, horizonteMeses, valorParcela },
      base: {
        saldoInicial: Number(saldoInicial.toFixed(2)),
        provisoesConsideradas: provisoesResult.rows.length,
        outrasComprasConsideradas: outrasComprasResult.rows.length,
        incluiOrcamentoMensal: false,
      },
      resumo: {
        menorSaldoSemCompra: Number(menorSaldoSemCompra.toFixed(2)),
        menorSaldoComCompra: Number(menorSaldoComCompra.toFixed(2)),
        diferencaMenorSaldo: Number((menorSaldoComCompra - menorSaldoSemCompra).toFixed(2)),
        mesesNegativos,
        primeiroMesNegativo,
        caixaFicaNegativo: mesesNegativos.length > 0,
      },
      meses,
      observacoes: [
        'A projeção parte da soma dos saldos atuais das contas ativas.',
        'Entradas e saídas futuras usam contas previstas pendentes ou atrasadas.',
        'Outras compras programadas com status PLANEJADA entram no cenário base.',
        'Orçamento mensal ainda não entra no cálculo para evitar dupla contagem com contas previstas.',
      ],
    });
  } catch (error) {
    res.status(400).json({ erro: error.message });
  }
});
'''

if backend_anchor not in backend:
    raise SystemExit('Anchor backend não encontrado')
backend = backend.replace(backend_anchor, backend_insert, 1)

state_anchor = "  const [carregando, setCarregando] = useState(true);\n  const [salvando, setSalvando] = useState(false);\n"
state_insert = "  const [carregando, setCarregando] = useState(true);\n  const [salvando, setSalvando] = useState(false);\n  const [compraSimulada, setCompraSimulada] = useState(null);\n  const [simulacao, setSimulacao] = useState(null);\n  const [simulando, setSimulando] = useState(false);\n  const [opcoesSimulacao, setOpcoesSimulacao] = useState({ dataDesejada: '', formaPagamento: 'A_VISTA', parcelas: 1 });\n"
if state_anchor not in app:
    raise SystemExit('Anchor estados não encontrado')
app = app.replace(state_anchor, state_insert, 1)

function_anchor = "  const excluirCompra = (compra) => {\n"
function_insert = r'''  const executarSimulacao = async (compra = compraSimulada, opcoes = opcoesSimulacao) => {
    if (!compra) return;
    setSimulando(true);
    try {
      const response = await axios.post(`${API_URL}/compras-programadas/${compra.id}/simular`, {
        dataDesejada: opcoes.dataDesejada,
        formaPagamento: opcoes.formaPagamento,
        parcelas: opcoes.formaPagamento === 'PARCELADO' ? Number(opcoes.parcelas) : 1,
      }, { headers: { Authorization: `Bearer ${token}` } });
      setSimulacao(response.data);
    } catch (error) {
      mostrarToast(error.response?.data?.erro || 'Não foi possível calcular o impacto da compra.', 'erro');
    } finally {
      setSimulando(false);
    }
  };

  const abrirSimulacao = (compra) => {
    const opcoes = {
      dataDesejada: String(compra.data_desejada || '').slice(0, 10),
      formaPagamento: compra.forma_pagamento || 'A_VISTA',
      parcelas: compra.forma_pagamento === 'PARCELADO' ? Number(compra.parcelas || 2) : 1,
    };
    setCompraSimulada(compra);
    setOpcoesSimulacao(opcoes);
    setSimulacao(null);
    setTimeout(() => document.getElementById('simulacao-compra-programada')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    executarSimulacao(compra, opcoes);
  };

  const fecharSimulacao = () => {
    setCompraSimulada(null);
    setSimulacao(null);
  };

  const excluirCompra = (compra) => {
'''
if function_anchor not in app:
    raise SystemExit('Anchor função não encontrado')
app = app.replace(function_anchor, function_insert, 1)
app = app.replace('Cadastre a intenção de compra. A análise de impacto no caixa será adicionada na próxima etapa.', 'Cadastre a intenção de compra e depois simule o impacto no seu caixa antes de decidir.', 1)

css_anchor = "        @media (max-width: 1100px) {\n"
css_insert = r'''        .compras-simulacao-card { border: 1px solid #bfdbfe; border-radius: 16px; padding: 20px; background: #f8fbff; margin-bottom: 22px; scroll-margin-top: 18px; }
        .compras-simulacao-header { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; margin-bottom: 16px; }
        .compras-simulacao-header h2 { margin: 0; color: #0f172a; font-size: 20px; }
        .compras-simulacao-header p { margin: 5px 0 0; color: #64748b; }
        .compras-simulacao-controles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) auto; gap: 12px; align-items: end; margin-bottom: 16px; }
        .compras-simulacao-resumo { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
        .compras-simulacao-metrica { border: 1px solid #dbeafe; border-radius: 12px; padding: 12px; background: #ffffff; }
        .compras-simulacao-metrica small { display: block; color: #64748b; margin-bottom: 4px; }
        .compras-simulacao-metrica strong { color: #0f172a; font-size: 18px; }
        .compras-simulacao-alerta { border-radius: 12px; padding: 12px 14px; margin-bottom: 16px; font-size: 14px; line-height: 1.45; }
        .compras-simulacao-table-wrap { overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; }
        .compras-simulacao-table { width: 100%; min-width: 860px; border-collapse: collapse; font-size: 13px; }
        .compras-simulacao-table th, .compras-simulacao-table td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; white-space: nowrap; }
        .compras-simulacao-table th:first-child, .compras-simulacao-table td:first-child { text-align: left; }
        .compras-simulacao-table th { background: #f8fafc; color: #475569; font-weight: 700; }
        .compras-simulacao-notas { margin: 14px 0 0; padding-left: 18px; color: #64748b; font-size: 12px; line-height: 1.5; }
        @media (max-width: 1100px) {
'''
if css_anchor not in app:
    raise SystemExit('Anchor CSS não encontrado')
app = app.replace(css_anchor, css_insert, 1)
app = app.replace("          .compras-form-grid-secondary {\n            grid-template-columns: repeat(2, minmax(0, 1fr));\n          }\n", "          .compras-form-grid-secondary {\n            grid-template-columns: repeat(2, minmax(0, 1fr));\n          }\n          .compras-simulacao-controles { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n          .compras-simulacao-resumo { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n", 1)
app = app.replace("          .compras-form-actions .btn {\n            width: 100%;\n          }\n", "          .compras-form-actions .btn {\n            width: 100%;\n          }\n          .compras-simulacao-card { padding: 16px; }\n          .compras-simulacao-header { flex-direction: column; }\n          .compras-simulacao-controles, .compras-simulacao-resumo { grid-template-columns: 1fr; }\n          .compras-simulacao-controles .btn { width: 100%; }\n", 1)

panel_anchor = "      </form>\n\n      <div>\n        <h2 style={{ margin: '0 0 12px', fontSize: '20px' }}>Compras cadastradas</h2>\n"
panel_insert = r'''      </form>

      {compraSimulada && (
        <section id="simulacao-compra-programada" className="compras-simulacao-card">
          <div className="compras-simulacao-header">
            <div>
              <h2>📈 Simulação de impacto no caixa</h2>
              <p><strong>{compraSimulada.descricao}</strong> · {formatarMoeda(compraSimulada.valor_estimado)}</p>
            </div>
            <Btn type="button" onClick={fecharSimulacao}>Fechar simulação</Btn>
          </div>
          <div className="compras-simulacao-controles">
            <label className="compras-field"><span className="compras-field-label">Data simulada</span><input type="date" value={opcoesSimulacao.dataDesejada} onChange={(e) => setOpcoesSimulacao({ ...opcoesSimulacao, dataDesejada: e.target.value })} /></label>
            <label className="compras-field"><span className="compras-field-label">Pagamento</span><select value={opcoesSimulacao.formaPagamento} onChange={(e) => setOpcoesSimulacao({ ...opcoesSimulacao, formaPagamento: e.target.value, parcelas: e.target.value === 'A_VISTA' ? 1 : Math.max(2, Number(opcoesSimulacao.parcelas) || 2) })}><option value="A_VISTA">À vista</option><option value="PARCELADO">Parcelado</option></select></label>
            {opcoesSimulacao.formaPagamento === 'PARCELADO' && <label className="compras-field"><span className="compras-field-label">Parcelas</span><input type="number" min="2" max="60" value={opcoesSimulacao.parcelas} onChange={(e) => setOpcoesSimulacao({ ...opcoesSimulacao, parcelas: e.target.value })} /></label>}
            <Btn type="button" variant="primary" onClick={() => executarSimulacao()} disabled={simulando}>{simulando ? 'Calculando...' : 'Recalcular'}</Btn>
          </div>
          {simulando && !simulacao ? <Spinner texto="Calculando projeção..." /> : simulacao && (
            <>
              <div className="compras-simulacao-resumo">
                <div className="compras-simulacao-metrica"><small>Saldo atual considerado</small><strong>{formatarMoeda(simulacao.base.saldoInicial)}</strong></div>
                <div className="compras-simulacao-metrica"><small>Menor saldo sem esta compra</small><strong>{formatarMoeda(simulacao.resumo.menorSaldoSemCompra)}</strong></div>
                <div className="compras-simulacao-metrica"><small>Menor saldo com a compra</small><strong>{formatarMoeda(simulacao.resumo.menorSaldoComCompra)}</strong></div>
                <div className="compras-simulacao-metrica"><small>{simulacao.parametros.formaPagamento === 'PARCELADO' ? 'Parcela estimada' : 'Impacto à vista'}</small><strong>{formatarMoeda(simulacao.parametros.valorParcela)}</strong></div>
              </div>
              <div className="compras-simulacao-alerta" style={{ background: simulacao.resumo.caixaFicaNegativo ? '#fef2f2' : '#f0fdf4', color: simulacao.resumo.caixaFicaNegativo ? '#991b1b' : '#166534', border: `1px solid ${simulacao.resumo.caixaFicaNegativo ? '#fecaca' : '#bbf7d0'}` }}>
                {simulacao.resumo.caixaFicaNegativo ? `⚠️ Neste cenário, o caixa projetado fica negativo a partir de ${simulacao.resumo.primeiroMesNegativo}. Vale testar outra data ou mais parcelas.` : '✅ Neste cenário, o saldo projetado não fica negativo dentro do horizonte calculado.'}
              </div>
              <div className="compras-simulacao-table-wrap">
                <table className="compras-simulacao-table">
                  <thead><tr><th>Mês</th><th>Entradas previstas</th><th>Saídas previstas</th><th>Outras compras</th><th>Esta compra</th><th>Saldo sem compra</th><th>Saldo com compra</th></tr></thead>
                  <tbody>{simulacao.meses.map((item) => <tr key={item.mes}><td><strong>{item.mes}</strong></td><td>{formatarMoeda(item.entradasPrevistas)}</td><td>{formatarMoeda(item.saidasPrevistas)}</td><td>{formatarMoeda(item.outrasCompras)}</td><td>{item.impactoCompra ? <strong style={{ color: '#b91c1c' }}>-{formatarMoeda(item.impactoCompra)}</strong> : formatarMoeda(0)}</td><td>{formatarMoeda(item.saldoSemCompra)}</td><td style={{ color: item.saldoComCompra < 0 ? '#b91c1c' : '#166534', fontWeight: 700 }}>{formatarMoeda(item.saldoComCompra)}</td></tr>)}</tbody>
                </table>
              </div>
              <ul className="compras-simulacao-notas">{(simulacao.observacoes || []).map((nota) => <li key={nota}>{nota}</li>)}</ul>
            </>
          )}
        </section>
      )}

      <div>
        <h2 style={{ margin: '0 0 12px', fontSize: '20px' }}>Compras cadastradas</h2>
'''
if panel_anchor not in app:
    raise SystemExit('Anchor painel não encontrado')
app = app.replace(panel_anchor, panel_insert, 1)

buttons_anchor = "                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>\n                    <Btn size=\"sm\" onClick={() => editarCompra(compra)}>Editar</Btn>\n                    <Btn size=\"sm\" onClick={() => excluirCompra(compra)}>Excluir</Btn>\n                  </div>\n"
buttons_insert = "                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>\n                    <Btn size=\"sm\" variant=\"primary\" onClick={() => abrirSimulacao(compra)}>Simular impacto</Btn>\n                    <Btn size=\"sm\" onClick={() => editarCompra(compra)}>Editar</Btn>\n                    <Btn size=\"sm\" onClick={() => excluirCompra(compra)}>Excluir</Btn>\n                  </div>\n"
if buttons_anchor not in app:
    raise SystemExit('Anchor botões não encontrado')
app = app.replace(buttons_anchor, buttons_insert, 1)

app_path.write_text(app, encoding='utf-8')
backend_path.write_text(backend, encoding='utf-8')
print('Simulação de compras aplicada com sucesso.')
