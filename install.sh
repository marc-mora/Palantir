#!/usr/bin/env bash
#
# Instalador de Palantir.
#
#   git clone <repo> && cd Palantir && ./install.sh
#
# En un servidor Linux con systemd deja Palantir funcionando como servicio:
# instala Node.js si falta, copia la aplicación a /opt/palantir, guarda partidas
# y mapas en /var/lib/palantir y arranca solo al encender la máquina.
# Volver a ejecutarlo actualiza la instalación (por ejemplo tras un «git pull»).
#
#   ./install.sh               instalar o actualizar el servicio
#   PORT=8080 ./install.sh     elegir puerto (por defecto 80 si está libre; si no, 3000)
#   ./install.sh --local       solo instalar dependencias en esta carpeta (para «npm start»)
#   ./install.sh --uninstall   quitar el servicio (las partidas no se borran)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/palantir}"
DATA_DIR="${DATA_DIR:-/var/lib/palantir}"
NODE_DIR="${NODE_DIR:-/opt/palantir-node}"
ENV_FILE="${ENV_FILE:-/etc/palantir.env}"
UNIT_FILE="${UNIT_FILE:-/etc/systemd/system/palantir.service}"
SERVICE_USER="${SERVICE_USER:-palantir}"
NODE_MAJOR=22      # versión que se descarga si no hay un Node válido
NODE_MIN=18        # versión mínima aceptada si ya hay uno instalado

say()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
has_systemd() { [ -d /run/systemd/system ] && have systemctl; }

MODE=service
case "${1:-}" in
  --local) MODE=local ;;
  --uninstall) MODE=uninstall ;;
  -h|--help) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  '') ;;
  *) die "Opción desconocida: $1 (usa --help)" ;;
esac

[ -f "$HERE/server.js" ] && [ -f "$HERE/package.json" ] || die "Ejecuta este script desde la carpeta del proyecto (no encuentro server.js)."

# Sin systemd (un Mac, WSL, un contenedor…) no hay servicio que montar: modo local.
if [ "$MODE" = service ] && ! has_systemd && [ -z "${FORCE_SERVICE:-}" ]; then
  say "Este sistema no usa systemd: instalo solo las dependencias en esta carpeta."
  MODE=local
fi

# El servicio y la desinstalación tocan carpetas del sistema: hace falta ser root.
if [ "$MODE" != local ] && [ "$(id -u)" -ne 0 ]; then
  have sudo || die "Hace falta ser root. Entra como root o instala sudo."
  say "Se necesitan permisos de administrador; te pedirá la contraseña de sudo."
  exec sudo --preserve-env=PORT,APP_DIR,DATA_DIR,NODE_DIR,ENV_FILE,UNIT_FILE,SERVICE_USER,FORCE_SERVICE bash "$0" "$@"
fi

# ---------------------------------------------------------------- utilidades

pkg_install() {
  if have apt-get; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif have dnf; then dnf install -y -q "$@" >/dev/null
  elif have yum; then yum install -y -q "$@" >/dev/null
  elif have zypper; then zypper --non-interactive install "$@" >/dev/null
  elif have apk; then apk add --quiet "$@"
  else return 1
  fi
}

fetch() { # fetch URL DESTINO
  if have curl; then curl -fsSL --retry 3 -o "$2" "$1"
  else wget -q -O "$2" "$1"
  fi
}

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Un Node vale para el servicio si es lo bastante nuevo, trae npm y no vive en una
# carpeta personal (el servicio no puede entrar en /root ni en /home).
usable_node() {
  local n="$1" dir
  [ -x "$n" ] || return 1
  [ "$(node_major "$n")" -ge "$NODE_MIN" ] || return 1
  dir="$(dirname "$(readlink -f "$n")")"
  [ -x "$dir/npm" ] || [ -x "$(dirname "$n")/npm" ] || return 1
  if [ "$MODE" = service ]; then
    case "$(readlink -f "$n")" in /root/*|/home/*) return 1 ;; esac
  fi
  return 0
}

# Descarga el Node oficial de nodejs.org, comprobando su suma SHA-256.
install_node() {
  [ "$(uname -s)" = Linux ] || die "Instala Node.js $NODE_MIN o superior (https://nodejs.org) y vuelve a ejecutar el script."
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "Arquitectura no soportada: $(uname -m). Instala Node.js $NODE_MIN+ a mano y repite." ;;
  esac
  if ! have curl && ! have wget; then
    say "Instalando curl…"
    pkg_install curl ca-certificates || die "No pude instalar curl. Instálalo y repite."
  fi
  have tar || pkg_install tar || die "Hace falta «tar»."
  have sha256sum || die "Hace falta «sha256sum» (paquete coreutils)."

  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp file sum
  tmp="$(mktemp -d)"
  say "Descargando Node.js $NODE_MAJOR ($arch) de nodejs.org…"
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || die "No pude conectar con nodejs.org."
  file="$(grep -o "node-v[0-9.]*-linux-${arch}\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || die "No encuentro Node.js para linux-$arch."
  fetch "$base/$file" "$tmp/$file" || die "Falló la descarga de $file."
  sum="$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  echo "$sum  $tmp/$file" | sha256sum -c --quiet - || die "La descarga de Node.js está corrupta (la suma no coincide)."
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  chmod -R a+rX "$NODE_DIR"
  ok "Node.js $("$NODE_DIR/bin/node" -v) instalado en $NODE_DIR"
}

# Deja en NODE_BIN un Node utilizable, instalándolo si hace falta.
ensure_node() {
  local cand
  for cand in "$NODE_DIR/bin/node" "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$cand" ] && usable_node "$cand"; then
      NODE_BIN="$cand"
      ok "Node.js $("$NODE_BIN" -v) ($NODE_BIN)"
      return
    fi
  done
  [ "$MODE" = local ] && [ "$(id -u)" -ne 0 ] && NODE_DIR="$HERE/.node"
  install_node
  NODE_BIN="$NODE_DIR/bin/node"
}

npm_install() { # npm_install CARPETA
  local bindir npm
  bindir="$(dirname "$NODE_BIN")"
  npm="$bindir/npm"
  [ -x "$npm" ] || npm="$(dirname "$(readlink -f "$NODE_BIN")")/npm"
  say "Instalando dependencias…"
  (cd "$1" && PATH="$bindir:$PATH" "$npm" ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
  ok "Dependencias instaladas"
}

port_free() { "$NODE_BIN" -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),()=>s.close(()=>process.exit(0)))' "$1" 2>/dev/null; }

my_ip() {
  local ip=""
  have ip && ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "${ip:-localhost}"
}

# ---------------------------------------------------------------- modo local

if [ "$MODE" = local ]; then
  ensure_node
  npm_install "$HERE"
  echo
  ok "Listo. Para arrancar Palantir:"
  case "$NODE_BIN" in
    "$HERE"/*) echo "    cd \"$HERE\" && PATH=\"$(dirname "$NODE_BIN"):\$PATH\" npm start" ;;
    *) echo "    cd \"$HERE\" && npm start" ;;
  esac
  echo "    y abre http://localhost:3000"
  exit 0
fi

# ---------------------------------------------------------------- desinstalar

if [ "$MODE" = uninstall ]; then
  if has_systemd; then
    systemctl disable --now palantir >/dev/null 2>&1 || true
  fi
  rm -f "$UNIT_FILE" "$ENV_FILE"
  has_systemd && systemctl daemon-reload || true
  rm -rf "$APP_DIR" "$NODE_DIR"
  ok "Servicio eliminado."
  echo "    Las partidas y los mapas siguen en $DATA_DIR (bórralos a mano si ya no los quieres)."
  exit 0
fi

# ---------------------------------------------------------------- servicio

ensure_node

# Usuario sin privilegios para el servicio.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  if have useradd; then useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  elif have adduser; then adduser -S -H -h "$DATA_DIR" -s /sbin/nologin "$SERVICE_USER"
  else die "No puedo crear el usuario «$SERVICE_USER» (no hay useradd)."
  fi
  ok "Usuario «$SERVICE_USER» creado"
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

# ¿Ya había un servicio en marcha? Se para para poder comprobar el puerto y copiar tranquilos.
WAS_RUNNING=0
if has_systemd && systemctl is-active --quiet palantir; then
  WAS_RUNNING=1
  systemctl stop palantir
fi

# Puerto: el que se pida; si no, el de la instalación anterior; si no, 80 si está libre o 3000.
OLD_PORT=""
[ -f "$ENV_FILE" ] && OLD_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | head -n1)"
if [ -n "${PORT:-}" ]; then :
elif [ -n "$OLD_PORT" ]; then PORT="$OLD_PORT"
elif port_free 80; then PORT=80
else
  PORT=3000
  say "El puerto 80 está ocupado por otro programa: uso el 3000."
fi
case "$PORT" in ''|*[!0-9]*) die "Puerto no válido: $PORT" ;; esac
port_free "$PORT" || die "El puerto $PORT está ocupado. Elige otro: PORT=8080 ./install.sh"

# Copiar la aplicación (el código, nunca los datos).
say "Copiando la aplicación a $APP_DIR…"
mkdir -p "$APP_DIR" "$DATA_DIR"
rm -rf "$APP_DIR/public" "$APP_DIR/shared"
cp -R "$HERE/public" "$HERE/shared" "$APP_DIR/"
cp "$HERE/server.js" "$HERE/fog.js" "$HERE/package.json" "$HERE/package-lock.json" "$APP_DIR/"
npm_install "$APP_DIR"
chown -R root:root "$APP_DIR" 2>/dev/null || true
chmod -R a+rX "$APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR"
chmod 750 "$DATA_DIR"

cat > "$ENV_FILE" <<EOF
# Configuración de Palantir. Tras cambiarla: systemctl restart palantir
PORT=$PORT
DATA_DIR=$DATA_DIR
NODE_ENV=production
EOF

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Palantir - mapa de rol con campo de vision por jugador
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server.js
Restart=on-failure
RestartSec=2
# Permite escuchar en el puerto 80 sin ser root, y nada más.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
ok "Servicio configurado ($UNIT_FILE)"

if ! has_systemd; then
  say "systemd no está disponible aquí: los archivos están en su sitio pero no arranco el servicio."
  exit 0
fi

systemctl daemon-reload
systemctl enable palantir >/dev/null 2>&1
systemctl restart palantir

# Abrir el puerto si hay un cortafuegos activo.
if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null && ok "Puerto $PORT abierto en ufw"
elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --quiet --permanent --add-port="$PORT/tcp" && firewall-cmd --quiet --reload && ok "Puerto $PORT abierto en firewalld"
fi

# Comprobar que responde de verdad.
URL="http://127.0.0.1:$PORT/api/info"
UP=0
for _ in $(seq 1 20); do
  if "$NODE_BIN" -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$URL" 2>/dev/null; then UP=1; break; fi
  sleep 0.5
done
if [ "$UP" -ne 1 ]; then
  systemctl --no-pager --lines=20 status palantir || true
  die "El servicio no responde. Mira el registro con: journalctl -u palantir -n 50"
fi

SUFFIX=""
[ "$PORT" = 80 ] || SUFFIX=":$PORT"
echo
ok "Palantir está en marcha$([ "$WAS_RUNNING" = 1 ] && echo ' (actualizado)')."
echo
echo "    Ábrelo en:  http://$(my_ip)$SUFFIX"
echo
echo "    Partidas y mapas:  $DATA_DIR"
echo "    Ver el registro:   journalctl -u palantir -f"
echo "    Parar / arrancar:  systemctl stop palantir  /  systemctl start palantir"
echo "    Actualizar:        git pull && ./install.sh"
echo "    Cambiar de puerto: PORT=8080 ./install.sh"
echo
echo "    Si no carga desde fuera, revisa el cortafuegos del proveedor del servidor (puerto $PORT/TCP)."
