'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GM_PREFIX = 'palantir.gm.';
  let pollTimer = null;

  async function loadRoom(code) {
    clearTimeout(pollTimer);
    code = code.trim().toUpperCase();
    const msg = $('joinMsg'), list = $('pcs');
    if (!code) return;
    let data;
    try {
      const res = await fetch('/api/rooms/' + encodeURIComponent(code));
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
    } catch (e) {
      list.innerHTML = '';
      msg.textContent = e.message || 'No se pudo conectar';
      msg.classList.remove('hidden');
      return;
    }
    msg.classList.remove('hidden');
    msg.textContent = data.pcs.length ? 'Elige tu personaje:' : 'El máster aún no ha creado personajes. Esta lista se actualiza sola.';
    list.innerHTML =
      data.pcs.map((p) => `<a href="/play.html?room=${data.code}&token=${p.id}"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</a>`).join('') +
      `<a href="/party.html?room=${data.code}"><span class="dot" style="background:#888"></span>Pantalla de party (visión conjunta)</a>`;
    pollTimer = setTimeout(() => loadRoom(code), 4000);
  }

  $('join').onclick = () => loadRoom($('code').value);
  $('code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadRoom($('code').value);
  });

  $('create').onclick = async () => {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const data = await res.json();
    localStorage.setItem(GM_PREFIX + data.code, data.gmKey);
    location.href = '/gm.html?room=' + data.code;
  };

  // Partidas que este navegador ha creado como máster.
  const mine = Object.keys(localStorage).filter((k) => k.startsWith(GM_PREFIX)).map((k) => k.slice(GM_PREFIX.length));
  $('myRooms').innerHTML = mine.map((c) => `<a href="/gm.html?room=${esc(c)}">Continuar partida <b>${esc(c)}</b></a>`).join('');

  const pre = new URLSearchParams(location.search).get('room');
  if (pre) {
    $('code').value = pre.toUpperCase();
    loadRoom(pre);
  }
})();
