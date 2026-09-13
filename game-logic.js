export const WIN_BONUSES = Object.freeze({ 1: -200, 2: -100, 3: -50 });

export function scorePick(slot, finishPosition) {
  const position = Number(finishPosition);
  if (![1, 2, 3].includes(Number(slot))) throw new Error("Posição da aposta inválida.");
  if (!Number.isInteger(position) || position < 1) throw new Error("Resultado inválido.");
  return position === 1 ? WIN_BONUSES[slot] : position;
}

export function calculateLives(scores) {
  const ordered = [...scores].sort((a, b) => b - a);
  const excluded = ordered.slice(0, 2);
  return {
    total: scores.reduce((sum, score) => sum + score, 0) - excluded.reduce((sum, score) => sum + score, 0),
    life1: excluded[0] ?? null,
    life2: excluded[1] ?? null,
  };
}

export function missingPlayerSelections(resultsByRider) {
  const ranked = [...resultsByRider.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (ranked.length < 3) throw new Error("São necessários três ciclistas escolhidos diferentes para atribuir uma falta de aposta.");
  return ranked.map(([riderId], index) => ({ riderId, slot: index + 1 }));
}
