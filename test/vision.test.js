'use strict';

const test = require('node:test');
const assert = require('node:assert');
const V = require('../shared/vision');

const GRID = 50;
const wall = (x1, y1, x2, y2, extra) => ({ x1, y1, x2, y2, type: 'wall', ...extra });
const viewer = (over) => ({ x: 100, y: 100, facing: 0, angle: 360, range: 0, darkvision: 0, truesight: 0, light: 0, ...over });
const env = (walls, over) => ({ segs: V.blocking(walls), lights: [], grid: GRID, dark: false, ...over });

test('una pared bloquea la línea de visión', () => {
  const walls = [wall(200, 0, 200, 200)];
  assert.equal(V.pointVisible(viewer(), 300, 100, env(walls)), false);
  assert.equal(V.pointVisible(viewer(), 150, 100, env(walls)), true);
});

test('una puerta cerrada bloquea y abierta no', () => {
  const door = { ...wall(200, 0, 200, 200), type: 'door', open: false };
  assert.equal(V.pointVisible(viewer(), 300, 100, env([door])), false);
  door.open = true;
  assert.equal(V.pointVisible(viewer(), 300, 100, env([door])), true);
});

test('el alcance limita la visión con luz', () => {
  const v = viewer({ range: 4 }); // 200 px
  assert.equal(V.pointVisible(v, 290, 100, env([])), true);
  assert.equal(V.pointVisible(v, 310, 100, env([])), false);
});

test('el cono de visión depende de la orientación', () => {
  const v = viewer({ angle: 90, facing: 0 });
  assert.equal(V.pointVisible(v, 300, 100, env([])), true);
  assert.equal(V.pointVisible(v, 300, 250, env([])), true); // ~37º
  assert.equal(V.pointVisible(v, 100, 300, env([])), false); // 90º
  assert.equal(V.pointVisible(v, 0, 100, env([])), false); // detrás
  const back = viewer({ angle: 90, facing: Math.PI });
  assert.equal(V.pointVisible(back, 0, 100, env([])), true);
});

test('a oscuras solo se ve con visión nocturna o si el punto está iluminado', () => {
  const dark = env([], { dark: true });
  assert.equal(V.pointVisible(viewer(), 200, 100, dark), false);
  assert.equal(V.pointVisible(viewer({ darkvision: 3 }), 200, 100, dark), true);
  assert.equal(V.pointVisible(viewer({ darkvision: 3 }), 300, 100, dark), false);
  const lit = env([], { dark: true, lights: [{ x: 400, y: 100, r: 100 }] });
  assert.equal(V.pointVisible(viewer(), 350, 100, lit), true);
  assert.equal(V.pointVisible(viewer(), 200, 100, lit), false);
});

test('una luz no ilumina a través de una pared', () => {
  const walls = [wall(380, 0, 380, 90)];
  const e = env(walls, { dark: true, lights: [{ x: 400, y: 50, r: 100 }] });
  // El observador ve el punto (360,60) en línea recta, pero la luz queda tras la pared.
  assert.equal(V.pointVisible(viewer(), 360, 60, e), false);
  assert.equal(V.pointVisible(viewer(), 420, 100, e), true);
});

test('lo invisible solo se ve con visión verdadera', () => {
  const npc = { x: 200, y: 100, size: 1, invisible: true };
  assert.equal(V.tokenVisible(viewer(), npc, env([])), false);
  assert.equal(V.tokenVisible(viewer({ truesight: 3 }), npc, env([])), true);
  assert.equal(V.tokenVisible(viewer({ truesight: 1 }), npc, env([])), false);
});

test('una ficha oculta por el máster no la ve nadie', () => {
  const npc = { x: 150, y: 100, size: 1, hidden: true };
  assert.equal(V.tokenVisible(viewer({ truesight: 10 }), npc, env([])), false);
});

test('una ficha asomando tras una esquina se ve; pegada al otro lado de un muro no', () => {
  // Muro vertical en x=200 de y=0 a y=100. Ficha con el centro tapado pero el borde asomando.
  const corner = [wall(200, 0, 200, 100)];
  const peeking = { x: 230, y: 105, size: 1 };
  assert.equal(V.pointVisible(viewer({ y: 50 }), peeking.x, peeking.y, env(corner)), false);
  assert.equal(V.tokenVisible(viewer({ y: 50 }), peeking, env(corner)), true);

  // Muro largo; ficha pegada al muro por el otro lado: su borde cruza el muro pero no debe contar.
  const long = [wall(200, -1000, 200, 1000)];
  const hugging = { x: 205, y: 100, size: 1 };
  assert.equal(V.tokenVisible(viewer(), hugging, env(long)), false);
});

test('el polígono de visibilidad excluye lo que hay tras una pared', () => {
  const walls = [wall(200, 50, 200, 150)];
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 200 };
  const poly = V.visibilityPolygon(100, 100, V.blocking(walls), bounds);
  assert.ok(poly.length >= 6);
  assert.equal(V.pointInPolygon(150, 100, poly), true);
  assert.equal(V.pointInPolygon(300, 100, poly), false); // sombra de la pared
  assert.equal(V.pointInPolygon(210, 10, poly), true); // por encima de la pared
  assert.equal(V.pointInPolygon(20, 180, poly), true);
});

test('el polígono coincide con pointVisible en puntos al azar (paredes cruzadas incluidas)', () => {
  const walls = [wall(150, 20, 350, 180), wall(150, 180, 350, 20), wall(60, 140, 140, 140), wall(300, 100, 390, 100)];
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 200 };
  const segs = V.blocking(walls);
  const v = viewer({ x: 80, y: 60 });
  const poly = V.visibilityPolygon(v.x, v.y, segs, bounds);
  let seed = 7, mismatches = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const px = rnd() * 400, py = rnd() * 200;
    // Se descartan puntos pegados a una pared, donde ambos métodos pueden diferir por redondeo.
    if (segs.some((s) => V.distPointSeg(px, py, s) < 1.5)) continue;
    if (V.pointInPolygon(px, py, poly) !== V.pointVisible(v, px, py, env(walls))) mismatches++;
  }
  assert.equal(mismatches, 0);
});
