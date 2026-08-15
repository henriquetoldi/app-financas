from pathlib import Path
import re

NEW_FUNCTION = r'''function parseValorMonetario(valorOriginal) {
  const arredondarMoeda = (numero) => Math.round((numero + Number.EPSILON) * 100) / 100;

  if (typeof valorOriginal === 'number') {
    const valor = Number.isFinite(valorOriginal) ? arredondarMoeda(valorOriginal) : null;
    return {
      valor,
      erro: valor === null ? 'A célula contém um número que o app não conseguiu interpretar.' : null,
      valorOriginal,
      interpretadoComo: valor,
    };
  }

  const textoOriginal = String(valorOriginal ?? '').trim();
  if (!textoOriginal) {
    return {
      valor: null,
      erro: 'A célula de valor está vazia.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  let texto = textoOriginal
    .replace(/\u00a0/g, ' ')
    .replace(/R\$/gi, '')
    .replace(/\s+/g, '')
    .trim();

  let negativo = false;
  if (/^\(.*\)$/.test(texto)) {
    negativo = true;
    texto = texto.slice(1, -1);
  }
  if (texto.startsWith('-')) negativo = true;
  texto = texto.replace(/^[+-]/, '');

  if (!texto) {
    return {
      valor: null,
      erro: 'A célula de valor está vazia.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  const aplicarSinalEArredondar = (numero) => {
    if (!Number.isFinite(numero)) return null;
    const arredondado = arredondarMoeda(numero);
    return negativo ? -Math.abs(arredondado) : arredondado;
  };

  // O Excel pode serializar números decimais com ruído de ponto flutuante e
  // notação científica, por exemplo 0.14000000000000001 ou 7E-2.
  if (/^\d+(?:[.,]\d+)?[eE][+-]?\d+$/.test(texto)) {
    const numeroCientifico = Number(texto.replace(',', '.'));
    const interpretadoComo = aplicarSinalEArredondar(numeroCientifico);
    return {
      valor: interpretadoComo,
      erro: interpretadoComo === null ? 'Não foi possível converter o conteúdo da célula em número.' : null,
      valorOriginal,
      interpretadoComo,
    };
  }

  if (!/^[0-9.,]+$/.test(texto)) {
    return {
      valor: null,
      erro: 'A célula contém caracteres que não parecem formar um valor monetário.',
      valorOriginal,
      interpretadoComo: null,
    };
  }

  const ultimaVirgula = texto.lastIndexOf(',');
  const ultimoPonto = texto.lastIndexOf('.');
  let decimal = null;

  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    decimal = ultimaVirgula > ultimoPonto ? ',' : '.';
  } else {
    const separador = ultimaVirgula >= 0 ? ',' : ultimoPonto >= 0 ? '.' : null;
    if (separador) {
      const ultimoSeparador = texto.lastIndexOf(separador);
      const digitosDepois = texto.length - ultimoSeparador - 1;
      const ocorrencias = texto.split(separador).length - 1;
      const parteInteira = texto.slice(0, ultimoSeparador);

      if (ocorrencias === 1) {
        if (digitosDepois > 0 && digitosDepois <= 2) {
          decimal = separador;
        } else if (digitosDepois === 3) {
          // Mantém 1.234 / 1,234 como milhar, mas trata 0.140 e 1234.567
          // como decimais, evitando multiplicar valores oriundos do Excel.
          decimal = parteInteira === '0' || parteInteira.length > 3 ? separador : null;
        } else if (digitosDepois > 3) {
          // Muitas casas decimais normalmente são ruído binário exportado pelo Excel.
          decimal = separador;
        }
      } else if (digitosDepois > 0 && digitosDepois <= 2) {
        decimal = separador;
      }
    }
  }

  let normalizado;
  if (decimal === ',') {
    const ultimo = texto.lastIndexOf(',');
    normalizado = texto.slice(0, ultimo).replace(/[.,]/g, '') + '.' + texto.slice(ultimo + 1).replace(/[.,]/g, '');
  } else if (decimal === '.') {
    const ultimo = texto.lastIndexOf('.');
    normalizado = texto.slice(0, ultimo).replace(/[.,]/g, '') + '.' + texto.slice(ultimo + 1).replace(/[.,]/g, '');
  } else {
    normalizado = texto.replace(/[.,]/g, '');
  }

  const numero = Number(normalizado);
  const interpretadoComo = aplicarSinalEArredondar(numero);

  return {
    valor: interpretadoComo,
    erro: interpretadoComo === null ? 'Não foi possível converter o conteúdo da célula em número.' : null,
    valorOriginal,
    interpretadoComo,
  };
}'''

pattern = re.compile(r"function parseValorMonetario\(valorOriginal\) \{.*?\n\}\n\n(?=function )", re.S)

for filename in ['App.jsx', 'backend-server.js']:
    path = Path(filename)
    content = path.read_text(encoding='utf-8')
    replacement = NEW_FUNCTION + '\n\n'
    updated, count = pattern.subn(lambda _match: replacement, content, count=1)
    if count != 1:
        raise SystemExit(f'Não foi possível localizar exatamente um parser em {filename}: {count}')
    path.write_text(updated, encoding='utf-8')

print('Parser monetário atualizado em App.jsx e backend-server.js')
