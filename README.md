# Slingshot Salvage

A top-down orbital salvage game built with **TypeScript, Vite and HTML5 Canvas**, with no external assets: everything is drawn procedurally and all sound is synthesized with WebAudio.

You fly a small ship through a sector of planets. Salvage pods are already in orbit around them. Tether up to three, tow them to the drop zone, and keep your fuel, your hull and your cargo alive while mines, interceptors and pod-thieves try to stop you. Gravity is free; thrust isn't.

The look is a cyanotype blueprint: flat paper blue, thin ink lines, dashed construction geometry, two spot inks (gold = cargo, orange = hostile).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit + production bundle (~63 kB, 22 kB gzipped)
npm run typecheck
```

## Controls

| Key | Action |
| --- | --- |
| `A` `D` / `←` `→` | Rotate |
| `W` / `↑` | Thrust (uses fuel) |
| `Space` / `J` | Fire pulse bolt (bolts curve in gravity) |
| `Shift` / `K` | Burn: a short, powerful dash on a cooldown |
| `X` | Cut the tether (drops all towed pods) |
| `P` / `Esc` | Pause |
| `R` | Restart the contract |
| `F1` / `` ` `` | Debug and telemetry overlay |
| `M` | Mute |

## How to play

- **Read the map.** Dashed rings around a planet are lines of equal gravitational pull (`g=22`, `g=55`, `g=120`). The dotted line from your ship is your predicted drift path under gravity alone, with a tick every half second. An orange X marks a predicted crash.
- **Pods** orbit planets on circular orbits. Fly close and they tether on automatically (max 3). A tether is a spring: towed pods swing and tug, and every pod adds weight (thrust and burn are divided by 1 + 0.22 per towed pod).
- **Deliver** by bringing pods inside the gold drop zone. Each delivery refuels 18 and scores 100.
- **Dock** in the drop zone at low speed to refuel and repair.
- **Hull and crashes.** Touchdowns under 95 u/s are safe. Faster impacts hurt and stun you. Pods that hit a planet at over 260 u/s are destroyed.
- **Fuel.** At zero fuel you have 10 seconds to reach the drop zone before you are stranded.
- **Contract.** Each sector has a delivery quota (about 70% of its pods). If too many pods are lost for the quota to still be reachable, the contract fails. Clear five sectors to win.

### Hostiles

| Unit | Behaviour | Counter |
| --- | --- | --- |
| **Mine** | Drifts under gravity. When you come within range it arms, homes in slowly and detonates when the collapsing ring reaches its centre. The blast also destroys pods and damages other hostiles. | Shoot it from range, or burn out of the ring. |
| **Interceptor** | Keeps a standoff ring around your *predicted* position, then telegraphs: a dashed aim line while it tracks, a solid line when it locks, then a 3-bolt burst. | Move across the line after it locks. Bolts curve in gravity, so the lock is only approximately right. |
| **Leech** | Picks the nearest pod (towed pods count as harder) and carries it to the nearest world edge. Without pods it rams you. | Shoot it: killing it drops the pod. It also dies if it hits a planet hard. |

## Architecture

```
src/
  core/    math.ts           angle math, seeded Rng, intercept solver, segment-circle test
           Ecs.ts            small entity-component-system (sparse component stores, deferred destroy)
           StateMachine.ts   explicit FSM with an adjacency table; illegal requests are rejected and counted
           SpatialHash.ts    uniform-grid broadphase, allocation-free in steady state
           ObjectPool.ts     generic pool (bolts, particles)
           EventBus.ts       typed pub/sub
  sim/     config.ts         tuning (live-editable) and constants
           types.ts          components, events, input
           gravity.ts        softened inverse-square field, orbital speed, trajectory prediction
           Sector.ts         procedural sector layout (planets, beacon, orbiting pods, enemy counts)
           ai.ts             Interceptor / Mine / Leech behaviour
           World.ts          Sim: fixed-step systems, collisions, tether, rules, run flow
  render/  Renderer.ts, Fx.ts, Palette.ts
  audio/   SoundEngine.ts
  ui/      Input.ts, Hud.ts (HUD, minimap, menus), DebugOverlay.ts
  Game.ts  composition root, frame loop, screen flow
```

### Boundaries

`src/sim` and `src/core` contain no DOM, canvas or audio code. The sim advances by fixed ticks and reports everything through the typed `EventBus` (`SHOT`, `HIT`, `EXPLOSION`, `POD_GRAB`, `CRASH`, ...). The presentation layer reacts:

- `Fx` turns events into particles, floating text, screen-shake trauma and hit-stop requests.
- `SoundEngine` turns events into synthesized sound.
- The renderer only reads the sim, and interpolates between the previous and current tick.

### Loop

`Game.frame` clamps `dt` to 50 ms, feeds a 60 Hz accumulator, and caps catch-up at six steps (a stalled tab cannot cause a burst of simulation). Hit-stop freezes the accumulator for a few frames after heavy impacts. Rendering interpolates each entity between `px/py` and `x/y` using the leftover accumulator fraction.

### ECS

Entities are integers; components live in per-type stores; systems are methods that iterate stores. Destruction is deferred: `kill()` marks an entity and `flush()` removes it after all systems have run, so a system never sees a half-deleted world mid-tick. Entity ids are never reused within a sector, so stale references (a tether pointing at a destroyed pod) can only fail an `isLive` check and cannot alias a new entity.

Planets, the drop zone and the ship's rules are not entities. They are static data or a single instance, and forcing them into the ECS would only add indirection.

### Object pooling

Bolts reuse a pooled bundle of component objects (`Transform`, `Body`, `Life`, `BoltC`), and particles come from their own pool. The debug overlay shows free/allocated counts. A leak shows up as an ever-growing "allocated" number.

### Gravity

`accelAt` sums a softened inverse-square pull from every planet: `a = gm * d / (|d|² + ε²)^(3/2)`. Softening stops the singularity at the surface. The same function drives the ship, pods, enemies and (scaled) bolts, the trajectory prediction, the contour rings (`radiusForPull`, solved by bisection) and the circular-orbit speed used to launch pods into orbit when a sector is generated.

### State machines

| Machine | States |
| --- | --- |
| Ship | `Drift`, `Thrust`, `Burn`, `Stunned`, `Docked`, `Dead` |
| Interceptor | `Patrol`, `Hunt`, `Charge`, `Fire`, `Recover` |
| Leech | `Seek`, `Carry`, `Evade` |
| Mine | `Idle`, `Armed` |

Each machine declares its legal transitions in a table. `request()` refuses an illegal transition and increments a counter that the debug overlay shows.

Responsiveness aids on the ship: a 150 ms burn input buffer (a press just before the cooldown ends still fires) and a 100 ms fire buffer.

### Tether physics

Each towed pod is joined to the one ahead of it (or to the ship) by a damped spring that only pulls when stretched past its rest length: `F = max(0, k·stretch + c·relativeSpeed)`. The reaction is applied to the other end, so a pod you are dragging also drags you.

### Enemy AI

- **Interceptor** steers toward a point on a ring around the ship's *predicted* position (with a slow lateral sway so it strafes), is thruster-limited (`steer` clamps acceleration), and avoids planet wells. Its aim solves the quadratic intercept equation against your current velocity, then locks for the final 220 ms of the charge so you have a window to dodge. Bolts are affected by gravity, so even a perfect lock is slightly wrong.
- **Leech** scores candidate pods by distance (towed pods are discounted by 1.4x) and falls back to the ship. It carries a pod rigidly and flees to the nearest edge.
- **Mine** is the simplest: proximity arms it, a visible fuse counts down.

### Procedural generation

`generateSector(n, seed)` is deterministic. Planets are rejection-sampled with a minimum gap, the drop zone is placed outside every well, and each pod is placed at 1.9-2.9 planet radii on a circular orbit, so the player has to catch moving cargo.

## Debug overlay (F1)

- FPS, frame time, sim step time and steps per frame.
- Entity count, bolt and particle pool free/allocated, spatial hash cell count.
- Ship FSM state, time in state, recent history, rejected-transition count.
- Each enemy's current FSM state and decision note.
- Toggles: hitboxes (colliders, planet radii, delivery radius), velocity vectors, broadphase grid, FSM labels over entities.
- Live sliders write directly into `Tuning`: gravity, thrust, turn rate, drag, burn impulse, fire cooldown, enemy rate, fuel use.
- Buttons to spawn a mine, interceptor or leech, refuel, and reset tuning.

## Verification

- `tsc --noEmit` (strict, no unused locals/params) and `vite build` pass.
- Checked against the real simulation in the browser:
  - Same seed gives the same outcome (a scripted bot is run twice).
  - FSM guards: legal and illegal transitions, `Dead` is terminal.
  - Tether grab, spring follow, cut, regrab cooldown, delivery.
  - Fast planet impact damages and stuns; slow touchdown is safe.
  - Mine blast destroys nearby cargo.
  - Interceptor cycles Hunt, Charge, Fire, Recover and fires three-bolt bursts.
  - Leech steals a pod; killing it frees the pod.
  - Burn impulse, cooldown, input buffer; fire rate limiting.
  - Screen flow: title, pause, sector advance, victory, contract failure, stranded, restart.
  - Restart leaves listener count and pool allocation unchanged.
- **Not covered:** the tests exercise the sim in fixed steps, so feel (thrust, turn rate, burn, difficulty, fuel pressure) is not covered by them. A simple scripted bot clears some seeds of sector 1 and fails others, which says more about the bot than the game. Sectors 2 to 5 were checked for state flow, not difficulty. There is no touch or gamepad support and no save data.
