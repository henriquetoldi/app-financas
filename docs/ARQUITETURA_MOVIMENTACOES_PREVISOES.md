# Arquitetura de Movimentações e Previsões

Este documento consolida a reorganização conceitual definida após os testes com Compras Programadas. O objetivo é reduzir confusão no uso diário, evitar novas abas soltas e orientar os próximos PRs de implementação.

## Decisão principal

A aplicação deve se organizar em quatro áreas principais:

```text
Dashboard
Movimentações
Previsões
Administração
```

Essa estrutura separa o app por natureza de uso:

- **Dashboard**: resumo executivo do que está acontecendo.
- **Movimentações**: tudo que já aconteceu ou foi importado.
- **Previsões**: tudo que ainda vai acontecer, pode acontecer ou está sendo planejado.
- **Administração**: configurações, cadastros auxiliares e manutenção.

## 1. Movimentações

Movimentações representa a base real do app: transações importadas, ajustes e validações de saldo.

### Deve conter

```text
Transações
Importar dados
Conferir saldos
Transferências internas
Regras de categorização
```

### Por que Conferência fica aqui

A Conferência de Saldos valida se a base de transações bate com o saldo real do banco. Portanto, ela depende diretamente das movimentações.

Conferência responde:

```text
O saldo calculado pelo app bate com o saldo real da conta?
```

Exemplo:

```text
Saldo inicial: R$ 1.000
+ Entradas importadas: R$ 3.000
- Saídas importadas: R$ 2.200
= Saldo calculado: R$ 1.800

Saldo real no banco: R$ 1.750
Diferença: R$ -50
```

Possíveis causas da diferença:

- transação faltando;
- transação duplicada;
- valor incorreto;
- saldo inicial incorreto;
- transferência interna mal classificada.

## 2. Previsões

Previsões consolida Planejamento Mensal, Contas Previstas e Compras Programadas.

A tela deve começar com um seletor de tipo:

```text
Tipo de previsão
- Orçamento por categoria
- Conta prevista
- Compra programada
```

### 2.1 Orçamento por categoria

Usado para valores planejados por categoria no mês.

Exemplos:

```text
Alimentação - R$ 800 - Agosto/2026
Transporte - R$ 400 - Agosto/2026
Lazer - R$ 300 - Agosto/2026
```

Responde:

```text
Quanto eu pretendo gastar ou receber nessa categoria?
```

### 2.2 Conta prevista

Usada para compromisso específico, com data, vencimento e status.

Exemplos:

```text
Internet Claro - R$ 119,90 - vencimento 10/08
Fatura cartão - R$ 950 - vencimento 15/08
Aluguel - R$ 1.200 - vencimento 05/08
```

Responde:

```text
Qual compromisso específico preciso pagar ou receber?
```

### 2.3 Compra programada

Usada para compra futura ainda em decisão.

Exemplos:

```text
Fogão - R$ 500 - desejo comprar em agosto
Notebook - R$ 3.000 - avaliar parcelamento
Viagem - R$ 1.200 - analisar melhor mês
```

Responde:

```text
Quero comprar isso. Quando e como comprar sem pressionar meu caixa?
```

## 3. Campos comuns de Previsões

Toda previsão deve ter campos mínimos comuns:

```text
tipo_previsao
natureza
descricao
categoria_macro_id
categoria_detalhada_id
valor_previsto
mes
ano
status
grau_certeza
observacao
```

### Natureza

Toda previsão precisa indicar natureza:

```text
Entrada / Receita
Saída / Despesa
```

Em compra programada, o padrão deve ser:

```text
Saída / Despesa
```

## 4. Categorias

Categorias devem sempre respeitar a natureza escolhida.

### Regra

Se a natureza for **Saída / Despesa**, a seleção deve mostrar somente categorias de despesa.

Se a natureza for **Entrada / Receita**, a seleção deve mostrar somente categorias de receita.

### Exemplo visual esperado

```text
Natureza: Saída / Despesa

Categoria:
🍔 Alimentação
  └ Restaurante
  └ Supermercado
  └ Padaria

🏠 Moradia
  └ Aluguel
  └ Energia
  └ Móveis / Eletrodomésticos
```

### Criação de categoria nova

Ao criar categoria nova dentro de qualquer fluxo, o usuário deve informar:

```text
Natureza: Entrada ou Saída
Nível: Macro ou Subcategoria
Categoria mãe: obrigatória se for subcategoria
Nome
Emoji opcional
```

A categoria nova deve nascer com a natureza correta e aparecer na lista filtrada correta.

## 5. Correção de categorias suspeitas

O app deve ter diagnóstico de categorias incoerentes.

Exemplo identificado:

```text
💰 Renda Extra    DESPESA
```

Esse caso deveria ser classificado como **RECEITA / ENTRADA**.

Diagnósticos úteis:

- receita cadastrada como despesa;
- despesa cadastrada como receita;
- categoria duplicada;
- categoria sem uso;
- previsão sem categoria;
- transação sem categoria;
- conta prevista vencida e não conciliada;
- conta com saldo divergente.

## 6. Diferença entre Conferência e Conciliação

### Conferência de saldos

```text
O saldo calculado pelo app bate com o saldo real do banco?
```

Fica em **Movimentações**.

### Conciliação

```text
Essa conta prevista bate com uma transação real?
```

Fica associada a **Previsões / Contas previstas** e também pode aparecer como ação em Transações.

## 7. Fluxo ideal de Compra Programada

```text
Compra programada
↓
Análise de impacto
↓
Aprovada
↓
Vira orçamento do mês ou conta prevista
↓
Depois vira transação real importada
↓
Conciliada quando aplicável
```

### Campos específicos de Compra Programada

```text
valor_estimado
mes_desejado
ano_desejado
prioridade
flexibilidade
forma_pagamento
valor_entrada
quantidade_parcelas
juros_percentual
status_analise
risco
recomendacao_texto
melhor_mes_sugerido
melhor_ano_sugerido
```

### Recomendações possíveis

```text
Comprar agora
Melhor adiar
Melhor parcelar
Não recomendado
Falta informação
```

## 8. Planejado x Realizado

A área de Previsões deve permitir comparar orçamento previsto contra transações reais.

Exemplo:

```text
Alimentação
Planejado: R$ 800
Realizado: R$ 920
Diferença: -R$ 120
```

Origem dos dados:

```text
Planejado = Previsões tipo Orçamento por categoria
Realizado = Transações reais categorizadas
```

## 9. Persistência definitiva

A primeira versão de Compras Programadas em `localStorage` foi removida por gerar comportamento de overlay e inconsistências.

A solução definitiva deve persistir no banco, preferencialmente em uma estrutura ampla:

```text
previsoes_financeiras
```

Campos sugeridos:

```text
id
usuario_id
tipo_previsao
natureza
descricao
categoria_macro_id
categoria_detalhada_id
valor_previsto
mes
ano
data_prevista
data_vencimento
status
grau_certeza
prioridade
forma_pagamento
quantidade_parcelas
valor_entrada
juros_percentual
observacao
criado_em
atualizado_em
```

## 10. Ordem recomendada de implementação

### PR 1 — Estabilização

Concluído no PR #55.

```text
Remover scripts públicos experimentais de Compras Programadas.
Remover overlay que escondia a sidebar.
Remover botão flutuante.
```

### PR 2 — Navegação conceitual

```text
Criar estrutura visual de Movimentações e Previsões no menu.
Não alterar regras de negócio ainda.
Manter telas antigas acessíveis por dentro dos novos grupos.
```

### PR 3 — Movimentações

```text
Agrupar Transações, Importação e Conferência de Saldos.
Manter comportamento existente.
Ajustar labels e navegação.
```

### PR 4 — Previsões

```text
Criar tela nativa de Previsões.
Reaproveitar Planejamento Mensal e Contas Previstas.
Adicionar placeholder correto para Compra Programada.
```

### PR 5 — Categorias por natureza

```text
Criar seletor reutilizável por natureza.
Filtrar Entrada/Saída corretamente.
Corrigir categorias suspeitas.
```

### PR 6 — Banco de Previsões

```text
Criar tabela previsoes_financeiras.
Criar rotas protegidas.
Migrar Compra Programada para banco.
```

### PR 7 — Inteligência financeira

```text
Planejado x realizado.
Análise de impacto da compra programada.
Transformar compra programada em orçamento ou conta prevista.
Diagnóstico de inconsistências.
```

## 11. Regras para evitar regressão

Não usar scripts públicos para criar telas novas.

Não criar overlay fullscreen para módulo principal.

Não esconder sidebar em telas principais.

Não misturar categorias de entrada e saída no mesmo seletor.

Não criar aba nova sem revisar se ela pertence a Movimentações, Previsões ou Administração.

Não criar tabela isolada de compras programadas antes de decidir a estrutura final de Previsões.
