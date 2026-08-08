import fs from 'node:fs';

const arquivo = 'changes/apply-comparador-cenarios.mjs';
let texto = fs.readFileSync(arquivo, 'utf8');

function substituirBloco(nome, novoBloco = '') {
  const inicio = texto.indexOf(`trocar(\n  '${nome}',`);
  if (inicio < 0) throw new Error(`Bloco não encontrado: ${nome}`);
  const proximo = texto.indexOf('\n\ntrocar(\n', inicio + 10);
  if (proximo < 0) throw new Error(`Fim do bloco não encontrado: ${nome}`);
  texto = texto.slice(0, inicio) + novoBloco + texto.slice(proximo);
}

substituirBloco(
  'fechar comparação ao excluir compra',
  `trocar(
  'fechar comparação ao excluir compra',
  "          await carregarCompras();\\n          mostrarToast('Compra programada excluída.');",
  "          if (compraComparada?.id === compra.id) fecharComparacao();\\n          if (compraSimulada?.id === compra.id) fecharSimulacao();\\n          await carregarCompras();\\n          mostrarToast('Compra programada excluída.');",
);`,
);

substituirBloco('remover variável sem uso e classificar cenários');

fs.writeFileSync(arquivo, texto);
console.log('Transformação do comparador ajustada para alvos robustos.');
