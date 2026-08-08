import fs from 'node:fs';

const arquivo = 'changes/apply-comparador-cenarios.mjs';
let texto = fs.readFileSync(arquivo, 'utf8');
const inicio = texto.indexOf("trocar(\n  'fechar comparação ao excluir compra',");
if (inicio < 0) throw new Error('Bloco de exclusão da transformação não encontrado.');
const proximo = texto.indexOf("\n\ntrocar(\n", inicio + 10);
if (proximo < 0) throw new Error('Fim do bloco de exclusão não encontrado.');
const novoBloco = `trocar(
  'fechar comparação ao excluir compra',
  "          await carregarCompras();\\n          mostrarToast('Compra programada excluída.');",
  "          if (compraComparada?.id === compra.id) fecharComparacao();\\n          if (compraSimulada?.id === compra.id) fecharSimulacao();\\n          await carregarCompras();\\n          mostrarToast('Compra programada excluída.');",
);`;
texto = texto.slice(0, inicio) + novoBloco + texto.slice(proximo);
fs.writeFileSync(arquivo, texto);
console.log('Transformação do comparador ajustada para exclusão robusta.');
