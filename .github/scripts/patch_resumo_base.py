from pathlib import Path

path = Path('App.jsx')
text = path.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: esperado 1 trecho, encontrado {count}')
    text = text.replace(old, new, 1)


replace_once(
    "  const [paginacao, setPaginacao] = useState({ total: 0, pagina: 1, limite: 50, totalPaginas: 1 });\n  const tabelaRef = useRef(null);",
    "  const [paginacao, setPaginacao] = useState({ total: 0, pagina: 1, limite: 50, totalPaginas: 1 });\n  const [transacoesResumo, setTransacoesResumo] = useState(null);\n  const [carregandoResumoBase, setCarregandoResumoBase] = useState(false);\n  const [exportandoExcel, setExportandoExcel] = useState(false);\n  const tabelaRef = useRef(null);",
    'states resumo/exportacao',
)

old_carregar = """  const carregarDados = async () => {
    setCarregando(true);

    try {
      const params = new URLSearchParams();
      params.set('pagina', String(pagina));
      params.set('limite', String(limite));
      if (filtros.busca) params.set('busca', filtros.busca);
      if (filtros.conta !== 'todas') params.set('contaId', filtros.conta);
      if (filtros.categoriaMacro !== 'todas' && filtros.categoriaMacro !== 'sem') params.set('categoriaMacroId', filtros.categoriaMacro);
      if (filtros.categoriaDetalhada !== 'todas' && filtros.categoriaDetalhada !== 'sem') params.set('categoriaDetalhadaId', filtros.categoriaDetalhada);
      if (filtros.status !== 'todas') params.set('status', filtros.status);
      if (filtros.tipo !== 'todos') params.set('tipo', filtros.tipo);
      if (dataInicial) params.set('dataInicial', dataInicial);
      if (dataFinal) params.set('dataFinal', dataFinal);
      const [transacoesResponse, categoriasResponse] = await Promise.all([
        axios.get(`${API_URL}/transacoes?${params.toString()}`, { headers: authHeaders }),
        axios.get(`${API_URL}/categorias`, { headers: authHeaders })
      ]);
"""
new_carregar = """  const montarParamsTransacoes = (paginaDesejada = pagina, limiteDesejado = limite) => {
    const params = new URLSearchParams();
    params.set('pagina', String(paginaDesejada));
    params.set('limite', String(limiteDesejado));
    if (filtros.busca) params.set('busca', filtros.busca);
    if (filtros.conta !== 'todas') params.set('contaId', filtros.conta);
    if (filtros.categoriaMacro !== 'todas' && filtros.categoriaMacro !== 'sem') params.set('categoriaMacroId', filtros.categoriaMacro);
    if (filtros.categoriaDetalhada !== 'todas' && filtros.categoriaDetalhada !== 'sem') params.set('categoriaDetalhadaId', filtros.categoriaDetalhada);
    if (filtros.status !== 'todas') params.set('status', filtros.status);
    if (filtros.tipo !== 'todos') params.set('tipo', filtros.tipo);
    if (dataInicial) params.set('dataInicial', dataInicial);
    if (dataFinal) params.set('dataFinal', dataFinal);
    return params;
  };

  const filtrarPendenciasEspeciais = (items) => items.filter((tx) => {
    const correspondeMacroSem = filtros.categoriaMacro !== 'sem' || (!tx.categoria_macro_id && !tx.categoria_id);
    const correspondeDetalhadaSem = filtros.categoriaDetalhada !== 'sem' || !tx.categoria_detalhada_id;
    return correspondeMacroSem && correspondeDetalhadaSem;
  });

  const normalizarSaldoBackend = (items) => items.map((tx) => {
    const saldoBackend = tx.saldo_acumulado === null || tx.saldo_acumulado === undefined ? null : Number(tx.saldo_acumulado);
    const configurado = Number.isFinite(saldoBackend);
    return {
      ...tx,
      saldo_acumulado_calculado: configurado ? saldoBackend : null,
      saldo_acumulado_configurado: configurado,
    };
  });

  const carregarTodasTransacoesFiltradas = async () => {
    const limiteCompleto = 500;
    const primeiraResponse = await axios.get(`${API_URL}/transacoes?${montarParamsTransacoes(1, limiteCompleto).toString()}`, { headers: authHeaders });
    const primeiraPagina = primeiraResponse.data.transacoes || [];
    const totalPaginas = Number(primeiraResponse.data.paginacao?.totalPaginas || 1);
    const todas = [...primeiraPagina];

    for (let inicio = 2; inicio <= totalPaginas; inicio += 4) {
      const paginas = Array.from({ length: Math.min(4, totalPaginas - inicio + 1) }, (_, indice) => inicio + indice);
      const respostas = await Promise.all(paginas.map((paginaAtual) => (
        axios.get(`${API_URL}/transacoes?${montarParamsTransacoes(paginaAtual, limiteCompleto).toString()}`, { headers: authHeaders })
      )));
      respostas.forEach((response) => todas.push(...(response.data.transacoes || [])));
    }

    return normalizarSaldoBackend(filtrarPendenciasEspeciais(todas));
  };

  useEffect(() => {
    if (abaTransacoes !== 'resumo') return undefined;
    let ativo = true;
    setTransacoesResumo(null);
    setCarregandoResumoBase(true);
    carregarTodasTransacoesFiltradas()
      .then((items) => { if (ativo) setTransacoesResumo(items); })
      .catch((error) => {
        if (ativo) mostrarToast('Erro ao carregar resumo completo: ' + (error.response?.data?.erro || error.message), 'erro');
      })
      .finally(() => { if (ativo) setCarregandoResumoBase(false); });
    return () => { ativo = false; };
  }, [abaTransacoes, filtros, dataInicial, dataFinal]);

  const carregarDados = async () => {
    setCarregando(true);

    try {
      const params = montarParamsTransacoes();
      const [transacoesResponse, categoriasResponse] = await Promise.all([
        axios.get(`${API_URL}/transacoes?${params.toString()}`, { headers: authHeaders }),
        axios.get(`${API_URL}/categorias`, { headers: authHeaders })
      ]);
"""
replace_once(old_carregar, new_carregar, 'helper de paginas completas')

start = text.index('  const resumoBase = useMemo(() => {')
end = text.index('  const primeiraTransacaoBase = resumoBase?.primeira || null;', start)
block = text[start:end]
if block.count('transacoesFiltradas') < 5:
    raise SystemExit('resumoBase: quantidade inesperada de referencias a transacoesFiltradas')
block = block.replace('transacoesFiltradas', 'transacoesBaseResumo')
block = "  const transacoesBaseResumo = transacoesResumo ?? transacoesFiltradas;\n\n" + block
block = block.replace(
    "      const dataReferenciaAntes = dataInicial || normalizarDataFiltro(ordenadas[0]?.data);\n      const saldoAntesPeriodo = calcularSaldoAntesDaData(item.contaId, dataReferenciaAntes);\n      const ultimaComSaldo = [...ordenadas].reverse().find((tx) => Number.isFinite(tx.saldo_acumulado_calculado));",
    "      const primeiraComSaldo = ordenadas.find((tx) => Number.isFinite(tx.saldo_acumulado_calculado));\n      const saldoAntesPeriodo = primeiraComSaldo\n        ? Number(primeiraComSaldo.saldo_acumulado_calculado) - (primeiraComSaldo.tipo === 'CREDITO' ? Number(primeiraComSaldo.valor || 0) : -Number(primeiraComSaldo.valor || 0))\n        : null;\n      const ultimaComSaldo = [...ordenadas].reverse().find((tx) => Number.isFinite(tx.saldo_acumulado_calculado));",
)
block = block.replace('  }, [transacoesBaseResumo, contas, dataInicial, contaSelecionadaFiltro]);', '  }, [transacoesBaseResumo, contas, contaSelecionadaFiltro]);')
text = text[:start] + block + text[end:]

old_export = """  const exportarExcel = (apenasSelecionadas = false) => {
    const selecionadasSet = new Set(selecionadas);
    const baseExportacao = apenasSelecionadas
      ? transacoesOrdenadas.filter((tx) => selecionadasSet.has(tx.id))
      : transacoesOrdenadas;

    if (baseExportacao.length === 0) {
      mostrarToast('Não há transações para exportar com os filtros atuais.');
      return;
    }

    try {
      const linhas = montarLinhasExportacao(baseExportacao);
      const bytes = criarXlsxTransacoes(linhas);
      const nomeArquivo = nomeArquivoExportacao(dataInicial, dataFinal, apenasSelecionadas);
      baixarArquivo(bytes, nomeArquivo, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (error) {
      console.error('Erro ao exportar transações:', error);
      mostrarToast('Erro ao exportar transações. Tente novamente.');
    }
  };
"""
new_export = """  const exportarExcel = async (apenasSelecionadas = false) => {
    if (exportandoExcel) return;
    setExportandoExcel(true);
    try {
      const selecionadasSet = new Set(selecionadas);
      const baseExportacao = apenasSelecionadas
        ? transacoesOrdenadas.filter((tx) => selecionadasSet.has(tx.id))
        : (await carregarTodasTransacoesFiltradas()).sort((a, b) => compararTransacoes(a, b, sortField || 'data', sortDirection || 'desc'));

      if (baseExportacao.length === 0) {
        mostrarToast('Não há transações para exportar com os filtros atuais.');
        return;
      }

      const linhas = montarLinhasExportacao(baseExportacao);
      const bytes = criarXlsxTransacoes(linhas);
      const nomeArquivo = nomeArquivoExportacao(dataInicial, dataFinal, apenasSelecionadas);
      baixarArquivo(bytes, nomeArquivo, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (error) {
      console.error('Erro ao exportar transações:', error);
      mostrarToast('Erro ao exportar transações. Tente novamente.');
    } finally {
      setExportandoExcel(false);
    }
  };
"""
replace_once(old_export, new_export, 'exportacao completa')

replace_once(
    "                <Btn variant=\"secondary\" size=\"sm\" onClick={() => setMaisAcoesAberto((aberto) => !aberto)}>⬇️ Exportar Excel ▾</Btn>",
    "                <Btn variant=\"secondary\" size=\"sm\" onClick={() => setMaisAcoesAberto((aberto) => !aberto)} disabled={exportandoExcel}>{exportandoExcel ? 'Exportando...' : '⬇️ Exportar Excel ▾'}</Btn>",
    'botao exportar',
)

replace_once(
    "        {abaTransacoes === 'resumo' && resumoBase && (",
    "        {abaTransacoes === 'resumo' && carregandoResumoBase && <Spinner texto=\"Carregando resumo completo da base...\" />}\n        {abaTransacoes === 'resumo' && !carregandoResumoBase && !resumoBase && (\n          <div style={{ background: 'white', borderRadius: '12px', padding: '28px', textAlign: 'center', color: '#64748b', marginBottom: '16px' }}>Nenhuma transação encontrada para os filtros atuais.</div>\n        )}\n        {abaTransacoes === 'resumo' && !carregandoResumoBase && resumoBase && (",
    'loading resumo',
)

path.write_text(text, encoding='utf-8')
