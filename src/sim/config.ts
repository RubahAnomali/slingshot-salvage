export const STEP = 1 / 60;
export const WORLD_W = 2800;
export const WORLD_H = 1800;

/** Live-tunable values. The F1 overlay edits this object directly. */
export const Tuning = {
  gravity: 1,
  thrust: 300,
  turnRate: 4.2,
  drag: 0.06,
  burnImpulse: 360,
  fireCooldown: 0.17,
  enemyRate: 1,
  fuelUse: 5,
};

export interface TuningMeta {
  key: keyof typeof Tuning;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const TUNING_META: readonly TuningMeta[] = [
  { key: 'gravity', label: 'gravity', min: 0, max: 2.5, step: 0.05 },
  { key: 'thrust', label: 'thrust', min: 100, max: 600, step: 10 },
  { key: 'turnRate', label: 'turn rate', min: 1, max: 8, step: 0.1 },
  { key: 'drag', label: 'drag', min: 0, max: 0.6, step: 0.01 },
  { key: 'burnImpulse', label: 'burn impulse', min: 100, max: 800, step: 10 },
  { key: 'fireCooldown', label: 'fire cooldown', min: 0.05, max: 0.6, step: 0.01 },
  { key: 'enemyRate', label: 'enemy rate', min: 0, max: 3, step: 0.1 },
  { key: 'fuelUse', label: 'fuel use /s', min: 0, max: 30, step: 0.5 },
];

export const DEFAULT_TUNING = { ...Tuning };

/** Gravitational constant: surface-ish pull scales with planet radius squared. */
export const GRAVITY_K = 520;

export const SHIP = {
  radius: 13,
  hull: 100,
  fuel: 100,
  burnCost: 12,
  burnTime: 0.22,
  burnCooldown: 1.1,
  stunTime: 0.35,
  invuln: 1.0,
  safeImpact: 95,
  maxTow: 3,
  towRest: 34,
  towStiffness: 90,
  towDamping: 6,
  grabRadius: 30,
  dockSpeed: 110,
  dockFuelRate: 28,
  dockRepairRate: 7,
  boltSpeed: 560,
  boltLife: 1.05,
  boltDamage: 1,
};

export const POD = { radius: 11, mass: 0.5, crashSpeed: 260, deliverFuel: 18 };

export const MINE = { radius: 15, trigger: 200, fuse: 1.0, blast: 125, damage: 34, homing: 55, maxSpeed: 120 };

export const INTERCEPTOR = {
  radius: 14,
  hp: 3,
  maxSpeed: 230,
  accel: 240,
  standoff: 330,
  huntRange: 820,
  loseRange: 1050,
  fireRange: 560,
  charge: 0.8,
  lockTime: 0.22,
  burst: 3,
  burstGap: 0.11,
  recover: 1.1,
  cooldown: 1.6,
  boltSpeed: 400,
  boltLife: 1.9,
  boltDamage: 11,
};

export const LEECH = { radius: 12, hp: 2, maxSpeed: 270, accel: 330, fleeSpeed: 300, ramDamage: 8, evade: 1.6 };

export const GRAVITY_ON_BOLT = 0.55;
export const MAX_SECTOR = 5;
