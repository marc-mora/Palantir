/* Pantalla del máster: lo ve todo, edita el mapa y aprueba los movimientos. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const code = (P.qs.get('room') || '').toUpperCase();
  const KEY = 'palantir.gm.' + code;

  // El enlace de máster lleva la clave en el hash; se guarda y se limpia de la barra.
  const hashKey = (location.hash.match(/key=([a-f0-9]+)/) || [])[1];
  if (hashKey) {
    localStorage.setItem(KEY, hashKey);
    history.replaceState(null, '', location.pathname + location.search);
  }
  const key = localStorage.getItem(KEY);
  if (!code || !key) {
    $('overlayMsg').textContent = 'Este navegador no tiene la clave de máster de esta partida. Usa el enlace de máster o crea una partida nueva.';
    $('overlay').classList.remove('hidden');
    return;
  }

  const view = new P.View($('c'));
  const fog = new P.Fog(view);
  const anim = new P.Animator();
  const redraw = P.scheduler(draw);
  view.onResize = redraw;

  let S = null; // estado del servidor
  let sel = null; // id de la ficha seleccionada
  let tool = 'select';
  let draft = null; // { pts:[inicio] } al dibujar muros, { rect:[a,b] } al dibujar un bloque
  let hover = null;
  let preview = 'gm'; // 'gm' | 'party' | id de ficha
  let fittedFor; // mapa para el que ya se encajó la cámara
  let selectNew = false;
  let syncInit = false;
  let camTimer = null;
  let exploredRaw = null; // memoria de lo explorado tal como la envía el servidor
  let memoryCache = { key: null, mask: null };
  let scenesSeen = false;

  const HINTS = {
    select: 'Arrastra una ficha para moverla · clic en una puerta para abrirla o cerrarla · arrastra el fondo para mover el mapa · rueda para zoom',
    wall: 'Clic para empezar un muro y clic para cada esquina · doble clic o Esc para terminar · Mayús ajusta a la cuadrícula',
    rect: 'Arrastra para dibujar una columna u objeto que tape la vista · botón derecho para mover el mapa',
    door: 'Clic en un extremo y clic en el otro para crear una puerta',
    light: 'Clic para colocar una luz fija (solo se nota con la escena a oscuras)',
    erase: 'Clic sobre un muro, puerta o luz para borrarlo',
  };

  const conn = P.connect(() => ({ t: 'hello', room: code, role: 'gm', key }), {
    onStatus(on) {
      $('status').classList.toggle('on', on);
    },
    onMessage(m) {
      if (m.t === 'error') {
        if (m.code === 'bad-key' || m.code === 'no-room') {
          $('overlayMsg').textContent = m.msg;
          $('overlay').classList.remove('hidden');
        } else toast(m.msg);
        return;
      }
      if (m.t !== 'state') return;
      const sameScene = S && S.sceneId === m.sceneId;
      const known = sameScene ? new Set(S.tokens.map((t) => t.id)) : null;
      // Los muros y lo explorado solo llegan cuando cambian.
      if (m.walls) m.segs = Vision.blocking(m.walls);
      else {
        m.walls = sameScene ? S.walls : [];
        m.segs = sameScene ? S.segs : [];
      }
      if (m.explored !== undefined) {
        exploredRaw = m.explored;
        memoryCache = { key: null, mask: null };
      }
      if (S && !sameScene) {
        // Se ha abierto otra escena.
        anim.reset();
        sel = null;
        draft = null;
        preview = 'gm';
        fittedFor = undefined;
      }
      S = m;
      anim.update(S.tokens);
      if (selectNew && known) {
        const fresh = S.tokens.find((t) => !known.has(t.id));
        if (fresh) sel = fresh.id;
        selectNew = false;
      }
      if (sel && !S.tokens.some((t) => t.id === sel)) sel = null;
      const fitKey = S.sceneId + '|' + S.scene.map + '|' + S.scene.width + 'x' + S.scene.height;
      if (fittedFor !== fitKey) {
        fittedFor = fitKey;
        fit();
      }
      if (!scenesSeen) {
        scenesSeen = true;
        showScenes(true);
      }
      renderScenes();
      if (!syncInit) {
        syncInit = true;
        $('syncParty').checked = !!S.partyCam;
      }
      renderPanel();
      redraw();
    },
  });

  const op = (name, data) => conn.send({ t: 'op', op: name, ...data });

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  function fit() {
    if (S) view.fit({ x: 0, y: 0, w: S.scene.width, h: S.scene.height });
    camChanged();
    redraw();
  }

  /* ---------- Sincronizar el encuadre con la pantalla de party ---------- */

  function camChanged() {
    if (!$('syncParty').checked || camTimer || !S || S.sceneId !== S.activeSceneId) return;
    camTimer = setTimeout(() => {
      camTimer = null;
      if ($('syncParty').checked) conn.send({ t: 'cam', rect: view.rect() });
    }, 80);
  }
  $('syncParty').onchange = (e) => {
    conn.send({ t: 'cam', rect: e.target.checked ? view.rect() : null });
  };

  /* ---------- Búsqueda de elementos bajo el cursor ---------- */

  const tokenById = (id) => (S ? S.tokens.find((t) => t.id === id) : null);

  function tokenAt(w) {
    const g = S.scene.gridSize;
    for (let i = S.tokens.length - 1; i >= 0; i--) {
      const t = S.tokens[i];
      if (Math.hypot(w.x - t.x, w.y - t.y) <= Math.max(Vision.tokenRadius(t, g), 10 / view.cam.zoom)) return t;
    }
    return null;
  }

  function proposalAt(w) {
    const g = S.scene.gridSize;
    for (const id of Object.keys(S.proposals)) {
      const t = tokenById(id), p = S.proposals[id];
      if (t && Math.hypot(w.x - p.x, w.y - p.y) <= Math.max(Vision.tokenRadius(t, g), 10 / view.cam.zoom)) return id;
    }
    return null;
  }

  function wallAt(w, doorsOnly) {
    let best = null, bd = 10 / view.cam.zoom;
    for (const s of S.walls) {
      if (doorsOnly && s.type !== 'door') continue;
      const d = Vision.distPointSeg(w.x, w.y, s);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  function lightAt(w) {
    return S.lights.find((l) => Math.hypot(w.x - l.x, w.y - l.y) <= 12 / view.cam.zoom) || null;
  }

  /** Ajusta un punto a un extremo de muro cercano (para cerrar esquinas) o a la cuadrícula. */
  function snap(w, toGrid) {
    let best = null, bd = 10 / view.cam.zoom;
    const consider = (x, y) => {
      const d = Math.hypot(w.x - x, w.y - y);
      if (d < bd) { bd = d; best = { x, y }; }
    };
    for (const s of S.walls) { consider(s.x1, s.y1); consider(s.x2, s.y2); }
    if (draft && draft.pts) consider(draft.pts[0].x, draft.pts[0].y);
    if (best) return best;
    if (toGrid || $('snapGrid').checked) {
      const g = S.scene.gridSize / 2;
      return { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
    }
    return { x: w.x, y: w.y };
  }

  /* ---------- Entrada ---------- */

  function select(id) {
    sel = id;
    renderPanel();
    redraw();
  }

  function setTool(t) {
    tool = t;
    draft = null;
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
    $('hint').textContent = HINTS[t];
    $('c').style.cursor = t === 'select' ? 'default' : 'crosshair';
    redraw();
  }

  P.attachInput(view, {
    onPan() {
      camChanged();
      redraw();
    },
    onHover(w) {
      hover = w;
      if (draft) redraw();
    },
    dragStart(w) {
      if (!S) return null;
      if (tool === 'select') {
        const pid = proposalAt(w);
        if (pid) {
          const p = S.proposals[pid], off = { x: p.x - w.x, y: p.y - w.y };
          return {
            move(m) { p.x = m.x + off.x; p.y = m.y + off.y; redraw(); },
            end(m, moved) {
              if (moved) op('setProposal', { id: pid, x: p.x, y: p.y });
              select(pid);
            },
          };
        }
        const t = tokenAt(w);
        if (t) {
          const off = { x: t.x - w.x, y: t.y - w.y }, orig = { x: t.x, y: t.y };
          return {
            move(m) { t.x = m.x + off.x; t.y = m.y + off.y; anim.snap(t); redraw(); },
            end(m, moved) {
              if (moved) op('moveToken', { id: t.id, x: t.x, y: t.y });
              select(t.id);
            },
            cancel() { t.x = orig.x; t.y = orig.y; anim.snap(t); redraw(); },
          };
        }
        return null;
      }
      if (tool === 'rect') {
        const a = snap(w);
        let b = a;
        return {
          move(m, e) { b = snap(m, e && e.shiftKey); draft = { rect: [a, b] }; redraw(); },
          end(m, moved) {
            draft = null;
            if (moved && Math.abs(b.x - a.x) > 3 && Math.abs(b.y - a.y) > 3) {
              const seg = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, type: 'wall' });
              op('addWalls', { walls: [seg(a.x, a.y, b.x, a.y), seg(b.x, a.y, b.x, b.y), seg(b.x, b.y, a.x, b.y), seg(a.x, b.y, a.x, a.y)] });
            }
            redraw();
          },
          cancel() { draft = null; redraw(); },
        };
      }
      return null;
    },
    onTap(w, e) {
      if (!S) return;
      if (tool === 'select') {
        const d = wallAt(w, true);
        if (d) op('toggleDoor', { id: d.id });
        else select(null);
      } else if (tool === 'wall' || tool === 'door') {
        const p = snap(w, e.shiftKey);
        if (!draft) draft = { pts: [p] };
        else {
          const a = draft.pts[0];
          if (Math.hypot(a.x - p.x, a.y - p.y) < 2) draft = null; // clic en el mismo punto: terminar
          else {
            op('addWalls', { walls: [{ x1: a.x, y1: a.y, x2: p.x, y2: p.y, type: tool === 'door' ? 'door' : 'wall' }] });
            draft = tool === 'wall' ? { pts: [p] } : null;
          }
        }
        redraw();
      } else if (tool === 'light') {
        op('addLight', { x: w.x, y: w.y, radius: Number($('lightRadius').value) || 6 });
      } else if (tool === 'erase') {
        const l = lightAt(w);
        if (l) return op('delLight', { id: l.id });
        const s = wallAt(w, false);
        if (s) op('delWall', { id: s.id });
      }
    },
  });

  $('tools').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
  });
  const addToken = (kind) => {
    selectNew = true;
    setTool('select');
    op('addToken', { kind, x: view.cam.x, y: view.cam.y });
  };
  $('addPc').onclick = () => addToken('pc');
  $('addNpc').onclick = () => addToken('npc');
  $('undo').onclick = () => op('undoWall');
  $('fit').onclick = fit;

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      draft = null;
      redraw();
    } else if (typing) {
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      op('undoWall');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      op('delToken', { id: sel });
    }
  });

  /* ---------- Panel lateral ---------- */

  const tokenSec = $('tokenSec');
  const fields = [...tokenSec.querySelectorAll('[data-f]')];
  const deg = (rad) => Math.round((((rad * 180) / Math.PI) % 360 + 360) % 360);

  function renderPanel() {
    if (!S) return;
    const active = document.activeElement;

    // Movimientos propuestos
    const ids = Object.keys(S.proposals).filter(tokenById);
    $('proposalsSec').classList.toggle('hidden', !ids.length);
    $('proposals').innerHTML =
      ids.map((id) => {
        const t = tokenById(id);
        return `<div class="proposal"><span class="dot" style="background:${P.esc(t.color)}"></span><span class="name">${P.esc(t.name)} quiere moverse</span>` +
          `<button class="small primary" data-approve="${id}">Mover</button><button class="small" data-reject="${id}">✕</button></div>`;
      }).join('') +
      (ids.length > 1 ? '<button class="small primary" data-approve-all="1">Mover a todos</button>' : '') +
      (ids.length ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Arrastra el destino en el mapa para corregirlo antes de mover.</p>' : '');

    // Lista de fichas
    const online = new Set(S.online);
    $('tokens').innerHTML = S.tokens.length
      ? S.tokens.map((t) =>
          `<div class="token-row${t.id === sel ? ' sel' : ''}" data-id="${t.id}">` +
          `<span class="dot" style="background:${P.esc(t.color)}"></span><span class="name">${P.esc(t.name)}</span>` +
          (t.hidden ? '<span class="badge">oculta</span>' : '') +
          (t.invisible ? '<span class="badge">invisible</span>' : '') +
          (t.kind === 'pc' ? `<span class="online${online.has(t.id) ? ' on' : ''}" title="${online.has(t.id) ? 'Conectado' : 'Sin conectar'}"></span>` : '<span class="badge">PNJ</span>') +
          '</div>').join('')
      : '<p class="muted" style="font-size:13px">Añade fichas con los botones «＋ Jugador» y «＋ PNJ».</p>';

    // Ficha seleccionada
    const t = tokenById(sel);
    tokenSec.classList.toggle('hidden', !t);
    if (t) {
      for (const el of fields) {
        if (el === active) continue;
        const f = el.dataset.f;
        if (el.type === 'checkbox') el.checked = !!t[f];
        else el.value = f === 'facing' ? deg(t.facing) : t[f];
      }
      $('facingOut').textContent = deg(t.facing) + '°';
      $('angleOut').textContent = t.angle >= 360 ? '360° (todo alrededor)' : t.angle + '°';
      tokenSec.querySelector('.pc-only').classList.toggle('hidden', t.kind !== 'pc');
    }

    // Escena
    const sc = S.scene;
    if (active !== $('gridSize')) $('gridSize').value = sc.gridSize;
    $('showGrid').checked = sc.showGrid;
    $('dark').checked = sc.dark;
    $('allies').checked = sc.alliesAlwaysVisible;

    // Vista previa
    const pcs = S.tokens.filter((x) => x.kind === 'pc');
    if (preview !== 'gm' && preview !== 'party' && !pcs.some((x) => x.id === preview)) preview = 'gm';
    $('preview').innerHTML =
      '<option value="gm">Máster (todo)</option><option value="party">Party (visión conjunta)</option>' +
      pcs.map((x) => `<option value="${x.id}">${P.esc(x.name)}</option>`).join('');
    $('preview').value = preview;
  }

  function sendField(el) {
    const f = el.dataset.f;
    if (!f || !sel) return;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
    if (f === 'facing') v = (v * Math.PI) / 180;
    op('updToken', { id: sel, patch: { [f]: v } });
  }
  tokenSec.addEventListener('input', (e) => {
    const el = e.target;
    if (el.type === 'text' || el.type === 'number') return; // estos esperan a «change»
    sendField(el);
  });
  tokenSec.addEventListener('change', (e) => sendField(e.target));
  $('delToken').onclick = () => sel && op('delToken', { id: sel });

  $('tokens').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) select(row.dataset.id);
  });
  $('tokens').addEventListener('dblclick', (e) => {
    const t = tokenById((e.target.closest('[data-id]') || {}).dataset?.id);
    if (!t) return;
    view.cam.x = t.x;
    view.cam.y = t.y;
    camChanged();
    redraw();
  });

  $('proposals').addEventListener('click', (e) => {
    const d = e.target.dataset;
    if (d.approve) op('approve', { id: d.approve });
    else if (d.reject) op('reject', { id: d.reject });
    else if (d.approveAll) op('approveAll');
  });

  $('gridSize').onchange = (e) => op('setScene', { patch: { gridSize: Number(e.target.value) } });
  $('showGrid').onchange = (e) => op('setScene', { patch: { showGrid: e.target.checked } });
  $('dark').onchange = (e) => op('setScene', { patch: { dark: e.target.checked } });
  $('allies').onchange = (e) => op('setScene', { patch: { alliesAlwaysVisible: e.target.checked } });
  $('clearWalls').onclick = () => {
    if (confirm('¿Borrar todos los muros y puertas de este mapa?')) op('clearWalls');
  };
  $('preview').onchange = (e) => {
    preview = e.target.value;
    redraw();
  };

  $('mapFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadMap(file);
      const dims = await imageSize(url);
      op('setMap', { url, ...dims });
    } catch (err) {
      toast(err.message);
    }
    e.target.value = '';
  };
  $('mapClear').onclick = () => op('setMap', { url: null });

  /* ---------- Pantalla de escenas ---------- */

  function showScenes(on) {
    $('scenesScreen').classList.toggle('hidden', !on);
    if (on) renderScenes();
  }

  const fmtDate = (ms) => new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function renderScenes() {
    if (!S) return;
    const active = S.scenes.find((x) => x.id === S.activeSceneId);
    $('sceneName').textContent = S.sceneName;
    $('awayNote').classList.toggle('hidden', S.sceneId === S.activeSceneId);
    $('awayName').textContent = active ? active.name : '';
    $('scenesCode').textContent = code;
    if ($('scenesScreen').classList.contains('hidden')) return;
    $('sceneCards').innerHTML = S.scenes.map((sc) => {
      const isActive = sc.id === S.activeSceneId;
      return `<div class="scene-card${isActive ? ' active' : ''}${sc.id === S.sceneId ? ' viewing' : ''}" data-id="${sc.id}">` +
        `<div class="thumb${sc.map ? ' has-map' : ''}" data-act="open"${sc.map ? ` style="background-image:url('${P.esc(sc.map)}')"` : ''}>` +
        (isActive ? '<span class="tag">Jugadores aquí</span>' : '') + '</div>' +
        '<div class="body">' +
        `<div class="title">${P.esc(sc.name)}</div>` +
        `<div class="meta muted">${sc.npcs} PNJ · ${sc.walls} muros y puertas<br>` +
        (sc.startAt ? `En curso · inicio fijado el ${fmtDate(sc.startAt)}` : 'Sin empezar') + '</div>' +
        '<div class="actions">' +
        '<button class="primary" data-act="open">Abrir</button>' +
        (isActive ? '' : '<button data-act="play">Jugar aquí</button>') + '</div>' +
        '<div class="actions minor">' +
        '<button data-act="rename">Renombrar</button><button data-act="start">Fijar inicio</button>' +
        '<button data-act="reset">Reiniciar</button>' +
        (S.scenes.length > 1 ? '<button class="danger" data-act="del">Eliminar</button>' : '') +
        '</div></div></div>';
    }).join('');
  }

  $('sceneCards').addEventListener('click', (e) => {
    const act = e.target.dataset.act, card = e.target.closest('[data-id]');
    if (!act || !card) return;
    const id = card.dataset.id, sc = S.scenes.find((x) => x.id === id);
    if (!sc) return;
    if (act === 'open') {
      op('viewScene', { id });
      showScenes(false);
    } else if (act === 'play') {
      op('activateScene', { id });
      showScenes(false);
    } else if (act === 'rename') {
      const name = prompt('Nombre de la escena:', sc.name);
      if (name && name.trim()) op('renameScene', { id, name });
    } else if (act === 'start') {
      if (confirm(`Se guardará el estado actual de «${sc.name}» como punto de inicio y se borrará lo que los jugadores hayan explorado en ella.\n\n¿Continuar?`)) op('setStart', { id });
    } else if (act === 'reset') {
      const what = sc.startAt
        ? `«${sc.name}» volverá a su punto de inicio (${fmtDate(sc.startAt)}): posiciones de las fichas, PNJ eliminados y puertas. Se borrará lo explorado.`
        : `«${sc.name}» aún no ha empezado: solo se borrará lo explorado y los movimientos pendientes.`;
      if (confirm(what + '\n\n¿Reiniciar?')) op('resetScene', { id });
    } else if (act === 'del') {
      if (confirm(`¿Eliminar la escena «${sc.name}» con su mapa, muros y PNJ? No se puede deshacer.`)) op('delScene', { id });
    }
  });

  $('openScenes').onclick = () => showScenes(true);
  $('closeScenes').onclick = () => showScenes(false);
  $('bringHere').onclick = () => op('activateScene', { id: S.sceneId });
  $('newScene').onclick = () => {
    const name = prompt('Nombre de la nueva escena:', 'Escena ' + (S.scenes.length + 1));
    if (!name || !name.trim()) return;
    op('addScene', { name });
    showScenes(false);
  };

  /* ---------- Importar de Dungeondraft (Universal VTT) ---------- */

  function importStatus(msg, isError) {
    const el = $('importStatus');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.classList.toggle('error', !!isError);
  }

  async function uploadMap(blob) {
    const res = await fetch(`/api/rooms/${code}/map`, { method: 'POST', headers: { 'Content-Type': blob.type, 'X-GM-Key': key }, body: blob });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo subir el mapa');
    return data.url;
  }

  const imageSize = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('No se pudo leer la imagen del mapa'));
    img.src = url;
  });

  function base64ToBlob(b64, type) {
    const parts = [];
    const CHUNK = 3 * 256 * 1024 * 4 / 3; // múltiplo de 4 caracteres
    for (let i = 0; i < b64.length; i += CHUNK) {
      const bin = atob(b64.slice(i, i + CHUNK));
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      parts.push(bytes);
    }
    return new Blob(parts, { type });
  }

  async function importDungeondraft(file) {
    try {
      importStatus('Leyendo ' + file.name + '…');
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('El archivo no es un mapa de Dungeondraft. Expórtalo como «Universal VTT» (.dd2vtt).');
      }
      if (!data || !data.resolution) throw new Error('El archivo no es un mapa de Dungeondraft. Expórtalo como «Universal VTT» (.dd2vtt).');
      let map = null, dims = {};
      if (typeof data.image === 'string' && data.image.length > 100) {
        importStatus('Subiendo la imagen del mapa…');
        const b64 = data.image.replace(/\s+/g, '');
        const url = await uploadMap(base64ToBlob(b64, Uvtt.imageMime(b64)));
        dims = await imageSize(url);
        map = { url };
      }
      const parsed = Uvtt.parse(data, dims.width, dims.height);
      importStatus('Creando la escena…');
      const res = await fetch(`/api/rooms/${code}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GM-Key': key },
        body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ''), map, ...parsed }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'No se pudo crear la escena');
      importStatus(`Importada: ${out.walls} muros y puertas, ${out.lights} luces.`);
      op('viewScene', { id: out.id });
      setTimeout(() => {
        importStatus('');
        showScenes(false);
      }, 1200);
    } catch (err) {
      importStatus(err.message || 'No se pudo importar el mapa', true);
    }
  }

  $('importDd').onclick = () => $('ddFile').click();
  $('ddFile').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importDungeondraft(file);
  };

  /* ---------- Enlaces para compartir ---------- */

  (async () => {
    let origin = location.origin;
    try {
      const info = await (await fetch('/api/info')).json();
      // Si el máster abrió «localhost», los móviles necesitan la IP de la red local.
      if (['localhost', '127.0.0.1'].includes(location.hostname) && info.lan.length) origin = `http://${info.lan[0]}:${info.port}`;
    } catch { /* se usa location.origin */ }
    const join = `${origin}/?room=${code}`;
    $('codeBig').textContent = code;
    $('qr').src = '/qr.svg?text=' + encodeURIComponent(join);
    $('joinLink').href = join;
    $('joinLink').textContent = join.replace(/^https?:\/\//, '');
    $('partyLink').href = `${origin}/party.html?room=${code}`;
    $('copyGm').onclick = async () => {
      try {
        await navigator.clipboard.writeText(`${origin}/gm.html?room=${code}#key=${key}`);
        $('copyGm').textContent = 'Copiado';
      } catch {
        prompt('Enlace de máster:', `${origin}/gm.html?room=${code}#key=${key}`);
      }
    };
  })();

  /* ---------- Dibujo ---------- */

  function drawVisionOutline(v, env) {
    const ctx = view.ctx, z = view.cam.zoom, g = env.grid;
    const range = (v.range || 0) * g, ts = (v.truesight || 0) * g;
    const R = range > 0 ? Math.max(range, ts) : P.BIG;
    const poly = fog.poly(env, v.x, v.y, range > 0 ? R : Infinity);
    ctx.save();
    P.piePath(ctx, v, R);
    ctx.clip();
    P.polyPath(ctx, poly);
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = v.color;
    ctx.fill();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = v.color;
    ctx.lineWidth = 4 / z;
    ctx.stroke();
    ctx.restore();
    if (range > 0 || v.angle < 360) {
      ctx.save();
      P.polyPath(ctx, poly);
      ctx.clip();
      P.piePath(ctx, v, R);
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = v.color;
      ctx.lineWidth = 4 / z;
      ctx.stroke();
      ctx.restore();
    }
    if (env.dark && v.darkvision > 0) {
      ctx.save();
      ctx.setLineDash([4 / z, 6 / z]);
      ctx.beginPath();
      ctx.arc(v.x, v.y, v.darkvision * g, 0, P.TAU);
      ctx.strokeStyle = v.color;
      ctx.lineWidth = 1.5 / z;
      ctx.stroke();
      ctx.restore();
    }
  }

  function draw() {
    if (!S) return;
    const ctx = view.ctx, z = view.cam.zoom, scene = S.scene, g = scene.gridSize;
    const live = S.tokens.map((t) => ({ ...t, ...anim.pos(t) }));
    const env = {
      segs: S.segs, lights: Vision.collectLights(live, S.lights, g), grid: g, dark: scene.dark,
      bounds: { x0: 0, y0: 0, x1: scene.width, y1: scene.height },
    };
    const pcs = live.filter((t) => t.kind === 'pc' && !t.hidden);

    P.drawBackdrop(view, scene, P.image(scene.map, redraw));

    if (preview !== 'gm') {
      const viewers = preview === 'party' ? pcs : live.filter((t) => t.id === preview);
      const mkey = preview + '|' + viewers.map((v) => v.id).join(',');
      if (memoryCache.key !== mkey) {
        const by = exploredRaw ? exploredRaw.by : {};
        memoryCache = { key: mkey, mask: P.exploredMask(exploredRaw, viewers.map((v) => by[v.id])) };
      }
      P.drawFog(view, fog.render(env, viewers, memoryCache.mask), 0.82);
    }
    view.applyWorld(ctx);

    // Luces fijas
    for (const l of S.lights) {
      ctx.save();
      ctx.setLineDash([3 / z, 5 / z]);
      ctx.beginPath();
      ctx.arc(l.x, l.y, l.radius * g, 0, P.TAU);
      ctx.strokeStyle = 'rgba(255, 214, 90, 0.7)';
      ctx.lineWidth = 1.5 / z;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(l.x, l.y, 7 / z, 0, P.TAU);
      ctx.fillStyle = '#ffd65a';
      ctx.fill();
      ctx.strokeStyle = '#3a2c00';
      ctx.stroke();
      ctx.restore();
    }

    // Línea de visión de cada jugador
    if (preview === 'gm') for (const v of pcs) drawVisionOutline(v, env);

    // Muros y puertas, agrupados por estilo (un mapa importado puede traer miles)
    ctx.lineCap = 'round';
    const strokeWalls = (test, color, width, dash) => {
      ctx.beginPath();
      for (const w of S.walls) {
        if (!test(w)) continue;
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
      }
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = width / z;
      ctx.stroke();
    };
    strokeWalls((w) => w.type !== 'door', '#ff6a3d', 3, []);
    strokeWalls((w) => w.type === 'door' && !w.open, '#3da5ff', 6, []);
    strokeWalls((w) => w.type === 'door' && w.open, '#5bd68a', 6, [6 / z, 8 / z]);
    ctx.setLineDash([]);

    // Movimientos propuestos
    for (const t of live) {
      const p = S.proposals[t.id];
      if (p) P.drawProposal(view, t, t, p, g);
    }

    // Fichas
    for (const t of live) P.drawToken(view, t, t, g, { selected: t.id === sel, alpha: t.hidden ? 0.45 : t.invisible ? 0.7 : 1 });

    // Muro o bloque en curso
    if (draft) {
      ctx.save();
      ctx.strokeStyle = '#ffe08a';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.beginPath();
      if (draft.rect) {
        const [a, b] = draft.rect;
        ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      } else if (hover) {
        const a = draft.pts[0], b = snap(hover);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (anim.active) redraw();
  }

  setTool('select');
})();
