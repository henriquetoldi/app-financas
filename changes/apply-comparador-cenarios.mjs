import fs from 'node:fs';

const arquivo = 'App.jsx';
const original = fs.readFileSync(arquivo, 'utf8');
const inicio = original.indexOf('function TelaComprasProgramadas');
const fim = original.indexOf('\nfunction TelaPrevisoes', inicio);
if (inicio < 0 || fim < 0) throw new Error('Não foi possível delimitar TelaComprasProgramadas.');

const antes = original.slice(0, inicio);
let bloco = original.slice(inicio, fim);
const depois = original.slice(fim);

function trocar(rotulo, antigo, novo) {
  if (!bloco.includes(antigo)) throw new Error(`Trecho não encontrado em TelaComprasProgramadas: ${rotulo}`);
  bloco = bloco.replace(antigo, novo);
}

trocar(
  'estados do comparador',
  "  const [atualizandoStatusId, setAtualizandoStatusId] = useState(null);",
  "  const [atualizandoStatusId, setAtualizandoStatusId] = useState(null);\n  const [compraComparada, setCompraComparada] = useState(null);\n  const [resultadosComparacao, setResultadosComparacao] = useState([]);\n  const [comparandoCenarios, setComparandoCenarios] = useState(false);\n  const [reservaMinimaComparacao, setReservaMinimaComparacao] = useState('0');",
);

trocar(
  'funcoes do comparador',
  "  const atualizarStatusCompra = async (compra, status) => {",
  `  const adicionarMesesDataCompra = (valor, quantidade) => {
    const partes = String(valor || '').slice(0, 10).split('-').map(Number);
    if (partes.length !== 3 || partes.some((item) => !Number.isFinite(item))) return dataLocalISO(new Date());
    const [ano, mes, dia] = partes;
    const indice = (ano * 12) + (mes - 1) + Number(quantidade || 0);
    const novoAno = Math.floor(indice / 12);
    const novoMesIndice = indice % 12;
    const ultimoDia = new Date(Date.UTC(novoAno, novoMesIndice + 1, 0)).getUTCDate();
    return \`${'${novoAno}'}-${'${String(novoMesIndice + 1).padStart(2, \'0\')}'}-${'${String(Math.min(dia, ultimoDia)).padStart(2, \'0\')}'}\`;
  };

  const montarCenariosComparacao = (compra) => {
    const hoje = dataLocalISO(new Date());
    const dataOriginal = String(compra?.data_desejada || '').slice(0, 10);
    const dataBase = dataOriginal && dataOriginal > hoje ? dataOriginal : hoje;
    const parcelasAtuais = Number(compra?.parcelas || 1);
    const opcoesParcelas = Array.from(new Set([1, 3, 6, 10, 12, parcelasAtuais]))
      .filter((item) => Number.isInteger(item) && item >= 1 && item <= 12)
      .sort((a, b) => a - b);
    const cenarios = [];
    for (let adiamentoMeses = 0; adiamentoMeses <= 2; adiamentoMeses += 1) {
      const dataDesejada = adicionarMesesDataCompra(dataBase, adiamentoMeses);
      for (const parcelas of opcoesParcelas) {
        cenarios.push({
          id: \`${'${dataDesejada}'}-${'${parcelas}'}x\`,
          dataDesejada,
          adiamentoMeses,
          formaPagamento: parcelas === 1 ? 'A_VISTA' : 'PARCELADO',
          parcelas,
        });
      }
    }
    return cenarios;
  };

  const compararCenarios = async (compra) => {
    if (!compra || ['COMPRADA', 'CANCELADA'].includes(compra.status)) return;
    setCompraComparada(compra);
    setResultadosComparacao([]);
    setComparandoCenarios(true);
    try {
      const cenarios = montarCenariosComparacao(compra);
      const resultados = [];
      for (let indice = 0; indice < cenarios.length; indice += 3) {
        const lote = cenarios.slice(indice, indice + 3);
        const respostas = await Promise.all(lote.map(async (cenario) => {
          const response = await axios.post(\`${'${API_URL}'}/compras-programadas/${'${compra.id}'}/simular\`, {
            dataDesejada: cenario.dataDesejada,
            formaPagamento: cenario.formaPagamento,
            parcelas: cenario.parcelas,
            horizonteMeses: 18,
          }, { headers: { Authorization: \`Bearer ${'${token}'}\` } });
          return {
            ...cenario,
            menorSaldoComCompra: Number(response.data?.resumo?.menorSaldoComCompra || 0),
            menorSaldoSemCompra: Number(response.data?.resumo?.menorSaldoSemCompra || 0),
            mesesNegativos: response.data?.resumo?.mesesNegativos || [],
            caixaFicaNegativo: Boolean(response.data?.resumo?.caixaFicaNegativo),
            valorParcela: Number(response.data?.parametros?.valorParcela || 0),
          };
        }));
        resultados.push(...respostas);
      }
      setResultadosComparacao(resultados);
      setTimeout(() => document.getElementById('comparacao-compra-programada')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (error) {
      mostrarToast(error.response?.data?.erro || 'Não foi possível comparar os cenários da compra.', 'erro');
    } finally {
      setComparandoCenarios(false);
    }
  };

  const fecharComparacao = () => {
    setCompraComparada(null);
    setResultadosComparacao([]);
  };

  const usarCenarioComparacao = (cenario) => {
    if (!compraComparada || !cenario) return;
    const opcoes = {
      dataDesejada: cenario.dataDesejada,
      formaPagamento: cenario.formaPagamento,
      parcelas: cenario.parcelas,
    };
    setCompraSimulada(compraComparada);
    setOpcoesSimulacao(opcoes);
    setSimulacao(null);
    setTimeout(() => document.getElementById('simulacao-compra-programada')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    executarSimulacao(compraComparada, opcoes);
  };

  const atualizarStatusCompra = async (compra, status) => {`,
);

trocar(
  'fechar comparação ao concluir compra',
  "      if (compraSimulada?.id === compra.id && ['COMPRADA', 'CANCELADA'].includes(status)) fecharSimulacao();",
  "      if (compraSimulada?.id === compra.id && ['COMPRADA', 'CANCELADA'].includes(status)) fecharSimulacao();\n      if (compraComparada?.id === compra.id && ['COMPRADA', 'CANCELADA'].includes(status)) fecharComparacao();",
);

trocar(
  'fechar comparação ao excluir compra',
  "          if (editandoId === compra.id) limparFormulario();\n          await carregarCompras();",
  "          if (editandoId === compra.id) limparFormulario();\n          if (compraComparada?.id === compra.id) fecharComparacao();\n          if (compraSimulada?.id === compra.id) fecharSimulacao();\n          await carregarCompras();",
);

trocar(
  'remover variável sem uso e classificar cenários',
  "  const rotuloStatusCompra = { PLANEJADA: 'Planejada', ADIADA: 'Adiada', COMPRADA: 'Comprada', CANCELADA: 'Cancelada' };\n  const comprasFiltradas = compras.filter((compra) => {",
  `  const comprasFiltradas = compras.filter((compra) => {`,
);

trocar(
  'derivação da recomendação',
  "  const totalCompradas = compras.filter((compra) => compra.status === 'COMPRADA').length;\n\n  return (",
  `  const totalCompradas = compras.filter((compra) => compra.status === 'COMPRADA').length;
  const reservaMinimaNumero = Math.max(0, Number(reservaMinimaComparacao) || 0);
  const cenariosClassificados = resultadosComparacao
    .map((cenario) => ({ ...cenario, atendeReserva: cenario.menorSaldoComCompra >= reservaMinimaNumero }))
    .sort((a, b) => {
      if (a.atendeReserva !== b.atendeReserva) return a.atendeReserva ? -1 : 1;
      if (a.atendeReserva && b.atendeReserva) {
        if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
        if (a.parcelas !== b.parcelas) return a.parcelas - b.parcelas;
        return b.menorSaldoComCompra - a.menorSaldoComCompra;
      }
      if (a.menorSaldoComCompra !== b.menorSaldoComCompra) return b.menorSaldoComCompra - a.menorSaldoComCompra;
      if (a.mesesNegativos.length !== b.mesesNegativos.length) return a.mesesNegativos.length - b.mesesNegativos.length;
      if (a.adiamentoMeses !== b.adiamentoMeses) return a.adiamentoMeses - b.adiamentoMeses;
      return a.parcelas - b.parcelas;
    });
  const recomendacaoComparacao = cenariosClassificados[0] || null;

  return (`,
);

trocar(
  'botão comparar nos cards',
  "                    {!['COMPRADA', 'CANCELADA'].includes(compra.status) && <Btn size=\"sm\" variant=\"primary\" onClick={() => abrirSimulacao(compra)}>Simular impacto</Btn>}",
  "                    {!['COMPRADA', 'CANCELADA'].includes(compra.status) && <Btn size=\"sm\" variant=\"primary\" onClick={() => compararCenarios(compra)}>Comparar cenários</Btn>}\n                    {!['COMPRADA', 'CANCELADA'].includes(compra.status) && <Btn size=\"sm\" onClick={() => abrirSimulacao(compra)}>Simular</Btn>}",
);

trocar(
  'painel comparador antes da simulação',
  "      {compraSimulada && (\n        <section id=\"simulacao-compra-programada\" className=\"compras-simulacao-card\">",
  `      {compraComparada && (
        <section id="comparacao-compra-programada" className="compras-simulacao-card">
          <div className="compras-simulacao-header">
            <div>
              <h2>🧭 Comparador de cenários</h2>
              <p><strong>{compraComparada.descricao}</strong> · {formatarMoeda(compraComparada.valor_estimado)}</p>
            </div>
            <Btn type="button" onClick={fecharComparacao}>Fechar comparação</Btn>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) auto', gap: '12px', alignItems: 'end', marginBottom: '16px' }}>
            <label className="compras-field">
              <span className="compras-field-label">Reserva mínima desejada</span>
              <input type="number" min="0" step="100" value={reservaMinimaComparacao} onChange={(e) => setReservaMinimaComparacao(e.target.value)} />
            </label>
            <Btn type="button" variant="primary" onClick={() => compararCenarios(compraComparada)} disabled={comparandoCenarios}>{comparandoCenarios ? 'Comparando...' : 'Recalcular cenários'}</Btn>
          </div>

          {comparandoCenarios ? <Spinner texto="Comparando datas e formas de pagamento..." /> : recomendacaoComparacao ? (
            <>
              <div style={{ border: recomendacaoComparacao.atendeReserva ? '1px solid #86efac' : '1px solid #fdba74', background: recomendacaoComparacao.atendeReserva ? '#f0fdf4' : '#fff7ed', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
                <strong style={{ display: 'block', color: recomendacaoComparacao.atendeReserva ? '#166534' : '#9a3412', marginBottom: '6px' }}>
                  {recomendacaoComparacao.atendeReserva ? '✅ Melhor cenário dentro da reserva definida' : '⚠️ Nenhum cenário preserva toda a reserva definida'}
                </strong>
                <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
                  <span><small style={{ color: '#64748b' }}>Quando</small><strong style={{ display: 'block' }}>{formatarDataCompra(recomendacaoComparacao.dataDesejada)}</strong></span>
                  <span><small style={{ color: '#64748b' }}>Pagamento</small><strong style={{ display: 'block' }}>{recomendacaoComparacao.parcelas === 1 ? 'À vista' : \`${'${recomendacaoComparacao.parcelas}'}x de ${'${formatarMoeda(recomendacaoComparacao.valorParcela)}'}\`}</strong></span>
                  <span><small style={{ color: '#64748b' }}>Menor saldo projetado</small><strong style={{ display: 'block' }}>{formatarMoeda(recomendacaoComparacao.menorSaldoComCompra)}</strong></span>
                </div>
                <p style={{ margin: '10px 0 0', color: '#475569', fontSize: '13px' }}>
                  {recomendacaoComparacao.atendeReserva
                    ? 'O ranking prioriza a data mais próxima que preserva sua reserva e, depois, o menor número de parcelas.'
                    : 'O ranking mostra primeiro o cenário que deixa o maior saldo mínimo projetado, já que nenhum atende à reserva informada.'}
                </p>
              </div>

              <div className="compras-simulacao-table-wrap">
                <table className="compras-simulacao-table" style={{ minWidth: '820px' }}>
                  <thead><tr><th>Cenário</th><th>Data</th><th>Pagamento</th><th>Menor saldo</th><th>Reserva</th><th>Meses negativos</th><th>Ação</th></tr></thead>
                  <tbody>{cenariosClassificados.slice(0, 8).map((cenario, indice) => <tr key={cenario.id}>
                    <td><strong>{indice === 0 ? '⭐ Recomendado' : \`Opção ${'${indice + 1}'}\`}</strong></td>
                    <td>{formatarDataCompra(cenario.dataDesejada)}</td>
                    <td>{cenario.parcelas === 1 ? 'À vista' : \`${'${cenario.parcelas}'}x\`}</td>
                    <td style={{ color: cenario.menorSaldoComCompra < reservaMinimaNumero ? '#b45309' : '#166534', fontWeight: 700 }}>{formatarMoeda(cenario.menorSaldoComCompra)}</td>
                    <td>{cenario.atendeReserva ? '✅ Preserva' : '⚠️ Abaixo'}</td>
                    <td>{cenario.mesesNegativos.length}</td>
                    <td><Btn size="sm" onClick={() => usarCenarioComparacao(cenario)}>Usar no simulador</Btn></td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p style={{ color: '#64748b', fontSize: '12px', margin: '12px 0 0' }}>A comparação usa o mesmo motor do simulador, horizonte fixo de 18 meses e mantém o valor total da compra. Juros, taxas ou descontos do parcelamento não são estimados automaticamente.</p>
            </>
          ) : <p style={{ color: '#64748b' }}>Nenhum cenário calculado.</p>}
        </section>
      )}

      {compraSimulada && (
        <section id="simulacao-compra-programada" className="compras-simulacao-card">`,
);

fs.writeFileSync(arquivo, antes + bloco + depois);
console.log('Comparador determinístico de cenários aplicado com sucesso.');
