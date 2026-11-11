# Palantir

Mapa de rol con **campo de visión por jugador**. El máster carga un mapa, dibuja muros, puertas y columnas, y coloca las fichas. Cada jugador ve en su móvil solo lo que ve su personaje; una pantalla de *party* muestra la visión conjunta del grupo.

## Qué hace

- **Máster** (`/gm.html`): lo ve todo, sin niebla, con la línea de visión de cada jugador dibujada en su color.
  - **Escenas**: una partida tiene varias escenas. Al entrar se abre la pantalla de escenas para elegir cuál preparar o jugar.
  - Sube el mapa (PNG / JPG / WebP) o **impórtalo de Dungeondraft** con sus muros, puertas y luces.
  - Dibuja muros, bloques (columnas, objetos), puertas, ventanas y luces a mano. «Medir» da distancias en casillas y en la unidad de la escena.
  - Crea fichas de jugador y de PNJ. Por jugador: alcance y ángulo de visión, orientación, visión nocturna, visión verdadera y luz que porta.
  - Abre y cierra puertas con un clic. Puede marcar fichas como invisibles u ocultas.
  - «Ver como…» para comprobar qué ve un jugador concreto o la party.
  - Mueve y hace zoom libremente; opcionalmente la pantalla de party sigue su encuadre.
- **Jugador** (`/play.html`, pensado para móvil): ve con claridad su campo de visión, bajo una niebla tenue lo que ya ha explorado y en negro lo que nunca ha visto. No ve PNJ ni enemigos hasta que entran en su campo de visión, aunque estén en una zona ya explorada.
  - Toca donde quiere moverse: se crea una **propuesta de movimiento** con su distancia. El máster puede corregir el destino arrastrándolo y luego pulsa «Mover» (o la rechaza).
  - No puede proponer atravesar muros, puertas cerradas ni ventanas: el destino se queda delante del obstáculo.
  - «Mirar» le deja girarse.
- **Party** (para una tele o tablet en la mesa): unión de los campos de visión y de lo explorado por todos los jugadores. Se abre con el enlace del panel del máster, que lleva una clave.

### Combate

El máster pulsa «Iniciar combate», escribe la iniciativa de cada ficha y va pasando turnos. Los jugadores ven de quién es el turno (solo de quien pueden ver) y un aviso cuando es el suyo.

- Cada ficha tiene un **movimiento por turno** en casillas (6 por defecto; 0 = sin límite). En combate, el jugador ve un círculo con lo que le queda y sus propuestas se recortan a esa distancia. Se recupera al empezar su turno.
- Solo descuentan movimiento las propuestas aprobadas; el máster puede mover cualquier ficha libremente.
- Las fichas que se crean durante el combate entran en la lista; se puede sacar o volver a meter a cualquiera.

### Un personaje, un dispositivo

El primer móvil que abre un personaje se lo queda: los demás lo ven «en uso» y no pueden abrir su vista. Si un jugador cambia de móvil o borra los datos del navegador, el máster selecciona su ficha y pulsa «Liberar dispositivo».

### Escenas y sesiones

- **Abrir** una escena es solo para el máster: puede prepararla mientras los jugadores siguen en otra. **Jugar aquí** lleva a los jugadores a esa escena.
- Los personajes jugadores existen en todas las escenas con la misma ficha (visión, color, nombre); su posición es propia de cada escena. Los PNJ, muros, puertas y luces son de cada escena.
- **Todo se guarda solo** y cada escena conserva su estado: si se corta la sesión o paráis a comer, al volver cada escena sigue donde estaba (fichas, puertas, lo explorado). Los navegadores se reconectan solos.
- **Punto de inicio**: se fija automáticamente cuando el primer jugador entra en la escena, y el máster puede volver a fijarlo cuando quiera con «Fijar inicio».
- **Reiniciar** devuelve la escena a su punto de inicio: posiciones de las fichas, PNJ eliminados y estado de las puertas, y borra lo explorado. Lo que se añadió después del inicio se conserva.
- **Duplicar** crea una copia de la escena (mapa, muros, luces y fichas) sin explorar y sin empezar.
- **Copia de seguridad**: descarga la partida entera en un archivo (escenas, mapas, fichas, lo explorado). «Restaurar una copia de seguridad», en la página de inicio, crea con él una partida nueva con su propio código.

### Importar de Dungeondraft

En Dungeondraft: *Export → Universal VTT* (archivo `.dd2vtt`). En Palantir: *Escenas → Importar de Dungeondraft*. Se crea una escena nueva con la imagen, el tamaño de casilla, los muros (incluidos los de objetos), las puertas y las luces. También sirven los `.uvtt` y `.df2vtt` de otras herramientas que exportan el mismo formato.

- Los portales que tapan la luz entran como puertas (cerradas) y los que dejan ver, como ventanas.
- Los muros curvos o de cueva se simplifican ligeramente para que el cálculo de visión sea rápido.
- Si la luz ambiente del mapa es muy oscura, la escena empieza «a oscuras».

### Reglas de visión

| Situación | Se ve si… |
|---|---|
| Escena iluminada | hay línea de visión, está dentro del ángulo y del alcance (0 = sin límite) |
| Escena a oscuras | además el punto está iluminado (luz fija o antorcha de alguien) **o** dentro de la visión nocturna |
| Ficha invisible | solo dentro del alcance de la visión verdadera |
| Ficha oculta | nunca (solo el máster) |

Los muros y las puertas cerradas cortan la visión y la luz. Las puertas abiertas y las ventanas no; las ventanas sí impiden el paso.

**Nadie ve su espalda**: un jugador nuevo ve 180° hacia donde mira (el máster puede cambiar el ángulo por ficha, hasta 360° para criaturas que lo ven todo). El cono también recorta la visión nocturna y la verdadera. Al moverse, la ficha queda mirando en la dirección del movimiento; el jugador puede girarse cuando quiera con «Mirar» y el máster con el control de orientación.

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
server.js          Servidor HTTP + WebSocket. Partidas, escenas y filtrado por jugador.
fog.js             Memoria de lo explorado por cada jugador (la calcula el servidor).
shared/vision.js   Motor de visión (línea de visión, luz, polígono de visibilidad). Lo usan servidor y navegador.
shared/uvtt.js     Lectura del formato Universal VTT de Dungeondraft.
public/common.js   Cámara, entrada táctil, niebla y dibujo compartidos.
public/gm.*        Pantalla del máster.
public/play.*      Pantalla del jugador y de party (party.html).
test/              Tests del motor de visión, la memoria y el importador (`npm test`).
```

Las partidas se guardan en `data/rooms/*.json` y los mapas en `data/maps/`.

## Límites conocidos

- El movimiento propuesto se comprueba en línea recta: para doblar una esquina hay que proponer dos movimientos.
- La imagen del mapa y los muros se envían enteros al móvil y se tapan allí; lo que nunca se envía son las fichas que el jugador no ve.
- En mapas enormes con miles de muros y visión sin límite de alcance, la animación puede ir a tirones en móviles modestos.
