'use strict';

/*
 * Pruebas de seguridad: arrancan el servidor de verdad y comprueban que los fallos
 * encontrados en la auditoría no vuelven (caídas por mensajes mal formados, fugas de
 * información a los jugadores, límites y contraseña de creación).
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function startServer(port, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-test-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env }, stdio: 'ignore' });
  const srv = { port, base: `http://localhost:${port}`, dir, exited: false };
  proc.on('exit', () => (srv.exited = true));
  srv.stop = () => new Promise((res) => {
    const done = () => { fs.rmSync(dir, { recursive: true, force: true }); res(); };
    if (srv.exited) return done();
    proc.on('exit', done);
    proc.kill('SIGKILL');
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(srv.base + '/api/info'); return srv; } catch { await sleep(100); }
  }
  await srv.stop();
  throw new Error('el servidor de pruebas no arranca');
}

/** Cliente WebSocket que guarda el último estado y todo lo recibido en crudo. */
function client(srv, hello) {
  const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
  const c = { ws, state: null, raw: [], error: null, closed: false, send: (o) => ws.send(JSON.stringify(o)) };
  ws.on('error', () => {});
  ws.on('close', () => (c.closed = true));
  ws.on('message', (d) => {
    c.raw.push(String(d));
    const m = JSON.parse(d);
    if (m.t === 'error') c.error = m;
    if (m.t === 'gmAuth') c.newKey = m.key;
    if (m.t === 'state') c.state = { ...(c.state && c.state.sceneId === m.sceneId ? c.state : {}), ...m };
  });
  c.ready = new Promise((res) => ws.on('open', () => { if (hello) c.send(hello); setTimeout(res, 150); }));
  return c;
}

const newRoom = async (srv, headers = {}) => (await fetch(srv.base + '/api/rooms', { method: 'POST', headers })).json();
const alive = async (srv) => !srv.exited && (await fetch(srv.base + '/api/info')).ok;

test('servidor abierto (sin contraseña de creación)', async (t) => {
  const srv = await startServer(39411);
  t.after(() => srv.stop());
  const { code, gmKey } = await newRoom(srv);
  const gm = client(srv, { t: 'hello', room: code, role: 'gm', key: gmKey });
  await gm.ready;
  const op = (name, data) => gm.send({ t: 'op', op: name, ...data });

  await t.test('una trama WebSocket demasiado grande no tira el servidor', async () => {
    const c = client(srv);
    await c.ready;
    c.ws.send('x'.repeat(300 * 1024));
    await sleep(400);
    assert.ok(await alive(srv));
  });

  await t.test('una trama WebSocket inválida no tira el servidor', async () => {
    const sock = net.connect(srv.port, 'localhost');
    await new Promise((r) => sock.on('connect', r));
    sock.on('error', () => {});
    sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    await sleep(200);
    sock.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    await sleep(400);
    sock.destroy();
    assert.ok(await alive(srv));
  });

  await t.test('mensajes de máster mal formados no tiran el servidor', async () => {
    const junk = ['x', 5, true, null, [], [1, 2], { a: 1 }];
    for (const v of junk) {
      for (const name of ['setScene', 'updToken', 'updRoster', 'addWalls', 'setMap', 'spawn', 'combatInit', 'release', 'approve', 'renameScene', 'viewScene', 'rotateX']) {
        gm.send({ t: 'op', op: name, patch: v, walls: v, id: v, url: v, name: v, x: v, y: v, init: v });
      }
      gm.send({ t: 'cam', rect: v });
      gm.send({ t: v, op: v });
    }
    gm.ws.send('[]'); gm.ws.send('null'); gm.ws.send('"hello"'); gm.ws.send('{"t":"op","op":"approve","id":"__proto__"}');
    gm.ws.send('{"t":"op","op":"reject","id":"constructor"}'); gm.ws.send('no es json');
    await sleep(500);
    assert.ok(await alive(srv));
    assert.equal({}.polluted, undefined);
  });

  await t.test('rutas raras devuelven error sin tirar el servidor ni salir de la carpeta pública', async () => {
    for (const p of ['/%00', '/%zz', '/..%2f..%2fserver.js', '/%2e%2e/%2e%2e/package.json', '/maps/..%2f..%2fserver.js', '/shared/..%2fserver.js']) {
      const r = await fetch(srv.base + p).catch(() => ({ status: 0 }));
      assert.ok(r.status === 404 || r.status === 403 || r.status === 500, `${p} -> ${r.status}`);
      if (r.text) assert.ok(!(await r.text()).includes('WebSocketServer'), p);
    }
    assert.ok(await alive(srv));
  });

  await t.test('todas las respuestas llevan cabeceras de seguridad', async () => {
    for (const p of ['/', '/gm.html', '/api/info', '/common.js']) {
      const h = (await fetch(srv.base + p)).headers;
      assert.match(h.get('content-security-policy'), /script-src 'self'/, p);
      assert.match(h.get('content-security-policy'), /frame-ancestors 'none'/, p);
      assert.equal(h.get('x-content-type-options'), 'nosniff', p);
      assert.equal(h.get('x-frame-options'), 'DENY', p);
    }
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'gm.html'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(!/\son[a-z]+\s*=/.test(html) && !/<script(?![^>]*\ssrc=)/.test(html), 'las páginas no llevan scripts ni manejadores en línea');
  });

  await t.test('solo se aceptan imágenes de verdad como mapa', async () => {
    const up = (body, type = 'image/png') => fetch(`${srv.base}/api/rooms/${code}/map`, { method: 'POST', headers: { 'Content-Type': type, 'X-GM-Key': gmKey }, body });
    assert.equal((await up('<html><script>alert(1)</script>')).status, 415);
    assert.equal((await up(PNG, 'image/jpeg')).status, 415, 'el contenido debe coincidir con el tipo declarado');
    assert.equal((await up(PNG, 'image/svg+xml')).status, 415);
    assert.equal((await up(PNG)).status, 200);
    assert.equal((await fetch(`${srv.base}/api/rooms/${code}/map`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-GM-Key': 'x' }, body: PNG })).status, 403);
  });

  await t.test('los mapas subidos sin usar tienen tope por partida', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(`${srv.base}/api/rooms/${code}/map`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-GM-Key': gmKey }, body: PNG })).status);
    assert.ok(statuses.includes(429), statuses.join(','));
  });

  await t.test('el QR y /api/info no sirven para otra cosa', async () => {
    assert.equal((await fetch(srv.base + '/qr.svg?text=' + encodeURIComponent('https://sitio-malicioso.example/premio'))).status, 400);
    assert.equal((await fetch(srv.base + '/qr.svg?text=' + encodeURIComponent(`http://192.168.1.20:3000/?room=${code}`))).status, 200);
    const info = await (await fetch(srv.base + '/api/info')).json();
    assert.equal(info.needsPassword, false);
  });

  await t.test('un identificador de jugador con formato inválido se ignora', async () => {
    const c = client(srv, { t: 'hello', room: code, role: 'player', tokenId: 'A'.repeat(100000) });
    await c.ready;
    await sleep(200);
    assert.ok(c.state && c.state.me === null);
    assert.deepEqual(gm.state.online, []);
  });

  await t.test('quien conecta sin identificarse es expulsado', async () => {
    const c = client(srv);
    await c.ready;
    await sleep(10600);
    assert.equal(c.closed, true);
  });

  await t.test('lo que recibe un jugador no incluye lo que no debe ver', async () => {
    op('addWalls', { walls: [{ x1: 1050, y1: 0, x2: 1050, y2: 1400 }] });
    op('addToken', { kind: 'pc', x: 500, y: 700 });
    op('addToken', { kind: 'npc', x: 1600, y: 333 }); // tras el muro, con antorcha
    op('addToken', { kind: 'npc', x: 800, y: 700 }); // a la vista, con antorcha
    await sleep(300);
    const [pc, hiddenNpc, seenNpc] = gm.state.tokens;
    op('updToken', { id: pc.id, patch: { range: 0 } });
    op('updToken', { id: hiddenNpc.id, patch: { light: 4, name: 'Emboscado', notes: 'SECRETO-DEL-MASTER', hp: 77, hpMax: 77 } });
    op('updToken', { id: seenNpc.id, patch: { light: 3 } });
    op('renameScene', { id: gm.state.sceneId, name: 'NOMBRE-QUE-DESTRIPA' });
    await sleep(250);
    const p = client(srv, { t: 'hello', room: code, role: 'player', tokenId: pc.id });
    await p.ready;
    await sleep(300);
    const all = () => p.raw.join('\n');
    assert.ok(!p.state.tokens.some((x) => x.id === hiddenNpc.id), 'el PNJ tras el muro no está en las fichas');
    assert.deepEqual(p.state.lights, [], 'con la escena iluminada no se envían luces');
    assert.ok(!all().includes('1600') && !all().includes(hiddenNpc.id), 'ni su posición ni su identificador viajan');
    assert.ok(!all().includes('NOMBRE-QUE-DESTRIPA') && !('sceneName' in p.state), 'el nombre de la escena es solo del máster');
    assert.ok(!all().includes('SECRETO-DEL-MASTER') && !all().includes('hpMax') && !all().includes(gmKey), 'ni la ficha privada ni la clave de máster');
    assert.ok(!all().includes(gm.state.gmCode) && !all().includes(gm.state.partyKey), 'ni el código de máster ni la clave de party');

    // A oscuras: llega la luz que alumbra algo que su personaje puede ver, no la de detrás del muro.
    op('setScene', { patch: { dark: true } });
    await sleep(300);
    assert.ok(p.state.lights.some((l) => l.x === 800 && l.y === 700), 'la antorcha visible sí llega');
    assert.ok(!p.state.lights.some((l) => l.x === 1600), 'la antorcha tras el muro no');
    assert.ok(!all().includes(hiddenNpc.id));
    op('setScene', { patch: { dark: false } });
    p.ws.close();
  });

  await t.test('cambiar el código de máster invalida las credenciales anteriores', async () => {
    const oldCode = gm.state.gmCode, oldParty = gm.state.partyKey;
    const second = client(srv, { t: 'hello', room: code, role: 'gm', key: gmKey });
    const party = client(srv, { t: 'hello', room: code, role: 'party', key: oldParty });
    await second.ready; await party.ready;
    op('rotateGm');
    await sleep(300);
    assert.ok(gm.newKey && gm.newKey !== gmKey && gm.state.gmCode !== oldCode && gm.state.partyKey !== oldParty);
    assert.ok(second.closed && party.closed, 'los demás dispositivos de máster y las pantallas de party quedan fuera');
    const stale = client(srv, { t: 'hello', room: code, role: 'gm', key: gmKey });
    await stale.ready;
    assert.equal(stale.error && stale.error.code, 'bad-key');
    const login = (c) => fetch(srv.base + '/api/gm-login', { method: 'POST', body: JSON.stringify({ code: c }) });
    assert.equal((await login(oldCode)).status, 403);
    const fresh = await login(gm.state.gmCode);
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).gmKey, gm.newKey);
    assert.equal((await fetch(`${srv.base}/api/rooms/${code}/export`, { headers: { 'X-GM-Key': gmKey } })).status, 403);
  });

  await t.test('muchos muros cruzados no bloquean el servidor', async () => {
    const other = await newRoom(srv);
    const g2 = client(srv, { t: 'hello', room: other.code, role: 'gm', key: other.gmKey });
    await g2.ready;
    const N = 9000, walls = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI;
      walls.push({ x1: 1050 + Math.cos(a) * 900, y1: 700 + Math.sin(a) * 650, x2: 1050 - Math.cos(a) * 900 + (i % 7), y2: 700 - Math.sin(a) * 650 + (i % 5) });
    }
    for (let i = 0; i < N; i += 500) g2.send({ t: 'op', op: 'addWalls', walls: walls.slice(i, i + 500) });
    g2.send({ t: 'op', op: 'addToken', kind: 'pc', x: 300, y: 300 });
    await sleep(2500);
    assert.ok(g2.state.walls.length <= 8000, 'hay un máximo de muros por escena: ' + g2.state.walls.length);
    const pcId = g2.state.tokens[0].id;
    g2.send({ t: 'op', op: 'updToken', id: pcId, patch: { range: 0 } });
    const pl = client(srv, { t: 'hello', room: other.code, role: 'player', tokenId: pcId });
    await pl.ready;
    for (let i = 0; i < 30; i++) pl.send({ t: 'face', angle: i / 10 });
    await sleep(300);
    // Mientras esa partida calcula, las demás peticiones siguen recibiendo respuesta pronto.
    let worst = 0;
    for (let i = 0; i < 8; i++) {
      const t0 = Date.now();
      assert.ok((await fetch(srv.base + '/api/info')).ok);
      worst = Math.max(worst, Date.now() - t0);
      await sleep(150);
    }
    assert.ok(worst < 4000, `la peor respuesta tardó ${worst} ms`);
    assert.ok(await alive(srv));
    g2.ws.close(); pl.ws.close();
  });

  await t.test('una inundación de mensajes se descarta', async () => {
    const before = gm.state.tokens.length;
    for (let i = 0; i < 3000; i++) op('addToken', { kind: 'npc', x: i, y: i });
    await sleep(1200);
    assert.ok(gm.state.tokens.length - before <= 300, 'añadidos: ' + (gm.state.tokens.length - before));
    assert.ok(await alive(srv));
  });

  await t.test('probar códigos de partida al azar tiene freno', async () => {
    const statuses = new Set();
    for (let k = 0; k < 4; k++) {
      await Promise.all(Array.from({ length: 100 }, async (_, i) => statuses.add((await fetch(`${srv.base}/api/rooms/ZZ${k}${String(i).padStart(3, '0')}`)).status)));
    }
    assert.ok(statuses.has(429), [...statuses].join(','));
  });

  await t.test('una copia de seguridad descomunal se rechaza antes de leerla', async () => {
    const res = await fetch(srv.base + '/api/import', { method: 'POST', headers: { 'Content-Length': String(500 * 1024 * 1024) }, body: 'x', duplex: 'half' }).catch(() => ({ status: 400 }));
    assert.ok(res.status === 400 || res.status === 413);
    assert.ok(await alive(srv));
  });
});

test('servidor con contraseña de creación', async (t) => {
  const srv = await startServer(39412, { CREATE_PASSWORD: 'clave-de-prueba-ñ' });
  t.after(() => srv.stop());
  const pw = { 'X-Create-Password': encodeURIComponent('clave-de-prueba-ñ') };

  await t.test('crear una partida exige la contraseña', async () => {
    assert.equal((await (await fetch(srv.base + '/api/info')).json()).needsPassword, true);
    assert.equal((await fetch(srv.base + '/api/rooms', { method: 'POST' })).status, 401);
    assert.equal((await fetch(srv.base + '/api/rooms', { method: 'POST', headers: { 'X-Create-Password': 'otra' } })).status, 401);
    assert.equal((await fetch(srv.base + '/api/rooms', { method: 'POST', headers: { 'X-Create-Password': '%' } })).status, 401);
    const ok = await fetch(srv.base + '/api/rooms', { method: 'POST', headers: pw });
    assert.equal(ok.status, 200);
    const room = await ok.json();
    assert.match(room.code, /^[A-Z2-9]{6}$/);
  });

  await t.test('restaurar una copia exige la contraseña', async () => {
    const backup = JSON.stringify({ format: 'palantir-backup', scenes: [{ name: 'Sala' }], maps: {} });
    assert.equal((await fetch(srv.base + '/api/import', { method: 'POST', body: backup })).status, 401);
    assert.equal((await fetch(srv.base + '/api/import', { method: 'POST', headers: pw, body: backup })).status, 200);
  });

  await t.test('continuar una partida existente no la necesita', async () => {
    const { code, gmKey } = await newRoom(srv, pw);
    const gm = client(srv, { t: 'hello', room: code, role: 'gm', key: gmKey });
    await gm.ready;
    assert.ok(gm.state && gm.state.gmCode);
    const login = await fetch(srv.base + '/api/gm-login', { method: 'POST', body: JSON.stringify({ code: gm.state.gmCode }) });
    assert.equal(login.status, 200);
    assert.equal((await fetch(`${srv.base}/api/rooms/${code}`)).status, 200);
    gm.ws.close();
  });

  await t.test('las partidas se guardan con permisos restringidos', async () => {
    await sleep(1200);
    const files = fs.readdirSync(path.join(srv.dir, 'rooms'));
    assert.ok(files.length > 0);
    for (const f of files) assert.equal(fs.statSync(path.join(srv.dir, 'rooms', f)).mode & 0o077, 0, f);
    assert.equal(fs.statSync(path.join(srv.dir, 'rooms')).mode & 0o077, 0);
  });
});
