import type { Entity } from '../core/Ecs';
import type { StateMachine } from '../core/StateMachine';

export type Kind = 'ship' | 'pod' | 'mine' | 'interceptor' | 'leech' | 'pbolt' | 'ebolt';

export type ShipState = 'Drift' | 'Thrust' | 'Burn' | 'Stunned' | 'Docked' | 'Dead';
export type InterceptorState = 'Patrol' | 'Hunt' | 'Charge' | 'Fire' | 'Recover';
export type LeechState = 'Seek' | 'Carry' | 'Evade';
export type MineState = 'Idle' | 'Armed';

export interface Transform {
  x: number;
  y: number;
  /** Previous-tick position/angle, for render interpolation. */
  px: number;
  py: number;
  a: number;
  pa: number;
}

export interface Body {
  vx: number;
  vy: number;
  mass: number;
  radius: number;
  /** Linear drag coefficient per second. */
  drag: number;
  /** Multiplier on planetary gravity (0 = unaffected). */
  gravity: number;
}

export interface Health {
  hp: number;
  max: number;
  /** Seconds of white flash left. */
  flash: number;
}

export interface Life {
  t: number;
}

export interface Planet {
  x: number;
  y: number;
  r: number;
  gm: number;
  name: string;
}

export interface Beacon {
  x: number;
  y: number;
  r: number;
}

export type PodMode = 'free' | 'towed' | 'carried';

export interface PodC {
  mode: PodMode;
  /** What this pod is tied to (ship or the pod ahead of it) while towed; the leech while carried. */
  link: Entity;
  grabCd: number;
}

export interface BoltC {
  damage: number;
  hostile: boolean;
}

export interface Brain {
  fsm: StateMachine<string>;
  /** General purpose timers. Meaning depends on archetype and is documented there. */
  t1: number;
  t2: number;
  burstLeft: number;
  aimX: number;
  aimY: number;
  lockedA: number;
  waypointX: number;
  waypointY: number;
  target: Entity;
  /** Last utility/steering note, shown in the debug overlay. */
  note: string;
}

export interface MineC {
  fuse: number;
  warned: boolean;
}

export interface ShipC {
  fsm: StateMachine<ShipState>;
  hull: number;
  fuel: number;
  av: number;
  fireCd: number;
  burnCd: number;
  burnLeft: number;
  /** Input buffers: seconds a press stays valid. */
  burnBuf: number;
  fireBuf: number;
  stun: number;
  invuln: number;
  strand: number;
  towCount: number;
  thrusting: boolean;
}

export interface InputState {
  left: boolean;
  right: boolean;
  thrust: boolean;
  fire: boolean;
  /** Edge-triggered: set by the input layer on key-down, cleared after one sim tick. */
  burnPressed: boolean;
  releasePressed: boolean;
}

export type GameOverReason = 'hull' | 'stranded' | 'contract';

export interface Stats {
  sectors: number;
  podsDelivered: number;
  podsLost: number;
  kills: number;
  shotsFired: number;
  shotsHit: number;
  crashes: number;
  damageTaken: number;
  fuelBurned: number;
  time: number;
  score: number;
}

export interface SimEvents {
  SECTOR_START: { sector: number };
  SHOT: { x: number; y: number; a: number; hostile: boolean };
  HIT: { x: number; y: number; dmg: number; kind: Kind };
  IMPACT: { x: number; y: number };
  EXPLOSION: { x: number; y: number; r: number };
  POD_GRAB: { x: number; y: number };
  POD_RELEASE: { x: number; y: number };
  POD_DELIVER: { x: number; y: number; total: number };
  POD_LOST: { x: number; y: number; why: 'crash' | 'stolen' | 'blast' };
  CRASH: { x: number; y: number; speed: number; damage: number };
  BURN: { x: number; y: number; a: number };
  THRUST: { on: boolean };
  ENEMY_DOWN: { kind: Kind; x: number; y: number };
  WARN: { kind: Kind; x: number; y: number };
  DOCK: { on: boolean };
  LOW_FUEL: Record<string, never>;
  SECTOR_CLEAR: { sector: number };
  GAME_OVER: { reason: GameOverReason };
  VICTORY: Record<string, never>;
}
