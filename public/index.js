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
    list.innerHTML = data.pcs.map((p) => {
      // Un personaje que ya lleva otro dispositivo no se puede abrir (salvo que sea este mismo).
      const mine = localStorage.getItem(`palantir.pc.${data.code}.${p.id}`);
      const dot = `<span class="dot" style="background:${esc(p.color)}"></span>`;
      if (p.taken && !mine) return `<span class="taken">${dot}${esc(p.name)}<small>en uso en otro dispositivo</small></span>`;
      const note = mine ? 'tu personaje' : p.reserve ? 'aún fuera del mapa' : '';
      return `<a href="/play.html?room=${data.code}&token=${p.id}">${dot}${esc(p.name)}${note ? `<small>${note}</small>` : ''}</a>`;
    }).join('');
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

  // Restaurar una partida entera desde un archivo de copia de seguridad.
  $('restore').onclick = () => $('restoreFile').click();
  $('restoreFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('restoreMsg').textContent = 'Restaurando…';
    try {
      const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo restaurar');
      localStorage.setItem(GM_PREFIX + data.code, data.gmKey);
      location.href = '/gm.html?room=' + data.code;
    } catch (err) {
      $('restoreMsg').textContent = err.message;
    }
  };

  const pre = new URLSearchParams(location.search).get('room');
  if (pre) {
    $('code').value = pre.toUpperCase();
    loadRoom(pre);
  }
})();
