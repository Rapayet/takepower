#!/usr/bin/env node
'use strict';
// fondo-ledger.js - libro publico del Baul (generador).   // LEDGER_VERSION = 1
//
// Que hace (una vez por hora, con un temporizador de systemd; tambien se puede correr a mano):
//   - Lee el registro PROPIO de phoenixd con la clave LIMITADA (esa clave no puede pagar) y la base del backend en SOLO LECTURA.
//   - Escribe el libro publico en LEDGER_DIR:  estado.json, indice.json y bloques/NNNNNN.json.
//     Cada bloque lleva el SHA-256 del archivo del bloque anterior (cadena). Un bloque ya escrito NUNCA se reescribe:
//     si alguno cambia, este programa se niega a seguir (y el espejo publico en GitHub, que sella cada bloque con OpenTimestamps, lo habria notado).
//   - Publica SOLO: numero, hora (UTC, milisegundos), tipo, sats, comision (msat) y hash del pago (o txid on-chain).
//     Nunca IP, direcciones, invoices, descripciones, notas ni mensajes.
//
// Reglas de los bloques (el que ocurra primero):
//   - 5 movimientos sin sellar  ->  se cierra un bloque con esos 5
//   - 24 horas desde el movimiento sin sellar mas antiguo  ->  se cierra con los que haya
//   - una SALIDA sin clasificar (no es reclamo, ni liquidez, ni anotada por el operador)  ->  se cierra en cuanto pasa la gracia de 15 minutos
//     (la gracia da tiempo a anotar un retiro hecho a mano; no cambia nada mas)
//   - sin movimientos y 7 dias desde el ultimo bloque  ->  bloque "latido" (sin movimientos, con el saldo)
//   - la primera vez  ->  bloque "inicio" (sin movimientos, con el saldo de ese momento)
//
// Uso:  node fondo-ledger.js             (genera lo que toque)
//       node fondo-ledger.js --dry       (calcula y cuenta, no escribe nada)
//       node fondo-ledger.js --verificar (solo comprueba la cadena de LEDGER_DIR; no usa phoenixd ni la base)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const E = process.env;
const TEST = E.LEDGER_TEST === '1';                         // solo para pruebas: permite fijar la hora y el modulo de sqlite
const BACKEND_DIR = E.BACKEND_DIR || '/opt/fondo/backend';
const DB_PATH = E.DB_PATH || path.join(BACKEND_DIR, 'fondo.db');
const PHX_URL = (E.PHOENIX_URL || 'http://127.0.0.1:9740').replace(/\/+$/, '');
const PHX_CONF = E.PHOENIX_CONF || '/root/.phoenix/phoenix.conf';
const OUT_DIR = E.LEDGER_DIR || '/opt/fondo/frontend/ledger';
const ALLOW_FILE = E.ALLOW_FILE || '/opt/fondo/vigilante/permitidos.txt';
const SQLITE_MODULE = TEST && E.LEDGER_SQLITE_MODULE ? E.LEDGER_SQLITE_MODULE : null;
const LOCK_FILE = TEST && E.LEDGER_LOCK ? E.LEDGER_LOCK : '/run/fondo-ledger.lock';   // fuera de la carpeta web
const HTTP_TIMEOUT_MS = TEST && E.LEDGER_HTTP_TIMEOUT_MS ? parseInt(E.LEDGER_HTTP_TIMEOUT_MS, 10) : 15000;

const FORMAT = 'takepower-ledger/1';
const ZERO = '0'.repeat(64);
const RULES = { movimientos_por_bloque: 5, horas_maximas: 24, latido_dias: 7, gracia_minutos: 15 };
const MAX_AGE_MS = RULES.horas_maximas * 3600000;
const HEARTBEAT_MS = RULES.latido_dias * 86400000;
const GRACE_MS = RULES.gracia_minutos * 60000;
const MOTIVOS = ['inicio', 'cinco_movimientos', 'sin_clasificar', '24_horas', 'latido'];
const LIQ_PAR_MS = 10 * 60 * 1000;   // una entrada y la compra de liquidez que pago se registran a la vez (en la real, a 0,6 s)
const TIPOS = ['entrada', 'reclamo', 'liquidez', 'gasto', 'retiro', 'sin_clasificar'];

const nowMs = () => (TEST && E.LEDGER_NOW_MS ? parseInt(E.LEDGER_NOW_MS, 10) : Date.now());
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isCount = (x) => Number.isSafeInteger(x) && x >= 0;
const log = (s) => console.log(iso(nowMs()) + ' ' + s);

// ---------------------------------------------------------------- lectura de phoenixd (clave limitada)
function readConf(file) {
  const o = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
async function phx(pw, p) {
  const r = await fetch(PHX_URL + p, { redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { Authorization: 'Basic ' + Buffer.from(':' + pw).toString('base64') } });
  const txt = (await r.text()).slice(0, 5000000);
  let json = null; try { json = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json };
}
async function listAll(pw, base) {
  const all = [];
  for (let offset = 0; offset < 100000; offset += 100) {
    const r = await phx(pw, base + '?limit=100&offset=' + offset);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error('la lista ' + base + ' de phoenixd no se pudo leer (HTTP ' + r.status + ')');
    for (const p of r.json) if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('la lista ' + base + ' de phoenixd trae una entrada con forma inesperada');
    all.push(...r.json);
    if (r.json.length < 100) return all;
  }
  throw new Error('demasiadas entradas en ' + base + ' para leer en una pasada');
}

// ---------------------------------------------------------------- base del backend (solo lectura) y lista de permitidos
function readClaims() {
  const req = SQLITE_MODULE ? require : createRequire(path.join(BACKEND_DIR, 'package.json'));
  const Database = req(SQLITE_MODULE || 'better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const rows = db.prepare("SELECT payment_hash, status FROM transactions WHERE type = 'claim' AND payment_hash IS NOT NULL").all();
    return new Map(rows.map((r) => [String(r.payment_hash).toLowerCase(), String(r.status)]));
  } finally { db.close(); }
}
// permitidos.txt: "<hash o txid, 64 hex minusculas> <fecha> <nota...>" (lo escribe vigilante-permitir). Si la nota empieza por "retiro", el tipo es "retiro"; si no, "gasto".
function readAllow() {
  const m = new Map();
  let txt = '';
  try { txt = fs.readFileSync(ALLOW_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return m; throw e; }
  for (const line of txt.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const key = parts[0].toLowerCase();
    if (!isHex64(key)) continue;
    const note = parts.slice(2).join(' ');
    m.set(key, /^retiro\b/i.test(note) ? 'retiro' : 'gasto');
  }
  return m;
}

// ---------------------------------------------------------------- de las listas de phoenixd a movimientos
// Cada movimiento: { key, t (ms), salida (bool), tipo, sats (CON SIGNO: + entra, - sale), fees_msat, hash_pago, tx, ref }
// La clave (hash del pago, o "tx:<txid>", o la referencia) identifica a un movimiento ya sellado, sea entrada o salida.
function normalize(incoming, outgoing, claims, allow) {
  const res = [];
  const seen = new Set();
  const push = (m) => {
    if (seen.has(m.key)) throw new Error('dos movimientos de phoenixd comparten la misma clave (' + m.key.slice(0, 16) + '...): no sigo para no esconder ninguno');
    seen.add(m.key); res.push(m);
  };
  // referencia estable de un movimiento sin hash ni txid: el paymentId de phoenixd (saneado) o, si no queda nada util, un hash de sus datos publicos
  const idOf = (p, parts) => {
    const clean = String(p.paymentId || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
    return 'id:' + (clean || sha256(JSON.stringify(parts)).slice(0, 32));
  };
  for (const p of incoming) {
    if (p.isPaid !== true || !Number.isFinite(p.completedAt) || p.completedAt <= 0) continue;
    const hash = isHex64(String(p.paymentHash || '').toLowerCase()) ? String(p.paymentHash).toLowerCase() : null;
    const ref = hash ? null : idOf(p, [p.type, p.subType, p.completedAt, p.receivedSat]);
    const ok = isCount(p.receivedSat);
    push({ key: hash || ref, t: Math.floor(p.completedAt), salida: false, tipo: ok ? 'entrada' : 'sin_clasificar', sats: ok ? p.receivedSat : 0, fees_msat: isCount(p.fees) ? p.fees : 0, hash_pago: hash, tx: null, ref });
  }
  for (const p of outgoing) {
    if (p.isPaid !== true || !Number.isFinite(p.completedAt) || p.completedAt <= 0) continue;
    const hash = isHex64(String(p.paymentHash || '').toLowerCase()) ? String(p.paymentHash).toLowerCase() : null;
    const tx = !hash && isHex64(String(p.txId || '').toLowerCase()) ? String(p.txId).toLowerCase() : null;
    const ref = hash || tx ? null : idOf(p, [p.type, p.subType, p.completedAt, p.sent]);
    let tipo;
    if (p.subType === 'auto_liquidity') tipo = 'liquidez';
    else if (hash && claims.has(hash) && claims.get(hash) !== 'failed') tipo = 'reclamo';
    else if (hash && allow.has(hash)) tipo = allow.get(hash);      // un reclamo "fallido" en la base pero pagado en phoenixd no se explica solo: queda sin clasificar hasta que el operador lo anote
    else if (tx && allow.has(tx)) tipo = allow.get(tx);
    else tipo = 'sin_clasificar';
    const ok = isCount(p.sent);
    push({ key: hash || (tx ? 'tx:' + tx : ref), t: Math.floor(p.completedAt), salida: true, tipo: ok ? tipo : 'sin_clasificar', sats: ok ? -p.sent : 0, fees_msat: isCount(p.fees) ? p.fees : 0, hash_pago: hash, tx, ref });
  }
  // Entrada que pago una compra de liquidez (canal nuevo o ampliado): phoenixd la informa NETA (receivedSat ya sin la comision, que va en
  // "fees", en msat) y ADEMAS lista la compra como salida auto_liquidity por ese mismo monto. Para no contar dos veces la comision, esa
  // entrada se publica BRUTA (lo que pago quien envio = receivedSat + comision) y la liquidez queda como su salida aparte.
  // Solo se empareja con una salida auto_liquidity cuyo monto enviado sea EXACTAMENTE la comision de la entrada, a menos de LIQ_PAR_MS,
  // y cada salida sirve para una sola entrada (la mas cercana en el tiempo; a igual distancia, la de clave menor). Sin pareja, la entrada queda neta
  // y la diferencia contable lo avisa.
  const orden = (a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const liq = res.filter((m) => m.salida && m.tipo === 'liquidez' && m.sats < 0).sort(orden);
  const ents = res.filter((m) => !m.salida && m.tipo === 'entrada' && m.fees_msat > 0).sort(orden);
  const usadas = new Set();
  for (const l of liq) {
    let mejor = null;
    for (const m of ents) {
      if (usadas.has(m) || -l.sats * 1000 !== m.fees_msat || Math.abs(l.t - m.t) > LIQ_PAR_MS) continue;
      if (!mejor || Math.abs(l.t - m.t) < Math.abs(mejor.t - l.t)) mejor = m;
    }
    if (mejor) { usadas.add(mejor); mejor.sats += -l.sats; }
  }
  res.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return res;
}
const delta = (m) => m.sats;

// clave de un movimiento ya publicado en un bloque (la misma que usa normalize)
function keyOfPublished(m) { return m.hash_pago || (m.tx ? 'tx:' + m.tx : m.ref); }

// ---------------------------------------------------------------- reglas de los bloques (funcion pura)
// open: movimientos sin sellar, en orden. Devuelve { plan: [{ movs, motivo }], rest }.
function planBlocks(open, now, lastClosedMs, hasBlocks) {
  const N = RULES.movimientos_por_bloque;
  const plan = [];
  const rest = open.slice();
  if (!hasBlocks) plan.push({ movs: [], motivo: 'inicio' });
  for (;;) {
    // una salida sin clasificar que aun esta dentro de la gracia frena el sellado de ella y de todo lo posterior (los numeros van en orden)
    const hold = rest.findIndex((m) => m.salida && m.tipo === 'sin_clasificar' && now - m.t < GRACE_MS);
    const sealable = hold < 0 ? rest : rest.slice(0, hold);
    if (!sealable.length) break;
    const sc = sealable.findIndex((m) => m.salida && m.tipo === 'sin_clasificar');
    let take, motivo;
    if (sc >= 0 && sc < N) { take = sc + 1; motivo = 'sin_clasificar'; }
    else if (sealable.length >= N) { take = N; motivo = 'cinco_movimientos'; }
    else if (now - sealable[0].t >= MAX_AGE_MS) { take = sealable.length; motivo = '24_horas'; }
    else break;
    plan.push({ movs: rest.splice(0, take), motivo });
  }
  if (!plan.length && !rest.length && hasBlocks && now - lastClosedMs >= HEARTBEAT_MS) plan.push({ movs: [], motivo: 'latido' });
  return { plan, rest };
}

// ---------------------------------------------------------------- escritura de archivos
function serializeBlock(b) {
  const head = (k) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(b[k]);
  const lines = ['formato', 'bloque', 'nodo', 'anterior', 'cerrado_en', 'motivo', 'rango', 'saldo_sat', 'credito_comisiones_sat'].map(head);
  const movs = b.movimientos.map((m) => '    ' + JSON.stringify(m));
  lines.push('  "movimientos": [' + (movs.length ? '\n' + movs.join(',\n') + '\n  ' : '') + ']');
  return Buffer.from('{\n' + lines.join(',\n') + '\n}\n', 'utf8');
}
// las carpetas del libro las lee el servidor web: siempre 755, aunque el umask del servicio sea 077
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  try { fs.chmodSync(dir, 0o755); } catch (e) {}
}
function writeAtomic(file, buf) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = file + '.tmp-' + process.pid;
  const fd = fs.openSync(tmp, 'w', 0o644);
  try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
  try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (e) {}
}

// ---------------------------------------------------------------- lectura y comprobacion de la cadena
function publicMovementOk(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const keys = Object.keys(m);
  const allowed = ['n', 'hora', 'tipo', 'sats', 'comision_msat', 'hash_pago', 'tx', 'ref'];
  if (!keys.every((k) => allowed.includes(k))) return false;
  if (!Number.isSafeInteger(m.n) || m.n < 1 || !TIPOS.includes(m.tipo) || !Number.isSafeInteger(m.sats) || !isCount(m.comision_msat)) return false;
  if (m.tipo === 'entrada' ? m.sats < 0 : (m.tipo !== 'sin_clasificar' && m.sats > 0)) return false;     // entrada suma; reclamo, liquidez, gasto y retiro restan
  if (typeof m.hora !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(m.hora)) return false;
  if (!Number.isFinite(Date.parse(m.hora)) || iso(Date.parse(m.hora)) !== m.hora) return false;      // mes 13, dia 45...: no es una hora real
  if (!(m.hash_pago === null || isHex64(m.hash_pago))) return false;
  if (m.tx !== undefined && !isHex64(m.tx)) return false;
  if (m.ref !== undefined && !/^id:[0-9A-Za-z_-]{1,64}$/.test(m.ref)) return false;
  if (!m.hash_pago && !m.tx && !m.ref) return false;            // todo movimiento tiene hash de pago, txid o referencia
  return true;
}
function loadChain() {
  const dir = path.join(OUT_DIR, 'bloques');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^\d{6}\.json$/.test(f)).sort(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const blocks = [];
  let prev = ZERO, expectN = 1, lastClosed = 0, nodo = null;
  names.forEach((f, i) => {
    const num = i + 1;
    if (f !== String(num).padStart(6, '0') + '.json') throw new Error('falta el bloque ' + num + ' (el siguiente archivo es ' + f + ')');
    const bytes = fs.readFileSync(path.join(dir, f));
    let b;
    try { b = JSON.parse(bytes.toString('utf8')); } catch (e) { throw new Error('el bloque ' + num + ' no es JSON valido'); }
    if (!b || b.formato !== FORMAT || b.bloque !== num) throw new Error('el bloque ' + num + ' no tiene el formato esperado');
    if (!/^[0-9a-f]{66}$/.test(String(b.nodo))) throw new Error('el bloque ' + num + ' no trae el nodo');
    if (nodo !== null && b.nodo !== nodo) throw new Error('el bloque ' + num + ' dice otro nodo que el primero');
    nodo = b.nodo;
    if (b.anterior !== prev) throw new Error('la cadena se rompe en el bloque ' + num + ': "anterior" no coincide con el hash del bloque ' + (num - 1));
    if (!MOTIVOS.includes(b.motivo)) throw new Error('el bloque ' + num + ' tiene un motivo desconocido');
    if ((num === 1) !== (b.motivo === 'inicio')) throw new Error('el bloque ' + num + ': el motivo "inicio" es solo del primer bloque, y el primer bloque tiene que ser "inicio"');
    const t = Date.parse(b.cerrado_en);
    if (!Number.isFinite(t) || iso(t) !== b.cerrado_en) throw new Error('el bloque ' + num + ' tiene una hora de cierre invalida');
    if (t < lastClosed) throw new Error('el bloque ' + num + ' se cerro antes que el anterior');
    if (!isCount(b.saldo_sat) || !isCount(b.credito_comisiones_sat)) throw new Error('el bloque ' + num + ' tiene un saldo invalido');
    if (!Array.isArray(b.movimientos)) throw new Error('el bloque ' + num + ' no trae la lista de movimientos');
    for (const m of b.movimientos) {
      if (!publicMovementOk(m)) throw new Error('el bloque ' + num + ' trae un movimiento con forma invalida');
      if (m.n !== expectN) throw new Error('el bloque ' + num + ': el movimiento ' + m.n + ' debia ser el ' + expectN);
      expectN++;
    }
    const rango = b.movimientos.length ? [b.movimientos[0].n, b.movimientos[b.movimientos.length - 1].n] : null;
    if (JSON.stringify(b.rango) !== JSON.stringify(rango)) throw new Error('el bloque ' + num + ': el rango no coincide con sus movimientos');
    if (!Buffer.from(serializeBlock(b)).equals(bytes)) throw new Error('el bloque ' + num + ' no esta en la forma canonica (alguien lo edito a mano?)');
    const sha = sha256(bytes);
    blocks.push({ num, file: f, sha, data: b });
    prev = sha; lastClosed = t;
  });
  // el indice anterior, si existe, no puede contradecir a los archivos (cada bloque ya publicado es inmutable)
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'indice.json'), 'utf8'));
    if (idx && Array.isArray(idx.bloques)) {
      for (const e of idx.bloques) {
        const b = blocks[e.bloque - 1];
        if (!b || b.sha !== e.sha256) throw new Error('el bloque ' + e.bloque + ' ya no coincide con el indice publicado (se modifico o se borro un bloque)');
      }
    }
  } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  return { blocks, lastSha: prev, lastClosed, nextN: expectN, nodo };
}

// ---------------------------------------------------------------- candado (una sola corrida a la vez)
// Dos corridas a la vez (el temporizador y una a mano) podrian escribir el mismo numero de bloque con contenido distinto.
// El candado vive fuera de la carpeta web. Un candado de un proceso que ya no existe, o de mas de 10 minutos, se retira.
function takeLock() {
  const me = String(process.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
      try { fs.writeSync(fd, me); } finally { fs.closeSync(fd); }
      return () => { try { if (fs.readFileSync(LOCK_FILE, 'utf8') === me) fs.unlinkSync(LOCK_FILE); } catch (e) {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = 0, age = Infinity;
    try { pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) || 0; age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs; } catch (e) { continue; }
    let alive;
    if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    else alive = age < 10000;                                  // recien creado y aun sin escribir el pid
    if (alive && age < 10 * 60000) throw new Error('hay otra corrida en curso (pid ' + pid + '); si no es cierto, borra ' + LOCK_FILE);
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
  }
  throw new Error('no pude tomar el candado ' + LOCK_FILE);
}

// ---------------------------------------------------------------- principal
async function main() {
  const args = process.argv.slice(2);
  const DRY = args.includes('--dry'), ONLY_VERIFY = args.includes('--verificar');
  if (args.some((a) => a !== '--dry' && a !== '--verificar')) { console.error('uso: node fondo-ledger.js [--dry | --verificar]'); process.exit(2); }
  const release = DRY || ONLY_VERIFY ? () => {} : takeLock();
  try { await generate(DRY, ONLY_VERIFY); } finally { release(); }
}
async function generate(DRY, ONLY_VERIFY) {
  let now = nowMs();            // se vuelve a tomar despues de leer a phoenixd (ver abajo)

  const chain = loadChain();
  if (ONLY_VERIFY) { log('cadena correcta: ' + chain.blocks.length + ' bloques, ' + (chain.nextN - 1) + ' movimientos'); return; }
  if (chain.lastClosed && now < chain.lastClosed) throw new Error('el reloj del servidor esta atrasado respecto del ultimo bloque (' + iso(chain.lastClosed) + ')');

  let pw = null;
  try { pw = readConf(PHX_CONF)['http-password-limited-access'] || null; } catch (e) {}
  if (!pw) throw new Error('no hay http-password-limited-access legible en ' + PHX_CONF);

  const info = await phx(pw, '/getinfo');
  const nodeId = info.status === 200 && info.json && typeof info.json.nodeId === 'string' ? info.json.nodeId.toLowerCase() : '';
  if (!/^[0-9a-f]{66}$/.test(nodeId)) throw new Error('getinfo de phoenixd ilegible (HTTP ' + info.status + ')');
  if (chain.nodo && chain.nodo !== nodeId) throw new Error('phoenixd es otro nodo distinto del que escribio el libro: no sigo');

  // foto consistente: lista, saldo y lista otra vez; si la lista cambio entre una lectura y otra, se repite
  let incoming, outgoing, bal;
  for (let attempt = 1; ; attempt++) {
    const a1 = await listAll(pw, '/payments/incoming'), o1 = await listAll(pw, '/payments/outgoing');
    const b = await phx(pw, '/getbalance');
    if (b.status !== 200 || !b.json || !isCount(b.json.balanceSat) || !isCount(b.json.feeCreditSat)) throw new Error('getbalance de phoenixd ilegible (HTTP ' + b.status + ')');
    const a2 = await listAll(pw, '/payments/incoming'), o2 = await listAll(pw, '/payments/outgoing');
    const sig = (l) => l.map((p) => [p.paymentHash || p.txId || p.paymentId || '', p.isPaid === true ? 1 : 0, p.completedAt || 0].join(':')).sort().join('|');
    if (sig(a1) === sig(a2) && sig(o1) === sig(o2)) { incoming = a2; outgoing = o2; bal = b.json; break; }
    if (attempt >= 3) throw new Error('los pagos de phoenixd cambiaron durante la lectura 3 veces seguidas: se reintenta en la proxima corrida');
  }
  now = nowMs();               // despues de la foto: ningun movimiento leido puede ser posterior a la hora de cierre de los bloques de esta corrida

  const claims = readClaims();
  const allow = readAllow();
  const movements = normalize(incoming, outgoing, claims, allow);

  const sealed = new Set();
  for (const b of chain.blocks) for (const m of b.data.movimientos) sealed.add(keyOfPublished(m));
  const current = new Set(movements.map((m) => m.key));
  const alertas = [];
  const faltan = [...sealed].filter((k) => !current.has(k)).length;
  if (faltan) alertas.push('hay ' + faltan + ' movimiento(s) ya sellado(s) que phoenixd ya no lista');
  const open = movements.filter((m) => !sealed.has(m.key));

  const { plan, rest } = planBlocks(open, now, chain.lastClosed, chain.blocks.length > 0);

  // saldo de cada bloque nuevo: el saldo actual menos lo que paso despues de ese bloque
  let after = rest.reduce((s, m) => s + delta(m), 0);
  const saldos = new Array(plan.length);
  for (let i = plan.length - 1; i >= 0; i--) {
    const raw = bal.balanceSat - after;
    saldos[i] = Math.max(0, raw);
    if (raw < 0) alertas.push('el saldo calculado de un bloque salia negativo (' + raw + ' sats): se publico 0');
    after += plan[i].movs.reduce((s, m) => s + delta(m), 0);
  }

  // comprobacion de cuentas: saldo del bloque "inicio" + suma (con signo) de todos los movimientos = saldo informado por phoenixd (con margen de redondeo).
  // (En la primera corrida el saldo del bloque "inicio" se calcula hacia atras desde el saldo actual, asi que la comprobacion seria circular.)
  if (chain.blocks.length) {
    const expected = chain.blocks[0].data.saldo_sat + movements.reduce((sum, m) => sum + delta(m), 0);
    const gap = bal.balanceSat - expected;
    if (Math.abs(gap) > Math.max(5, 2 * movements.length)) alertas.push('diferencia contable de ' + gap + ' sats entre el saldo del nodo (' + bal.balanceSat + ') y el saldo inicial mas los movimientos (' + expected + '); puede ser transitoria (pagos en curso)');
  }

  // armar y escribir los bloques nuevos
  const newBlocks = [];
  let prev = chain.lastSha, n = chain.nextN, num = chain.blocks.length;
  plan.forEach((p, i) => {
    num++;
    const movimientos = p.movs.map((m) => {
      const o = { n: n++, hora: iso(m.t), tipo: m.tipo, sats: m.sats, comision_msat: m.fees_msat, hash_pago: m.hash_pago };
      if (m.tx) o.tx = m.tx;
      if (m.ref) o.ref = m.ref;
      return o;
    });
    const b = {
      formato: FORMAT, bloque: num, nodo: nodeId, anterior: prev, cerrado_en: iso(now), motivo: p.motivo,
      rango: movimientos.length ? [movimientos[0].n, movimientos[movimientos.length - 1].n] : null,
      saldo_sat: saldos[i], credito_comisiones_sat: bal.feeCreditSat, movimientos,
    };
    const bytes = serializeBlock(b);
    const sha = sha256(bytes);
    newBlocks.push({ num, file: String(num).padStart(6, '0') + '.json', bytes, sha, data: b });
    prev = sha;
  });

  const counts = {};
  for (const m of open) counts[m.tipo] = (counts[m.tipo] || 0) + 1;
  log('phoenixd: ' + incoming.length + ' entradas y ' + outgoing.length + ' salidas leidas; movimientos nuevos: ' + open.length + ' (' + (Object.keys(counts).sort().map((k) => k + '=' + counts[k]).join(' ') || 'ninguno') + '); saldo ' + bal.balanceSat + ' sats');
  log('bloques por crear: ' + (plan.map((p) => p.motivo).join(', ') || 'ninguno') + '; quedan abiertos: ' + rest.length);
  if (DRY) { log('simulacro: no se escribio nada; ' + (alertas.length ? 'alertas: ' + alertas.length + ' -> ' + alertas.join(' | ') : 'sin alertas')); return; }

  ensureDir(OUT_DIR);
  for (const nb of newBlocks) writeAtomic(path.join(OUT_DIR, 'bloques', nb.file), nb.bytes);
  const all = chain.blocks.concat(newBlocks);
  const last = all.length ? all[all.length - 1] : null;
  const indice = { formato: FORMAT, bloques: all.map((b) => ({ bloque: b.num, archivo: 'bloques/' + b.file, sha256: b.sha, cerrado_en: b.data.cerrado_en, motivo: b.data.motivo, movimientos: b.data.movimientos.length })) };
  writeAtomic(path.join(OUT_DIR, 'indice.json'), Buffer.from(JSON.stringify(indice, null, 1) + '\n', 'utf8'));
  const estado = {
    formato: FORMAT, nodo: nodeId, actualizado_en: iso(now), reglas: RULES,
    bloques: all.length, ultimo_bloque: last ? { bloque: last.num, sha256: last.sha, cerrado_en: last.data.cerrado_en, motivo: last.data.motivo } : null,
    movimientos_sellados: n - 1, saldo_sat: bal.balanceSat, credito_comisiones_sat: bal.feeCreditSat,
    abierto: rest.map((m) => { const o = { hora: iso(m.t), tipo: m.tipo, sats: m.sats, comision_msat: m.fees_msat, hash_pago: m.hash_pago }; if (m.tx) o.tx = m.tx; if (m.ref) o.ref = m.ref; return o; }),
    alertas,
  };
  writeAtomic(path.join(OUT_DIR, 'estado.json'), Buffer.from(JSON.stringify(estado, null, 1) + '\n', 'utf8'));
  log('listo: ' + all.length + ' bloques (' + newBlocks.length + ' nuevos), ' + (n - 1) + ' movimientos sellados, ' + rest.length + ' abiertos' + (alertas.length ? ', alertas: ' + alertas.length : ''));
}

if (require.main === module) {
  main().catch((e) => { console.error(iso(nowMs()) + ' ERROR: ' + (e && e.message || e)); process.exit(1); });
} else {
  module.exports = { planBlocks, normalize, serializeBlock, loadChain, keyOfPublished, RULES };
}
