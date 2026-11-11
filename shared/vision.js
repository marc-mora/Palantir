/*
 * Motor de visión compartido entre servidor (Node) y navegador.
 *
 * - visibilityPolygon(): polígono de línea de visión desde un punto, dadas unas paredes.
 * - pointVisible()/tokenVisible(): ¿puede un observador ver un punto / una ficha?
 *
 * Unidades: las posiciones están en píxeles del mapa. Los alcances de las fichas
 * (range, darkvision, truesight, light) están en casillas y se multiplican por env.grid.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Vision = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;

  /** Paredes que bloquean la vista: muros y puertas cerradas. Las ventanas dejan ver. */
  function blocking(walls) {
    return walls.filter((w) => w.type === 'wall' || (w.type === 'door' && !w.open));
  }

  /** Paredes que impiden el paso: todo menos las puertas abiertas (las ventanas también frenan). */
  function blockingMove(walls) {
    return walls.filter((w) => !(w.type === 'door' && w.open));
  }

  /** Fracción (0..1] del trayecto A→B en la que se choca con la primera pared; 1 si no hay ninguna. */
  function firstHit(ax, ay, bx, by, segs) {
    const rx = bx - ax, ry = by - ay;
    let best = 1;
    for (let i = 0; i < segs.length; i++) {
      const w = segs[i];
      const sx = w.x2 - w.x1, sy = w.y2 - w.y1;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((w.x1 - ax) * sy - (w.y1 - ay) * sx) / den;
      if (t <= 1e-9 || t >= best) continue;
      const u = ((w.x1 - ax) * ry - (w.y1 - ay) * rx) / den;
      if (u >= 0 && u <= 1) best = t;
    }
    return best;
  }

  /** ¿El segmento A→B cruza la pared w? */
  function segHit(ax, ay, bx, by, w) {
    const rx = bx - ax, ry = by - ay;
    const sx = w.x2 - w.x1, sy = w.y2 - w.y1;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return false;
    const t = ((w.x1 - ax) * sy - (w.y1 - ay) * sx) / den;
    const u = ((w.x1 - ax) * ry - (w.y1 - ay) * rx) / den;
    return t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1;
  }

  /** Línea de visión despejada entre dos puntos. */
  function los(ax, ay, bx, by, segs) {
    for (let i = 0; i < segs.length; i++) if (segHit(ax, ay, bx, by, segs[i])) return false;
    return true;
  }

  function angleDiff(a, b) {
    let d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  function distPointSeg(px, py, s) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - s.x1) * dx + (py - s.y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (s.x1 + dx * t), py - (s.y1 + dy * t));
  }

  // Los cruces entre muros no dependen del observador: se calculan una vez por lista de muros.
  const crossCache = new WeakMap();
  function wallCrossings(segs) {
    let pts = crossCache.get(segs);
    if (pts) return pts;
    pts = [];
    const n = segs.length;
    for (let i = 0; i < n; i++) {
      const a = segs[i], adx = a.x2 - a.x1, ady = a.y2 - a.y1;
      for (let j = i + 1; j < n; j++) {
        const b = segs[j], bdx = b.x2 - b.x1, bdy = b.y2 - b.y1;
        const den = adx * bdy - ady * bdx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((b.x1 - a.x1) * bdy - (b.y1 - a.y1) * bdx) / den;
        if (t <= 0 || t >= 1) continue;
        const u = ((b.x1 - a.x1) * ady - (b.y1 - a.y1) * adx) / den;
        if (u > 0 && u < 1) pts.push(a.x1 + adx * t, a.y1 + ady * t);
      }
    }
    crossCache.set(segs, pts);
    return pts;
  }

  /**
   * Polígono de visibilidad desde (ox, oy).
   * segs: paredes que bloquean. bounds: {x0,y0,x1,y1} límites del mapa.
   * maxR: si es finito, solo se consideran paredes dentro de ese radio (optimización);
   *       el resultado debe recortarse después a un círculo de ese radio.
   */
  function visibilityPolygon(ox, oy, segs, bounds, maxR) {
    // La caja exterior es el mapa (ampliado si el observador está fuera de él).
    let x0 = Math.min(bounds.x0, ox - 10), y0 = Math.min(bounds.y0, oy - 10);
    let x1 = Math.max(bounds.x1, ox + 10), y1 = Math.max(bounds.y1, oy + 10);
    let list;
    if (maxR && isFinite(maxR)) {
      const m = maxR * 1.05 + 2;
      x0 = Math.max(x0, ox - m); y0 = Math.max(y0, oy - m);
      x1 = Math.min(x1, ox + m); y1 = Math.min(y1, oy + m);
      list = segs.filter((s) => distPointSeg(ox, oy, s) <= m);
    } else {
      list = segs.slice();
    }
    const nWalls = list.length;
    list.push(
      { x1: x0, y1: y0, x2: x1, y2: y0 },
      { x1: x1, y1: y0, x2: x1, y2: y1 },
      { x1: x1, y1: y1, x2: x0, y2: y1 },
      { x1: x0, y1: y1, x2: x0, y2: y0 }
    );

    const n = list.length;
    const S = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      S[i] = { x: s.x1, y: s.y1, dx: s.x2 - s.x1, dy: s.y2 - s.y1 };
    }

    // Puntos objetivo: extremos de pared, cruces entre paredes y cruces con la caja.
    const seen = new Set();
    const angles = [];
    const addPoint = (x, y) => {
      const k = Math.round(x * 4) + ',' + Math.round(y * 4);
      if (seen.has(k)) return;
      seen.add(k);
      const a = Math.atan2(y - oy, x - ox);
      angles.push(a - 1e-4, a, a + 1e-4);
    };
    for (let i = 0; i < n; i++) {
      addPoint(S[i].x, S[i].y);
      addPoint(S[i].x + S[i].dx, S[i].y + S[i].dy);
    }
    const cross = wallCrossings(segs);
    for (let k = 0; k < cross.length; k += 2) {
      const x = cross[k], y = cross[k + 1];
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) addPoint(x, y);
    }
    for (let i = 0; i < nWalls; i++) {
      const a = S[i];
      for (let j = nWalls; j < n; j++) {
        const b = S[j];
        const den = a.dx * b.dy - a.dy * b.dx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / den;
        const u = ((b.x - a.x) * a.dy - (b.y - a.y) * a.dx) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) addPoint(a.x + a.dx * t, a.y + a.dy * t);
      }
    }
    angles.sort((p, q) => p - q);

    // Cada pared se apunta en los sectores angulares que ocupa vista desde el observador,
    // de modo que cada rayo solo se prueba contra las paredes de su sector.
    const B = 256, K = B / TAU;
    const buckets = new Array(B);
    for (let b = 0; b < B; b++) buckets[b] = [];
    for (let i = 0; i < n; i++) {
      const s = S[i];
      const a1 = Math.atan2(s.y - oy, s.x - ox), a2 = Math.atan2(s.y + s.dy - oy, s.x + s.dx - ox);
      let d = a2 - a1;
      if (d > Math.PI) d -= TAU;
      else if (d < -Math.PI) d += TAU;
      const start = d >= 0 ? a1 : a2;
      const b0 = Math.floor((start + Math.PI) * K) - 1;
      const b1 = Math.floor((start + Math.abs(d) + Math.PI) * K) + 1;
      for (let b = b0; b <= b1; b++) buckets[((b % B) + B) % B].push(i);
    }

    const poly = [];
    for (let k = 0; k < angles.length; k++) {
      const ang = angles[k];
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const bucket = buckets[((Math.floor((ang + Math.PI) * K) % B) + B) % B];
      let best = Infinity;
      for (let q = 0; q < bucket.length; q++) {
        const s = S[bucket[q]];
        const den = dx * s.dy - dy * s.dx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((s.x - ox) * s.dy - (s.y - oy) * s.dx) / den;
        if (t <= 1e-9 || t >= best) continue;
        const u = ((s.x - ox) * dy - (s.y - oy) * dx) / den;
        if (u >= -1e-9 && u <= 1 + 1e-9) best = t;
      }
      if (best !== Infinity) poly.push({ x: ox + dx * best, y: oy + dy * best });
    }
    return poly;
  }

  function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function tokenRadius(t, grid) {
    return (t.size || 1) * grid * 0.4;
  }

  /** Fuentes de luz en píxeles: luces fijas del mapa + antorchas que portan las fichas. */
  function collectLights(tokens, staticLights, grid) {
    const out = [];
    for (const l of staticLights || []) out.push({ x: l.x, y: l.y, r: l.radius * grid });
    for (const t of tokens || []) {
      if (t.light > 0 && !t.hidden) out.push({ x: t.x, y: t.y, r: t.light * grid, tid: t.id });
    }
    return out;
  }

  /**
   * Parte de la visión que no depende de los muros: ángulo, alcance y luz.
   * isLit(): ¿está iluminado el punto? Solo se consulta en escenas a oscuras.
   * invisible: el objetivo solo es visible con visión verdadera.
   */
  function withinSight(v, px, py, grid, dark, isLit, invisible) {
    const dx = px - v.x, dy = py - v.y;
    const d = Math.hypot(dx, dy);
    if (v.angle < 360 && d > 1e-6) {
      const half = (v.angle * Math.PI) / 360;
      if (Math.abs(angleDiff(Math.atan2(dy, dx), v.facing || 0)) > half) return false;
    }
    const ts = (v.truesight || 0) * grid;
    if (invisible) return d <= ts;
    if (d <= ts) return true;
    const range = (v.range || 0) * grid;
    if (!dark) return range === 0 || d <= range;
    if (d <= (v.darkvision || 0) * grid) return true;
    if (range > 0 && d > range) return false;
    return isLit();
  }

  function litAt(px, py, env) {
    for (const L of env.lights) {
      if (Math.hypot(px - L.x, py - L.y) <= L.r && los(L.x, L.y, px, py, env.segs)) return true;
    }
    return false;
  }

  const YES = () => true;

  /**
   * ¿El observador v ve el punto (px, py)?
   * env: { segs, lights:[{x,y,r}], grid, dark }
   */
  function pointVisible(v, px, py, env, invisible) {
    // Primero lo barato (ángulo y alcance), luego los muros y al final la luz.
    if (!withinSight(v, px, py, env.grid, env.dark, YES, invisible)) return false;
    if (!los(v.x, v.y, px, py, env.segs)) return false;
    return withinSight(v, px, py, env.grid, env.dark, () => litAt(px, py, env), invisible);
  }

  /** ¿El observador v ve la ficha t? Basta con que vea el centro o parte del borde. */
  function tokenVisible(v, t, env) {
    if (t.hidden) return false;
    if (pointVisible(v, t.x, t.y, env, t.invisible)) return true;
    const r = tokenRadius(t, env.grid) * 0.8;
    for (let i = 0; i < 8; i++) {
      const a = (i * TAU) / 8;
      const sx = t.x + Math.cos(a) * r, sy = t.y + Math.sin(a) * r;
      // El punto del borde no cuenta si queda al otro lado de una pared respecto a la propia ficha.
      if (!los(t.x, t.y, sx, sy, env.segs)) continue;
      if (pointVisible(v, sx, sy, env, t.invisible)) return true;
    }
    return false;
  }

  return {
    TAU, blocking, blockingMove, firstHit, segHit, los, angleDiff, distPointSeg, visibilityPolygon,
    pointInPolygon, tokenRadius, collectLights, withinSight, pointVisible, tokenVisible,
  };
});
