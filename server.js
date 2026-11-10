'use strict';

/*
 * Palantir — servidor.
 *
 * El servidor es la autoridad: guarda el estado de cada partida y decide qué
 * fichas ve cada cliente. A un jugador nunca se le envía la posición de un PNJ
 * que su personaje no puede ver.
 *
 * Una partida tiene varias escenas. Los jugadores están siempre en la escena
 * activa; el máster puede abrir cualquier otra para prepararla. Cada escena
 * conserva su propio estado (fichas, puertas, lo explorado) y se guarda sola.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Vision = require('./shared/vision');
const Fog = require('./fog');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const MAPS_DIR = path.join(DATA_DIR, 'maps');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MAP_BYTES = 60 * 1024 * 1024;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_WALLS = 20000;
const MAX_SCENES = 60;
const DEFAULT_PC_ANGLE = 180; // grados de campo de visión de un jugador recién creado
// Datos del personaje (iguales en todas las escenas). Posición, orientación y
// ocultación son propias de cada escena.
const CHAR_FIELDS = ['name', 'color', 'size', 'range', 'angle', 'darkvision', 'truesight', 'light'];

fs.mkdirSync(ROOMS_DIR, { recursive: true });
fs.mkdirSync(MAPS_DIR, { recursive: true });

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990'];
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/* ---------- Partidas y escenas ---------- */

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

function blankScene(name) {
  return {
    id: newId(),
    name,
    scene: { map: null, width: 2100, height: 1400, gridSize: 70, showGrid: true, dark: false, alliesAlwaysVisible: true },
    walls: [],
    lights: [],
    tokens: [],
    proposals: {},
    explored: {}, // pcId -> mapa de bits en base64
    fogSpec: '',
    fogRev: 0,
    wallsRev: 0,
    start: null, // punto de inicio para «Reiniciar»: { at, tokens, doors }
  };
}

const sceneById = (room, id) => room.scenes.find((s) => s.id === id) || null;
const activeScene = (room) => sceneById(room, room.activeSceneId) || room.scenes[0];

function createRoom() {
  const first = blankScene('Escena 1');
  const room = { code: newCode(), gmKey: crypto.randomBytes(16).toString('hex'), scenes: [first], activeSceneId: first.id, partyCam: null };
  rooms.set(room.code, room);
  save(room);
  return room;
}

/** Los personajes jugadores existen en todas las escenas: al crear una, se colocan en su centro. */
function seedPcs(room, sc) {
  const src = activeScene(room);
  if (!src || src === sc) return;
  const pcs = src.tokens.filter((t) => t.kind === 'pc');
  pcs.forEach((p, i) => sc.tokens.push({ ...p, ...startSpot(sc, i, pcs.length), facing: 0, hidden: false, invisible: false }));
}

function startSpot(sc, i, n) {
  return { x: sc.scene.width / 2 + (i - (n - 1) / 2) * sc.scene.gridSize, y: sc.scene.height / 2 };
}

function snapshot(sc) {
  const doors = {};
  for (const w of sc.walls) if (w.type === 'door') doors[w.id] = w.open;
  return { at: Date.now(), tokens: JSON.parse(JSON.stringify(sc.tokens)), doors };
}

/**
 * Devuelve la escena a su punto de inicio: posiciones, PNJ eliminados y puertas.
 * Lo que se añadió después se conserva tal cual. Siempre borra lo explorado.
 */
function resetScene(sc) {
  if (sc.start) {
    const snap = new Map(sc.start.tokens.map((t) => [t.id, t]));
    const present = new Set(sc.tokens.map((t) => t.id));
    for (const t of sc.tokens) {
      const s = snap.get(t.id);
      if (!s) continue;
      t.x = s.x; t.y = s.y; t.facing = s.facing; t.hidden = s.hidden; t.invisible = s.invisible;
    }
    for (const s of sc.start.tokens) {
      if (s.kind === 'npc' && !present.has(s.id)) sc.tokens.push(JSON.parse(JSON.stringify(s)));
    }
    for (const w of sc.walls) if (w.type === 'door' && w.id in sc.start.doors) w.open = sc.start.doors[w.id];
    sc.wallsRev++;
  }
  sc.proposals = {};
  sc.explored = {};
  sc.fogRev++;
}

function unlinkMap(url) {
  if (url) fs.unlink(path.join(MAPS_DIR, path.basename(url)), () => {});
}

/* ---------- Guardado ---------- */

const roomFile = (room) => path.join(ROOMS_DIR, room.code + '.json');

function save(room) {
  const r = rt(room);
  if (r.saveTimer) return;
  r.saveTimer = setTimeout(() => {
    r.saveTimer = null;
    const file = roomFile(room);
    fs.writeFile(file + '.tmp', JSON.stringify(room), (err) => {
      if (err) return console.error('No se pudo guardar la partida', room.code, err.message);
      fs.rename(file + '.tmp', file, () => {});
    });
  }, 800);
}

/** Al parar el servidor se escribe lo que quedara pendiente, para no perder los últimos cambios. */
function flushSync() {
  for (const [code, r] of runtime) {
    if (!r.saveTimer) continue;
    clearTimeout(r.saveTimer);
    r.saveTimer = null;
    const room = rooms.get(code);
    if (!room) continue;
    try {
      fs.writeFileSync(roomFile(room), JSON.stringify(room));
    } catch (e) {
      console.error('No se pudo guardar la partida', code, e.message);
    }
  }
}

function migrate(room) {
  if (!Array.isArray(room.scenes) || !room.scenes.length) {
    // Formato anterior: una sola escena en la raíz de la partida.
    const sc = blankScene('Escena 1');
    if (room.scene) sc.scene = room.scene;
    sc.walls = room.walls || [];
    sc.lights = room.lights || [];
    sc.tokens = room.tokens || [];
    sc.proposals = room.proposals || {};
    room.scenes = [sc];
    room.activeSceneId = sc.id;
    for (const k of ['scene', 'walls', 'lights', 'tokens', 'proposals']) delete room[k];
  }
  for (const sc of room.scenes) {
    const blank = blankScene('');
    for (const k of Object.keys(blank)) if (!(k in sc)) sc[k] = blank[k];
  }
  if (!sceneById(room, room.activeSceneId)) room.activeSceneId = room.scenes[0].id;
}

function loadRooms() {
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const room = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8'));
      if (!room || !room.code || !room.gmKey) continue;
      migrate(room);
      rooms.set(room.code, room);
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
const coord = (v) => Math.round(num(v, 0, -COORD, COORD) * 10) / 10;

function mapUrlOk(room, url) {
  return typeof url === 'string' && new RegExp('^/maps/' + room.code + '-[a-f0-9]+\\.(png|jpg|webp)$').test(url);
}

function pushWall(sc, x1, y1, x2, y2, type, open) {
  if (sc.walls.length >= MAX_WALLS) return;
  const w = { id: newId(), x1: coord(x1), y1: coord(y1), x2: coord(x2), y2: coord(y2), type: type === 'door' ? 'door' : 'wall', open: !!open };
  if (Math.hypot(w.x2 - w.x1, w.y2 - w.y1) >= 2) sc.walls.push(w);
}

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

function moveToken(sc, t, x, y) {
  x = num(x, t.x, -COORD, COORD);
  y = num(y, t.y, -COORD, COORD);
  if (Math.hypot(x - t.x, y - t.y) > 1) t.facing = Math.atan2(y - t.y, x - t.x);
  t.x = x;
  t.y = y;
  delete sc.proposals[t.id];
}

function removePcEverywhere(room, id, except) {
  for (const s of room.scenes) {
    if (s === except) continue;
    s.tokens = s.tokens.filter((t) => !(t.id === id && t.kind === 'pc'));
    delete s.proposals[id];
    delete s.explored[id];
    if (s.start) s.start.tokens = s.start.tokens.filter((t) => t.id !== id);
  }
}

function addPcEverywhere(room, t, except) {
  for (const s of room.scenes) {
    if (s === except || s.tokens.some((x) => x.id === t.id)) continue;
    const n = s.tokens.filter((x) => x.kind === 'pc').length;
    s.tokens.push({ ...t, ...startSpot(s, n, n + 1), facing: 0, hidden: false, invisible: false });
  }
}

function gmOp(room, ws, m) {
  const sc = sceneById(room, ws.meta.sceneId) || activeScene(room);
  const token = () => sc.tokens.find((t) => t.id === m.id);
  const target = () => sceneById(room, m.id);

  switch (m.op) {
    /* --- Escenas --- */
    case 'viewScene':
      if (target()) ws.meta.sceneId = m.id;
      return sendState(ws, room);
    case 'activateScene': {
      const s = target();
      if (!s) return;
      room.activeSceneId = s.id;
      room.partyCam = null;
      ws.meta.sceneId = s.id;
      break;
    }
    case 'addScene': {
      if (room.scenes.length >= MAX_SCENES) return;
      const s = blankScene(str(m.name, 'Escena ' + (room.scenes.length + 1), 60));
      seedPcs(room, s);
      room.scenes.push(s);
      ws.meta.sceneId = s.id;
      break;
    }
    case 'renameScene': {
      const s = target();
      if (s) s.name = str(m.name, s.name, 60);
      break;
    }
    case 'delScene': {
      const s = target();
      if (!s || room.scenes.length <= 1) return;
      room.scenes = room.scenes.filter((x) => x !== s);
      unlinkMap(s.scene.map);
      if (room.activeSceneId === s.id) {
        room.activeSceneId = room.scenes[0].id;
        room.partyCam = null;
      }
      break;
    }
    case 'resetScene': {
      const s = target();
      if (s) resetScene(s);
      break;
    }
    case 'setStart': {
      const s = target();
      if (!s) return;
      s.start = snapshot(s);
      s.proposals = {};
      s.explored = {};
      s.fogRev++;
      break;
    }

    /* --- Escena abierta --- */
    case 'setScene': {
      const s = sc.scene, p = m.patch || {};
      if ('gridSize' in p) s.gridSize = num(p.gridSize, s.gridSize, 10, 500);
      if ('showGrid' in p) s.showGrid = !!p.showGrid;
      if ('dark' in p) s.dark = !!p.dark;
      if ('alliesAlwaysVisible' in p) s.alliesAlwaysVisible = !!p.alliesAlwaysVisible;
      break;
    }
    case 'setMap': {
      const old = sc.scene.map;
      if (m.url == null) {
        sc.scene.map = null;
      } else {
        if (!mapUrlOk(room, m.url)) return;
        sc.scene.map = m.url;
        sc.scene.width = num(m.width, 2100, 50, 20000);
        sc.scene.height = num(m.height, 1400, 50, 20000);
      }
      if (old && old !== sc.scene.map) unlinkMap(old);
      break;
    }
    case 'addWalls':
      if (!Array.isArray(m.walls)) return;
      for (const w of m.walls.slice(0, 500)) if (w) pushWall(sc, w.x1, w.y1, w.x2, w.y2, w.type, false);
      sc.wallsRev++;
      break;
    case 'delWall':
      sc.walls = sc.walls.filter((w) => w.id !== m.id);
      sc.wallsRev++;
      break;
    case 'undoWall':
      sc.walls.pop();
      sc.wallsRev++;
      break;
    case 'clearWalls':
      sc.walls = [];
      sc.wallsRev++;
      break;
    case 'toggleDoor': {
      const w = sc.walls.find((x) => x.id === m.id && x.type === 'door');
      if (w) w.open = !w.open;
      sc.wallsRev++;
      break;
    }
    case 'addLight':
      if (sc.lights.length < 2000) {
        sc.lights.push({ id: newId(), x: num(m.x, 0, -COORD, COORD), y: num(m.y, 0, -COORD, COORD), radius: num(m.radius, 6, 0.5, 200) });
      }
      break;
    case 'delLight':
      sc.lights = sc.lights.filter((l) => l.id !== m.id);
      break;
    case 'addToken': {
      if (sc.tokens.length >= 300) return;
      const kind = m.kind === 'npc' ? 'npc' : 'pc';
      const count = sc.tokens.filter((t) => t.kind === kind).length;
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
      sc.tokens.push(t);
      if (kind === 'pc') addPcEverywhere(room, t, sc);
      break;
    }
    case 'updToken': {
      const t = token();
      if (!t) return;
      const was = t.kind;
      applyTokenPatch(t, m.patch);
      if (was === 'pc' && t.kind === 'npc') removePcEverywhere(room, t.id, sc);
      else if (was === 'npc' && t.kind === 'pc') addPcEverywhere(room, t, sc);
      else if (t.kind === 'pc') {
        // La ficha de personaje es la misma en todas las escenas.
        for (const s of room.scenes) {
          const other = s !== sc && s.tokens.find((x) => x.id === t.id);
          if (other) for (const f of CHAR_FIELDS) other[f] = t[f];
        }
      }
      break;
    }
    case 'delToken': {
      const t = token();
      if (!t) return;
      sc.tokens = sc.tokens.filter((x) => x !== t);
      delete sc.proposals[t.id];
      if (t.kind === 'pc') {
        delete sc.explored[t.id];
        removePcEverywhere(room, t.id, sc);
      }
      break;
    }
    case 'moveToken': {
      const t = token();
      if (t) moveToken(sc, t, m.x, m.y);
      break;
    }
    case 'setProposal': {
      const t = token();
      if (t) sc.proposals[t.id] = { x: num(m.x, t.x, -COORD, COORD), y: num(m.y, t.y, -COORD, COORD) };
      break;
    }
    case 'approve': {
      const t = token(), p = sc.proposals[m.id];
      if (t && p) moveToken(sc, t, p.x, p.y);
      break;
    }
    case 'reject':
      delete sc.proposals[m.id];
      break;
    case 'approveAll':
      for (const t of sc.tokens) {
        const p = sc.proposals[t.id];
        if (p) moveToken(sc, t, p.x, p.y);
      }
      sc.proposals = {};
      break;
    default:
      return;
  }
  changed(room);
}

/* ---------- Visión y memoria de lo explorado ---------- */

const segsCache = new WeakMap(); // escena -> { rev, segs }

/** Muros que bloquean, reutilizando la lista mientras no cambien (así el motor aprovecha sus cachés). */
function blockingSegs(sc) {
  const c = segsCache.get(sc);
  if (c && c.rev === sc.wallsRev && c.walls === sc.walls) return c.segs;
  const segs = Vision.blocking(sc.walls);
  segsCache.set(sc, { rev: sc.wallsRev, walls: sc.walls, segs });
  return segs;
}

function envOf(sc) {
  const s = sc.scene;
  return {
    segs: blockingSegs(sc),
    lights: Vision.collectLights(sc.tokens, sc.lights, s.gridSize),
    grid: s.gridSize,
    dark: s.dark,
    bounds: { x0: 0, y0: 0, x1: s.width, y1: s.height },
  };
}

/** La escena activa «empieza» cuando entra el primer jugador: ahí se fija su punto de inicio. */
function maybeStart(room) {
  const sc = activeScene(room);
  if (sc.start) return;
  for (const c of rt(room).clients) {
    if (c.meta.role !== 'gm') {
      sc.start = snapshot(sc);
      return;
    }
  }
}

function updateExplored(room) {
  const sc = activeScene(room);
  if (!sc.start) return;
  const sp = Fog.spec(sc.scene), key = Fog.specKey(sp);
  if (sc.fogSpec !== key) {
    sc.fogSpec = key;
    sc.explored = {};
    sc.fogRev++;
  }
  const env = envOf(sc);
  let lit = null;
  for (const t of sc.tokens) {
    if (t.kind !== 'pc' || t.hidden) continue;
    if (env.dark && !lit) lit = Fog.litBits(env, sp);
    const merged = Fog.merge(sc.explored[t.id], Fog.seenBits(t, env, sp, lit));
    if (merged) {
      sc.explored[t.id] = merged;
      sc.fogRev++;
    }
  }
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

function sceneSummary(sc) {
  return {
    id: sc.id, name: sc.name, map: sc.scene.map,
    npcs: sc.tokens.filter((t) => t.kind === 'npc').length,
    walls: sc.walls.length,
    startAt: sc.start ? sc.start.at : null,
  };
}

/**
 * Envía a un cliente su vista. Los muros y la memoria de lo explorado pueden
 * pesar bastante, así que solo viajan cuando han cambiado desde el último envío.
 */
function sendState(ws, room) {
  const meta = ws.meta;
  const active = activeScene(room);
  const sc = (meta.role === 'gm' && sceneById(room, meta.sceneId)) || active;
  if (meta.role === 'gm') meta.sceneId = sc.id;

  const view = { t: 'state', role: meta.role, code: room.code, sceneId: sc.id, sceneName: sc.name, scene: sc.scene, partyCam: sc === active ? room.partyCam : null };

  const wallsKey = sc.id + ':' + sc.wallsRev + ':' + sc.walls.length;
  const sendWalls = meta.wallsKey !== wallsKey;
  meta.wallsKey = wallsKey;
  const fogKey = sc.id + ':' + sc.fogRev + ':' + (sc.start ? sc.start.at : 0);
  const sendFog = meta.fogKey !== fogKey;
  meta.fogKey = fogKey;
  const sp = Fog.spec(sc.scene);
  const fogHead = { cols: sp.cols, rows: sp.rows, cell: sp.cell };

  if (meta.role === 'gm') {
    const online = [];
    for (const c of rt(room).clients) if (c.meta.role === 'player' && c.meta.tokenId) online.push(c.meta.tokenId);
    view.lights = sc.lights;
    view.tokens = sc.tokens;
    view.proposals = sc.proposals;
    view.online = online;
    view.scenes = room.scenes.map(sceneSummary);
    view.activeSceneId = active.id;
    view.startAt = sc.start ? sc.start.at : null;
    if (sendWalls) view.walls = sc.walls;
    if (sendFog) view.explored = sc.start ? { ...fogHead, by: sc.explored } : null;
    return send(ws, view);
  }

  const env = envOf(sc);
  const pcs = sc.tokens.filter((t) => t.kind === 'pc');
  const viewers = meta.role === 'party' ? pcs.filter((t) => !t.hidden) : pcs.filter((t) => t.id === meta.tokenId);

  const tokens = sc.tokens.filter((t) => {
    if (viewers.includes(t)) return true;
    if (t.hidden) return false;
    if (t.kind === 'pc' && sc.scene.alliesAlwaysVisible) return true;
    return viewers.some((v) => Vision.tokenVisible(v, t, env));
  });

  view.proposals = {};
  for (const v of viewers) if (sc.proposals[v.id]) view.proposals[v.id] = sc.proposals[v.id];
  view.lights = env.lights;
  view.viewers = viewers.map(viewerToken);
  view.tokens = tokens.map(publicToken);
  view.me = meta.role === 'player' && viewers[0] ? viewers[0].id : null;
  if (sendWalls) view.segs = env.segs.map((w) => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }));
  if (sendFog) {
    const bits = meta.role === 'party' ? Fog.union(viewers.map((v) => sc.explored[v.id]), sp) : (viewers[0] && sc.explored[viewers[0].id]) || null;
    view.explored = sc.start ? { ...fogHead, bits } : null;
  }
  send(ws, view);
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
    for (const ws of r.clients) sendState(ws, room);
  });
}

function changed(room) {
  maybeStart(room);
  updateExplored(room);
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

/** Crea una escena ya montada (mapa, muros, puertas y luces). Lo usa la importación de Dungeondraft. */
function importScene(room, data) {
  const sc = blankScene(str(data.name, 'Escena importada', 60));
  const s = sc.scene;
  if (data.map && mapUrlOk(room, data.map.url)) s.map = data.map.url;
  s.width = num(data.width, s.width, 50, 20000);
  s.height = num(data.height, s.height, 50, 20000);
  s.gridSize = num(data.gridSize, s.gridSize, 10, 500);
  s.dark = !!data.dark;
  s.showGrid = false; // los mapas de Dungeondraft ya suelen llevar la cuadrícula dibujada
  for (const w of Array.isArray(data.walls) ? data.walls : []) if (Array.isArray(w)) pushWall(sc, w[0], w[1], w[2], w[3], 'wall', false);
  for (const d of Array.isArray(data.doors) ? data.doors : []) if (Array.isArray(d)) pushWall(sc, d[0], d[1], d[2], d[3], 'door', d[4]);
  for (const l of (Array.isArray(data.lights) ? data.lights : []).slice(0, 2000)) {
    if (Array.isArray(l)) sc.lights.push({ id: newId(), x: coord(l[0]), y: coord(l[1]), radius: num(l[2], 6, 0.5, 200) });
  }
  seedPcs(room, sc);
  room.scenes.push(sc);
  return sc;
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
    const pcs = activeScene(room).tokens.filter((t) => t.kind === 'pc').map((t) => ({ id: t.id, name: t.name, color: t.color }));
    return json(res, 200, { code: room.code, pcs });
  }

  m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{1,12})\/(map|scenes)$/);
  if (m && req.method === 'POST') {
    const room = rooms.get(m[1].toUpperCase());
    if (!room) return json(res, 404, { error: 'No existe esa partida' });
    if (req.headers['x-gm-key'] !== room.gmKey) return json(res, 403, { error: 'Clave de máster incorrecta' });

    if (m[2] === 'map') {
      const ext = IMAGE_EXT[(req.headers['content-type'] || '').split(';')[0].trim()];
      if (!ext) return json(res, 415, { error: 'Formato no admitido (usa PNG, JPG o WebP)' });
      let body;
      try {
        body = await readBody(req, MAX_MAP_BYTES);
      } catch {
        return json(res, 413, { error: 'El mapa es demasiado grande (máx. 60 MB)' });
      }
      const name = `${room.code}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
      await fs.promises.writeFile(path.join(MAPS_DIR, name), body);
      return json(res, 200, { url: '/maps/' + name });
    }

    if (room.scenes.length >= MAX_SCENES) return json(res, 400, { error: 'Demasiadas escenas en esta partida' });
    let data;
    try {
      data = JSON.parse((await readBody(req, MAX_IMPORT_BYTES)).toString('utf8'));
    } catch {
      return json(res, 400, { error: 'No se pudo leer la escena' });
    }
    if (!data || typeof data !== 'object') return json(res, 400, { error: 'No se pudo leer la escena' });
    const sc = importScene(room, data);
    changed(room);
    return json(res, 200, { id: sc.id, walls: sc.walls.length, lights: sc.lights.length });
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
  if (p === '/shared/vision.js' || p === '/shared/uvtt.js') return serveFile(res, path.join(__dirname, 'shared'), p.slice(8));
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
      ws.meta = { code: room.code, role, tokenId: role === 'player' ? String(m.tokenId || '') : null, sceneId: null, wallsKey: null, fogKey: null };
      rt(room).clients.add(ws);
      if (role === 'gm') broadcast(room);
      else changed(room); // la entrada de un jugador puede dar comienzo a la escena
      return;
    }

    if (!ws.meta) return;
    const room = rooms.get(ws.meta.code);
    if (!room) return;

    if (ws.meta.role === 'gm') {
      if (m.t === 'op') gmOp(room, ws, m);
      else if (m.t === 'cam') {
        // El encuadre solo se comparte si el máster está viendo la escena en la que están los jugadores.
        if (ws.meta.sceneId && ws.meta.sceneId !== activeScene(room).id) return;
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
      const sc = activeScene(room);
      const t = sc.tokens.find((x) => x.id === ws.meta.tokenId && x.kind === 'pc');
      if (!t) return;
      if (m.t === 'propose') {
        sc.proposals[t.id] = { x: num(m.x, t.x, -COORD, COORD), y: num(m.y, t.y, -COORD, COORD) };
        changed(room);
      } else if (m.t === 'cancel') {
        delete sc.proposals[t.id];
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

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flushSync();
    process.exit(0);
  });
}

loadRooms();
server.listen(PORT, () => {
  console.log(`Palantir escuchando en http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  En tu red local: http://${ip}:${PORT}`);
});
