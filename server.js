'use strict';

/*
 * Palantir — servidor.
 *
 * El servidor es la autoridad: guarda el estado de cada partida y decide qué
 * fichas ve cada cliente. A un jugador nunca se le envía la posición de un PNJ
 * que su personaje no puede ver.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Vision = require('./shared/vision');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const MAPS_DIR = path.join(DATA_DIR, 'maps');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MAP_BYTES = 25 * 1024 * 1024;
const DEFAULT_PC_ANGLE = 180; // grados de campo de visión de un jugador recién creado

fs.mkdirSync(ROOMS_DIR, { recursive: true });
fs.mkdirSync(MAPS_DIR, { recursive: true });

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990'];
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/* ---------- Partidas ---------- */

const rooms = new Map(); // code -> room (persistido)
const runtime = new Map(); // code -> { clients:Set<ws>, pending:boolean, saveTimer }

function rt(room) {
  let r = runtime.get(room.code);
  if (!r) runtime.set(room.code, (r = { clients: new Set(), pending: false, saveTimer: null }));
  return r;
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (const b of crypto.randomBytes(5)) c += alphabet[b % alphabet.length];
    if (!rooms.has(c)) return c;
  }
}

function createRoom() {
  const room = {
    code: newCode(),
    gmKey: crypto.randomBytes(16).toString('hex'),
    scene: { map: null, width: 2100, height: 1400, gridSize: 70, showGrid: true, dark: false, alliesAlwaysVisible: true },
    walls: [],
    lights: [],
    tokens: [],
    proposals: {},
    partyCam: null,
  };
  rooms.set(room.code, room);
  save(room);
  return room;
}

function save(room) {
  const r = rt(room);
  if (r.saveTimer) return;
  r.saveTimer = setTimeout(() => {
    r.saveTimer = null;
    const file = path.join(ROOMS_DIR, room.code + '.json');
    fs.writeFile(file + '.tmp', JSON.stringify(room), (err) => {
      if (err) return console.error('No se pudo guardar la partida', room.code, err.message);
      fs.rename(file + '.tmp', file, () => {});
    });
  }, 800);
}

function loadRooms() {
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const room = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8'));
      if (room && room.code && room.gmKey) rooms.set(room.code, room);
    } catch (e) {
      console.error('Partida ilegible:', f, e.message);
    }
  }
}

/* ---------- Validación ---------- */

function num(v, def, min, max) {
  v = Number(v);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}

function str(v, def, max) {
  if (typeof v !== 'string') return def;
  return v.trim().slice(0, max) || def;
}

function color(v, def) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : def;
}

const COORD = 100000;

function applyTokenPatch(t, p) {
  if (!p || typeof p !== 'object') return;
  if ('name' in p) t.name = str(p.name, t.name, 40);
  if ('color' in p) t.color = color(p.color, t.color);
  if ('kind' in p) t.kind = p.kind === 'npc' ? 'npc' : 'pc';
  if ('x' in p) t.x = num(p.x, t.x, -COORD, COORD);
  if ('y' in p) t.y = num(p.y, t.y, -COORD, COORD);
  if ('facing' in p) t.facing = num(p.facing, t.facing, -10, 10);
  if ('size' in p) t.size = num(p.size, t.size, 0.5, 6);
  if ('range' in p) t.range = num(p.range, t.range, 0, 1000);
  if ('angle' in p) t.angle = num(p.angle, t.angle, 10, 360);
  if ('darkvision' in p) t.darkvision = num(p.darkvision, t.darkvision, 0, 1000);
  if ('truesight' in p) t.truesight = num(p.truesight, t.truesight, 0, 1000);
  if ('light' in p) t.light = num(p.light, t.light, 0, 1000);
  if ('hidden' in p) t.hidden = !!p.hidden;
  if ('invisible' in p) t.invisible = !!p.invisible;
}

/* ---------- Operaciones del máster ---------- */

function moveToken(room, t, x, y) {
  x = num(x, t.x, -COORD, COORD);
  y = num(y, t.y, -COORD, COORD);
  if (Math.hypot(x - t.x, y - t.y) > 1) t.facing = Math.atan2(y - t.y, x - t.x);
  t.x = x;
  t.y = y;
  delete room.proposals[t.id];
}

function gmOp(room, m) {
  const token = () => room.tokens.find((t) => t.id === m.id);
  switch (m.op) {
    case 'setScene': {
      const s = room.scene, p = m.patch || {};
      if ('gridSize' in p) s.gridSize = num(p.gridSize, s.gridSize, 10, 500);
      if ('showGrid' in p) s.showGrid = !!p.showGrid;
      if ('dark' in p) s.dark = !!p.dark;
      if ('alliesAlwaysVisible' in p) s.alliesAlwaysVisible = !!p.alliesAlwaysVisible;
      break;
    }
    case 'setMap': {
      const old = room.scene.map;
      if (m.url == null) {
        room.scene.map = null;
      } else {
        const re = new RegExp('^/maps/' + room.code + '-[a-f0-9]+\\.(png|jpg|webp)$');
        if (typeof m.url !== 'string' || !re.test(m.url)) return;
        room.scene.map = m.url;
        room.scene.width = num(m.width, 2100, 50, 20000);
        room.scene.height = num(m.height, 1400, 50, 20000);
      }
      if (old && old !== room.scene.map) fs.unlink(path.join(MAPS_DIR, path.basename(old)), () => {});
      break;
    }
    case 'addWalls': {
      if (!Array.isArray(m.walls)) return;
      for (const w of m.walls.slice(0, 200)) {
        if (!w || room.walls.length >= 5000) break;
        const wall = {
          id: newId(),
          x1: num(w.x1, 0, -COORD, COORD), y1: num(w.y1, 0, -COORD, COORD),
          x2: num(w.x2, 0, -COORD, COORD), y2: num(w.y2, 0, -COORD, COORD),
          type: w.type === 'door' ? 'door' : 'wall',
          open: false,
        };
        if (Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) >= 2) room.walls.push(wall);
      }
      break;
    }
    case 'delWall':
      room.walls = room.walls.filter((w) => w.id !== m.id);
      break;
    case 'undoWall':
      room.walls.pop();
      break;
    case 'clearWalls':
      room.walls = [];
      break;
    case 'toggleDoor': {
      const w = room.walls.find((x) => x.id === m.id && x.type === 'door');
      if (w) w.open = !w.open;
      break;
    }
    case 'addLight':
      if (room.lights.length < 500) {
        room.lights.push({ id: newId(), x: num(m.x, 0, -COORD, COORD), y: num(m.y, 0, -COORD, COORD), radius: num(m.radius, 6, 0.5, 200) });
      }
      break;
    case 'delLight':
      room.lights = room.lights.filter((l) => l.id !== m.id);
      break;
    case 'addToken': {
      if (room.tokens.length >= 300) return;
      const kind = m.kind === 'npc' ? 'npc' : 'pc';
      const count = room.tokens.filter((t) => t.kind === kind).length;
      const t = {
        id: newId(),
        name: (kind === 'pc' ? 'Jugador ' : 'PNJ ') + (count + 1),
        kind,
        color: kind === 'pc' ? PALETTE[count % PALETTE.length] : '#8b1e1e',
        x: num(m.x, 0, -COORD, COORD), y: num(m.y, 0, -COORD, COORD),
        facing: 0, size: 1,
        // Un personaje no ve lo que tiene a la espalda: por defecto, medio círculo hacia donde mira.
        range: 0, angle: kind === 'pc' ? DEFAULT_PC_ANGLE : 360, darkvision: 0, truesight: 0, light: 0,
        hidden: false, invisible: false,
      };
      room.tokens.push(t);
      break;
    }
    case 'updToken': {
      const t = token();
      if (t) applyTokenPatch(t, m.patch);
      break;
    }
    case 'delToken':
      room.tokens = room.tokens.filter((t) => t.id !== m.id);
      delete room.proposals[m.id];
      break;
    case 'moveToken': {
      const t = token();
      if (t) moveToken(room, t, m.x, m.y);
      break;
    }
    case 'setProposal': {
      const t = token();
      if (t) room.proposals[t.id] = { x: num(m.x, t.x, -COORD, COORD), y: num(m.y, t.y, -COORD, COORD) };
      break;
    }
    case 'approve': {
      const t = token(), p = room.proposals[m.id];
      if (t && p) moveToken(room, t, p.x, p.y);
      break;
    }
    case 'reject':
      delete room.proposals[m.id];
      break;
    case 'approveAll':
      for (const t of room.tokens) {
        const p = room.proposals[t.id];
        if (p) moveToken(room, t, p.x, p.y);
      }
      room.proposals = {};
      break;
    default:
      return;
  }
  changed(room);
}

/* ---------- Vistas por cliente ---------- */

function publicToken(t) {
  return { id: t.id, name: t.name, kind: t.kind, color: t.color, x: t.x, y: t.y, facing: t.facing, size: t.size, angle: t.angle };
}

function viewerToken(t) {
  return {
    id: t.id, name: t.name, color: t.color, x: t.x, y: t.y, facing: t.facing, size: t.size,
    range: t.range, angle: t.angle, darkvision: t.darkvision, truesight: t.truesight, light: t.light,
  };
}

function viewFor(room, meta) {
  const base = { t: 'state', role: meta.role, code: room.code, scene: room.scene, partyCam: room.partyCam };
  if (meta.role === 'gm') {
    const online = [];
    for (const c of rt(room).clients) if (c.meta.role === 'player' && c.meta.tokenId) online.push(c.meta.tokenId);
    return { ...base, walls: room.walls, lights: room.lights, tokens: room.tokens, proposals: room.proposals, online };
  }

  const grid = room.scene.gridSize;
  const segs = Vision.blocking(room.walls);
  const lights = Vision.collectLights(room.tokens, room.lights, grid);
  const env = { segs, lights, grid, dark: room.scene.dark };
  const pcs = room.tokens.filter((t) => t.kind === 'pc');
  const viewers = meta.role === 'party' ? pcs.filter((t) => !t.hidden) : pcs.filter((t) => t.id === meta.tokenId);

  const tokens = room.tokens.filter((t) => {
    if (viewers.includes(t)) return true;
    if (t.hidden) return false;
    if (t.kind === 'pc' && room.scene.alliesAlwaysVisible) return true;
    return viewers.some((v) => Vision.tokenVisible(v, t, env));
  });

  const proposals = {};
  for (const v of viewers) if (room.proposals[v.id]) proposals[v.id] = room.proposals[v.id];

  return {
    ...base,
    segs: segs.map((w) => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
    lights,
    viewers: viewers.map(viewerToken),
    tokens: tokens.map(publicToken),
    proposals,
    me: meta.role === 'player' && viewers[0] ? viewers[0].id : null,
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  const r = rt(room);
  if (r.pending) return;
  r.pending = true;
  setImmediate(() => {
    r.pending = false;
    for (const ws of r.clients) send(ws, viewFor(room, ws.meta));
  });
}

function changed(room) {
  save(room);
  broadcast(room);
}

/* ---------- HTTP ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, baseDir, rel, cache) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache || 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/info' && req.method === 'GET') return json(res, 200, { lan: lanAddresses(), port: PORT });

  if (p === '/api/rooms' && req.method === 'POST') {
    const room = createRoom();
    return json(res, 200, { code: room.code, gmKey: room.gmKey });
  }

  let m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{1,12})$/);
  if (m && req.method === 'GET') {
    const room = rooms.get(m[1].toUpperCase());
    if (!room) return json(res, 404, { error: 'No existe esa partida' });
    const pcs = room.tokens.filter((t) => t.kind === 'pc').map((t) => ({ id: t.id, name: t.name, color: t.color }));
    return json(res, 200, { code: room.code, pcs });
  }

  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{1,12})\/map$/);
  if (m && req.method === 'POST') {
    const room = rooms.get(m[1].toUpperCase());
    if (!room) return json(res, 404, { error: 'No existe esa partida' });
    if (req.headers['x-gm-key'] !== room.gmKey) return json(res, 403, { error: 'Clave de máster incorrecta' });
    const ext = IMAGE_EXT[(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext) return json(res, 415, { error: 'Formato no admitido (usa PNG, JPG o WebP)' });
    let body;
    try {
      body = await readBody(req, MAX_MAP_BYTES);
    } catch {
      return json(res, 413, { error: 'El mapa es demasiado grande (máx. 25 MB)' });
    }
    const name = `${room.code}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    await fs.promises.writeFile(path.join(MAPS_DIR, name), body);
    return json(res, 200, { url: '/maps/' + name });
  }

  if (p === '/qr.svg' && req.method === 'GET') {
    const text = (url.searchParams.get('text') || '').slice(0, 500);
    if (!text) return json(res, 400, { error: 'text requerido' });
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  if (p.startsWith('/maps/')) return serveFile(res, MAPS_DIR, p.slice(6), 'public, max-age=31536000, immutable');
  if (p === '/shared/vision.js') return serveFile(res, path.join(__dirname, 'shared'), 'vision.js');
  return serveFile(res, PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'error interno' });
    else res.end();
  });
});

/* ---------- WebSocket ---------- */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  ws.meta = null;
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      if (ws.meta) return;
      const room = rooms.get(String(m.room || '').toUpperCase());
      if (!room) return send(ws, { t: 'error', code: 'no-room', msg: 'No existe esa partida' });
      const role = m.role === 'gm' ? 'gm' : m.role === 'party' ? 'party' : 'player';
      if (role === 'gm' && m.key !== room.gmKey) return send(ws, { t: 'error', code: 'bad-key', msg: 'Clave de máster incorrecta' });
      ws.meta = { code: room.code, role, tokenId: role === 'player' ? String(m.tokenId || '') : null };
      rt(room).clients.add(ws);
      broadcast(room); // también actualiza la lista de conectados del máster
      return;
    }

    if (!ws.meta) return;
    const room = rooms.get(ws.meta.code);
    if (!room) return;

    if (ws.meta.role === 'gm') {
      if (m.t === 'op') gmOp(room, m);
      else if (m.t === 'cam') {
        const r = m.rect;
        room.partyCam = r && typeof r === 'object'
          ? { x: num(r.x, 0, -COORD, COORD), y: num(r.y, 0, -COORD, COORD), w: num(r.w, 1000, 10, COORD), h: num(r.h, 1000, 10, COORD) }
          : null;
        save(room);
        for (const c of rt(room).clients) if (c.meta.role === 'party') send(c, { t: 'cam', rect: room.partyCam });
      }
      return;
    }

    if (ws.meta.role === 'player') {
      const t = room.tokens.find((x) => x.id === ws.meta.tokenId && x.kind === 'pc');
      if (!t) return;
      if (m.t === 'propose') {
        room.proposals[t.id] = { x: num(m.x, t.x, -COORD, COORD), y: num(m.y, t.y, -COORD, COORD) };
        changed(room);
      } else if (m.t === 'cancel') {
        delete room.proposals[t.id];
        changed(room);
      } else if (m.t === 'face') {
        t.facing = num(m.angle, t.facing, -10, 10);
        changed(room);
      }
    }
  });

  ws.on('close', () => {
    if (!ws.meta) return;
    const room = rooms.get(ws.meta.code);
    if (!room) return;
    rt(room).clients.delete(ws);
    broadcast(room);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30000).unref();

loadRooms();
server.listen(PORT, () => {
  console.log(`Palantir escuchando en http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  En tu red local: http://${ip}:${PORT}`);
});
