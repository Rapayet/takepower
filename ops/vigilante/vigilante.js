#!/usr/bin/env node
'use strict';
// vigilante.js (v1.1) - vigilante INDEPENDIENTE del backend del Baul. Corre cada minuto (systemd timer) como proceso aparte.
// v1.1: el titulo del aviso va en ASCII plano (ntfy solo decodifica RFC 2047, no %20: con encodeURIComponent se veria "FRENO%20DEL%20BAUL").
//
// Que vigila (todo contra el registro PROPIO de phoenixd, que el backend no puede falsear, y la base del backend en SOLO LECTURA):
//   1. Toda salida de dinero de phoenixd (pagada o en curso) debe estar explicada: ser un reclamo registrado en la base, estar en la lista de
//      permitidos (los scripts de operacion anotan el hash ANTES de pagar) o caer dentro de una ventana de mantenimiento que abriste tu.
//      Si no -> FRENO: crea el archivo HALT, detiene el backend y phoenixd, y avisa.
//   2. Una salida que phoenixd marca pagada pero la base marca 'failed' (el escenario de doble pago) -> FRENO.
//   3. Tope de salidas en 24 h (MAX_OUTFLOW_24H_SATS): si se supera, aunque cada pago este "explicado" -> FRENO.
//   4. Reclamos 'pending' de mas de PENDING_ALERT_MIN minutos, nodeId distinto del configurado, phoenixd o la base inaccesibles -> AVISO.
// Usa SOLO la clave limitada de phoenixd (no puede pagar). Nunca imprime claves. Aviso opcional por ntfy (NOTIFY_URL) y latido (HEARTBEAT_URL).
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { execFile } = require('child_process');

const E = process.env;
const BACKEND_DIR = E.BACKEND_DIR || '/opt/fondo/backend';
const DB_PATH = E.DB_PATH || path.join(BACKEND_DIR, 'fondo.db');
const HALT_FILE = E.HALT_FILE || path.join(BACKEND_DIR, 'HALT');
const PHX_URL = (E.PHOENIX_URL || 'http://127.0.0.1:9740').replace(/\/+$/, '');
const PHX_CONF = E.PHOENIX_CONF || '/root/.phoenix/phoenix.conf';
const STATE_DIR = E.STATE_DIR || '/var/lib/vigilante';
const ALLOW_FILE = E.ALLOW_FILE || '/opt/fondo/vigilante/permitidos.txt';
const WINDOW_FILE = E.WINDOW_FILE || '/opt/fondo/vigilante/ventana.txt';
const MAX_OUTFLOW_24H = Math.max(0, parseInt(E.MAX_OUTFLOW_24H_SATS) || 0);        // 0 = sin tope (no recomendado)
const PENDING_ALERT_MS = Math.max(1, parseFloat(E.PENDING_ALERT_MIN) || 10) * 60000;
const NOTIFY_URL = E.NOTIFY_URL || '';
const HEARTBEAT_URL = E.HEARTBEAT_URL || '';
const WATCH_HOURS = 26;                                  // ventana de lectura del registro de phoenixd
const REPEAT_ALERT_MS = 6 * 3600000;                     // un mismo aviso no se repite antes de 6 h
const UNREACHABLE_ALERT_AFTER = 3;                       // corridas seguidas sin poder leer phoenixd/la base antes de avisar

const log = (s) => console.log(new Date().toISOString() + ' ' + s);

function readConf(file) {
  const o = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
function readEnvVar(file, name) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) {}
  return '';
}

// ---------- estado en disco ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'estado.json'), 'utf8')); } catch (e) { return {}; }
}
function saveState(st) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(STATE_DIR, 'estado.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
  fs.renameSync(tmp, path.join(STATE_DIR, 'estado.json'));
}

// ---------- avisos (nunca lanzan error) ----------
async function notify(level, title, text) {
  log('[' + level + '] ' + title + ' - ' + text);
  if (!NOTIFY_URL) return;
  try {
    await fetch(NOTIFY_URL, { method: 'POST', signal: AbortSignal.timeout(8000), headers: { Title: String(title).normalize('NFD').replace(/[^\x20-\x7e]/g, '').slice(0, 120), Priority: level === 'alta' ? '5' : level === 'media' ? '3' : '2', Tags: level === 'alta' ? 'rotating_light' : 'warning' }, body: text.slice(0, 1000) });
  } catch (e) { log('no se pudo enviar el aviso: ' + ((e && e.name) || 'error')); }
}
async function alertOnce(st, key, level, title, text, every) {
  st.alerts = st.alerts || {};
  const now = Date.now();
  if (st.alerts[key] && now - st.alerts[key] < (every || REPEAT_ALERT_MS)) return;
  st.alerts[key] = now;
  await notify(level, title, text);
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 30000 }, (err) => resolve(err ? 'error: ' + (err.code || err.message) : 'ok')));
}

// ---------- phoenixd (solo lectura, clave limitada) ----------
async function phx(pw, p, timeoutMs) {
  const r = await fetch(PHX_URL + p, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs || 15000), headers: { Authorization: 'Basic ' + Buffer.from(':' + pw).toString('base64') } });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json };
}
async function readOutgoing(pw, fromMs) {
  const all = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await phx(pw, '/payments/outgoing?all=true&limit=100&offset=' + offset + '&from=' + Math.max(0, Math.floor(fromMs)));
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error('lista de pagos salientes ilegible (HTTP ' + r.status + ')');
    for (const p of r.json) if (!p || typeof p !== 'object') throw new Error('lista de pagos salientes con forma inesperada');
    all.push(...r.json);
    if (r.json.length < 100) return all;
  }
  throw new Error('demasiados pagos salientes para revisar en una pasada');
}

// ---------- listas de permitidos y ventana de mantenimiento ----------
function readAllow() {
  const hashes = new Set(), txids = new Set();
  try {
    for (const line of fs.readFileSync(ALLOW_FILE, 'utf8').split('\n')) {
      const tok = line.trim().split(/\s+/)[0] || '';
      if (/^[0-9a-f]{64}$/.test(tok)) { hashes.add(tok); txids.add(tok); }   // un hash de pago o un txid: ambos son hex de 64
    }
  } catch (e) {}
  return { hashes, txids };
}
function readWindow(now) {
  // una sola linea: <expira_epoch_segundos> <max_sats> <nota>
  try {
    const m = /^\s*(\d+)\s+(\d+)\b/.exec(fs.readFileSync(WINDOW_FILE, 'utf8'));
    if (m && now < parseInt(m[1]) * 1000) return { until: parseInt(m[1]) * 1000, max: parseInt(m[2]) };
  } catch (e) {}
  return null;
}

// ---------- base del backend (solo lectura) ----------
function readDb() {
  const Database = createRequire(path.join(BACKEND_DIR, 'package.json'))('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const rows = db.prepare("SELECT id, payment_hash, status, created_at FROM transactions WHERE type = 'claim' AND payment_hash IS NOT NULL AND created_at >= datetime('now', '-3 days')").all();
    return rows;
  } finally { db.close(); }
}
const parseSqlTime = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');

// ---------- el freno ----------
async function trip(st, reasons, stopPhoenix) {
  if (st.tripped) {
    log('ya estaba frenado; no se repiten las acciones');
    await alertOnce(st, 'sigue-frenado', 'media', 'El Baul sigue frenado', 'Existe ' + HALT_FILE + ' y siguen apareciendo salidas sin explicar. Investiga y borra el archivo para reabrir');
    return;
  }
  st.tripped = true; st.trippedAt = Date.now();
  const reason = reasons.join(' | ').slice(0, 900);
  try { fs.appendFileSync(HALT_FILE, new Date().toISOString() + ' vigilante: ' + reason + '\n', { mode: 0o600 }); } catch (e) { log('NO se pudo escribir ' + HALT_FILE + ': ' + e.message); }
  const a = await run('systemctl', ['stop', 'fondo-backend']);
  let b = 'no se toca';
  if (stopPhoenix) b = await run('systemctl', ['stop', 'phoenixd']);
  await notify('alta', 'FRENO DEL BAUL', reason + ' || backend: ' + a + ' | phoenixd: ' + b + ' || para reabrir: investiga, borra ' + HALT_FILE + ' y arranca los servicios');
}

async function main() {
  const now = Date.now();
  const st = loadState();
  const findings = { trips: [], stopPhoenix: false };

  if (st.ackedUntil === undefined) { st.ackedUntil = now; log('primera ejecucion: se vigila lo que ocurra desde ahora'); }
  if (st.tripped && !fs.existsSync(HALT_FILE)) { st.tripped = false; st.ackedUntil = now; await notify('media', 'Vigilante: HALT retirado', 'Se da por enterado: se vigila desde este momento'); }

  // credencial limitada (nunca la completa)
  let pw = null;
  try { pw = readConf(PHX_CONF)['http-password-limited-access'] || null; } catch (e) {}
  if (!pw) { await alertOnce(st, 'sinclave', 'media', 'Vigilante sin clave', 'No hay http-password-limited-access legible en ' + PHX_CONF); saveState(st); process.exit(1); }

  const ownNode = (E.OWN_NODE_ID || readEnvVar(path.join(BACKEND_DIR, '.env'), 'OWN_NODE_ID') || '').toLowerCase();
  let ok = true;

  // --- phoenixd: identidad y pagos salientes ---
  let outgoing = null;
  try {
    const info = await phx(pw, '/getinfo');
    const id = info.status === 200 && info.json && typeof info.json.nodeId === 'string' ? info.json.nodeId.toLowerCase() : '';
    if (!id) throw new Error('getinfo ilegible (HTTP ' + info.status + ')');
    if (ownNode && id !== ownNode) await alertOnce(st, 'nodeid', 'alta', 'nodeId distinto', 'El nodeId de phoenixd no coincide con OWN_NODE_ID: o cambio el nodo o la configuracion es otra');
    outgoing = await readOutgoing(pw, now - WATCH_HOURS * 3600000);
    st.phxFails = 0;
  } catch (e) {
    ok = false;
    st.phxFails = (st.phxFails || 0) + 1;
    log('phoenixd: ' + e.message + ' (' + st.phxFails + ' seguidas)');
    if (st.phxFails >= UNREACHABLE_ALERT_AFTER) await alertOnce(st, 'phx', 'media', 'Vigilante no alcanza phoenixd', e.message + ' (' + st.phxFails + ' corridas seguidas)');
  }

  // --- base del backend ---
  let rows = null;
  try { rows = readDb(); st.dbFails = 0; } catch (e) {
    ok = false;
    st.dbFails = (st.dbFails || 0) + 1;
    log('base: ' + e.message + ' (' + st.dbFails + ' seguidas)');
    if (st.dbFails >= UNREACHABLE_ALERT_AFTER) await alertOnce(st, 'db', 'media', 'Vigilante no puede leer la base', e.message);
  }

  // --- pendientes viejos (solo aviso) ---
  if (rows) {
    st.pendingAlerted = st.pendingAlerted || {};
    for (const t of rows) {
      if (t.status !== 'pending') { delete st.pendingAlerted[t.id]; continue; }
      const age = now - parseSqlTime(t.created_at);
      if (age > PENDING_ALERT_MS && !st.pendingAlerted[t.id]) {
        st.pendingAlerted[t.id] = now;
        await notify('media', 'Reclamo pendiente', 'La transaccion ' + t.id + ' lleva ' + Math.round(age / 60000) + ' min en pending: revisa el registro de phoenixd');
      }
    }
  }

  // --- el corazon: toda salida de dinero debe estar explicada ---
  if (outgoing && rows) {
    const dbStatus = new Map(rows.map(t => [t.payment_hash, t.status]));
    const allow = readAllow();
    const win = readWindow(now);
    let winUsed = st.winUsed && win && st.winUntil === win.until ? st.winUsed : 0;
    const seen = new Set(st.seen || []);
    let total24 = 0, unexplained = 0;
    for (const p of outgoing) {
      if (!(typeof p.createdAt === 'number') || p.createdAt <= st.ackedUntil) continue;
      const moved = p.isPaid === true || (p.isPaid !== true && !p.completedAt);       // pagada o en curso (si no: fallida, no salio dinero)
      if (!moved || p.subType === 'auto_liquidity') continue;
      const amount = Number.isFinite(p.sent) && p.sent > 0 ? p.sent : 0;
      if (now - p.createdAt <= 24 * 3600000) total24 += amount;
      const key = (typeof p.paymentHash === 'string' ? p.paymentHash : (p.txId || p.paymentId || '?')) + ':' + (p.subType || '');
      let why = null;
      if (typeof p.paymentHash === 'string') {
        const s = dbStatus.get(p.paymentHash);
        if (allow.hashes.has(p.paymentHash)) why = null;
        else if (s === undefined) why = 'pago Lightning de ' + amount + ' sats (hash ' + p.paymentHash.slice(0, 12) + '...) que NO esta en la base ni en permitidos';
        else if (s === 'failed' && p.isPaid === true) { findings.trips.push('phoenixd pago ' + amount + ' sats (hash ' + p.paymentHash.slice(0, 12) + '...) pero la base lo marca fallido'); continue; }
      } else if (!(p.txId && allow.txids.has(String(p.txId)))) {
        why = 'salida de tipo ' + (p.subType || p.type || 'desconocido') + ' de ' + amount + ' sats (' + String(p.txId || p.paymentId || '').slice(0, 12) + '...) sin explicacion';
      }
      if (!why) continue;
      if (win && (seen.has(key) || winUsed + amount <= win.max)) {            // dentro de la ventana de mantenimiento que abriste
        if (!seen.has(key)) { winUsed += amount; seen.add(key); await notify('info', 'Salida dentro de la ventana de mantenimiento', why); }
        continue;
      }
      unexplained++; findings.trips.push(why); findings.stopPhoenix = true;
    }
    st.winUsed = winUsed; st.winUntil = win ? win.until : null; st.seen = [...seen].slice(-200);
    if (MAX_OUTFLOW_24H > 0 && total24 > MAX_OUTFLOW_24H) findings.trips.push('salidas de ' + total24 + ' sats en 24 h superan el tope de ' + MAX_OUTFLOW_24H);
    log('revisadas ' + outgoing.length + ' entradas del registro; salidas 24 h: ' + total24 + ' sats; sin explicar: ' + unexplained);
  }

  if (findings.trips.length) { await trip(st, findings.trips, findings.stopPhoenix); saveState(st); process.exit(0); }
  if (st.tripped) await alertOnce(st, 'sigue-frenado', 'media', 'El Baul sigue frenado', 'Existe ' + HALT_FILE + '. Investiga y bórralo para reabrir');

  if (ok && HEARTBEAT_URL) { try { await fetch(HEARTBEAT_URL, { signal: AbortSignal.timeout(8000) }); } catch (e) { log('latido no enviado'); } }
  saveState(st);
}

main().catch(async (e) => {
  log('ERROR INTERNO: ' + (e && e.stack || e));
  try { const st = loadState(); await alertOnce(st, 'interno', 'media', 'Vigilante fallo', String(e && e.message || e)); saveState(st); } catch (e2) {}
  process.exit(1);
});
