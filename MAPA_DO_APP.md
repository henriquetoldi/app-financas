# Mapa conceitual do app financeiro

Este documento separa os conceitos centrais do app para evitar que novas evoluções misturem orçamento, contas operacionais e fatos financeiros já realizados.

## 1. Planejamento

Planejamento responde: **"quanto eu pretendo ou costumo gastar no mês?"**

Use Planejamento Mensal para orçamento, previsão e compromissos futuros agregados, como:

- Alimentação prevista: R$ 800 no mês.
- Transporte previsto: R$ 400 no mês.
- Internet prevista: R$ 120 no mês.
- Dívida parcelada: R$ 1.500 por 3 meses.

O planejamento é comparado com o realizado por **soma agregada de transações categorizadas no mês**. Ele não deve procurar uma transação individual de mesmo valor.

## 2. Provisão / Contas previstas

Provisão responde: **"quais pagamentos ou recebimentos concretos eu preciso acompanhar e depois conferir se aconteceram?"**

Use Provisões quando existe um compromisso operacional específico, como:

- Boleto Claro Internet, R$ 119,90, vencimento dia 05.
- Fatura do cartão, R$ 1.500, vencimento dia 10.
- Cliente X vai pagar R$ 2.000 no dia 15.
- Aluguel a pagar, R$ 1.500, vencimento dia 07.

Provisões podem ser conciliadas com transações reais. Planejamentos não geram provisões automaticamente nesta etapa.

## 3. Transação

Transações são fatos reais importados do banco, cartão ou planilha, como:

- Supermercado Carone, R$ 180.
- iFood, R$ 42.
- CLARO SA, R$ 119,90.
- Uber, R$ 35.

Transações devem ser categorizadas corretamente para alimentar dashboard, planejamento x realizado, regras de categorização, conferências e relatórios. Transferências internas marcadas não devem ser tratadas como gasto real no comparativo de orçamento.

## 4. Conciliação

Conciliação responde: **"esta provisão específica aconteceu nesta transação específica?"**

Exemplo correto:

- Provisão: Claro Internet, R$ 119,90, vencimento 05/06/2026.
- Transação: CLARO SA, R$ 119,90, data 05/06/2026.
- Resultado: provisão conciliada.

A conciliação continua focada em **Provisão x Transação**. Ela não deve tentar conciliar planejamento genérico de categoria com uma transação individual.

## 5. Dashboard

Dashboard é a visão consolidada para acompanhar o estado financeiro em um período. Ele pode mostrar saldos, receitas, despesas, categorias, provisões, conciliações e alertas, mas deve respeitar as fronteiras conceituais:

- Planejamento é previsão/orçamento.
- Provisão é compromisso operacional específico.
- Transação é fato realizado.
- Conciliação vincula provisão e transação.

## Como Planejamento se compara com Realizado

O comparativo **Planejado x Realizado por categoria** responde:

> Quanto eu planejei gastar em cada categoria e quanto eu realmente gastei?

Regras do cálculo:

1. O valor planejado vem dos itens cadastrados em `planejamentos_mensais` no mês selecionado.
2. O valor realizado vem da soma de transações do mês por categoria.
3. Considera apenas transações de saída/despesa (`DEBITO` ou `DESPESA`).
4. Não considera transações marcadas como transferência interna.
5. Quando `categoria_id` existe no planejamento, ele é a chave preferencial de comparação.
6. Quando não existe `categoria_id`, o app usa o texto da categoria como compatibilidade com dados antigos.

## Por que Planejamento não é conciliado item a item

Planejamento representa orçamento e intenção. Uma previsão de R$ 800 em Alimentação normalmente será realizada por várias transações menores, como mercado, delivery e padaria. Procurar uma transação única de R$ 800 confundiria orçamento com pagamento operacional.

Para acompanhar se um pagamento específico aconteceu, use Provisão e Conciliação.

## Quando usar cada área

### Use Planejamento quando

- Quiser definir orçamento mensal por categoria.
- Quiser registrar despesas fixas esperadas.
- Quiser prever gastos variáveis.
- Quiser projetar parcelas e compromissos nos próximos meses.
- Quiser comparar planejado x realizado por categoria.

### Use Provisão quando

- Existir uma conta específica a pagar.
- Existir um recebimento específico esperado.
- Você precisar conferir depois se aquele compromisso aconteceu.
- Você quiser receber alertas e acompanhar pendências operacionais.

### Use Conciliação quando

- Uma transação real importada corresponde a uma provisão específica.
- Você quer confirmar que uma conta prevista foi paga ou recebida.
- Você quer manter rastreabilidade entre compromisso previsto e fato realizado.

## Mapa simples de telas e rotas principais

| Área | Tela no app | Rota/API principal | Papel conceitual |
| --- | --- | --- | --- |
| Login | Login Google/OAuth | `/api/auth/google`, `/api/auth/google/callback` | Autenticação do usuário |
| Dashboard | Início / dashboard | `/api/dashboard/resumo` | Visão consolidada do período |
| Importação XLSX | Importar transações por planilha | `/api/importar-xlsx/*` | Entrada segura de transações reais |
| Contas | Contas | `/api/contas` | Cadastro e saldo de contas |
| Transações | Transações | `/api/transacoes` | Fatos realizados e categorização |
| Categorias | Categorias | `/api/categorias` | Taxonomia para classificar transações e planejamento |
| Regras de categorização | Regras | `/api/regras-categorizacao` | Automatiza categorização de transações |
| Planejamento Mensal | Planejamento Mensal | `/api/planejamento`, `/api/planejamento/resumo-mensal` | Orçamento, previsão e projeção mensal |
| Provisões / Contas previstas | Provisões | `/api/provisoes` | Compromissos específicos a pagar/receber |
| Conciliação | Sugestões/confirmar conciliação | `/api/conciliacoes/*` | Vínculo Provisão x Transação |
| Conferência de saldos | Conferência de saldos | `/api/conferencias-saldo/*` | Diagnóstico entre saldo real e saldo calculado |
| Backups | Backups | `/api/backups` | Histórico de importações e segurança |
| Notificações | Notificações | `/api/notificacoes` | Avisos operacionais |
