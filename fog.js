'use strict';

/*
 * Memoria de lo explorado.
 *
 * Por cada jugador y escena se guarda un mapa de bits de baja resolución con las
 * zonas que su personaje ha llegado a ver. Lo calcula el servidor (no el móvil)
 * para que sobreviva a recargas, cambios de dispositivo y cortes de la sesión.
 */

const Vision = require('./shared/vision');

/** Rejilla de la memoria: un cuarto de casilla por celda, con tope de 512 celdas por lado. */
function spec(scene) {
  const cell = Math.max(scene.gridSize / 4, Math.max(scene.width, scene.height) / 512);
  return { cell, cols: Math.max(1, Math.ceil(scene.width / cell)), rows: Math.max(1, Math.ceil(scene.height / cell)) };
}

const specKey = (sp) => `${sp.cols}x${sp.rows}x${sp.cell.toFixed(3)}`;
const newBits = (sp) => new Uint8Array(Math.ceil((sp.cols * sp.rows) / 8));
const setBit = (bits, idx) => { bits[idx >> 3] |= 1 << (idx & 7); };
const getBit = (bits, idx) => (bits[idx >> 3] >> (idx & 7)) & 1;

/** Llama a fn(idx, cx, cy) por cada celda cuyo centro cae dentro del polígono. */
function fillPolygon(poly, sp, fn) {
  if (poly.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const j0 = Math.max(0, Math.ceil(minY / sp.cell - 0.5));
  const j1 = Math.min(sp.rows - 1, Math.floor(maxY / sp.cell - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const cy = (j + 0.5) * sp.cell;
    xs.length = 0;
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
      const a = poly[k], b = poly[m];
      if ((a.y > cy) !== (b.y > cy)) xs.push(a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / sp.cell - 0.5));
      const i1 = Math.min(sp.cols - 1, Math.floor(xs[k + 1] / sp.cell - 0.5));
      for (let i = i0; i <= i1; i++) fn(j * sp.cols + i, (i + 0.5) * sp.cell, cy);
    }
  }
}

/** Celdas iluminadas por alguna luz (solo hace falta en escenas a oscuras). */
function litBits(env, sp) {
  const bits = newBits(sp);
  for (const L of env.lights) {
    const poly = Vision.visibilityPolygon(L.x, L.y, env.segs, env.bounds, L.r);
    fillPolygon(poly, sp, (idx, cx, cy) => {
      if (Math.hypot(cx - L.x, cy - L.y) <= L.r) setBit(bits, idx);
    });
  }
  return bits;
}

/** Celdas que el observador v ve ahora mismo. lit: resultado de litBits() o null si hay luz. */
function seenBits(v, env, sp, lit) {
  const bits = newBits(sp);
  const g = env.grid;
  const range = (v.range || 0) * g;
  const reach = Math.max(range, (v.truesight || 0) * g, env.dark ? (v.darkvision || 0) * g : 0);
  const poly = Vision.visibilityPolygon(v.x, v.y, env.segs, env.bounds, range > 0 ? reach : Infinity);
  fillPolygon(poly, sp, (idx, cx, cy) => {
    if (Vision.withinSight(v, cx, cy, g, env.dark, () => !!lit && getBit(lit, idx) === 1, false)) setBit(bits, idx);
  });
  // La casilla que pisa siempre la conoce.
  const i = Math.floor(v.x / sp.cell), j = Math.floor(v.y / sp.cell);
  if (i >= 0 && i < sp.cols && j >= 0 && j < sp.rows) setBit(bits, j * sp.cols + i);
  return bits;
}

/** Añade `bits` a la memoria guardada en base64. Devuelve la nueva cadena, o null si no cambia nada. */
function merge(b64, bits) {
  const old = b64 ? Buffer.from(b64, 'base64') : null;
  if (!old || old.length !== bits.length) return Buffer.from(bits).toString('base64');
  let changed = false;
  for (let k = 0; k < bits.length; k++) {
    const v = old[k] | bits[k];
    if (v !== old[k]) {
      old[k] = v;
      changed = true;
    }
  }
  return changed ? old.toString('base64') : null;
}

/** Une varias memorias (para la pantalla de party). */
function union(list, sp) {
  const out = Buffer.alloc(Math.ceil((sp.cols * sp.rows) / 8));
  for (const b64 of list) {
    if (!b64) continue;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== out.length) continue;
    for (let k = 0; k < out.length; k++) out[k] |= buf[k];
  }
  return out.toString('base64');
}

module.exports = { spec, specKey, litBits, seenBits, merge, union, getBit };
