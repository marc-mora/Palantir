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
  - Si su visión es un cono (menos de 360°), «Mirar» le deja girarse.
- **Party** (para una tele o tablet en la mesa): unión de los campos de visión y de lo explorado por todos los jugadores. Se abre con el enlace del panel del máster, que lleva una clave.

### Reserva de personajes y PNJ

En el panel del máster, «Reserva» guarda fichas ya preparadas (nombre, color, tamaño, visión, luz, movimiento…) que todavía no están en el mapa. La reserva es de la partida, así que vale para todas las escenas.

- **Sacar**: pulsa «Sacar» y haz clic en el mapa donde quieras que aparezca.
- **PNJ**: son plantillas. Cada vez que sacas uno se crea una copia («Goblin», «Goblin 2»…) y la plantilla sigue en la reserva.
- **Personajes jugadores**: son únicos. Al sacarlo entra en juego y sale de la reserva. Su jugador puede elegirlo desde el principio; su móvil espera hasta que el máster lo saque.
- **Sale oculta**: una ficha así entra al mapa sin que los jugadores la vean hasta que el máster la descubra.
- **Retirar a la reserva**: quita una ficha del mapa guardando sus características. Un personaje retirado conserva su móvil y lo que había explorado.

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

**El mapa se descubre al avanzar**: un jugador nuevo ve hasta 8 casillas (el máster lo cambia por ficha; 0 = sin límite, solo le frenan los muros). Lo que queda más lejos sigue en negro hasta que se acerca.

**Ángulo de visión**: por defecto todas las fichas ven 360°, todo a su alrededor. El máster puede estrecharlo por ficha (por ejemplo 180° para que no vea su espalda); entonces importa hacia dónde mira: al moverse queda mirando en la dirección del movimiento, el jugador puede girarse con «Mirar» y el máster con el control de orientación. El cono también recorta la visión nocturna y la verdadera.

El servidor decide qué fichas recibe cada cliente: la posición de un PNJ que tu personaje no ve **no llega a tu móvil**. (La imagen del mapa y los muros sí se envían enteros y se tapan en el dispositivo.)

## Ponerlo en marcha

### En un servidor (VPS) o en un Linux que quieras dejar encendido

```bash
git clone https://github.com/marc-mora/Palantir.git
cd Palantir
./install.sh
```

El instalador lo deja funcionando como servicio y al terminar te dice la dirección para abrirlo:

- Instala Node.js si no hay uno válido (lo descarga de nodejs.org y comprueba su suma).
- Copia la aplicación a `/opt/palantir` y la ejecuta con un usuario propio sin privilegios.
- Guarda partidas y mapas en `/var/lib/palantir`, fuera del código, para que las actualizaciones no los toquen.
- Arranca solo al encender la máquina y se reinicia si falla.
- Usa el puerto 80 si está libre (si no, el 3000). Para elegirlo: `PORT=8080 ./install.sh`.

Para **actualizar**: `git pull && ./install.sh`. Para quitarlo: `./install.sh --uninstall` (las partidas no se borran).

Va por HTTP sin cifrar. Para HTTPS hace falta un dominio apuntando al servidor y un proxy delante (Caddy o nginx) hacia el puerto de Palantir.

### En tu ordenador, para jugar en la misma mesa

Con [Node.js](https://nodejs.org) 18 o superior:

```bash
./install.sh --local     # o: npm install
npm start
```

Abre `http://localhost:3000`, pulsa **Crear partida nueva** y comparte el QR o el código con los jugadores. Los móviles se conectan por la wifi de casa escaneando el QR (el servidor muestra tu IP local al arrancar).

### Otras formas

Hay un `Dockerfile` para servicios como Render, Fly.io o Railway; monta un volumen en `/app/data` para conservar partidas y mapas.

Variables de entorno: `PORT` (por defecto 3000) y `DATA_DIR` (por defecto `./data`).

## Estructura

```
install.sh         Instalador: deja Palantir como servicio en un servidor Linux.
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
