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
  let ruler = null; // [a, b] mientras se mide
  let sheet = null; // ficha abierta en la pantalla de personajes: { type: 'roster' | 'token', id }
  let focusNewAttr = false;
  let placing = null; // id de la ficha de la reserva que se va a colocar con el próximo clic
  let knownRoster = null; // para seleccionar la ficha de reserva recién creada
  let shareOrigin = location.origin;

  const HINTS = {
    select: 'Arrastra una ficha para moverla · clic en una puerta para abrirla o cerrarla · arrastra el fondo para mover el mapa · rueda para zoom',
    wall: 'Clic para empezar un muro y clic para cada esquina · doble clic o Esc para terminar · Mayús ajusta a la cuadrícula',
    rect: 'Arrastra para dibujar una columna u objeto que tape la vista · botón derecho para mover el mapa',
    door: 'Clic en un extremo y clic en el otro para crear una puerta',
    window: 'Clic en un extremo y clic en el otro para crear una ventana: deja ver, pero los jugadores no pueden atravesarla',
    ruler: 'Arrastra para medir una distancia · Esc para quitar la medida',
    light: 'Clic para colocar una luz fija (solo se nota con la escena a oscuras)',
    erase: 'Clic sobre un muro, puerta, ventana o luz para borrarlo',
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
        ruler = null;
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
      if (knownRoster) {
        // Ficha recién creada en la reserva: se abre para rellenarla.
        const fresh = S.roster.find((e) => !knownRoster.has(e.id));
        knownRoster = null;
        if (fresh) openSheets({ type: 'roster', id: fresh.id });
      }
      renderSheets();
      if (placing && !S.roster.some((e) => e.id === placing)) stopPlacing();
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
      updatePartyLink();
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
  const rosterById = (id) => (S ? S.roster.find((e) => e.id === id) : null);

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

  /* ---------- Sacar fichas de la reserva: se elige el sitio con un clic ---------- */

  function startPlacing(id) {
    const e = rosterById(id);
    if (!e) return;
    setTool('select');
    placing = id;
    $('hint').textContent = `Haz clic en el mapa donde quieras colocar a «${e.name}» · Esc para cancelar`;
    $('c').style.cursor = 'crosshair';
    renderPanel();
    redraw();
  }

  function stopPlacing() {
    if (!placing) return;
    placing = null;
    $('hint').textContent = HINTS[tool];
    $('c').style.cursor = tool === 'select' ? 'default' : 'crosshair';
    renderPanel();
    redraw();
  }

  function setTool(t) {
    tool = t;
    draft = null;
    ruler = null;
    placing = null;
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
      if (draft || placing) redraw();
    },
    dragStart(w) {
      if (!S || placing) return null; // colocando: el clic coloca y arrastrar mueve el mapa
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
      if (tool === 'ruler') {
        const a = { x: w.x, y: w.y };
        return {
          move(m) { ruler = [a, { x: m.x, y: m.y }]; redraw(); },
          end() { redraw(); },
          cancel() { ruler = null; redraw(); },
        };
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
      if (placing) {
        selectNew = true;
        op('spawn', { id: placing, x: w.x, y: w.y });
        stopPlacing();
        return;
      }
      if (tool === 'select') {
        const d = wallAt(w, true);
        if (d) op('toggleDoor', { id: d.id });
        else select(null);
      } else if (tool === 'wall' || tool === 'door' || tool === 'window') {
        const p = snap(w, e.shiftKey);
        if (!draft) draft = { pts: [p] };
        else {
          const a = draft.pts[0];
          if (Math.hypot(a.x - p.x, a.y - p.y) < 2) draft = null; // clic en el mismo punto: terminar
          else {
            op('addWalls', { walls: [{ x1: a.x, y1: a.y, x2: p.x, y2: p.y, type: tool }] });
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
    // Solo cuenta como «escribiendo» un campo de texto o número, no una casilla o un deslizador.
    const el = document.activeElement;
    const typing = el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'range', 'color', 'file'].includes(el.type));
    if (e.key === 'Escape') {
      stopPlacing();
      draft = null;
      ruler = null;
      redraw();
    } else if (typing || sheetsOpen() || !$('scenesScreen').classList.contains('hidden')) {
      return; // escribiendo, o con una pantalla abierta encima del mapa
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
  const hpTag = (t) => (t.hpMax > 0 ? `<span class="hp" title="Vida">${t.hp}/${t.hpMax}</span>` : '');
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

    // Combate
    const cb = $('combatBody');
    if (!(cb.contains(active) && active.tagName === 'INPUT')) {
      const c = S.combat;
      if (!c) {
        cb.innerHTML = '<button class="small primary" data-combat="combatStart">Iniciar combate</button>' +
          '<p class="muted" style="font-size:12px;margin:6px 0 0">Orden de iniciativa, turnos y límite de movimiento por turno.</p>';
      } else {
        const out = S.tokens.filter((t) => !(t.id in c.inits));
        cb.innerHTML =
          `<div class="row" style="margin-bottom:6px"><b style="flex:1">Ronda ${c.round}</b>` +
          `<button class="small primary" data-combat="combatNext">${c.turnId ? 'Siguiente turno' : 'Empezar'}</button>` +
          '<button class="small" data-combat="combatEnd">Terminar</button></div>' +
          c.order.map((id) => {
            const t = tokenById(id);
            if (!t) return '';
            const moved = t.speed > 0 ? `${P.fmtNum(Math.min(t.speed, c.moved[id] || 0))}/${P.fmtNum(t.speed)}` : '';
            return `<div class="combat-row${id === c.turnId ? ' now' : ''}"><span class="dot" style="background:${P.esc(t.color)}"></span>` +
              `<span class="name">${P.esc(t.name)}</span><span class="moved" title="Casillas movidas este turno">${moved}</span>` +
              `<input type="number" value="${c.inits[id]}" data-init="${id}" title="Iniciativa">` +
              `<button class="small" data-ctoggle="${id}" title="Sacar del combate">✕</button></div>`;
          }).join('') +
          (out.length ? '<p class="combat-out muted">Fuera del combate: ' + out.map((t) => `<button class="small" data-ctoggle="${t.id}">＋ ${P.esc(t.name)}</button>`).join('') + '</p>' : '');
      }
    }

    // Lista de fichas
    const online = new Set(S.online);
    const claimed = new Set(S.claimed);
    $('tokens').innerHTML = S.tokens.length
      ? S.tokens.map((t) =>
          `<div class="token-row${t.id === sel ? ' sel' : ''}" data-id="${t.id}">` +
          `<span class="dot" style="background:${P.esc(t.color)}"></span><span class="name">${P.esc(t.name)}</span>` + hpTag(t) +
          (t.hidden ? '<span class="badge">oculta</span>' : '') +
          (t.invisible ? '<span class="badge">invisible</span>' : '') +
          (claimed.has(t.id) ? '<span class="badge" title="Ligado al dispositivo de un jugador">ligado</span>' : '') +
          (t.kind === 'pc' ? `<span class="online${online.has(t.id) ? ' on' : ''}" title="${online.has(t.id) ? 'Conectado' : 'Sin conectar'}"></span>` : '<span class="badge">PNJ</span>') +
          '</div>').join('')
      : '<p class="muted" style="font-size:13px">Añade fichas con los botones «＋ Jugador» y «＋ PNJ».</p>';

    // Reserva
    $('roster').innerHTML = S.roster.length
      ? S.roster.map((e) =>
          `<div class="token-row" data-id="${e.id}" title="Abrir su ficha">` +
          `<span class="dot" style="background:${P.esc(e.color)}"></span><span class="name">${P.esc(e.name)}</span>` + hpTag(e) +
          (e.hidden ? '<span class="badge" title="Al sacarla, los jugadores no la verán hasta que la descubras">sale oculta</span>' : '') +
          (e.kind === 'pc' ? '<span class="badge">PJ</span>' : '<span class="badge">PNJ</span>') +
          `<button class="small${e.id === placing ? ' active' : ''}" data-spawn="${e.id}">Sacar</button></div>`).join('')
      : '<p class="muted" style="font-size:13px;margin:0">La reserva está vacía.</p>';

    // Ficha seleccionada
    const t = tokenById(sel);
    tokenSec.classList.toggle('hidden', !t);
    if (t) {
      for (const el of fields) {
        if (el === active) continue;
        const f = el.dataset.f;
        if (el.type === 'checkbox') el.checked = !!t[f];
        else el.value = f === 'facing' ? deg(t.facing || 0) : t[f] ?? 0;
      }
      $('facingOut').textContent = deg(t.facing || 0) + '°';
      $('angleOut').textContent = t.angle >= 360 ? '360° (todo alrededor)' : t.angle + '°';
      tokenSec.querySelector('.pc-only').classList.toggle('hidden', t.kind !== 'pc');
      $('release').classList.toggle('hidden', !claimed.has(t.id));
    }

    // Escena
    const sc = S.scene;
    if (active !== $('gridSize')) $('gridSize').value = sc.gridSize;
    if (active !== $('cellDistance')) $('cellDistance').value = sc.cellDistance;
    if (active !== $('unit')) $('unit').value = sc.unit;
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
  $('stash').onclick = () => sel && op('stash', { id: sel });
  $('openSheet').onclick = () => sel && openSheets({ type: 'token', id: sel });

  $('addRosterPc').onclick = () => newSheet('pc');
  $('addRosterNpc').onclick = () => newSheet('npc');
  $('roster').addEventListener('click', (e) => {
    const spawn = e.target.dataset.spawn;
    if (spawn) return placing === spawn ? stopPlacing() : startPlacing(spawn);
    const row = e.target.closest('[data-id]');
    if (row) openSheets({ type: 'roster', id: row.dataset.id });
  });
  $('release').onclick = () => {
    const t = tokenById(sel);
    if (t && confirm(`«${t.name}» dejará de estar ligado al móvil que lo lleva y ese móvil se desconectará. El siguiente que lo elija se lo queda.\n\n¿Liberar?`)) op('release', { id: sel });
  };

  $('combatBody').addEventListener('click', (e) => {
    const d = e.target.dataset;
    if (d.combat === 'combatEnd' && !confirm('¿Terminar el combate? Se pierde el orden de iniciativa.')) return;
    if (d.combat) op(d.combat);
    else if (d.ctoggle) op('combatToggle', { id: d.ctoggle });
  });
  $('combatBody').addEventListener('change', (e) => {
    const id = e.target.dataset.init;
    if (!id) return;
    e.target.blur(); // al perder el foco la lista puede reordenarse
    op('combatInit', { id, init: Number(e.target.value) });
  });

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
  $('cellDistance').onchange = (e) => op('setScene', { patch: { cellDistance: Number(e.target.value) } });
  $('unit').onchange = (e) => op('setScene', { patch: { unit: e.target.value } });
  $('showGrid').onchange = (e) => op('setScene', { patch: { showGrid: e.target.checked } });
  $('dark').onchange = (e) => op('setScene', { patch: { dark: e.target.checked } });
  $('allies').onchange = (e) => op('setScene', { patch: { alliesAlwaysVisible: e.target.checked } });
  $('clearWalls').onclick = () => {
    if (confirm('¿Borrar todos los muros, puertas y ventanas de este mapa?')) op('clearWalls');
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

  /* ---------- Pantalla de personajes y PNJ (fichas del máster) ---------- */

  const sheetForm = $('sheetForm');
  const sheetFields = [...sheetForm.querySelectorAll('[data-s]')];
  const sheetObj = () => (!sheet ? null : sheet.type === 'roster' ? rosterById(sheet.id) : tokenById(sheet.id));
  const sheetsOpen = () => !$('sheetScreen').classList.contains('hidden');

  function openSheets(target) {
    if (target) sheet = target;
    $('sheetScreen').classList.remove('hidden');
    renderSheets();
  }

  function closeSheets() {
    $('sheetScreen').classList.add('hidden');
  }

  /** Guarda un cambio de la ficha abierta, esté en la reserva o en el mapa. */
  function sheetPatch(patch) {
    if (!sheet) return;
    op(sheet.type === 'roster' ? 'updRoster' : 'updToken', { id: sheet.id, patch });
  }

  function renderSheets() {
    if (!S || !sheetsOpen()) return;
    if (sheet && !sheetObj()) sheet = null;
    if (!sheet && S.roster.length) sheet = { type: 'roster', id: S.roster[0].id };
    else if (!sheet && S.tokens.length) sheet = { type: 'token', id: S.tokens[0].id };

    const row = (type, o) =>
      `<div class="token-row${sheet && sheet.type === type && sheet.id === o.id ? ' sel' : ''}" data-type="${type}" data-id="${o.id}">` +
      `<span class="dot" style="background:${P.esc(o.color)}"></span><span class="name">${P.esc(o.name)}</span>${hpTag(o)}</div>`;
    const group = (title, type, list) => `<h4>${title}</h4>` + (list.length ? list.map((o) => row(type, o)).join('') : '<p class="none">—</p>');
    $('sheetList').innerHTML =
      group('Reserva · personajes', 'roster', S.roster.filter((e) => e.kind === 'pc')) +
      group('Reserva · PNJ', 'roster', S.roster.filter((e) => e.kind !== 'pc')) +
      group(`En el mapa · ${P.esc(S.sceneName)}`, 'token', S.tokens);

    const o = sheetObj();
    sheetForm.classList.toggle('hidden', !o);
    $('sheetEmpty').classList.toggle('hidden', !!o);
    if (!o) return;
    const inRoster = sheet.type === 'roster';
    const active = document.activeElement;
    $('sheetWhere').textContent = inRoster ? 'En la reserva' : `En el mapa · ${S.sceneName}`;
    $('sheetHiddenLabel').textContent = inRoster ? 'Sale oculta (los jugadores no la ven hasta que la descubras)' : 'Oculta a los jugadores';
    for (const el of sheetFields) {
      if (el === active) continue;
      const f = el.dataset.s;
      if (el.type === 'checkbox') el.checked = !!o[f];
      else el.value = o[f] ?? (el.type === 'number' ? 0 : '');
    }
    for (const el of sheetForm.querySelectorAll('.pc-only')) el.classList.toggle('hidden', o.kind !== 'pc');
    $('sheetSpawn').classList.toggle('hidden', !inRoster);
    $('sheetDup').classList.toggle('hidden', !inRoster);
    $('sheetStash').classList.toggle('hidden', inRoster);
    $('sheetDel').textContent = inRoster ? 'Eliminar de la reserva' : 'Eliminar del mapa';

    renderLook(o, active);

    // Características: no se redibujan mientras se escribe en ellas.
    const box = $('sheetAttrs');
    if (!box.contains(active)) {
      const attrs = o.attrs || [];
      box.innerHTML = attrs.map((a, i) =>
        `<div class="attr-row"><input type="text" maxlength="30" placeholder="Nombre (p. ej. Fuerza)" value="${P.esc(a.k)}" data-attr="k">` +
        `<input type="text" maxlength="60" placeholder="Valor" value="${P.esc(a.v)}" data-attr="v">` +
        `<button type="button" class="small" data-del-attr="${i}" title="Quitar">✕</button></div>`).join('');
      if (focusNewAttr && box.lastElementChild) box.lastElementChild.querySelector('input').focus();
      focusNewAttr = false;
    }
  }

  /* --- Figura con la que se ve la ficha en el mapa --- */

  const fillSelect = (el, list) => { el.innerHTML = list.map((x) => `<option value="${x.id}">${P.esc(x.label)}</option>`).join(''); };
  fillSelect($('lookRace'), Sprites.races);
  fillSelect($('lookClass'), Sprites.classes);
  $('lookMonsters').innerHTML = Sprites.monsters.map((m) => `<button type="button" data-monster="${m.id}"><canvas width="112" height="112"></canvas>${P.esc(m.label)}</button>`).join('');
  for (const b of $('lookMonsters').children) {
    const c = b.querySelector('canvas').getContext('2d');
    c.translate(56, 56);
    Sprites.draw(c, 'm:' + b.dataset.monster, '#8b1e1e', 40);
  }

  function renderLook(o, active) {
    const p = Sprites.parse(o.sprite);
    const type = p ? p.type : '';
    if (active !== $('lookType')) $('lookType').value = type;
    if (p && p.type === 'h') {
      if (active !== $('lookRace')) $('lookRace').value = p.race;
      if (active !== $('lookClass')) $('lookClass').value = p.cls;
    }
    $('lookRaceBox').classList.toggle('hidden', type !== 'h');
    $('lookClassBox').classList.toggle('hidden', type !== 'h');
    $('lookMonsters').classList.toggle('hidden', type !== 'm');
    for (const b of $('lookMonsters').children) b.classList.toggle('active', !!p && p.monster === b.dataset.monster);

    const cv = $('lookPreview'), c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.translate(cv.width / 2, cv.height / 2);
    if (!Sprites.draw(c, o.sprite, o.color, 74)) {
      c.beginPath(); c.arc(0, 0, 74, 0, P.TAU);
      c.fillStyle = o.color; c.fill();
      c.lineWidth = 7; c.strokeStyle = '#101018'; c.stroke();
      c.fillStyle = '#fff'; c.font = '600 74px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText((o.name || '?').trim().charAt(0).toUpperCase(), 0, 4);
    }
  }

  /** Cambia la figura; las criaturas grandes ajustan también el tamaño de la ficha. */
  function setLook(sprite) {
    const o = sheetObj();
    if (!o) return;
    const patch = { sprite };
    const hint = Sprites.sizeHint(sprite), before = Sprites.sizeHint(o.sprite);
    if (hint) patch.size = hint;
    else if (before && o.size === before) patch.size = 1;
    sheetPatch(patch);
  }
  const humanoidLook = () => `h:${$('lookRace').value}:${$('lookClass').value}`;
  $('lookType').onchange = (e) => {
    const p = Sprites.parse((sheetObj() || {}).sprite);
    if (e.target.value === 'h') setLook(humanoidLook());
    else if (e.target.value === 'm') setLook('m:' + (p && p.monster ? p.monster : Sprites.monsters[0].id));
    else setLook('');
  };
  $('lookRace').onchange = () => setLook(humanoidLook());
  $('lookClass').onchange = () => setLook(humanoidLook());
  $('lookMonsters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-monster]');
    if (b) setLook('m:' + b.dataset.monster);
  });

  const readAttrs = () => [...$('sheetAttrs').querySelectorAll('.attr-row')].map((r) => ({ k: r.querySelector('[data-attr=k]').value, v: r.querySelector('[data-attr=v]').value }));

  function sendSheetField(el) {
    const f = el.dataset.s;
    if (!f) return;
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    sheetPatch({ [f]: v });
  }
  sheetForm.addEventListener('change', (e) => {
    if (e.target.dataset.attr) sheetPatch({ attrs: readAttrs() });
    else sendSheetField(e.target);
  });
  sheetForm.addEventListener('input', (e) => {
    if (e.target.type === 'color' || e.target.type === 'checkbox') sendSheetField(e.target);
  });
  $('sheetAttrs').addEventListener('click', (e) => {
    const i = e.target.dataset.delAttr;
    if (i === undefined) return;
    const attrs = readAttrs();
    attrs.splice(Number(i), 1);
    e.target.blur(); // para que la lista se redibuje
    sheetPatch({ attrs });
  });
  $('addAttr').onclick = () => {
    focusNewAttr = true;
    sheetPatch({ attrs: [...readAttrs(), { k: '', v: '' }] });
  };
  $('sheetList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    if (document.activeElement && sheetForm.contains(document.activeElement)) document.activeElement.blur(); // guarda lo que se estuviera escribiendo
    sheet = { type: row.dataset.type, id: row.dataset.id };
    renderSheets();
  });
  const newSheet = (kind) => {
    knownRoster = new Set(S.roster.map((e) => e.id));
    op('addRoster', { kind });
  };
  $('newPc').onclick = () => newSheet('pc');
  $('newNpc').onclick = () => newSheet('npc');
  $('openSheets').onclick = () => openSheets();
  $('scenesSheets').onclick = () => openSheets(); // también desde la pantalla de escenas, sin entrar en ninguna
  $('closeSheets').onclick = closeSheets;
  $('sheetSpawn').onclick = () => {
    if (!sheet || sheet.type !== 'roster') return;
    const id = sheet.id;
    closeSheets();
    showScenes(false); // por si se abrió desde la pantalla de escenas: hay que ver el mapa
    startPlacing(id);
  };
  $('sheetDup').onclick = () => {
    if (!sheet || sheet.type !== 'roster') return;
    knownRoster = new Set(S.roster.map((e) => e.id));
    op('dupRoster', { id: sheet.id });
  };
  $('sheetStash').onclick = () => {
    const o = sheetObj();
    if (!o || sheet.type !== 'token') return;
    op('stash', { id: o.id });
    if (o.kind === 'pc') sheet = { type: 'roster', id: o.id }; // un personaje conserva su identidad en la reserva
  };
  $('sheetDel').onclick = () => {
    const o = sheetObj();
    if (!o) return;
    const where = sheet.type === 'roster' ? 'de la reserva' : 'del mapa';
    if (!confirm(`¿Eliminar a «${o.name}» ${where}? Se pierde su ficha.`)) return;
    op(sheet.type === 'roster' ? 'delRoster' : 'delToken', { id: o.id });
  };

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
        '<button data-act="rename">Renombrar</button><button data-act="dup">Duplicar</button>' +
        '<button data-act="start">Fijar inicio</button><button data-act="reset">Reiniciar</button>' +
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
    } else if (act === 'dup') {
      op('dupScene', { id });
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

  $('backup').onclick = async () => {
    const btn = $('backup'), label = btn.textContent;
    btn.textContent = 'Preparando…';
    try {
      const res = await fetch(`/api/rooms/${code}/export`, { headers: { 'X-GM-Key': key } });
      if (!res.ok) throw new Error('No se pudo crear la copia');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `palantir-${code}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (err) {
      importStatus(err.message, true);
    }
    btn.textContent = label;
  };

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

  // La pantalla de party enseña lo que ve todo el grupo, así que su enlace lleva una clave.
  function updatePartyLink() {
    if (S) $('partyLink').href = `${shareOrigin}/party.html?room=${code}&k=${S.partyKey}`;
  }

  (async () => {
    let origin = location.origin;
    try {
      const info = await (await fetch('/api/info')).json();
      // Si el máster abrió «localhost», los móviles necesitan la IP de la red local.
      if (['localhost', '127.0.0.1'].includes(location.hostname) && info.lan.length) origin = `http://${info.lan[0]}:${info.port}`;
    } catch { /* se usa location.origin */ }
    shareOrigin = origin;
    updatePartyLink();
    const join = `${origin}/?room=${code}`;
    $('codeBig').textContent = code;
    $('qr').src = '/qr.svg?text=' + encodeURIComponent(join);
    $('joinLink').href = join;
    $('joinLink').textContent = join.replace(/^https?:\/\//, '');
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
    strokeWalls((w) => w.type === 'wall', '#ff6a3d', 3, []);
    strokeWalls((w) => w.type === 'window', '#d7a6ff', 5, [2 / z, 7 / z]);
    strokeWalls((w) => w.type === 'door' && !w.open, '#3da5ff', 6, []);
    strokeWalls((w) => w.type === 'door' && w.open, '#5bd68a', 6, [6 / z, 8 / z]);
    ctx.setLineDash([]);

    // Movimientos propuestos
    for (const t of live) {
      const p = S.proposals[t.id];
      if (p) P.drawProposal(view, t, t, p, g, P.distLabel(scene, Math.hypot(p.x - t.x, p.y - t.y)));
    }

    // Fichas (con un aro en la que tiene el turno)
    for (const t of live) {
      if (S.combat && S.combat.turnId === t.id) P.drawTurnRing(view, t, t, g);
      P.drawToken(view, t, t, g, { selected: t.id === sel, alpha: t.hidden ? 0.45 : t.invisible ? 0.7 : 1 });
      if (t.hpMax > 0) {
        // Barra de vida: solo existe en esta pantalla, a los jugadores no se les envía.
        const r = Vision.tokenRadius(t, g), w = r * 2, h = 5 / z, x = t.x - r, y = t.y - r - 10 / z;
        const frac = Math.max(0, Math.min(1, t.hp / t.hpMax));
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(x - 1 / z, y - 1 / z, w + 2 / z, h + 2 / z);
        ctx.fillStyle = frac > 0.5 ? '#4caf7a' : frac > 0.25 ? '#e0a83a' : '#d9534f';
        ctx.fillRect(x, y, w * frac, h);
      }
    }

    // Ficha de la reserva a punto de colocarse
    const ghost = placing && hover ? rosterById(placing) : null;
    if (ghost) P.drawToken(view, { ...ghost, facing: 0 }, hover, g, { alpha: 0.55 });

    // Regla
    if (ruler) {
      const [a, b] = ruler;
      ctx.save();
      ctx.strokeStyle = '#ffe08a';
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      P.drawLabel(view, P.distLabel(scene, Math.hypot(b.x - a.x, b.y - a.y)), b.x, b.y - 10 / z, '#ffe08a');
    }

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
