'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Uvtt = require('../shared/uvtt');

const sample = () => ({
  format: 0.3,
  resolution: { map_origin: { x: 2, y: 1 }, map_size: { x: 20, y: 10 }, pixels_per_grid: 50 },
  line_of_sight: [
    [{ x: 2, y: 1 }, { x: 12, y: 1 }, { x: 12, y: 6 }],
    [{ x: 4, y: 4 }, { x: 5, y: 4.001 }, { x: 6, y: 4 }], // el vértice central sobra
  ],
  objects_line_of_sight: [[{ x: 15, y: 3 }, { x: 16, y: 3 }, { x: 16, y: 4 }, { x: 15, y: 4 }, { x: 15, y: 3 }]],
  portals: [
    { position: { x: 12, y: 7 }, bounds: [{ x: 12, y: 6 }, { x: 12, y: 8 }], rotation: 1.57, closed: true, freestanding: false },
    { position: { x: 7, y: 1 }, bounds: [{ x: 6.5, y: 1 }, { x: 7.5, y: 1 }], rotation: 0, closed: false, freestanding: false },
  ],
  lights: [{ position: { x: 5, y: 5 }, range: 4, intensity: 1, color: 'ffeccd8b', shadows: true }, { position: { x: 9, y: 9 }, range: 0 }],
  environment: { baked_lighting: true, ambient_light: 'ffffffff' },
  image: '',
});

test('convierte casillas a píxeles restando el origen', () => {
  const r = Uvtt.parse(sample());
  assert.equal(r.width, 1000);
  assert.equal(r.height, 500);
  assert.equal(r.gridSize, 50);
  assert.deepEqual(r.walls[0], [0, 0, 500, 0]);
  assert.deepEqual(r.walls[1], [500, 0, 500, 250]);
});

test('simplifica vértices innecesarios y trae los objetos', () => {
  const r = Uvtt.parse(sample());
  assert.deepEqual(r.walls[2], [100, 150, 200, 150]);
  assert.equal(r.walls.length, 2 + 1 + 4);
});

test('puertas: closed:false entra como puerta abierta', () => {
  const r = Uvtt.parse(sample());
  assert.deepEqual(r.doors, [[500, 250, 500, 350, false], [225, 0, 275, 0, true]]);
});

test('luces con su alcance en casillas; las de alcance 0 se descartan', () => {
  assert.deepEqual(Uvtt.parse(sample()).lights, [[150, 200, 4]]);
});

test('una luz ambiente oscura deja la escena a oscuras', () => {
  const d = sample();
  assert.equal(Uvtt.parse(d).dark, false);
  d.environment.ambient_light = 'ff101018';
  assert.equal(Uvtt.parse(d).dark, true);
});

test('si la imagen mide otra cosa, las coordenadas se escalan a la imagen', () => {
  const r = Uvtt.parse(sample(), 2000, 1000);
  assert.equal(r.gridSize, 100);
  assert.deepEqual(r.walls[0], [0, 0, 1000, 0]);
});

test('rechaza archivos que no son Universal VTT y detecta el tipo de imagen', () => {
  assert.throws(() => Uvtt.parse({ foo: 1 }));
  assert.equal(Uvtt.imageMime('iVBORw0KGgo'), 'image/png');
  assert.equal(Uvtt.imageMime('/9j/4AAQ'), 'image/jpeg');
  assert.equal(Uvtt.imageMime('UklGRh4A'), 'image/webp');
});
