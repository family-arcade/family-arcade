/**
 * A solo round plays exactly as it always has. Seeded rounds with a child
 * steering a slow circle, stepped at a fixed 1/60 s, must end exactly where
 * these fingerprints say. Each was taken from the rules as they stood before
 * a round could hold several children. A change that moves any of them
 * changes how a solo round plays: the change is wrong, not the fingerprint.
 */
import { describe, expect, it } from 'vitest';
import { MAPS, type MapId } from './city';
import { grow, round } from './testing';
import { stepWorld, type Options, type World } from './world';

/** The child steers a slow circle, once round about every 21 seconds. */
const circle = (i: number) => ({ x: Math.cos(i / 200), z: Math.sin(i / 200) });
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function fingerprint(w: World, events: Record<string, number>) {
  return {
    status: w.status,
    elapsed: r3(w.elapsed),
    holes: w.holes.map((h) => ({ x: r3(h.x), z: r3(h.z), r: r3(h.r), score: h.score, lives: h.lives })),
    props: w.props.size,
    people: w.people.filter((p) => p.alive).length,
    police: w.responders.length,
    attacks: w.attacks.length,
    powerups: w.powerups.length,
    events,
  };
}

/** A seeded solo round with power-ups on, the child `size` big at the start (see `grow`). */
function solo(seed: number, map: MapId, seconds: number, opts: Partial<Options>, size = 0) {
  const w = round(seed, MAPS[map].rivals, { map, powerups: true, ...opts });
  if (size) grow(w, 0, size);
  const events: Record<string, number> = {};
  for (let i = 0; i < seconds * 60; i++) {
    for (const e of stepWorld(w, 1 / 60, circle(i))) events[e.type] = (events[e.type] ?? 0) + 1;
  }
  return fingerprint(w, events);
}

describe('solo rounds play exactly as before', () => {
  it('Town on Easy, 40 seconds', () => {
    expect(solo(7, 'town', 40, { difficulty: 'easy' })).toEqual({
      status: 'playing',
      elapsed: 40,
      holes: [
        { x: 119.52, z: 107.696, r: 3.723, score: 143, lives: Infinity },
        { x: -153.576, z: -118.837, r: 3.421, score: 146, lives: Infinity },
        { x: -110.184, z: 18.181, r: 3.516, score: 145, lives: Infinity },
        { x: -162.015, z: 127.575, r: 3.378, score: 120, lives: Infinity },
        { x: -64.58, z: 100.368, r: 3.524, score: 140, lives: Infinity },
      ],
      props: 2727,
      people: 205,
      police: 3,
      attacks: 0,
      powerups: 1,
      events: { eat: 220, level: 10, food: 7, regrow: 69, power: 1, combo: 10, police: 1, park: 1 },
    });
  });

  it('City on Medium with the city fighting back, 60 seconds', () => {
    expect(solo(8, 'city', 60, { difficulty: 'medium', fightBack: true })).toEqual({
      status: 'playing',
      elapsed: 60,
      holes: [
        { x: 86.365, z: 17.007, r: 3.737, score: 146, lives: 5 },
        { x: -44.703, z: -231.513, r: 3.99, score: 244, lives: 5 },
        { x: 124.59, z: 45.364, r: 3.913, score: 283, lives: 5 },
        { x: 58.03, z: 3.848, r: 4.273, score: 406, lives: 5 },
        { x: 199.098, z: 92.545, r: 3.985, score: 327, lives: 5 },
        { x: -62.148, z: -194.747, r: 4.051, score: 280, lives: 5 },
      ],
      props: 4642,
      people: 303,
      police: 0,
      attacks: 1,
      powerups: 1,
      events: { eat: 430, level: 16, food: 15, combo: 25, regrow: 132, incoming: 2, police: 1, hurt: 1, boom: 1, park: 2, power: 1 },
    });
  });

  it('Megalopolis on Hard, 60 seconds', () => {
    expect(solo(9, 'mega', 60, { difficulty: 'hard' })).toEqual({
      status: 'playing',
      elapsed: 60,
      holes: [
        { x: -130.725, z: 28.508, r: 2.974, score: 46, lives: 3 },
        { x: -111.151, z: -246.235, r: 4.909, score: 785, lives: 3 },
        { x: -73.02, z: 188.76, r: 4.389, score: 487, lives: 3 },
        { x: 79.682, z: -99.961, r: 4.48, score: 442, lives: 3 },
        { x: -81.417, z: 211.417, r: 4.546, score: 492, lives: 3 },
        { x: -64.976, z: -151.745, r: 4.636, score: 605, lives: 3 },
        { x: 125.185, z: -168.428, r: 4.633, score: 681, lives: 3 },
      ],
      props: 7516,
      people: 425,
      police: 2,
      attacks: 0,
      powerups: 1,
      events: { eat: 529, level: 26, food: 28, combo: 37, regrow: 130, rebuild: 8, police: 1 },
    });
  });

  it('Region on Medium, the child starting big enough to eat buildings, with the army, 60 seconds', () => {
    expect(solo(10, 'region', 60, { difficulty: 'medium', fightBack: true }, 1500)).toEqual({
      status: 'playing',
      elapsed: 60,
      holes: [
        { x: 45.946, z: 12.626, r: 14.793, score: 10639, lives: 5 },
        { x: 15.812, z: 166.686, r: 4.027, score: 287, lives: 5 },
        { x: 77.056, z: 43.009, r: 3.8, score: 239, lives: 5 },
        { x: -115.802, z: 87.247, r: 4.777, score: 933, lives: 5 },
        { x: -206.398, z: -52.798, r: 4.564, score: 1156, lives: 5 },
        { x: 268.486, z: 9.267, r: 4.197, score: 295, lives: 5 },
        { x: 34.758, z: -66.48, r: 3.818, score: 309, lives: 5 },
        { x: 210.469, z: 21.43, r: 4.536, score: 474, lives: 5 },
        { x: -78.414, z: -116.742, r: 4.064, score: 562, lives: 5 },
      ],
      props: 9139,
      people: 436,
      police: 0,
      attacks: 2,
      powerups: 1,
      events: { eat: 1132, combo: 60, food: 38, level: 26, regrow: 132, rebuild: 46, incoming: 2, boom: 7, power: 1 },
    });
  });
});
