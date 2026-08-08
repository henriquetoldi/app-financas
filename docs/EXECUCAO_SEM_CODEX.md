# Execução sem Codex

Este documento registra a estratégia de implantação enquanto não houver crédito disponível no Codex.

## Contexto

A alteração estrutural em `App.jsx` para criar `Previsões` e `Movimentações` exige edição cuidadosa do arquivo principal, que hoje concentra grande parte do frontend.

Pelo conector direto do GitHub, alterações nesse arquivo precisam ser feitas como substituição completa, o que aumenta o risco de quebrar o app em produção caso o arquivo não seja editado em ambiente local com build.

## Estratégia segura

Enquanto não houver Codex ou ambiente local disponível, avançar em PRs menores e seguros:

1. Remover duplicidade visual de usuário/Sair.
2. Ajustar textos e documentação.
3. Corrigir HTML/CSS global de baixo risco.
4. Manter a arquitetura documentada na issue #56.
5. Evitar alterações grandes em `App.jsx` sem build local.

## Próxima alteração segura

Remover o bloco duplicado de usuário no rodapé da sidebar, mantendo o usuário/avatar/logout apenas no topo direito.

## Alteração estrutural pendente

Criar `TelaPrevisoes` no React:

- modo `previsoes`;
- abas internas: Orçamento, Contas previstas, Compras programadas;
- reaproveitar `TelaPlanejamentoMensal`;
- reaproveitar `TelaProvisoes`;
- placeholder seguro para Compras Programadas;
- sem `public/*.js`;
- sem overlay;
- sem mexer no banco.

Essa etapa deve ser executada quando houver uma forma segura de editar `App.jsx` com validação de build.
