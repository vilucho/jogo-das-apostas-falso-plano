# Jogo das Apostas — Falso Plano

Aplicação web para o jogo de apostas das Grandes Voltas. Foi desenhada primeiro para telemóvel.

## O que já faz

- Registo e entrada com nome e PIN.
- Conta de administração separada da conta usada para jogar.
- Competições com inscrições próprias.
- Importação da startlist por CSV com as colunas `ciclista` e `equipa`.
- Três escolhas ordenadas sem ciclistas repetidos.
- Alteração da aposta até ao fecho.
- Fecho por distância, hora de segurança ou decisão manual.
- Revelação das escolhas apenas depois do fecho.
- Introdução de resultados apenas para os ciclistas escolhidos.
- Bónus de `-200`, `-100` e `-50` para o vencedor conforme o lugar da aposta.
- Atribuição automática das três piores escolhas a quem não apostou.
- Exclusão automática das duas piores escolhas de cada jogador.
- Classificação, vidas e diferença para o líder.
- Empates na mesma posição, correção de resultados e etapas canceladas.

## Executar localmente

1. Copiar `.env.example` para `.env` e preencher os valores.
2. Instalar dependências com `npm install`.
3. Iniciar com `npm start`.
4. Abrir `http://localhost:3000`.

As variáveis `ADMIN_NAME`, `ADMIN_PIN` e `SESSION_SECRET` são obrigatórias numa publicação real. A base de dados fica no caminho definido por `DATABASE_PATH`.

## Publicação

A aplicação precisa de um serviço Node.js com armazenamento persistente. O ficheiro da base de dados não pode ficar num disco temporário. Em serviços com volumes, montar um volume em `/app/data` e usar `DATABASE_PATH=/app/data/game.db`.

O fecho automático por quilometragem deve ser testado com uma fonte em direto antes de ser ativado oficialmente. A hora de segurança e o fecho manual continuam sempre disponíveis.
