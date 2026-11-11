/*
 * Lectura del formato Universal VTT que exporta Dungeondraft (.dd2vtt, .uvtt, .df2vtt).
 *
 * El archivo es un JSON con la imagen del mapa en base64 y, en unidades de casilla:
 *   resolution.map_origin / map_size / pixels_per_grid
 *   line_of_sight, objects_line_of_sight   polilíneas de muros
 *   portals                                puertas (closed:true) y ventanas (closed:false)
 *   lights                                 luces ({ position, range })
 *   environment.ambient_light              color ambiente "aarrggbb"
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Uvtt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Tipo de imagen a partir del principio del base64. */
  function imageMime(b64) {
    if (b64.startsWith('/9j/')) return 'image/jpeg';
    if (b64.startsWith('UklGR')) return 'image/webp';
    return 'image/png';
  }

  /** Simplificación de Douglas-Peucker: quita vértices que se desvían menos de `tol` píxeles. */
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
      const len2 = dx * dx + dy * dy;
      let worst = -1, far = tol;
      for (let i = a + 1; i < b; i++) {
        let t = len2 ? ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(pts[i][0] - (ax + dx * t), pts[i][1] - (ay + dy * t));
        if (d > far) { far = d; worst = i; }
      }
      if (worst > 0) {
        keep[worst] = 1;
        stack.push([a, worst], [worst, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }

  const r1 = (v) => Math.round(v * 10) / 10;
  const isPoint = (p) => p && typeof p === 'object' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));

  /**
   * Convierte el JSON a píxeles del mapa.
   * imgW/imgH: tamaño real de la imagen; si no coincide con lo que dice el archivo, manda la imagen.
   * Devuelve { width, height, gridSize, dark, walls, doors, windows (todos [[x1,y1,x2,y2]]), lights:[[x,y,radio]] }.
   */
  function parse(data, imgW, imgH) {
    if (!data || typeof data !== 'object' || !data.resolution) throw new Error('No parece un mapa exportado en formato Universal VTT');
    const res = data.resolution;
    const cols = Number(res.map_size && res.map_size.x) || 0, rows = Number(res.map_size && res.map_size.y) || 0;
    const ox = Number(res.map_origin && res.map_origin.x) || 0, oy = Number(res.map_origin && res.map_origin.y) || 0;
    let ppg = Number(res.pixels_per_grid) || 70;
    if (imgW && cols) ppg = imgW / cols;
    const width = imgW || cols * ppg, height = imgH || rows * ppg;
    if (!width || !height) throw new Error('El archivo no indica el tamaño del mapa');
    const px = (p) => [(Number(p.x) - ox) * ppg, (Number(p.y) - oy) * ppg];

    const walls = [];
    const addPolyline = (line) => {
      const pts = simplify(line.filter(isPoint).map(px), 1.5);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 2) walls.push([r1(a[0]), r1(a[1]), r1(b[0]), r1(b[1])]);
      }
    };
    for (const key of ['line_of_sight', 'objects_line_of_sight']) {
      const set = Array.isArray(data[key]) ? data[key] : [];
      if (set.length && isPoint(set[0])) addPolyline(set); // variante antigua: una única polilínea
      else for (const line of set) if (Array.isArray(line)) addPolyline(line);
    }

    // Portales: los que tapan la luz (closed:true) son puertas; los que dejan ver son ventanas.
    const doors = [], windows = [];
    for (const p of Array.isArray(data.portals) ? data.portals : []) {
      const b = p && p.bounds;
      if (!Array.isArray(b) || b.length < 2 || !isPoint(b[0]) || !isPoint(b[1])) continue;
      const a = px(b[0]), c = px(b[1]);
      const seg = [r1(a[0]), r1(a[1]), r1(c[0]), r1(c[1])];
      if (p.closed === false) windows.push(seg);
      else doors.push(seg);
    }

    const lights = [];
    for (const l of Array.isArray(data.lights) ? data.lights : []) {
      if (!l || !isPoint(l.position)) continue;
      const range = Number(l.range) || 0;
      if (range <= 0) continue;
      const c = px(l.position);
      lights.push([r1(c[0]), r1(c[1]), Math.round(range * 100) / 100]);
    }

    // Luz ambiente "aarrggbb": si es muy oscura, la escena empieza a oscuras.
    let dark = false;
    const amb = data.environment && data.environment.ambient_light;
    if (typeof amb === 'string' && /^[0-9a-fA-F]{6,8}$/.test(amb)) {
      const n = parseInt(amb.slice(-6), 16);
      dark = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.35;
    }

    return { width: Math.round(width), height: Math.round(height), gridSize: r1(ppg), dark, walls, doors, windows, lights };
  }

  return { imageMime, simplify, parse };
});
