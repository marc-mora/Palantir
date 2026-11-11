/*
 * Figuras vistas desde arriba, dibujadas por código (sin imágenes).
 *
 * Una figura se identifica con un texto:
 *   'h:<raza>:<clase>'   personaje (por ejemplo 'h:enano:guerrero')
 *   'm:<monstruo>'       monstruo  (por ejemplo 'm:troll')
 *   ''                   círculo clásico con la inicial
 *
 * Todo se dibuja en un espacio donde el radio de la ficha vale 50 y la figura
 * mira hacia arriba (y negativa); quien la pinta la gira según su orientación.
 */
'use strict';

const Sprites = (() => {
  const TAU = Math.PI * 2;
  const OUT = '#1c1410'; // contorno

  /* ---------- Utilidades de dibujo ---------- */

  function fs(ctx, fill, lw = 2) {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (lw) { ctx.lineWidth = lw; ctx.strokeStyle = OUT; ctx.stroke(); }
  }
  function ell(ctx, x, y, rx, ry, fill, lw, rot = 0) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
    fs(ctx, fill, lw);
  }
  const circ = (ctx, x, y, r, fill, lw) => ell(ctx, x, y, r, r, fill, lw);
  function poly(ctx, pts, fill, lw) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    fs(ctx, fill, lw);
  }
  /** Trazo grueso con contorno: brazos, palos, hojas. */
  function bar(ctx, x1, y1, x2, y2, color, w, cap = 'round') {
    ctx.lineCap = cap;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.lineWidth = w + 3; ctx.strokeStyle = OUT; ctx.stroke();
    ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke();
  }
  /** Curva gruesa con contorno (colas, plumas). pts: [inicio, control, fin]. */
  function curve(ctx, pts, color, w) {
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.quadraticCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
    ctx.lineWidth = w + 3; ctx.strokeStyle = OUT; ctx.stroke();
    ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke();
  }
  function shade(hex, k) { // k < 0 oscurece, k > 0 aclara
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('');
  }

  const STEEL = '#b4bcc6', STEEL_D = '#7f8994', WOOD = '#7a5230', WOOD_D = '#59391f', GOLD = '#d9b24a', BONE = '#e8e2cf';

  /* ---------- Objetos ---------- */

  function sword(ctx, h, len = 34, tilt = 0.12, w = 4.5, blade = STEEL) {
    const dx = Math.sin(tilt), dy = -Math.cos(tilt);
    bar(ctx, h[0], h[1], h[0] + dx * len, h[1] + dy * len, blade, w, 'butt');
    poly(ctx, [[h[0] + dx * len - dy * w * 0.6, h[1] + dy * len + dx * w * 0.6], [h[0] + dx * (len + 6), h[1] + dy * (len + 6)], [h[0] + dx * len + dy * w * 0.6, h[1] + dy * len - dx * w * 0.6]], blade, 1.5);
    bar(ctx, h[0] - dy * 6 + dx * 2, h[1] + dx * 6 + dy * 2, h[0] + dy * 6 + dx * 2, h[1] - dx * 6 + dy * 2, GOLD, 2.5);
    circ(ctx, h[0] - dx * 5, h[1] - dy * 5, 2.4, GOLD, 1.5);
  }
  function dagger(ctx, h, tilt) { sword(ctx, h, 15, tilt, 3.5); }
  function shield(ctx, h, color, r = 13) {
    circ(ctx, h[0], h[1], r, color, 2.5);
    circ(ctx, h[0], h[1], r - 3.5, null, 1.2);
    circ(ctx, h[0], h[1], 3.6, STEEL, 1.5);
  }
  function pole(ctx, h, back, front, color = WOOD, w = 3.5, tilt = 0) {
    const dx = Math.sin(tilt), dy = -Math.cos(tilt);
    bar(ctx, h[0] - dx * back, h[1] - dy * back, h[0] + dx * front, h[1] + dy * front, color, w);
    return [h[0] + dx * front, h[1] + dy * front, dx, dy];
  }
  function staff(ctx, h, color) {
    const [x, y] = pole(ctx, h, 20, 34);
    circ(ctx, x, y - 3, 6.5, shade(color, 0.35), 2);
    circ(ctx, x - 1.5, y - 4.5, 2, '#ffffff', 0);
  }
  function spear(ctx, h, tilt = 0) {
    const [x, y, dx, dy] = pole(ctx, h, 22, 36, WOOD, 3, tilt);
    poly(ctx, [[x - dy * 4, y + dx * 4], [x + dx * 12, y + dy * 12], [x + dy * 4, y - dx * 4]], STEEL, 1.5);
  }
  function pitchfork(ctx, h) {
    const [x, y] = pole(ctx, h, 22, 32, WOOD, 3);
    bar(ctx, x - 7, y, x + 7, y, STEEL_D, 2.5);
    for (const o of [-7, 0, 7]) bar(ctx, x + o, y, x + o, y - 11, STEEL_D, 2.2);
  }
  function oar(ctx, h) {
    const [x, y, dx, dy] = pole(ctx, h, 24, 30, WOOD, 3.2, 0.25);
    ell(ctx, x + dx * 8, y + dy * 8, 5.5, 11, shade(WOOD, 0.15), 2, 0.25);
  }
  function axe(ctx, h, double, big) {
    const [x, y] = pole(ctx, h, 18, big ? 36 : 28, WOOD_D, big ? 4.5 : 3.5, 0.1);
    const s = big ? 1.45 : 1;
    poly(ctx, [[x, y + 9 * s], [x + 14 * s, y + 14 * s], [x + 16 * s, y - 2 * s], [x, y + 1 * s]], STEEL, 2);
    if (double) poly(ctx, [[x, y + 9 * s], [x - 14 * s, y + 14 * s], [x - 16 * s, y - 2 * s], [x, y + 1 * s]], STEEL, 2);
  }
  function hammer(ctx, h) {
    const [x, y] = pole(ctx, h, 14, 28, WOOD_D, 3.5);
    ctx.beginPath(); ctx.rect(x - 9, y - 4, 18, 10); fs(ctx, STEEL, 2);
  }
  function club(ctx, h, big) {
    const k = big ? 1.5 : 1;
    bar(ctx, h[0], h[1] + 10, h[0] + 4 * k, h[1] - 30 * k, WOOD_D, 5 * k);
    circ(ctx, h[0] + 4.5 * k, h[1] - 32 * k, 6.5 * k, WOOD, 2);
  }
  function cleaver(ctx, h) {
    bar(ctx, h[0], h[1] + 5, h[0], h[1] - 8, WOOD_D, 3.5);
    poly(ctx, [[h[0] - 3, h[1] - 8], [h[0] - 3, h[1] - 36], [h[0] + 10, h[1] - 30], [h[0] + 9, h[1] - 8]], '#9aa1a8', 2);
  }
  function bow(ctx, h) {
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(h[0] + 2, h[1] + 4, 21, Math.PI * 1.08, Math.PI * 1.92);
    ctx.lineWidth = 6.5; ctx.strokeStyle = OUT; ctx.stroke();
    ctx.lineWidth = 3.5; ctx.strokeStyle = WOOD; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(h[0] - 18, h[1] - 1); ctx.lineTo(h[0] + 22, h[1] - 1);
    ctx.lineWidth = 1; ctx.strokeStyle = '#efe9da'; ctx.stroke();
  }
  function quiver(ctx) {
    ctx.save(); ctx.translate(9, 12); ctx.rotate(0.35);
    ctx.beginPath(); ctx.rect(-4.5, -9, 9, 22); fs(ctx, WOOD_D, 2);
    for (const o of [-2.5, 0.5, 3]) bar(ctx, o, -10, o, -15, '#e9e4d6', 1.2);
    ctx.restore();
  }
  function book(ctx, h, color) {
    ctx.save(); ctx.translate(h[0], h[1] - 3); ctx.rotate(-0.2);
    ctx.beginPath(); ctx.rect(-8, -6, 16, 12); fs(ctx, color, 2);
    ctx.beginPath(); ctx.rect(-6, -4.5, 12, 9); fs(ctx, '#f1ead6', 1);
    bar(ctx, 0, -4.5, 0, 4.5, '#b9ae90', 0.6);
    ctx.restore();
  }
  function purse(ctx, h) {
    circ(ctx, h[0], h[1] - 2, 6, '#b8862b', 2);
    bar(ctx, h[0] - 3, h[1] - 6.5, h[0] + 3, h[1] - 6.5, WOOD_D, 1.5);
  }
  function cape(ctx, R, color, len = 16) {
    poly(ctx, [[-R.w + 4, 2], [R.w - 4, 2], [R.w - 9, R.d + len], [0, R.d + len + 4], [-R.w + 9, R.d + len]], color, 2);
  }

  /* ---------- Cabezas, pelo y tocados ---------- */

  function hairCap(ctx, R, color, front = 0.38) {
    const r = R.head, y = R.headY;
    ctx.beginPath();
    ctx.arc(0, y, r, -0.12 * Math.PI, 1.12 * Math.PI);
    ctx.quadraticCurveTo(0, y - r * front, Math.cos(-0.12 * Math.PI) * r, y + Math.sin(-0.12 * Math.PI) * r);
    fs(ctx, color, 1.6);
  }

  const HAIR = {
    short: (ctx, R) => hairCap(ctx, R, R.hair),
    curly(ctx, R) {
      const r = R.head, y = R.headY;
      for (let a = -0.05; a <= 1.06; a += 0.185) circ(ctx, Math.cos(a * Math.PI) * r * 0.86, y + Math.sin(a * Math.PI) * r * 0.86, r * 0.34, R.hair, 1.4);
      hairCap(ctx, R, R.hair, 0.2);
    },
    long: (ctx, R) => hairCap(ctx, R, R.hair, 0.3),
    // Cabeza rapada con un moño atrás.
    topknot(ctx, R) { bar(ctx, 0, R.headY - R.head * 0.2, 0, R.headY + R.head * 0.5, R.hair, 3, 'butt'); circ(ctx, 0, R.headY + R.head * 0.62, R.head * 0.4, R.hair, 1.6); },
    // Solo una corona de pelo en la nuca.
    balding: (ctx, R) => hairCap(ctx, R, R.hair, -0.45),
  };

  function ears(ctx, R) {
    const r = R.head, y = R.headY;
    for (const s of [-1, 1]) {
      if (R.ears === 'elf') poly(ctx, [[s * (r - 2), y - 3], [s * (r + 9), y + 4], [s * (r - 2), y + 5]], R.skin, 1.6);
      else if (R.ears === 'big') poly(ctx, [[s * (r - 3), y - 5], [s * (r + 15), y - 1], [s * (r - 2), y + 6]], R.skin, 1.6);
      else if (R.ears === 'round') circ(ctx, s * (r - 1), y - 5, r * 0.5, R.earColor || R.skin, 1.6);
      else circ(ctx, s * r, y + 1, 3, R.skin, 1.4);
    }
  }

  function head(ctx, R) {
    const r = R.head, y = R.headY;
    ears(ctx, R);
    if (R.snout) { ell(ctx, 0, y - r - R.snout * 0.45, r * 0.55, R.snout, R.skin, 1.8); circ(ctx, 0, y - r - R.snout * 1.25, 2.4, R.noseColor || '#3a2a22', 1); }
    else circ(ctx, 0, y - r + 0.5, R.nose || 2.4, R.skin, 1.4);
    circ(ctx, 0, y, r, R.skin, 2);
    if (R.tusks) for (const s of [-1, 1]) poly(ctx, [[s * 4, y - r + 3], [s * 6.5, y - r - 5], [s * 8, y - r + 4]], '#f3eedd', 1.2);
    if (R.hair && HAIR[R.hairStyle || 'short']) HAIR[R.hairStyle || 'short'](ctx, R);
    if (R.horns) for (const s of [-1, 1]) curve(ctx, [[s * (r - 3), y + 1], [s * (r + R.horns), y - 2], [s * (r + R.horns * 0.7), y - r - R.horns * 0.55]], R.hornColor || '#e3d6b5', 3.6);
    if (R.sockets) for (const s of [-1, 1]) circ(ctx, s * 4.5, y - r * 0.45, 2.8, '#2a2320', 0);
  }

  const HEADGEAR = {
    helmet(ctx, R) {
      const r = R.head + 1.2, y = R.headY;
      circ(ctx, 0, y, r, STEEL, 2);
      bar(ctx, 0, y - r + 1, 0, y + r - 1, STEEL_D, 2.6, 'butt');
      bar(ctx, -r + 2, y - 1, r - 2, y - 1, STEEL_D, 1.6, 'butt');
    },
    hood(ctx, R, color, C) {
      const r = R.head + 2.5, y = R.headY, c = C.hood || C.cloth;
      ctx.beginPath();
      ctx.arc(0, y, r, -0.85 * Math.PI, -0.15 * Math.PI);
      ctx.quadraticCurveTo(r + 2, y + r * 0.6, 0, y + r + 9);
      ctx.quadraticCurveTo(-r - 2, y + r * 0.6, Math.cos(-0.85 * Math.PI) * r, y + Math.sin(-0.85 * Math.PI) * r);
      fs(ctx, c, 2);
      ell(ctx, 0, y - r * 0.5, r * 0.56, r * 0.4, shade(c, -0.55), 1.2);
      ell(ctx, 0, y - r * 0.62, r * 0.36, r * 0.22, R.skin, 0);
    },
    wizard(ctx, R, color, C) {
      const r = R.head, y = R.headY;
      circ(ctx, 0, y, r + 8, C.cloth, 2);
      poly(ctx, [[-r * 0.75, y + 2], [r * 0.75, y + 2], [6, y + r + 15]], shade(C.cloth, -0.2), 2);
      circ(ctx, 0, y, r * 0.78, shade(C.cloth, 0.12), 1.6);
      circ(ctx, 0, y, r * 0.78 + 2.2, null, 0);
      ctx.beginPath(); ctx.arc(0, y, r * 0.78 + 1.6, 0, TAU); ctx.lineWidth = 2.6; ctx.strokeStyle = color; ctx.stroke();
    },
    cap(ctx, R, color, C) {
      const r = R.head, y = R.headY;
      ell(ctx, 0, y + 1.5, r + 1.5, r + 0.5, C.hat, 2);
      circ(ctx, 0, y + 1.5, 2.2, shade(C.hat, 0.3), 1);
    },
    beret(ctx, R, color, C) {
      const r = R.head, y = R.headY;
      ell(ctx, 2.5, y + 2, r + 4, r + 1.5, C.hat, 2, 0.25);
      circ(ctx, 4, y + 3, 2, shade(C.hat, 0.35), 1);
    },
    feathered(ctx, R, color, C) {
      const r = R.head, y = R.headY;
      ell(ctx, 0, y + 1, r + 9, r + 6, C.hat, 2);
      circ(ctx, 0, y + 1, r * 0.8, shade(C.hat, 0.18), 1.6);
      curve(ctx, [[r * 0.5, y - 2], [r + 16, y + 2], [r + 9, y + r + 12]], color, 4.2);
      curve(ctx, [[r * 0.5, y - 2], [r + 12, y + 4], [r + 8, y + r + 9]], shade(color, 0.45), 1.2);
    },
    straw(ctx, R) {
      const r = R.head, y = R.headY, c = '#dcbb5a';
      circ(ctx, 0, y, r + 10, c, 2);
      ctx.strokeStyle = shade(c, -0.22); ctx.lineWidth = 1;
      for (let a = 0; a < TAU; a += TAU / 14) { ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8); ctx.lineTo(Math.cos(a) * (r + 9), y + Math.sin(a) * (r + 9)); ctx.stroke(); }
      circ(ctx, 0, y, r * 0.8, shade(c, -0.1), 1.6);
    },
    bandana(ctx, R, color) {
      const r = R.head, y = R.headY;
      poly(ctx, [[-3, y + r - 1], [-9, y + r + 10], [-1, y + r + 5]], color, 1.5);
      poly(ctx, [[3, y + r - 1], [8, y + r + 9], [1, y + r + 5]], color, 1.5);
      hairCap(ctx, R, color, 0.75);
      circ(ctx, 0, y + r - 1, 2.6, shade(color, -0.25), 1.2);
    },
    tonsure(ctx, R) {
      const r = R.head, y = R.headY;
      circ(ctx, 0, y, r, R.hair || '#5a3b22', 2);
      circ(ctx, 0, y + 0.5, r * 0.56, R.skin, 1.2);
    },
  };

  /* ---------- Razas ---------- */

  const RACES = {
    humano: { label: 'Humano', scale: 1, w: 33, d: 15, head: 13, skin: '#e0b089', hair: '#5a3b22' },
    enano: { label: 'Enano', scale: 0.94, w: 37, d: 18, head: 14, skin: '#d9a37c', hair: '#b5542a', beard: { color: '#b5542a', len: 17, w: 1.02 } },
    halfling: { label: 'Halfling', scale: 0.74, w: 30, d: 15, head: 15, skin: '#e6b993', hair: '#7a4a21', hairStyle: 'curly' },
    altoelfo: { label: 'Alto elfo', scale: 1, w: 29, d: 13, head: 12, skin: '#f0d9c0', hair: '#efe2a4', hairStyle: 'long', ears: 'elf', longHair: 15 },
    elfosilvano: { label: 'Elfo silvano', scale: 1, w: 29, d: 13, head: 12, skin: '#d9b38c', hair: '#8a4320', hairStyle: 'long', ears: 'elf', longHair: 11, leaves: true },
    gnomo: { label: 'Gnomo', scale: 0.7, w: 29, d: 15, head: 15, skin: '#deb18f', hair: '#ececec', nose: 4, beard: { color: '#ececec', len: 13, w: 0.8 } },
    ogro: { label: 'Ogro', scale: 0.98, w: 42, d: 24, head: 13, skin: '#b9ad8a', hair: null, belly: true, sizeHint: 2 },
  };

  /* ---------- Clases ---------- */

  const CLASSES = {
    guerrero: {
      label: 'Guerrero', cloth: '#8d949c', headgear: 'helmet',
      back: (ctx, R, color) => cape(ctx, R, color, 12),
      torso(ctx, R) { for (const s of [-1, 1]) circ(ctx, s * (R.w - 6), 1, 8.5, STEEL, 2); },
      items(ctx, h, R, color) { sword(ctx, h.r); shield(ctx, [h.l[0] - 3, h.l[1] + 3], color, 14.5); },
    },
    explorador: {
      label: 'Explorador', cloth: '#3f6b3a', hood: '#33582f', headgear: 'hood',
      back(ctx, R) { cape(ctx, R, '#2f4f2b', 13); quiver(ctx); },
      hands: (R) => ({ l: [-R.w + 6, -R.d - 16], r: [R.w - 8, -R.d - 4] }),
      items(ctx, h) { bow(ctx, h.l); },
    },
    bribon: {
      label: 'Bribón', cloth: '#3a3a44', hood: '#2b2b33', headgear: 'hood',
      back: (ctx, R) => cape(ctx, R, '#25252c', 9),
      torso(ctx, R, color) { ell(ctx, 0, 1, R.head + 4, R.head * 0.75 + 3, color, 1.6); },
      items(ctx, h) { dagger(ctx, h.l, -0.45); dagger(ctx, h.r, 0.45); },
    },
    academico: {
      label: 'Académico', cloth: '#3d4a7a', hat: '#2c365c', headgear: 'cap', robe: true,
      torso(ctx, R, color) { ell(ctx, 0, 1, R.head + 4, R.head * 0.75 + 3, color, 1.6); },
      hands: (R) => ({ l: [-R.w + 12, -R.d - 9], r: [R.w - 6, -R.d - 6] }),
      items(ctx, h) { book(ctx, h.l, '#7a2e2e'); bar(ctx, h.r[0], h.r[1] + 2, h.r[0] + 3, h.r[1] - 12, '#f1ead6', 1.6); },
    },
    hechicero: {
      label: 'Hechicero', cloth: '#5b3a7a', headgear: 'wizard', robe: true,
      items(ctx, h, R, color) { staff(ctx, h.r, color); },
    },
    sacerdote: {
      label: 'Sacerdote', cloth: '#e6dfcf', headgear: 'tonsure', robe: true,
      torso(ctx, R, color) { for (const s of [-1, 1]) bar(ctx, s * 7, -R.d + 3, s * 9, R.d + 5, color, 4.5, 'butt'); },
      items(ctx, h) { hammer(ctx, h.r); },
    },
    burgues: {
      label: 'Burgués', cloth: '#7a5a3a', hat: '#4a5e3a', headgear: 'beret',
      torso(ctx, R, color) { ell(ctx, 0, 1, R.head + 4, R.head * 0.75 + 3, '#efe9da', 1.6); bar(ctx, -R.w + 8, R.d - 4, R.w - 8, R.d - 4, color, 3, 'butt'); },
      hands: (R) => ({ l: [-R.w + 9, -R.d - 6], r: [R.w - 4, -R.d - 5] }),
      items(ctx, h) { purse(ctx, h.l); },
    },
    cortesano: {
      label: 'Cortesano', cloth: '#8e1f2f', hat: '#2b2b33', headgear: 'feathered',
      back: (ctx, R) => cape(ctx, R, '#5e1420', 9),
      torso(ctx, R) { ctx.beginPath(); ctx.ellipse(0, 3, R.w - 4, R.d - 3.5, 0, 0, TAU); ctx.lineWidth = 1.8; ctx.strokeStyle = GOLD; ctx.stroke(); },
      items(ctx, h) { sword(ctx, h.r, 38, 0.2, 2, '#dfe5ea'); },
    },
    campesino: {
      label: 'Campesino', cloth: '#b79a6a', headgear: 'straw',
      torso(ctx, R, color) { bar(ctx, -R.w + 8, R.d - 4, R.w - 8, R.d - 4, color, 3, 'butt'); },
      items(ctx, h) { pitchfork(ctx, h.r); },
    },
    ribereno: {
      label: 'Ribereño', cloth: '#e9e4d6', headgear: 'bandana',
      torso(ctx, R) {
        ctx.save(); ctx.beginPath(); ctx.ellipse(0, 3, R.w - 1, R.d - 1, 0, 0, TAU); ctx.clip();
        ctx.strokeStyle = '#3b6ea8'; ctx.lineWidth = 3.2;
        for (let x = -R.w; x <= R.w; x += 8) { ctx.beginPath(); ctx.moveTo(x, -30); ctx.lineTo(x, 40); ctx.stroke(); }
        ctx.restore();
      },
      items(ctx, h) { oar(ctx, h.r); },
    },
  };

  /* ---------- Figura humanoide ---------- */

  function humanoid(ctx, R0, C, color) {
    const R = { headY: 0, ...R0 };
    const armW = R.armW || 9;
    ctx.save();
    // Las figuras llenan la peana: a tamaño de ficha se distinguen mejor.
    const k = (R.scale || 1) * 1.2;
    ctx.scale(k, k);
    const h = C.hands ? C.hands(R) : { l: [-R.w + 3, -R.d - 9], r: [R.w - 3, -R.d - 9] };

    if (R.tail) R.tail(ctx);
    if (R.wings) R.wings(ctx, color);
    if (C.back) C.back(ctx, R, color);
    if (R.longHair) ell(ctx, 0, R.headY + R.longHair * 0.55, R.head * 0.92, R.head * 0.7 + R.longHair, R.hair, 2);

    const sleeve = C.sleeve || (C.bare ? R.skin : C.cloth);
    bar(ctx, -R.w + 6, 1, h.l[0], h.l[1], sleeve, armW);
    bar(ctx, R.w - 6, 1, h.r[0], h.r[1], sleeve, armW);
    if (C.items) C.items(ctx, h, R, color);
    const handR = R.handR || 4.6;
    circ(ctx, h.l[0], h.l[1], handR, R.handColor || R.skin, 1.8);
    circ(ctx, h.r[0], h.r[1], handR, R.handColor || R.skin, 1.8);
    if (R.claws) for (const p of [h.l, h.r]) for (const o of [-3.5, 0, 3.5]) bar(ctx, p[0] + o, p[1] - handR + 1, p[0] + o * 1.4, p[1] - handR - 6, '#2a2320', 1.4);

    const cloth = C.bare ? R.skin : C.cloth;
    if (C.robe) ell(ctx, 0, 6, R.w * 0.86, R.d + 9, shade(cloth, -0.14), 2);
    if (R.belly) ell(ctx, 0, -6, R.w * 0.72, R.d * 0.95, shade(cloth, 0.1), 2);
    ell(ctx, 0, 3, R.w, R.d, cloth, 2.2);
    if (C.torso) C.torso(ctx, R, color);
    if (R.leaves) for (const [x, y, a] of [[-R.w + 9, 6, 0.6], [R.w - 10, 7, -0.5], [-8, R.d - 2, 0.2]]) ell(ctx, x, y, 4.5, 2.4, '#5d9a4a', 1.2, a);

    if (R.beard) {
      // Vista desde arriba, la barba asoma por delante de la cara.
      const bd = R.beard, r = R.head, y = R.headY;
      ell(ctx, 0, y - r * 0.7, r * bd.w, bd.len, bd.color, 2);
      bar(ctx, 0, y - r - 1, 0, y - r * 0.7 - bd.len + 3, shade(bd.color, -0.25), 0.8, 'butt');
    }
    head(ctx, R);
    if (C.headgear && HEADGEAR[C.headgear]) HEADGEAR[C.headgear](ctx, R, color, C);
    ctx.restore();
  }

  /* ---------- Monstruos ---------- */

  const bare = (extra) => ({ bare: true, ...extra });
  const batWings = (span, c) => (ctx) => {
    for (const s of [-1, 1]) {
      poly(ctx, [[s * 8, 0], [s * span, -16], [s * (span - 4), 4], [s * (span - 14), 2], [s * (span - 12), 16], [s * (span - 24), 10], [s * 18, 22], [s * 6, 12]], c, 2);
      bar(ctx, s * 8, 0, s * span, -16, shade(c, -0.35), 1.6);
    }
  };

  function quadruped(ctx, o) {
    // Cola
    if (o.tailThin) { curve(ctx, [[0, 28], [16, 40], [4, 52]], o.tailColor, 2.2); }
    else poly(ctx, [[-5, 28], [0, 52], [5, 28]], o.fur, 2);
    // Patas
    for (const [x, y] of [[-13, -12], [13, -12], [-14, 20], [14, 20]]) ell(ctx, x, y, 5, 7, o.paw, 1.8);
    ell(ctx, 0, 6, o.bw, 26, o.fur, 2.2);
    ell(ctx, 0, 6, o.bw * 0.45, 20, shade(o.fur, -0.14), 0);
    // Orejas, cabeza y hocico
    for (const s of [-1, 1]) {
      if (o.earRound) circ(ctx, s * 9, -19, 5.5, o.earColor, 1.6);
      else poly(ctx, [[s * 4, -22], [s * 11, -32], [s * 11, -18]], o.fur, 1.6);
    }
    ell(ctx, 0, -24, 10.5, 12, o.fur, 2);
    ell(ctx, 0, -36, o.snoutW, 8.5, shade(o.fur, 0.12), 1.8);
    circ(ctx, 0, -43.5, 2.2, o.nose, 1);
    for (const s of [-1, 1]) circ(ctx, s * 5, -29, 1.5, o.eye, 0);
  }

  const MONSTERS = {
    goblin: {
      label: 'Goblin',
      draw: (ctx, color) => humanoid(ctx, { scale: 0.76, w: 27, d: 13, head: 13, skin: '#7fa04a', hair: null, ears: 'big', nose: 3.4 },
        { cloth: '#5a4630', items: (c, h) => spear(c, h.r, 0.08), torso: (c, R) => bar(c, -R.w + 8, R.d - 3, R.w - 8, R.d - 3, color, 2.5, 'butt') }, color),
    },
    orco: {
      label: 'Orco',
      draw: (ctx, color) => humanoid(ctx, { scale: 1, w: 39, d: 19, head: 14, skin: '#5f8a3a', hair: '#1d1a17', hairStyle: 'topknot', ears: 'elf', tusks: true },
        { cloth: '#4a3b2a', sleeve: '#5f8a3a', torso: (c, R) => { for (const s of [-1, 1]) { circ(c, s * (R.w - 7), 1, 8, '#3a2f22', 2); poly(c, [[s * (R.w - 10), -4], [s * (R.w + 3), -9], [s * (R.w - 4), 2]], STEEL_D, 1.4); } },
          items: (c, h) => { cleaver(c, h.r); shield(c, [h.l[0] - 2, h.l[1] + 5], color, 12); } }, color),
    },
    troll: {
      label: 'Troll', sizeHint: 2,
      draw(ctx, color) {
        humanoid(ctx, { scale: 0.96, w: 42, d: 27, head: 12, headY: -17, skin: '#6f8f86', hair: null, ears: 'big', nose: 4.5, armW: 12, handR: 6.5, claws: true },
          bare({ hands: (R) => ({ l: [-R.w + 4, -R.d - 14], r: [R.w - 4, -R.d - 14] }),
            torso: (c) => { for (const [x, y, r] of [[-16, 10, 4], [10, 14, 5], [22, 0, 3.4], [-4, 20, 3], [-26, -2, 3]]) circ(c, x, y, r, '#5b7a72', 1); } }), color);
      },
    },
    gigante: {
      label: 'Gigante', sizeHint: 3,
      draw: (ctx, color) => humanoid(ctx, { scale: 0.97, w: 43, d: 24, head: 15, skin: '#d2a37e', hair: '#4a3524', hairStyle: 'balding', armW: 12, handR: 6, belly: true },
        { cloth: '#7b6a55', sleeve: '#d2a37e', torso: (c, R) => bar(c, -R.w + 10, R.d - 5, R.w - 10, R.d - 5, color, 3.5, 'butt'), items: (c, h) => club(c, h.r, true) }, color),
    },
    esqueleto: {
      label: 'Esqueleto',
      draw: (ctx, color) => humanoid(ctx, { scale: 0.98, w: 29, d: 13, head: 12.5, skin: BONE, hair: null, armW: 4.5, sockets: true, nose: 1.4 },
        { cloth: '#d6cfba', sleeve: BONE, torso: (c, R) => { for (const y of [-4, 1, 6, 11]) bar(c, -R.w + 9, y, R.w - 9, y, '#3a332c', 1.2, 'butt'); bar(c, 0, -8, 0, 14, '#3a332c', 1.6, 'butt'); },
          items: (c, h) => { sword(c, h.r, 30, 0.1, 4, '#9a8f7a'); shield(c, [h.l[0] - 2, h.l[1] + 5], shade(color, -0.35), 11); } }, color),
    },
    zombi: {
      label: 'Zombi',
      draw: (ctx, color) => humanoid(ctx, { scale: 1, w: 32, d: 15, head: 13, skin: '#8fa37f', hair: '#3b3a2c', hairStyle: 'balding', claws: true },
        { cloth: '#5c5a4a', sleeve: '#8fa37f', hands: (R) => ({ l: [-12, -R.d - 26], r: [14, -R.d - 22] }),
          torso: (c, R) => { poly(c, [[-R.w + 8, -2], [-6, 4], [-R.w + 12, 10]], '#6d2f2f', 1); bar(c, 6, R.d - 6, R.w - 9, R.d - 3, color, 2.5, 'butt'); } }, color),
    },
    espectro: {
      label: 'Espectro',
      draw(ctx, color) {
        ctx.save(); ctx.globalAlpha *= 0.82;
        const c = '#d7e6ea';
        ctx.beginPath(); ctx.moveTo(-26, -4);
        ctx.quadraticCurveTo(-30, 26, -14, 34); ctx.quadraticCurveTo(-10, 46, -4, 36); ctx.quadraticCurveTo(2, 52, 8, 37); ctx.quadraticCurveTo(14, 46, 18, 32);
        ctx.quadraticCurveTo(30, 22, 26, -4); ctx.closePath(); fs(ctx, c, 2);
        for (const s of [-1, 1]) { bar(ctx, s * 22, -2, s * 17, -30, c, 6); for (const o of [-3, 0, 3]) bar(ctx, s * 17 + o, -32, s * 17 + o * 1.5, -39, BONE, 1.4); }
        ell(ctx, 0, -2, 27, 14, c, 2);
        circ(ctx, 0, -4, 15, shade(c, 0.25), 2);
        ell(ctx, 0, -11, 8.5, 6.5, '#1b2a33', 1.2);
        for (const s of [-1, 1]) circ(ctx, s * 3.4, -12, 1.5, color, 0);
        ctx.restore();
      },
    },
    lobo: { label: 'Lobo', draw: (ctx) => quadruped(ctx, { fur: '#77706a', paw: '#5f5953', bw: 13, snoutW: 5.2, nose: '#1f1a18', eye: '#f2d24a' }) },
    rata: { label: 'Rata gigante', draw: (ctx) => quadruped(ctx, { fur: '#6b5a48', paw: '#d9a3a0', bw: 14.5, snoutW: 4.4, nose: '#d9817c', eye: '#1b1414', earRound: true, earColor: '#d9a3a0', tailThin: true, tailColor: '#d9a3a0' }) },
    arana: {
      label: 'Araña gigante', sizeHint: 2,
      draw(ctx, color) {
        const c = '#2e2a33';
        for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
          const y0 = -14 + i * 4, kx = s * (26 + (i === 1 || i === 2 ? 6 : 0)), ky = -30 + i * 17, tx = s * (40 + (i === 1 || i === 2 ? 6 : 0)), ty = -44 + i * 27;
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(s * 7, y0); ctx.lineTo(kx, ky); ctx.lineTo(tx, ty);
          ctx.lineWidth = 6; ctx.strokeStyle = OUT; ctx.stroke(); ctx.lineWidth = 3.2; ctx.strokeStyle = '#3d3745'; ctx.stroke();
        }
        circ(ctx, 0, 16, 20, c, 2.2);
        poly(ctx, [[0, 6], [6, 16], [0, 28], [-6, 16]], color, 1.4);
        circ(ctx, 0, -11, 12.5, '#3d3745', 2.2);
        for (const s of [-1, 1]) { bar(ctx, s * 3.5, -21, s * 5, -28, '#1b1820', 2); circ(ctx, s * 3, -17, 1.6, '#e0453a', 0); circ(ctx, s * 7, -14, 1.2, '#e0453a', 0); }
      },
    },
    murcielago: {
      label: 'Murciélago gigante',
      draw(ctx) {
        const c = '#4a3f52';
        batWings(47, c)(ctx);
        ell(ctx, 0, 4, 9, 15, '#3b3340', 2);
        for (const s of [-1, 1]) poly(ctx, [[s * 3, -13], [s * 9, -24], [s * 9, -11]], '#3b3340', 1.5);
        circ(ctx, 0, -12, 7.5, '#3b3340', 2);
        for (const s of [-1, 1]) circ(ctx, s * 3, -15, 1.3, '#e0453a', 0);
      },
    },
    hombrerata: {
      label: 'Hombre rata',
      draw: (ctx, color) => humanoid(ctx, { scale: 0.92, w: 30, d: 14, head: 12, skin: '#8a7f73', hair: null, ears: 'round', earColor: '#d9a3a0', snout: 9, noseColor: '#d9817c', claws: true,
        tail: (c) => curve(c, [[0, 12], [24, 34], [6, 50]], '#d9a3a0', 2.6) },
        { cloth: '#4b4034', sleeve: '#8a7f73', back: (c, R) => cape(c, R, '#3a3128', 8), torso: (c, R) => bar(c, -R.w + 8, R.d - 4, R.w - 8, R.d - 4, color, 2.5, 'butt'),
          items: (c, h) => { sword(c, h.r, 22, 0.25, 3.6, '#9a8f7a'); } }, color),
    },
    hombrebestia: {
      label: 'Hombre bestia',
      draw: (ctx, color) => humanoid(ctx, { scale: 1, w: 37, d: 18, head: 13.5, skin: '#7a5a3a', hair: '#4a3421', hairStyle: 'short', snout: 7, horns: 11 },
        bare({ torso: (c, R) => { ell(c, 0, 8, R.w * 0.6, R.d * 0.55, '#4a3421', 0); bar(c, -R.w + 8, R.d - 3, R.w - 8, R.d - 3, color, 2.5, 'butt'); }, items: (c, h) => axe(c, h.r) }), color),
    },
    minotauro: {
      label: 'Minotauro', sizeHint: 2,
      draw: (ctx, color) => humanoid(ctx, { scale: 0.97, w: 43, d: 22, head: 15, skin: '#6b4a32', hair: '#3a2718', hairStyle: 'short', snout: 9, horns: 17, armW: 11, handR: 5.6 },
        bare({ torso: (c, R) => { ell(c, 0, 9, R.w * 0.6, R.d * 0.55, '#3a2718', 0); bar(c, -R.w + 9, R.d - 4, R.w - 9, R.d - 4, color, 3, 'butt'); }, items: (c, h) => axe(c, h.r, true, true) }), color),
    },
    demonio: {
      label: 'Demonio', sizeHint: 2,
      draw: (ctx, color) => humanoid(ctx, { scale: 1, w: 36, d: 17, head: 13, skin: '#a3262a', hair: null, ears: 'elf', horns: 13, hornColor: '#1f1a1a', claws: true, handColor: '#5e1418',
        wings: batWings(49, '#5e1418'), tail: (c) => { curve(c, [[0, 14], [-22, 34], [-4, 48]], '#a3262a', 3); poly(c, [[-9, 46], [-2, 55], [2, 45]], '#5e1418', 1.5); } },
        bare({ torso: (c, R) => bar(c, -R.w + 8, R.d - 3, R.w - 8, R.d - 3, color, 2.5, 'butt') }), color),
    },
    dragon: {
      label: 'Dragón', sizeHint: 3,
      draw(ctx, color) {
        const body = color, mem = shade(color, 0.3), dark = shade(color, -0.35);
        for (const s of [-1, 1]) {
          poly(ctx, [[s * 8, -6], [s * 50, -22], [s * 46, -2], [s * 36, -4], [s * 38, 14], [s * 26, 8], [s * 24, 24], [s * 8, 12]], mem, 2);
          bar(ctx, s * 8, -6, s * 50, -22, dark, 2.4); bar(ctx, s * 12, -4, s * 37, 13, dark, 1.4); bar(ctx, s * 11, 0, s * 24, 23, dark, 1.4);
        }
        curve(ctx, [[0, 24], [16, 40], [2, 54]], body, 6);
        poly(ctx, [[-4, 50], [2, 60], [7, 50]], dark, 1.5);
        for (const [x, y] of [[-12, -8], [12, -8], [-12, 22], [12, 22]]) ell(ctx, x, y, 5.5, 7.5, dark, 1.8);
        ell(ctx, 0, 8, 14, 25, body, 2.2);
        bar(ctx, 0, -12, 0, -30, body, 9);
        for (let y = -8; y <= 26; y += 7) poly(ctx, [[-3, y + 3], [0, y - 4], [3, y + 3]], dark, 1);
        for (const s of [-1, 1]) bar(ctx, s * 5, -34, s * 10, -24, '#efe6c8', 2.4);
        ell(ctx, 0, -39, 7.5, 11, body, 2);
        for (const s of [-1, 1]) { circ(ctx, s * 4, -40, 1.6, '#f2d24a', 0); circ(ctx, s * 2.4, -48, 0.9, OUT, 0); }
      },
    },
    limo: {
      label: 'Limo',
      draw(ctx, color) {
        ctx.save(); ctx.globalAlpha *= 0.88;
        ctx.beginPath();
        const pts = [[0, -34], [22, -30], [36, -10], [32, 14], [40, 30], [16, 36], [-6, 30], [-28, 36], [-38, 12], [-30, -8], [-26, -28]];
        ctx.moveTo((pts[0][0] + pts[pts.length - 1][0]) / 2, (pts[0][1] + pts[pts.length - 1][1]) / 2);
        pts.forEach((p, i) => { const n = pts[(i + 1) % pts.length]; ctx.quadraticCurveTo(p[0], p[1], (p[0] + n[0]) / 2, (p[1] + n[1]) / 2); });
        ctx.closePath(); fs(ctx, color, 2.4);
        ell(ctx, -2, 2, 22, 20, shade(color, 0.22), 0);
        for (const [x, y, r] of [[-12, -12, 5], [10, 8, 3.5], [-6, 14, 2.4], [14, -14, 2.6]]) circ(ctx, x, y, r, shade(color, 0.55), 0.8);
        ctx.restore();
      },
    },
  };

  /* ---------- API ---------- */

  function parse(id) {
    if (typeof id !== 'string' || !id) return null;
    const p = id.split(':');
    if (p[0] === 'h' && RACES[p[1]] && CLASSES[p[2]]) return { type: 'h', race: p[1], cls: p[2] };
    if (p[0] === 'm' && MONSTERS[p[1]]) return { type: 'm', monster: p[1] };
    return null;
  }

  const has = (id) => !!parse(id);

  /** Tamaño de ficha recomendado para una figura (casillas), si es mayor de lo normal. */
  function sizeHint(id) {
    const p = parse(id);
    if (!p) return null;
    return (p.type === 'h' ? RACES[p.race].sizeHint : MONSTERS[p.monster].sizeHint) || null;
  }

  /**
   * Dibuja la figura centrada en el origen, mirando hacia arriba, con radio de ficha R.
   * El color de la ficha se usa en la peana y en detalles (capa, escudo, pluma…).
   */
  function draw(ctx, id, color, R) {
    const p = parse(id);
    if (!p) return false;
    ctx.save();
    ctx.scale(R / 50, R / 50);
    ctx.lineJoin = 'round';
    // Peana: distingue a cada ficha por su color y la separa del mapa.
    ctx.beginPath(); ctx.arc(0, 0, 47, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = OUT; ctx.stroke();
    ctx.lineWidth = 3.4; ctx.strokeStyle = color; ctx.stroke();
    if (p.type === 'h') humanoid(ctx, RACES[p.race], CLASSES[p.cls], color);
    else MONSTERS[p.monster].draw(ctx, color);
    ctx.restore();
    return true;
  }

  const labels = (obj) => Object.entries(obj).map(([id, v]) => ({ id, label: v.label }));

  return { draw, has, parse, sizeHint, races: labels(RACES), classes: labels(CLASSES), monsters: labels(MONSTERS) };
})();

if (typeof module === 'object' && module.exports) module.exports = Sprites;
