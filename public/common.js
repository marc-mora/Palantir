/* Utilidades compartidas por las tres pantallas: conexión, cámara, entrada táctil y dibujo. */
'use strict';

const P = (() => {
  const TAU = Math.PI * 2;
  const BIG = 1e5;
  const qs = new URLSearchParams(location.search);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- Conexión con reconexión automática ---------- */

  function connect(hello, handlers) {
    let ws = null, retry = 0, timer = null;
    function open() {
      clearTimeout(timer);
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      const mine = ws;
      mine.onopen = () => {
        retry = 0;
        mine.send(JSON.stringify(hello()));
        if (handlers.onStatus) handlers.onStatus(true);
      };
      mine.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        handlers.onMessage(m);
      };
      mine.onclose = () => {
        if (ws !== mine) return;
        if (handlers.onStatus) handlers.onStatus(false);
        timer = setTimeout(open, Math.min(5000, 500 * 2 ** retry++));
      };
    }
    open();
    // Los móviles cortan la conexión al bloquear la pantalla: reconectar al volver.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && ws.readyState > 1) open();
    });
    return {
      send(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      },
    };
  }

  /* ---------- Cámara ---------- */

  class View {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cam = { x: 0, y: 0, zoom: 1 };
      this.onResize = null;
      this.resize();
      new ResizeObserver(() => {
        this.resize();
        if (this.onResize) this.onResize();
      }).observe(canvas);
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
    }
    toWorld(sx, sy) {
      return { x: (sx - this.w / 2) / this.cam.zoom + this.cam.x, y: (sy - this.h / 2) / this.cam.zoom + this.cam.y };
    }
    applyWorld(ctx) {
      const k = this.dpr * this.cam.zoom;
      ctx.setTransform(k, 0, 0, k, (this.dpr * this.w) / 2 - this.cam.x * k, (this.dpr * this.h) / 2 - this.cam.y * k);
    }
    /** Encaja un rectángulo del mundo {x,y,w,h} en pantalla. */
    fit(rect, pad = 20) {
      this.cam.x = rect.x + rect.w / 2;
      this.cam.y = rect.y + rect.h / 2;
      this.cam.zoom = clampZoom(Math.min((this.w - pad * 2) / rect.w, (this.h - pad * 2) / rect.h));
    }
    /** Rectángulo del mundo visible ahora mismo. */
    rect() {
      const w = this.w / this.cam.zoom, h = this.h / this.cam.zoom;
      return { x: this.cam.x - w / 2, y: this.cam.y - h / 2, w, h };
    }
  }

  const clampZoom = (z) => Math.max(0.03, Math.min(8, z));

  /* ---------- Entrada: arrastrar, pellizcar, rueda y toques ---------- */

  /**
   * opts.onTap(world, ev)         toque/clic sin arrastre
   * opts.dragStart(world, ev)     devuelve {move(world), end(world, moved)} para capturar el arrastre; null = mover mapa
   * opts.onPan()                  el usuario ha movido o hecho zoom
   * opts.onHover(world)           movimiento del ratón sin pulsar
   */
  function attachInput(view, opts) {
    const el = view.canvas;
    const pts = new Map();
    let mode = null, custom = null, moved = false, start = null, last = null, pinch = null;

    const pos = (e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const p = pos(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        start = last = p;
        moved = false;
        custom = e.button === 0 && opts.dragStart ? opts.dragStart(view.toWorld(p.x, p.y), e) : null;
        mode = custom ? 'custom' : e.button === 0 ? 'pan' : 'forcepan';
      } else if (pts.size === 2) {
        if (custom && custom.cancel) custom.cancel();
        custom = null;
        mode = 'pinch';
        moved = true;
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.cam.zoom, world: view.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
      }
    });

    el.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (!pts.has(e.pointerId)) {
        if (opts.onHover) opts.onHover(view.toWorld(p.x, p.y), e);
        return;
      }
      pts.set(e.pointerId, p);
      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        view.cam.zoom = clampZoom((pinch.zoom * d) / pinch.d);
        // Mantener bajo los dedos el mismo punto del mundo.
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        view.cam.x = pinch.world.x - (mx - view.w / 2) / view.cam.zoom;
        view.cam.y = pinch.world.y - (my - view.h / 2) / view.cam.zoom;
        if (opts.onPan) opts.onPan();
        return;
      }
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > 6) moved = true;
      if (!moved) return;
      if (mode === 'custom') custom.move(view.toWorld(p.x, p.y), e);
      else if (mode === 'pan' || mode === 'forcepan') {
        view.cam.x -= (p.x - last.x) / view.cam.zoom;
        view.cam.y -= (p.y - last.y) / view.cam.zoom;
        if (opts.onPan) opts.onPan();
      }
      last = p;
    });

    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pos(e);
      pts.delete(e.pointerId);
      if (pts.size === 0) {
        const world = view.toWorld(p.x, p.y);
        if (e.type === 'pointercancel') {
          if (custom && custom.cancel) custom.cancel();
        } else if (mode === 'custom') custom.end(world, moved, e);
        else if (mode === 'pan' && !moved && opts.onTap) opts.onTap(world, e);
        mode = custom = null;
      } else if (pts.size === 1) {
        mode = 'forcepan';
        moved = true;
        last = start = [...pts.values()][0];
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      const before = view.toWorld(p.x, p.y);
      view.cam.zoom = clampZoom(view.cam.zoom * Math.exp(-e.deltaY * 0.0015));
      view.cam.x = before.x - (p.x - view.w / 2) / view.cam.zoom;
      view.cam.y = before.y - (p.y - view.h / 2) / view.cam.zoom;
      if (opts.onPan) opts.onPan();
    }, { passive: false });
  }

  /* ---------- Bucle de dibujo bajo demanda ---------- */

  function scheduler(draw) {
    let queued = false;
    return function request() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        draw();
      });
    };
  }

  /* ---------- Animación de fichas ---------- */

  class Animator {
    constructor(duration = 450) {
      this.m = new Map();
      this.duration = duration;
    }
    _cur(a, now) {
      const k = Math.min(1, (now - a.t0) / this.duration);
      const e = k * (2 - k);
      return { x: a.fx + (a.tx - a.fx) * e, y: a.fy + (a.ty - a.fy) * e };
    }
    update(tokens) {
      const now = performance.now();
      const seen = new Set();
      for (const t of tokens) {
        seen.add(t.id);
        const a = this.m.get(t.id);
        if (!a) this.m.set(t.id, { fx: t.x, fy: t.y, tx: t.x, ty: t.y, t0: -1e9 });
        else if (a.tx !== t.x || a.ty !== t.y) {
          const p = this._cur(a, now);
          a.fx = p.x; a.fy = p.y; a.tx = t.x; a.ty = t.y; a.t0 = now;
        }
      }
      for (const id of this.m.keys()) if (!seen.has(id)) this.m.delete(id);
    }
    reset() {
      this.m.clear();
    }
    snap(t) {
      this.m.set(t.id, { fx: t.x, fy: t.y, tx: t.x, ty: t.y, t0: -1e9 });
    }
    pos(t) {
      const a = this.m.get(t.id);
      return a ? this._cur(a, performance.now()) : { x: t.x, y: t.y };
    }
    get active() {
      const now = performance.now();
      for (const a of this.m.values()) if (now - a.t0 < this.duration) return true;
      return false;
    }
  }

  /* ---------- Imágenes de mapa ---------- */

  const images = new Map();
  function image(url, onload) {
    if (!url) return null;
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.onload = onload;
      img.src = url;
      images.set(url, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /* ---------- Dibujo ---------- */

  function polyPath(ctx, pts) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i) ctx.lineTo(pts[i].x, pts[i].y);
      else ctx.moveTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();
  }

  /** Círculo o sector (cono) de radio R centrado en el observador. */
  function piePath(ctx, v, R) {
    ctx.beginPath();
    if (v.angle >= 360) ctx.arc(v.x, v.y, R, 0, TAU);
    else {
      const half = (v.angle * Math.PI) / 360;
      ctx.moveTo(v.x, v.y);
      ctx.arc(v.x, v.y, R, v.facing - half, v.facing + half);
      ctx.closePath();
    }
  }

  function drawBackdrop(view, scene, img) {
    const ctx = view.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, view.canvas.width, view.canvas.height);
    view.applyWorld(ctx);
    if (img) ctx.drawImage(img, 0, 0, scene.width, scene.height);
    else {
      ctx.fillStyle = '#cfc5ad';
      ctx.fillRect(0, 0, scene.width, scene.height);
    }
    if (scene.showGrid) {
      const g = scene.gridSize;
      ctx.beginPath();
      for (let x = 0; x <= scene.width + 0.5; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, scene.height); }
      for (let y = 0; y <= scene.height + 0.5; y += g) { ctx.moveTo(0, y); ctx.lineTo(scene.width, y); }
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 1 / view.cam.zoom;
      ctx.stroke();
    }
  }

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 150 ? '#111' : '#fff';
  }

  /** opts: { alpha, me, selected, label } */
  function drawToken(view, t, pos, grid, opts = {}) {
    const ctx = view.ctx, z = view.cam.zoom;
    const r = Vision.tokenRadius(t, grid);
    ctx.save();
    ctx.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
    if (opts.selected || opts.me) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 5 / z, 0, TAU);
      ctx.strokeStyle = opts.selected ? '#ffd54a' : '#ffffff';
      ctx.lineWidth = 2.5 / z;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, TAU);
    ctx.fillStyle = t.color;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5 / z, r * 0.1);
    ctx.strokeStyle = t.kind === 'npc' ? '#1a0000' : '#101018';
    ctx.stroke();
    // Marca de orientación
    const fx = Math.cos(t.facing || 0), fy = Math.sin(t.facing || 0);
    ctx.beginPath();
    ctx.moveTo(pos.x + fx * r * 0.7, pos.y + fy * r * 0.7);
    ctx.lineTo(pos.x + fx * r * 1.3, pos.y + fy * r * 1.3);
    ctx.lineWidth = Math.max(2 / z, r * 0.16);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    // Inicial
    ctx.fillStyle = textColorFor(t.color);
    ctx.font = `600 ${r}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((t.name || '?').trim().charAt(0).toUpperCase(), pos.x, pos.y + r * 0.06);
    // Nombre
    if (opts.label !== false) {
      const fs = 12 / z;
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3 / z;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineJoin = 'round';
      ctx.strokeText(t.name, pos.x, pos.y + r + 5 / z);
      ctx.fillStyle = '#fff';
      ctx.fillText(t.name, pos.x, pos.y + r + 5 / z);
    }
    ctx.restore();
  }

  /** Movimiento propuesto: línea discontinua + ficha fantasma en el destino. */
  function drawProposal(view, t, from, to, grid) {
    const ctx = view.ctx, z = view.cam.zoom;
    const r = Vision.tokenRadius(t, grid);
    ctx.save();
    ctx.setLineDash([8 / z, 6 / z]);
    ctx.lineWidth = 3 / z;
    ctx.strokeStyle = t.color;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.lineWidth = 5 / z;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(to.x, to.y, r, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 3 / z;
    ctx.strokeStyle = t.color;
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = t.color;
    ctx.fill();
    ctx.restore();
  }

  /* ---------- Memoria de lo explorado ---------- */

  // Opacidad de la niebla sobre lo ya explorado que ahora no se ve (0 = sin niebla, 1 = negro).
  const MEMORY_ALPHA = 0.3;

  function decodeBits(b64, len) {
    if (!b64) return null;
    let bin;
    try { bin = atob(b64); } catch { return null; }
    if (bin.length !== len) return null;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Convierte la memoria que envía el servidor en una imagen pequeña (una celda = un píxel).
   * head: { cols, rows, cell }. list: mapas de bits en base64; se unen todos.
   */
  function exploredMask(head, list) {
    if (!head) return null;
    const n = head.cols * head.rows, len = Math.ceil(n / 8);
    const acc = new Uint8Array(len);
    let any = false;
    for (const b64 of list) {
      const bits = decodeBits(b64, len);
      if (!bits) continue;
      any = true;
      for (let k = 0; k < len; k++) acc[k] |= bits[k];
    }
    if (!any) return null;
    const canvas = document.createElement('canvas');
    canvas.width = head.cols;
    canvas.height = head.rows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(head.cols, head.rows);
    for (let i = 0; i < n; i++) if ((acc[i >> 3] >> (i & 7)) & 1) img.data[i * 4 + 3] = 255;
    ctx.putImageData(img, 0, 0);
    return { canvas, w: head.cols * head.cell, h: head.rows * head.cell };
  }

  /* ---------- Niebla ---------- */

  /**
   * Calcula la zona visible por un conjunto de observadores y devuelve un lienzo
   * negro con esa zona recortada, listo para pintarse encima del mapa.
   */
  class Fog {
    constructor(view) {
      this.view = view;
      this.light = document.createElement('canvas');
      this.tmp = document.createElement('canvas');
      this.vis = document.createElement('canvas');
      this.fog = document.createElement('canvas');
      this.cache = new Map();
      this.cacheKey = null;
    }

    _prep(c) {
      const W = this.view.canvas.width, H = this.view.canvas.height;
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      return ctx;
    }

    /** Polígono de visibilidad con caché mientras no cambien las paredes. */
    poly(env, x, y, maxR) {
      if (this.cacheKey !== env.segs) { this.cacheKey = env.segs; this.cache.clear(); }
      const key = x.toFixed(1) + ',' + y.toFixed(1) + ',' + (isFinite(maxR) ? Math.round(maxR) : 'inf');
      let p = this.cache.get(key);
      if (!p) {
        if (this.cache.size > 300) this.cache.clear();
        p = Vision.visibilityPolygon(x, y, env.segs, env.bounds, maxR);
        this.cache.set(key, p);
      }
      return p;
    }

    /**
     * env: { segs, lights:[{x,y,r}], grid, dark, bounds }. viewers: fichas con posición ya animada.
     * memory: resultado de exploredMask() o null. Lo explorado queda bajo una niebla tenue,
     * lo nunca visto en negro y lo que se ve ahora, despejado.
     */
    render(env, viewers, memory) {
      const view = this.view, g = env.grid;
      const vis = this._prep(this.vis);

      if (env.dark) {
        const lc = this._prep(this.light);
        view.applyWorld(lc);
        for (const L of env.lights) {
          lc.save();
          lc.beginPath();
          lc.arc(L.x, L.y, L.r, 0, TAU);
          lc.clip();
          polyPath(lc, this.poly(env, L.x, L.y, L.r));
          lc.fill();
          lc.restore();
        }
      }

      for (const v of viewers) {
        const ts = (v.truesight || 0) * g, range = (v.range || 0) * g, dv = (v.darkvision || 0) * g;
        const tc = this._prep(this.tmp);
        view.applyWorld(tc);
        if (!env.dark) {
          const R = range > 0 ? Math.max(range, ts) : BIG;
          tc.save();
          piePath(tc, v, R);
          tc.clip();
          polyPath(tc, this.poly(env, v.x, v.y, range > 0 ? R : Infinity));
          tc.fill();
          tc.restore();
        } else {
          // (zona iluminada ∩ alcance) ∪ visión en la oscuridad / verdadera…
          tc.save();
          if (range > 0) {
            tc.beginPath();
            tc.arc(v.x, v.y, range, 0, TAU);
            tc.clip();
          }
          tc.setTransform(1, 0, 0, 1, 0, 0);
          tc.drawImage(this.light, 0, 0);
          tc.restore();
          view.applyWorld(tc);
          const R2 = Math.max(dv, ts);
          if (R2 > 0) {
            tc.beginPath();
            tc.arc(v.x, v.y, R2, 0, TAU);
            tc.fill();
          }
          // …∩ línea de visión ∩ cono.
          const maxR = range > 0 ? Math.max(range, R2) : Infinity;
          tc.globalCompositeOperation = 'destination-in';
          polyPath(tc, this.poly(env, v.x, v.y, maxR));
          tc.fill();
          if (v.angle < 360) {
            piePath(tc, v, BIG);
            tc.fill();
          }
        }
        vis.drawImage(this.tmp, 0, 0);
      }

      const fc = this._prep(this.fog);
      fc.fillStyle = '#000';
      fc.fillRect(0, 0, this.fog.width, this.fog.height);
      fc.globalCompositeOperation = 'destination-out';
      if (memory) {
        fc.globalAlpha = 1 - MEMORY_ALPHA;
        view.applyWorld(fc);
        fc.imageSmoothingEnabled = true;
        fc.drawImage(memory.canvas, 0, 0, memory.w, memory.h);
        fc.setTransform(1, 0, 0, 1, 0, 0);
        fc.globalAlpha = 1;
      }
      fc.drawImage(this.vis, 0, 0);
      return this.fog;
    }
  }

  function drawFog(view, fogCanvas, alpha) {
    const ctx = view.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(fogCanvas, 0, 0);
    ctx.restore();
  }

  return { TAU, BIG, qs, esc, connect, View, attachInput, scheduler, Animator, image, polyPath, piePath, drawBackdrop, drawToken, drawProposal, exploredMask, Fog, drawFog };
})();
