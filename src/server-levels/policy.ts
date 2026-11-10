export const SERVER_LEVEL_XP_UNITS_PER_XP = 60;
export const SERVER_LEVEL_SCORING_POLICY_VERSION = 1;
export const SERVER_LEVEL_MAX_CONTINUOUS_SECONDS = 12 * 60 * 60;
export const SERVER_LEVEL_ROLLING_WINDOW_SECONDS = 24 * 60 * 60;
export const SERVER_LEVEL_ROLLING_CAP_SECONDS = 12 * 60 * 60;
export const SERVER_LEVEL_ORDERING_WINDOW_MS = 10 * 60 * 1_000;
export const SERVER_LEVEL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1_000;

export type ServerLevelMultiplier = 1 | 2 | 3 | 4;

export interface ServerLevelOccupancyFact {
  population: number;
  maxSlots: number;
  queueSize: number;
}

export interface ServerLevelProgress {
  level: number;
  totalXpUnits: number;
  currentLevelXpUnits: number;
  nextLevelXpUnits: number;
  progressXpUnits: number;
  requiredXpUnits: number;
}

export function resolveOccupancyMultiplier(
  fact: ServerLevelOccupancyFact,
): ServerLevelMultiplier | null {
  if (
    !Number.isSafeInteger(fact.population) ||
    !Number.isSafeInteger(fact.maxSlots) ||
    !Number.isSafeInteger(fact.queueSize) ||
    fact.population <= 0 ||
    fact.maxSlots <= 0 ||
    fact.queueSize < 0
  ) {
    return null;
  }
  if (fact.queueSize > 0) return 1;
  if (fact.population * 4 <= fact.maxSlots) return 4;
  if (fact.population * 2 <= fact.maxSlots) return 3;
  if (fact.population * 4 <= fact.maxSlots * 3) return 2;
  return 1;
}

export function calculateServerXpUnits(
  qualifyingSeconds: number,
  multiplier: ServerLevelMultiplier,
): number {
  if (!Number.isSafeInteger(qualifyingSeconds) || qualifyingSeconds < 0) {
    throw new Error("Qualifying duration must be a non-negative whole number of seconds.");
  }
  const units = qualifyingSeconds * multiplier;
  if (!Number.isSafeInteger(units)) throw new Error("Server XP interval exceeds safe precision.");
  return units;
}

export function serverLevelThresholdXpUnits(level: number): number {
  if (!Number.isSafeInteger(level) || level < 1) {
    throw new Error("Server Level must be a positive whole number.");
  }
  const offset = level - 1;
  const units = 100 * offset * offset * SERVER_LEVEL_XP_UNITS_PER_XP;
  if (!Number.isSafeInteger(units))
    throw new Error("Server Level threshold exceeds safe precision.");
  return units;
}

export function calculateServerLevel(totalXpUnits: number): number {
  if (!Number.isSafeInteger(totalXpUnits) || totalXpUnits < 0) {
    throw new Error("Server XP total must be a non-negative fixed-point integer.");
  }
  return Math.floor(Math.sqrt(totalXpUnits / (100 * SERVER_LEVEL_XP_UNITS_PER_XP))) + 1;
}

export function calculateServerLevelProgress(totalXpUnits: number): ServerLevelProgress {
  const level = calculateServerLevel(totalXpUnits);
  const currentLevelXpUnits = serverLevelThresholdXpUnits(level);
  const nextLevelXpUnits = serverLevelThresholdXpUnits(level + 1);
  return {
    level,
    totalXpUnits,
    currentLevelXpUnits,
    nextLevelXpUnits,
    progressXpUnits: totalXpUnits - currentLevelXpUnits,
    requiredXpUnits: nextLevelXpUnits - currentLevelXpUnits,
  };
}
