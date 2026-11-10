# Palantir

Mapa de rol con **campo de visión por jugador**. El máster carga un mapa, dibuja muros, puertas y columnas, y coloca las fichas. Cada jugador ve en su móvil solo lo que ve su personaje; una pantalla de *party* muestra la visión conjunta del grupo.

## Qué hace

- **Máster** (`/gm.html`): lo ve todo, sin niebla, con la línea de visión de cada jugador dibujada en su color.
  - Sube el mapa (PNG / JPG / WebP), define el tamaño de casilla y dibuja muros, bloques (columnas, objetos), puertas y luces.
  - Crea fichas de jugador y de PNJ. Por jugador: alcance y ángulo de visión, orientación, visión nocturna, visión verdadera y luz que porta.
  - Abre y cierra puertas con un clic. Puede marcar fichas como invisibles u ocultas.
  - «Ver como…» para comprobar qué ve un jugador concreto o la party.
  - Mueve y hace zoom libremente; opcionalmente la pantalla de party sigue su encuadre.
- **Jugador** (`/play.html`, pensado para móvil): mapa en negro salvo su campo de visión. No ve PNJ ni enemigos hasta que entran en él.
  - Toca donde quiere moverse: se crea una **propuesta de movimiento**. El máster puede corregir el destino arrastrándolo y luego pulsa «Mover» (o la rechaza).
  - Si su visión es un cono, el modo «Mirar» le deja girarse.
- **Party** (`/party.html`, para una tele o tablet en la mesa): unión de los campos de visión de todos los jugadores.

### Reglas de visión

| Situación | Se ve si… |
|---|---|
| Escena iluminada | hay línea de visión, está dentro del ángulo y del alcance (0 = sin límite) |
| Escena a oscuras | además el punto está iluminado (luz fija o antorcha de alguien) **o** dentro de la visión nocturna |
| Ficha invisible | solo dentro del alcance de la visión verdadera |
| Ficha oculta | nunca (solo el máster) |

Los muros y las puertas cerradas cortan la visión y la luz. Las puertas abiertas no.

El servidor decide qué fichas recibe cada cliente: la posición de un PNJ que tu personaje no ve **no llega a tu móvil**. (La imagen del mapa y los muros sí se envían enteros y se tapan en el dispositivo.)

## Ponerlo en marcha

Hace falta [Node.js](https://nodejs.org) 18 o superior.

```bash
npm install
npm start
```

Abre `http://localhost:3000`, pulsa **Crear partida nueva** y comparte el QR o el código con los jugadores.

- **Jugando en la misma mesa**: arranca el servidor en tu portátil; los móviles se conectan por la wifi de casa escaneando el QR (el servidor muestra tu IP local al arrancar).
- **Jugando en remoto**: despliégalo en cualquier servicio que mantenga un proceso Node con WebSockets (Render, Fly.io, Railway, un VPS…). Hay un `Dockerfile` listo. Monta un volumen en `/app/data` para conservar partidas y mapas.

Variables de entorno: `PORT` (por defecto 3000) y `DATA_DIR` (por defecto `./data`).

## Estructura

```
server.js          Servidor HTTP + WebSocket. Estado de las partidas y filtrado por jugador.
shared/vision.js   Motor de visión (línea de visión, luz, polígono de visibilidad). Lo usan servidor y navegador.
public/common.js   Cámara, entrada táctil, niebla y dibujo compartidos.
public/gm.*        Pantalla del máster.
public/play.*      Pantalla del jugador y de party (party.html).
test/              Tests del motor de visión (`npm test`).
```

Las partidas se guardan en `data/rooms/*.json` y los mapas en `data/maps/`.

## Ideas para más adelante

- Varias escenas por partida y cambio de mapa en caliente.
- Memoria de lo explorado (zonas ya vistas en gris).
- Importar muros desde Dungeondraft / Universal VTT.
- Turnos e iniciativa, medición de distancias, límite de movimiento por turno.
- Ventanas (dejan ver pero no pasar) y muros que bloquean el movimiento propuesto.
- Clave por jugador para que nadie pueda abrir la vista de otro.
