'use strict';

const test = require('node:test');
const assert = require('node:assert');
const V = require('../shared/vision');
const Fog = require('../fog');

const scene = { width: 800, height: 400, gridSize: 40 };
const sp = Fog.spec(scene); // celdas de 10 px → 80 x 40
const env = (walls, over) => ({
  segs: V.blocking(walls), lights: [], grid: scene.gridSize, dark: false,
  bounds: { x0: 0, y0: 0, x1: scene.width, y1: scene.height }, ...over,
});
const viewer = (over) => ({ x: 200, y: 200, facing: 0, angle: 360, range: 0, darkvision: 0, truesight: 0, light: 0, ...over });
const at = (bits, x, y) => Fog.getBit(bits, Math.floor(y / sp.cell) * sp.cols + Math.floor(x / sp.cell));
const count = (bits) => bits.reduce((n, b) => n + b.toString(2).replace(/0/g, '').length, 0);

test('la rejilla es de un cuarto de casilla', () => {
  assert.deepEqual(sp, { cell: 10, cols: 80, rows: 40 });
});

test('lo visto respeta muros, cono y alcance', () => {
  const wall = [{ x1: 400, y1: 0, x2: 400, y2: 400, type: 'wall' }];
  const bits = Fog.seenBits(viewer({ angle: 180, range: 4 }), env(wall), sp, null);
  assert.equal(at(bits, 300, 200), 1, 'delante y cerca');
  assert.equal(at(bits, 100, 200), 0, 'a la espalda');
  assert.equal(at(bits, 385, 200), 0, 'fuera de alcance (4 casillas = 160 px)');
  assert.equal(at(bits, 500, 200), 0, 'tras el muro');
  const open = Fog.seenBits(viewer(), env(wall), sp, null);
  assert.equal(at(open, 100, 50), 1);
  assert.equal(at(open, 500, 200), 0, 'tras el muro aunque no haya límite de alcance');
});

test('a oscuras solo cuenta lo iluminado o al alcance de la visión nocturna', () => {
  const e = env([], { dark: true, lights: [{ x: 600, y: 200, r: 60 }] });
  const lit = Fog.litBits(e, sp);
  const bits = Fog.seenBits(viewer({ darkvision: 2 }), e, sp, lit);
  assert.equal(at(bits, 250, 200), 1, 'visión nocturna');
  assert.equal(at(bits, 400, 200), 0, 'oscuro');
  assert.equal(at(bits, 600, 210), 1, 'iluminado a lo lejos');
});

test('la memoria acumula y avisa solo cuando hay algo nuevo', () => {
  const a = Fog.seenBits(viewer({ range: 2 }), env([]), sp, null);
  const first = Fog.merge(undefined, a);
  assert.ok(first);
  assert.equal(Fog.merge(first, a), null, 'ver lo mismo no cambia nada');
  const b = Fog.seenBits(viewer({ x: 600, range: 2 }), env([]), sp, null);
  const second = Fog.merge(first, b);
  assert.ok(second && second !== first);
  const all = Buffer.from(second, 'base64');
  assert.equal(count(all), count(a) + count(b));
  assert.equal(at(all, 200, 200), 1);
  assert.equal(at(all, 600, 200), 1);
  assert.equal(at(all, 400, 200), 0);
  assert.equal(Fog.union([first, Fog.merge(undefined, b)], sp), second);
});
