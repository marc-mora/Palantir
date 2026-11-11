/* Pantalla de jugador (su campo de visión) y pantalla de party (unión de todos). */
'use strict';

(() => {
  const role = document.body.dataset.role; // 'player' | 'party'
  const code = (P.qs.get('room') || '').toUpperCase();
  const tokenId = P.qs.get('token') || '';
  const $ = (id) => document.getElementById(id);
  // El personaje queda ligado a este dispositivo con un secreto que guarda el navegador.
  const SECRET_KEY = `palantir.pc.${code}.${tokenId}`;
  const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

  const view = new P.View($('c'));
  const fog = new P.Fog(view);
  const anim = new P.Animator();

  let S = null; // último estado recibido del servidor
  let mode = 'move'; // 'move' | 'look'
  let follow = true; // la cámara sigue a mi ficha (jugador) o a la vista del máster (party)
  let framed = false;
  let memory = null; // lo ya explorado (imagen de baja resolución)

  const redraw = P.scheduler(draw);
  view.onResize = () => {
    if (role === 'party' && follow) frameParty();
    redraw();
  };

  const conn = P.connect(() => ({ t: 'hello', room: code, role, tokenId, secret: stored(SECRET_KEY), key: P.qs.get('k') }), {
    onStatus(on) {
      $('status').classList.toggle('on', on);
    },
    onMessage(m) {
      if (m.t === 'error') {
        conn.stop(); // nos han rechazado: no tiene sentido reintentar
        return showOverlay(m.msg);
      }
      if (m.t === 'claim') {
        try { localStorage.setItem(SECRET_KEY, m.secret); } catch { /* sin almacenamiento: habrá que liberar el personaje al recargar */ }
        return;
      }
      if (m.t === 'notice') return toast(m.msg);
      if (m.t === 'cam' && S) {
        S.partyCam = m.rect;
        if (follow) frameParty();
        return redraw();
      }
      if (m.t !== 'state') return;
      const prevMe = me();
      const sameScene = S && S.sceneId === m.sceneId;
      // Los muros y lo explorado solo llegan cuando cambian.
      if (!m.segs) m.segs = sameScene ? S.segs : [];
      if (m.explored !== undefined) memory = P.exploredMask(m.explored, m.explored ? [m.explored.bits] : []);
      if (S && !sameScene) {
        // El máster ha cambiado de escena.
        anim.reset();
        framed = false;
        follow = true;
      }
      S = m;
      anim.update(S.tokens);
      updateHud();
      if (role === 'player') {
        const now = me();
        if (now && !framed) {
          view.cam.zoom = Math.max(0.1, Math.min(3, view.w / (S.scene.gridSize * 12)));
          framed = true;
        }
        // Al moverse mi ficha, la cámara vuelve a seguirla.
        if (now && prevMe && sameScene && (now.x !== prevMe.x || now.y !== prevMe.y)) follow = true;
      } else if (!framed || follow) {
        frameParty();
        framed = true;
      }
      redraw();
    },
  });

  function me() {
    return S && S.me ? S.viewers.find((v) => v.id === S.me) || null : null;
  }

  function frameParty() {
    if (!S) return;
    view.fit(S.partyCam || { x: 0, y: 0, w: S.scene.width, h: S.scene.height }, S.partyCam ? 0 : 20);
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  function showOverlay(msg) {
    $('overlayMsg').textContent = msg;
    $('back').href = '/?room=' + encodeURIComponent(code);
    $('overlay').classList.remove('hidden');
  }

  function updateTurn() {
    const c = S.combat, el = $('turn');
    el.classList.toggle('hidden', !c);
    if (!c) return;
    const mine = !!(c.turn && S.me && c.turn.id === S.me);
    el.classList.toggle('mine', mine);
    let txt = 'Ronda ' + c.round + ' · ';
    if (!c.turn) txt += 'preparando iniciativa';
    else if (mine) txt += '¡tu turno!';
    else txt += c.turn.hidden ? 'turno de alguien que no ves' : 'turno de ' + c.turn.name;
    if (c.budget !== null && c.budget !== undefined) txt += ' · te quedan ' + P.fmtNum(c.budget) + ' casillas';
    el.textContent = txt;
  }

  function updateHud() {
    updateTurn();
    if (role !== 'player') return;
    const m = me();
    if (!m) {
      return showOverlay(S.waiting
        ? 'El máster aún no ha sacado a tu personaje al mapa. Espera aquí: entrarás en cuanto lo haga.'
        : 'Tu personaje ya no está en la partida. Pide al máster que lo cree y vuelve a entrar.');
    }
    $('overlay').classList.add('hidden');
    $('who').textContent = m.name;
    $('dot').style.background = m.color;
    $('pending').classList.toggle('hidden', !S.proposals[m.id]);
    const cone = m.angle < 360;
    $('modeLook').classList.toggle('hidden', !cone);
    if (!cone && mode === 'look') setMode('move');
  }

  function setMode(m) {
    mode = m;
    $('modeMove').classList.toggle('active', m === 'move');
    $('modeLook').classList.toggle('active', m === 'look');
  }

  /* ---------- Entrada ---------- */

  P.attachInput(view, {
    onPan() {
      follow = false;
      redraw();
    },
    onTap(world) {
      if (role !== 'player') return;
      const m = me();
      if (!m) return;
      if (mode === 'look') conn.send({ t: 'face', angle: Math.atan2(world.y - m.y, world.x - m.x) });
      else conn.send({ t: 'propose', x: world.x, y: world.y });
    },
  });

  $('center').onclick = () => {
    follow = true;
    if (role === 'party') frameParty();
    redraw();
  };
  if (role === 'player') {
    $('modeMove').onclick = () => setMode('move');
    $('modeLook').onclick = () => setMode('look');
    $('cancel').onclick = () => conn.send({ t: 'cancel' });
  }

  /* ---------- Dibujo ---------- */

  function draw() {
    if (!S) return;
    const scene = S.scene, g = scene.gridSize;
    const viewers = S.viewers.map((v) => ({ ...v, ...anim.pos(v) }));

    if (role === 'player' && follow && viewers[0]) {
      view.cam.x = viewers[0].x;
      view.cam.y = viewers[0].y;
    }

    P.drawBackdrop(view, scene, P.image(scene.map, redraw));

    // Las antorchas se mueven con la ficha que las lleva mientras dura la animación.
    const byId = new Map(S.tokens.map((t) => [t.id, t]));
    const lights = S.lights.map((L) => (L.tid && byId.has(L.tid) ? { ...L, ...anim.pos(byId.get(L.tid)) } : L));
    const env = { segs: S.segs, lights, grid: g, dark: scene.dark, bounds: { x0: 0, y0: 0, x1: scene.width, y1: scene.height } };
    P.drawFog(view, fog.render(env, viewers, memory), 1);

    view.applyWorld(view.ctx);
    const ctx = view.ctx, z = view.cam.zoom;
    // En combate: hasta dónde puede llegar todavía este turno.
    if (role === 'player' && S.combat && S.combat.budget !== null && viewers[0]) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(viewers[0].x, viewers[0].y, S.combat.budget * g, 0, P.TAU);
      ctx.setLineDash([10 / z, 8 / z]);
      ctx.lineWidth = 2 / z;
      ctx.strokeStyle = 'rgba(255, 213, 74, 0.85)';
      ctx.stroke();
      ctx.restore();
    }
    for (const v of viewers) {
      const p = S.proposals[v.id];
      if (p) P.drawProposal(view, v, v, p, g, P.distLabel(scene, Math.hypot(p.x - v.x, p.y - v.y)));
    }
    const turnId = S.combat && S.combat.turn ? S.combat.turn.id : null;
    for (const t of S.tokens) {
      const pos = anim.pos(t);
      if (t.id === turnId) P.drawTurnRing(view, t, pos, g);
      P.drawToken(view, t, pos, g, { me: t.id === S.me });
    }

    if (anim.active) redraw();
  }
})();
