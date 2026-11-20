require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bolt11 = require('bolt11');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', false);  // PARCHE-IP-2026-11: nginx no agrega X-Forwarded-For; la IP real la fija el middleware de abajo
// ========== PARCHE-IP-2026-11: IP real del cliente ==========
// nginx NO agrega X-Forwarded-For (deja pasar el que mande el cliente) y SI pone X-Real-IP = IP de la conexion real.
// Por eso: X-Forwarded-For se ignora y X-Real-IP solo se acepta si la conexion llega desde esta misma maquina (nginx).
const net = require('net');
function expandIPv6(raw) {
  const ip = raw.split('%')[0].toLowerCase();
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => {
    const out = [];
    if (!s) return out;
    for (const g of s.split(':')) {
      if (g.includes('.')) {   // IPv4 incrustada, p. ej. ::ffff:1.2.3.4
        const p = g.split('.').map(Number);
        out.push(((p[0] << 8) | p[1]).toString(16), ((p[2] << 8) | p[3]).toString(16));
      } else out.push(g);
    }
    return out;
  };
  const head = toGroups(halves[0]);
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = toGroups(halves[1]);
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : head.concat(new Array(fill).fill('0'), tail);
}
// Devuelve una IP valida como clave de control: IPv4 tal cual; IPv6 -> su prefijo /64 (quien tiene un /64 puede rotar dentro de el); si no es IP -> null
function normalizeIP(raw) {
  if (typeof raw !== 'string') return null;
  let ip = raw.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const kind = net.isIP(ip.split('%')[0]);
  if (kind === 4) return ip;
  if (kind !== 6) return null;
  const g = expandIPv6(ip);
  if (!g) return null;
  if (g.slice(0, 5).every(x => parseInt(x, 16) === 0) && g[5] === 'ffff') {   // ::ffff:aabb:ccdd (IPv4 mapeada en hexadecimal)
    const hi = parseInt(g[6], 16), lo = parseInt(g[7], 16);
    return (hi >> 8) + '.' + (hi & 255) + '.' + (lo >> 8) + '.' + (lo & 255);
  }
  return g.slice(0, 4).map(x => x.replace(/^0+(?=.)/, '')).join(':') + '::';
}
app.use((req, res, next) => {
  const sock = req.socket && req.socket.remoteAddress;
  const viaNginx = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const xr = req.headers['x-real-ip'];
  const ip = (viaNginx && typeof xr === 'string' && normalizeIP(xr)) || normalizeIP(sock) || '0.0.0.0';
  Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
  next();
});

// ========== SECURITY HEADERS ==========
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ========== BODY PARSING ==========
app.use(express.json({ limit: '10kb' }));

// ========== RATE LIMITING ==========
const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
  standardHeaders: true, legacyHeaders: false
});

const donateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10,
  message: { error: 'Demasiadas solicitudes. Espera unos minutos.' },
  standardHeaders: true, legacyHeaders: false
});

const voteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 30,
  message: { error: 'Demasiados votos. Espera un minuto.' },
  standardHeaders: true, legacyHeaders: false
});

const productLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Límite de productos alcanzado. Espera una hora.' },
  standardHeaders: true, legacyHeaders: false
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 60,
  message: { error: 'Demasiadas solicitudes.' },
  standardHeaders: true, legacyHeaders: false
});

app.use('/api/', generalLimiter);

// ========== CONFIG FROM ENV ==========
// PARCHE-B-2026-11: los pagos van directo a phoenixd (sin LNbits ni libro contable intermedio)
const PHOENIX_URL = (process.env.PHOENIX_URL || 'http://127.0.0.1:9740').replace(/\/+$/, '');
const PHOENIX_PW_LIMITED = process.env.PHOENIX_PASSWORD_LIMITED || '';   // lee saldo y crea invoices; NO puede pagar ni mover fondos
const PHOENIX_PW_FULL = process.env.PHOENIX_PASSWORD_FULL || '';         // la unica capaz de pagar: se usa solo dentro de payClaim()
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const CLAIM_AMOUNT = parseInt(process.env.CLAIM_AMOUNT) || 10000;
const MIN_DONATION = parseInt(process.env.MIN_DONATION) || 20000;
const MAX_FUND = parseInt(process.env.MAX_FUND) || 100000000;
const OPERATIONS_RESERVE_PERCENT = parseInt(process.env.OPERATIONS_RESERVE_PERCENT) || 7;
const OPERATIONS_RESERVE_MINIMUM = parseInt(process.env.OPERATIONS_RESERVE_MINIMUM) || 37500;
const CLAIM_INTERVAL_DAYS = parseInt(process.env.CLAIM_INTERVAL_DAYS) || 21;
const DB_PATH = process.env.DB_PATH || '/opt/fondo/backend/fondo.db';

// PARCHE-CLAIM-2026-11  configuracion de seguridad (todo lo nuevo cierra por defecto)
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';                               // solo nginx (en esta misma maquina) llega a la app
const OWN_NODE_ID = (process.env.OWN_NODE_ID || '').trim().toLowerCase();   // pubkey de NUESTRO nodo: phoenix-cli getinfo -> nodeId
const DAILY_CLAIM_CAP = parseInt(process.env.DAILY_CLAIM_CAP) || 100000;    // tope de sats que pueden salir por reclamos en 24 h
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS) || 8000;
const PAY_TIMEOUT_MS = parseInt(process.env.PAY_TIMEOUT_MS) || 30000;
const CLAIMS_ACTIVE = process.env.CLAIMS_ENABLED === 'true' && /^0[23][0-9a-f]{64}$/.test(OWN_NODE_ID) && !!TURNSTILE_SECRET && !!PHOENIX_PW_FULL;
if (!CLAIMS_ACTIVE) console.warn('AVISO: reclamos DESACTIVADOS (hace falta CLAIMS_ENABLED=true, OWN_NODE_ID v\xe1lido, TURNSTILE_SECRET y PHOENIX_PASSWORD_FULL)');


if (!PHOENIX_PW_LIMITED) {
  console.error('FATAL: falta PHOENIX_PASSWORD_LIMITED en .env');
  process.exit(1);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(PHOENIX_URL)) {
  console.error('FATAL: PHOENIX_URL debe ser http://127.0.0.1:PUERTO (las credenciales de phoenixd no salen de esta maquina)');
  process.exit(1);
}
if (!TURNSTILE_SECRET) {
  console.warn('AVISO: falta TURNSTILE_SECRET: todo lo que pide verificacion (reclamos, donaciones, proponer productos) se rechaza');
}

// ========== DATABASE ==========
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec("CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, lightning_address TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_claim DATETIME, total_claimed INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1)");
db.exec("CREATE TABLE IF NOT EXISTS nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, payee TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_claim DATETIME, total_claimed INTEGER DEFAULT 0)");
db.exec("CREATE TABLE IF NOT EXISTS vision_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
db.exec("CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, wallet_id INTEGER, node_id INTEGER, amount_sats INTEGER, status TEXT, payment_hash TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
db.exec(`CREATE TABLE IF NOT EXISTS energy_products (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, categoria TEXT NOT NULL, mj REAL NOT NULL, descripcion TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, is_active INTEGER DEFAULT 1)`);
db.exec(`CREATE TABLE IF NOT EXISTS energy_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, voter_ip TEXT NOT NULL, vote INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id, voter_ip), FOREIGN KEY (product_id) REFERENCES energy_products(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS energy_votes_predefined (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, voter_ip TEXT NOT NULL, vote INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id, voter_ip))`);

// Tabla para bloqueo de claims por IP (anti-multicuenta)
db.exec("CREATE TABLE IF NOT EXISTS claim_ips (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, last_claim DATETIME DEFAULT CURRENT_TIMESTAMP)");
db.exec("CREATE INDEX IF NOT EXISTS idx_claim_ips_ip ON claim_ips(ip)");

// ========== HELPERS ==========
function getClientIP(req) {
  return req.ip || 'unknown';  // PARCHE-IP-2026-11: req.ip lo fija el middleware (X-Real-IP de nginx); X-Forwarded-For ya no cuenta
}

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return false;   // PARCHE-D-2026-11: sin secreto NO se verifica nada: se rechaza (antes dejaba pasar)
  if (!token) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: net.isIPv4(ip) ? ip : undefined })
    });
    const data = await response.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile error:', err.message);
    return false;
  }
}

// ========== PARCHE-B-2026-11: capa de pagos directa con phoenixd ==========
// Sin LNbits ni libro contable intermedio: lo que sale de aqui es un pago Lightning real, de monto fijo, y queda registrado ANTES de enviarse.
const nodeCrypto = require('crypto');
const nodeFs = require('fs');
const HALT_FILE = process.env.HALT_FILE || '/opt/fondo/backend/HALT';   // si existe, NO sale ningun pago (lo crea el vigilante, el freno interno o tu a mano)
const RECONCILE_MS = Math.max(200, parseInt(process.env.RECONCILE_INTERVAL_MS) || 60000);
let haltedReason = null;    // freno interno: se activa ante algo imposible y solo se quita reiniciando (y borrando HALT_FILE)
let nodeVerified = false;   // OWN_NODE_ID coincide con el nodeId real de phoenixd
let nodeChecked = false;    // ya se hizo al menos una verificacion (para avisar en el log la primera vez)
let inflightTx = null;      // pago en curso dentro de este proceso (el conciliador no lo toca)

db.exec("CREATE TABLE IF NOT EXISTS claim_intents (tx_id INTEGER PRIMARY KEY, prev_last_claim TEXT, ip_row_id INTEGER)");

function claimsOpen() { return CLAIMS_ACTIVE && nodeVerified && !haltedReason && !nodeFs.existsSync(HALT_FILE); }

function tripBreaker(reason) {
  if (!haltedReason) { haltedReason = reason; console.error('FRENO DE EMERGENCIA: ' + reason); }
  try { nodeFs.appendFileSync(HALT_FILE, new Date().toISOString() + ' ' + reason + '\n', { mode: 0o600 }); }
  catch (e) { console.error('No se pudo escribir ' + HALT_FILE + ': ' + e.message); }
}

// Llamada HTTP a phoenixd (siempre en esta misma maquina). Usa la clave LIMITADA salvo que se pida la completa (solo payinvoice).
async function phx(method, path, o) {
  o = o || {};
  const pw = o.full ? PHOENIX_PW_FULL : PHOENIX_PW_LIMITED;
  if (!pw) throw new Error('falta la credencial de phoenixd');
  const init = { method, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs || 8000), headers: { Authorization: 'Basic ' + Buffer.from(':' + pw).toString('base64') } };
  if (o.form) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(o.form).toString(); }
  const r = await fetch(PHOENIX_URL + path, init);
  const txt = (await r.text()).slice(0, 500000);
  let json = null;
  try { json = JSON.parse(txt); } catch (e) {}
  return { status: r.status, ok: r.ok, json, text: txt.slice(0, 200) };
}

// null = no se pudo saber (NUNCA se confunde con "saldo 0")
async function getPhoenixBalanceOrNull() {
  try {
    const r = await phx('GET', '/getbalance');
    if (!r.ok || !r.json || typeof r.json.balanceSat !== 'number' || !Number.isFinite(r.json.balanceSat) || r.json.balanceSat < 0) return null;
    return Math.floor(r.json.balanceSat);
  } catch (e) { return null; }
}
async function getPhoenixBalance() { const b = await getPhoenixBalanceOrNull(); return b === null ? 0 : b; }

async function verifyNode() {
  try {
    const r = await phx('GET', '/getinfo');
    const id = r.ok && r.json && typeof r.json.nodeId === 'string' ? r.json.nodeId.trim().toLowerCase() : '';
    const ok = /^0[23][0-9a-f]{64}$/.test(OWN_NODE_ID) && id === OWN_NODE_ID;
    if (!nodeChecked || ok !== nodeVerified) console.log(ok ? 'phoenixd verificado: su nodeId coincide con OWN_NODE_ID' : 'AVISO: el nodeId de phoenixd no coincide con OWN_NODE_ID (o no responde): reclamos bloqueados');
    nodeVerified = ok;
  } catch (e) {
    if (!nodeChecked || nodeVerified) console.error('AVISO: no se pudo verificar phoenixd (' + e.message + '): reclamos bloqueados');
    nodeVerified = false;
  }
  nodeChecked = true;
}

function connRefused(e) {
  const c = e && e.cause;
  if (!c) return false;
  if (c.code === 'ECONNREFUSED') return true;
  return Array.isArray(c.errors) && c.errors.length > 0 && c.errors.every(x => x && x.code === 'ECONNREFUSED');
}

// Prueba criptografica de pago: sha256(preimage) == payment_hash
function preimageMatches(pre, hash) {
  return typeof pre === 'string' && /^[0-9a-f]{64}$/.test(pre) && nodeCrypto.createHash('sha256').update(Buffer.from(pre, 'hex')).digest('hex') === hash;
}

// Que dice el registro PROPIO de phoenixd (no nuestra base) sobre un pago saliente.
// { found, paid, completed, preimage }  |  null si no se pudo consultar o la respuesta no tiene la forma esperada
async function phoenixOutgoingByHash(hash, sinceMs) {
  try {
    const hits = [];
    let end = false;
    for (let offset = 0; offset < 1000 && !end; offset += 100) {
      const r = await phx('GET', '/payments/outgoing?all=true&limit=100&offset=' + offset + '&from=' + Math.max(0, Math.floor(sinceMs)));
      if (!r.ok || !Array.isArray(r.json)) return null;
      if (r.json.some(p => !p || typeof p !== 'object')) return null;               // forma inesperada: no se concluye nada
      // las entradas que no son pagos Lightning (compra automatica de liquidez, splice, cierre de canal) no traen paymentHash: no pueden ser el nuestro y se ignoran
      for (const p of r.json) if (typeof p.paymentHash === 'string' && p.paymentHash === hash) hits.push(p);
      if (r.json.length < 100) end = true;
    }
    if (!hits.length) return end ? { found: false } : null;
    const proof = (p) => p.isPaid === true && preimageMatches(typeof p.preimage === 'string' ? p.preimage : '', hash);
    return {
      found: true,
      paid: hits.some(proof),                                                      // alguna entrada demuestra el pago
      odd: hits.some(p => p.isPaid === true && !proof(p)),                         // marcada pagada pero sin preimage valida
      inflight: hits.some(p => p.isPaid !== true && !p.completedAt),               // sigue en curso
    };
  } catch (e) { return null; }
}

// Solo hay dos veredictos "definitivos": pagado (con prueba criptografica) y fallido (phoenixd mismo lo registra como fallido).
// Todo lo demas -incluido "phoenixd no tiene registro"- queda como 'unknown' (pendiente): nunca se asume fallo.
function classifyRecord(rec, hash, why) {
  if (rec === null) return { state: 'unknown', why: why + '; no se pudo leer el registro de phoenixd' };
  if (!rec.found) return { state: 'unknown', why: why + '; phoenixd no muestra ese pago (se deja pendiente, no se asume fallo)' };
  if (rec.paid) return { state: 'paid' };
  if (rec.odd) return { state: 'unknown', why: why + '; registro pagado sin preimage valida' };
  if (rec.inflight) return { state: 'unknown', why: why + '; el pago sigue en curso en phoenixd' };
  return { state: 'failed', why: why + '; phoenixd registra el pago como fallido' };
}

// Paga EXACTAMENTE el invoice ya validado (monto fijo dentro del invoice; nunca se envia amountSat).
// state: 'paid' | 'failed' | 'unknown'
async function payClaim(pr, hash, sinceMs) {
  if (!PHOENIX_PW_FULL) return { state: 'failed', why: 'sin credencial de pago' };
  let r;
  try {
    r = await phx('POST', '/payinvoice', { form: { invoice: pr }, full: true, timeoutMs: PAY_TIMEOUT_MS });
  } catch (e) {
    if (connRefused(e)) return { state: 'failed', why: 'phoenixd inalcanzable (la peticion nunca llego)' };
    return { state: 'unknown', why: 'sin respuesta de phoenixd (' + ((e && e.name) || 'error') + ')' };
  }
  if (r.status === 200 && r.json && r.json.paymentHash === hash && preimageMatches(r.json.paymentPreimage, hash)) {
    return r.json.recipientAmountSat === CLAIM_AMOUNT ? { state: 'paid' } : { state: 'paid', anomaly: 'recipientAmountSat=' + r.json.recipientAmountSat + ' (esperado ' + CLAIM_AMOUNT + ')' };
  }
  if (r.status === 401 || r.status === 403) return { state: 'failed', why: 'phoenixd rechazo la credencial (HTTP ' + r.status + ')' };
  return classifyRecord(await phoenixOutgoingByHash(hash, sinceMs), hash, r.status === 200 ? 'HTTP 200 sin prueba de pago' : 'HTTP ' + r.status);
}

// ----- registro de la intencion, liquidacion y reversa (cada una atomica; liquidar/revertir solo actuan sobre filas 'pending') -----
const _intentTx = db.transaction((hash, nodeRec, walletRec, ip, prevLast) => {
  if (nodeRec) db.prepare('UPDATE nodes SET last_claim = CURRENT_TIMESTAMP WHERE id = ?').run(nodeRec.id);
  else db.prepare('UPDATE wallets SET last_claim = CURRENT_TIMESTAMP WHERE id = ?').run(walletRec.id);
  const ipId = db.prepare('INSERT INTO claim_ips (ip) VALUES (?)').run(ip).lastInsertRowid;
  const t = nodeRec
    ? db.prepare("INSERT INTO transactions (type, node_id, amount_sats, status, payment_hash) VALUES ('claim', ?, ?, 'pending', ?)").run(nodeRec.id, CLAIM_AMOUNT, hash)
    : db.prepare("INSERT INTO transactions (type, wallet_id, amount_sats, status, payment_hash) VALUES ('claim', ?, ?, 'pending', ?)").run(walletRec.id, CLAIM_AMOUNT, hash);
  db.prepare('INSERT INTO claim_intents (tx_id, prev_last_claim, ip_row_id) VALUES (?, ?, ?)').run(t.lastInsertRowid, prevLast || null, ipId);
  return Number(t.lastInsertRowid);
});
function recordClaimIntent(hash, nodeRec, walletRec, ip, prevLast) {
  return { txId: _intentTx(hash, nodeRec, walletRec, ip, prevLast), sinceMs: Date.now() - 10 * 60 * 1000 };
}
const _settleTx = db.transaction((txId) => {
  const t = db.prepare("SELECT * FROM transactions WHERE id = ? AND status = 'pending'").get(txId);
  if (!t) return false;
  db.prepare("UPDATE transactions SET status = 'completed' WHERE id = ?").run(txId);
  if (t.node_id) db.prepare('UPDATE nodes SET total_claimed = total_claimed + ? WHERE id = ?').run(t.amount_sats, t.node_id);
  else db.prepare('UPDATE wallets SET total_claimed = total_claimed + ? WHERE id = ?').run(t.amount_sats, t.wallet_id);
  return true;
});
function settleClaimPaid(txId) { return _settleTx(txId); }
const _rollbackTx = db.transaction((txId) => {
  const t = db.prepare("SELECT * FROM transactions WHERE id = ? AND status = 'pending'").get(txId);
  if (!t) return false;
  const it = db.prepare('SELECT * FROM claim_intents WHERE tx_id = ?').get(txId) || {};
  db.prepare("UPDATE transactions SET status = 'failed' WHERE id = ?").run(txId);
  if (t.node_id) db.prepare('UPDATE nodes SET last_claim = ? WHERE id = ?').run(it.prev_last_claim || null, t.node_id);
  else db.prepare('UPDATE wallets SET last_claim = ? WHERE id = ?').run(it.prev_last_claim || null, t.wallet_id);
  if (it.ip_row_id) db.prepare('DELETE FROM claim_ips WHERE id = ?').run(it.ip_row_id);
  return true;
});
function rollbackClaim(txId) { return _rollbackTx(txId); }

// Resuelve los pagos que quedaron 'pending' (corte de red, tiempo de espera, reinicio) mirando el registro de phoenixd.
async function reconcilePending() {
  try {
    const rows = db.prepare("SELECT id, payment_hash, created_at FROM transactions WHERE type = 'claim' AND status = 'pending' ORDER BY id LIMIT 20").all();
    for (const t of rows) {
      if (t.id === inflightTx) continue;
      const created = Date.parse(String(t.created_at).replace(' ', 'T') + 'Z');
      const rec = await phoenixOutgoingByHash(t.payment_hash, Number.isFinite(created) ? created - 10 * 60 * 1000 : 0);
      const v = classifyRecord(rec, t.payment_hash, 'conciliacion');
      if (t.id === inflightTx) continue;
      if (v.state === 'paid' && settleClaimPaid(t.id)) console.log('Conciliado: el pago ' + t.id + ' si salio; queda completado');
      else if (v.state === 'failed' && rollbackClaim(t.id)) console.log('Conciliado: el pago ' + t.id + ' fallo; se libera el cupo');
    }
  } catch (e) { console.error('Conciliacion: ' + e.message); }
}

verifyNode();
const VERIFY_MS = Math.max(200, parseInt(process.env.VERIFY_INTERVAL_MS) || 5 * 60 * 1000);
setInterval(verifyNode, VERIFY_MS).unref();
setTimeout(reconcilePending, 3000).unref();
setInterval(reconcilePending, RECONCILE_MS).unref();
console.log('phoenixd: ' + PHOENIX_URL + ' | credencial de pago: ' + (PHOENIX_PW_FULL ? 'si' : 'NO') + ' | HALT_FILE: ' + HALT_FILE);

function canClaim(lastClaim) {
  if (!lastClaim) return true;
  return (new Date() - new Date(lastClaim)) / (1000 * 60 * 60 * 24) >= CLAIM_INTERVAL_DAYS;
}

function daysUntilClaim(lastClaim) {
  if (!lastClaim) return 0;
  return Math.max(0, Math.ceil(CLAIM_INTERVAL_DAYS - (new Date() - new Date(lastClaim)) / (1000 * 60 * 60 * 24)));
}

function decodeInvoice(invoice) {
  try {
    const decoded = bolt11.decode(invoice);
    const payeeTag = decoded.tags.find(t => t.tagName === 'payee_node_key');
    return { amountSat: decoded.satoshis || Math.floor(decoded.millisatoshis / 1000) || 0, payee: payeeTag ? payeeTag.data : decoded.payeeNodeKey || null };
  } catch (err) { return null; }
}

// PARCHE-B-2026-11: checkPaymentStatus (LNbits) eliminado; el estado de un pago sale del registro de phoenixd (ver phoenixOutgoingByHash)

function sanitizeString(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/[<>]/g, '');
}

function sanitizeLightningAddress(addr) {
  if (typeof addr !== 'string') return '';
  const cleaned = addr.trim().toLowerCase().slice(0, 100);
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) return '';
  return cleaned;
}

// ========== PARCHE-CLAIM-2026-11: validacion en el punto de pago ==========
let claimBusy = false;   // un solo reclamo a la vez (evita carreras y salidas en paralelo)

// GET con tiempo maximo, sin seguir redirecciones y con tope de tamano
async function fetchJsonLimited(url, maxBytes) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'application/json' } });
  if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > (maxBytes || 200000)) { try { await reader.cancel(); } catch (e) {} throw new Error('respuesta demasiado grande'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// El callback LNURL lo controla el dueno de la direccion: solo https, dominio publico, sin credenciales ni puertos raros
function parseLnurlCallback(raw) {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || h === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(h)) return null;
    return u;
  } catch (e) { return null; }
}

// Se llama SIEMPRE justo antes de pagar, con el texto exacto que se va a pagar.
function strictInvoiceCheck(raw) {
  const bad = (m) => ({ ok: false, error: m });
  if (typeof raw !== 'string') return bad('Invoice inv\xe1lido');
  const pr = raw.trim().toLowerCase();
  if (pr.length < 50 || pr.length > 2000) return bad('Invoice inv\xe1lido');
  let d;
  try { d = bolt11.decode(pr); } catch (e) { return bad('Invoice inv\xe1lido'); }
  if (!d.network || d.network.bech32 !== 'bc') return bad('Invoice inv\xe1lido (solo Bitcoin mainnet)');
  if (d.millisatoshis !== String(CLAIM_AMOUNT * 1000)) return bad('El invoice debe ser exactamente ' + CLAIM_AMOUNT + ' sats.');
  const payee = d.payeeNodeKey;
  if (!payee) return bad('No se pudo identificar el nodo destino del invoice');
  if (payee === OWN_NODE_ID) return bad('Invoice no permitido');
  if (!d.timeExpireDate || d.timeExpireDate < Math.floor(Date.now() / 1000) + 30) return bad('El invoice est\xe1 vencido o por vencer. Genera uno nuevo.');
  const hashTag = d.tags.find(t => t.tagName === 'payment_hash');
  if (!hashTag || !/^[0-9a-f]{64}$/.test(hashTag.data)) return bad('Invoice inv\xe1lido');
  return { ok: true, pr, payee, hash: hashTag.data };
}

function claimsPaidLast24h() {
  return db.prepare("SELECT COALESCE(SUM(amount_sats), 0) AS s FROM transactions WHERE type = 'claim' AND status IN ('completed', 'pending') AND created_at >= datetime('now', '-1 day')").get().s;
}

// ========== ROUTES ==========

// Check if IP already claimed within CLAIM_INTERVAL_DAYS
function canClaimByIP(ip) {
  const record = db.prepare('SELECT last_claim FROM claim_ips WHERE ip = ? ORDER BY last_claim DESC LIMIT 1').get(ip);
  if (!record) return true;
  return (new Date() - new Date(record.last_claim)) / (1000 * 60 * 60 * 24) >= CLAIM_INTERVAL_DAYS;
}

function daysUntilClaimByIP(ip) {
  const record = db.prepare('SELECT last_claim FROM claim_ips WHERE ip = ? ORDER BY last_claim DESC LIMIT 1').get(ip);
  if (!record) return 0;
  return Math.max(0, Math.ceil(CLAIM_INTERVAL_DAYS - (new Date() - new Date(record.last_claim)) / (1000 * 60 * 60 * 24)));
}

app.post('/api/claim', claimLimiter, async (req, res) => {
  const { lightning_address, invoice, turnstile_token } = req.body;
  if (!claimsOpen()) return res.status(503).json({ error: 'El Baúl está en mantenimiento. Vuelve pronto.' });
  const clientIP = getClientIP(req);

  const turnstileOK = await verifyTurnstile(turnstile_token, clientIP);
  if (!turnstileOK) return res.status(403).json({ error: 'Verificación de seguridad fallida. Recarga la página.' });

  if (!lightning_address && !invoice) return res.status(400).json({ error: 'Lightning address o invoice requerido' });

  // Bloqueo por IP (anti-multicuenta)
  if (!canClaimByIP(clientIP)) {
    return res.status(400).json({ error: 'Debes esperar', days_remaining: daysUntilClaimByIP(clientIP) });
  }

  try {
    let walletRecord = null, nodeRecord = null, decodedInvoice = null;

    if (invoice) {
      if (typeof invoice !== 'string' || invoice.length > 2000) return res.status(400).json({ error: 'Invoice inválido' });
      decodedInvoice = decodeInvoice(invoice);
      if (!decodedInvoice) return res.status(400).json({ error: 'Invoice inválido' });
      if (decodedInvoice.amountSat !== CLAIM_AMOUNT) return res.status(400).json({ error: 'El invoice debe ser exactamente ' + CLAIM_AMOUNT + ' sats. Tu invoice es de ' + decodedInvoice.amountSat + ' sats.' });
      if (!decodedInvoice.payee) return res.status(400).json({ error: 'No se pudo identificar el nodo destino del invoice' });

      nodeRecord = db.prepare('SELECT * FROM nodes WHERE payee = ?').get(decodedInvoice.payee);
      if (!nodeRecord) { db.prepare('INSERT INTO nodes (payee) VALUES (?)').run(decodedInvoice.payee); nodeRecord = db.prepare('SELECT * FROM nodes WHERE payee = ?').get(decodedInvoice.payee); }
      if (!canClaim(nodeRecord.last_claim)) return res.status(400).json({ error: 'Debes esperar', days_remaining: daysUntilClaim(nodeRecord.last_claim) });
    } else {
      const cleanAddress = sanitizeLightningAddress(lightning_address);
      if (!cleanAddress) return res.status(400).json({ error: 'Lightning address inválido. Formato: usuario@dominio.com' });

      walletRecord = db.prepare('SELECT * FROM wallets WHERE lightning_address = ?').get(cleanAddress);
      if (!walletRecord) { db.prepare('INSERT INTO wallets (lightning_address) VALUES (?)').run(cleanAddress); walletRecord = db.prepare('SELECT * FROM wallets WHERE lightning_address = ?').get(cleanAddress); }
      if (!canClaim(walletRecord.last_claim)) return res.status(400).json({ error: 'Debes esperar', days_remaining: daysUntilClaim(walletRecord.last_claim) });
    }

    const balance = await getPhoenixBalanceOrNull();
    if (balance === null) return res.status(503).json({ error: 'No se pudo consultar el saldo del fondo. Intenta de nuevo en unos minutos.' });
    const reservedForOps = Math.max(OPERATIONS_RESERVE_MINIMUM, Math.floor(balance * OPERATIONS_RESERVE_PERCENT / 100));
    if (balance - reservedForOps < CLAIM_AMOUNT) return res.status(400).json({ error: 'Fondos insuficientes. El fondo necesita más donaciones.' });

    // PARCHE-CLAIM-2026-11: un reclamo a la vez; todo se re-valida con el candado tomado
    if (claimBusy) return res.status(429).json({ error: 'Hay otro reclamo en curso. Intenta de nuevo en unos segundos.' });
    claimBusy = true;
    let paymentResult;
    try {
      // 1) re-validar plazos con el candado tomado (cierra la carrera entre el chequeo y el pago)
      const fresh = nodeRecord ? db.prepare('SELECT last_claim FROM nodes WHERE id = ?').get(nodeRecord.id) : db.prepare('SELECT last_claim FROM wallets WHERE id = ?').get(walletRecord.id);
      if (!canClaim(fresh && fresh.last_claim)) return res.status(400).json({ error: 'Debes esperar', days_remaining: daysUntilClaim(fresh.last_claim) });
      if (!canClaimByIP(clientIP)) return res.status(400).json({ error: 'Debes esperar', days_remaining: daysUntilClaimByIP(clientIP) });

      // 2) tope diario de salidas: es el dano maximo por dia aunque todo lo demas falle
      if (claimsPaidLast24h() + CLAIM_AMOUNT > DAILY_CLAIM_CAP) return res.status(503).json({ error: 'Se alcanz\xf3 el l\xedmite diario de reclamos. Intenta ma\xf1ana.' });

      // 3) obtener el invoice a pagar (si viene de una Lightning address, nunca se confia en lo que devuelva)
      let toPay = invoice;
      if (!toPay) {
        try {
          const parts = walletRecord.lightning_address.split('@');
          const lnurlData = await fetchJsonLimited('https://' + parts[1] + '/.well-known/lnurlp/' + parts[0]);
          const cb = parseLnurlCallback(lnurlData && lnurlData.callback);
          if (!cb) return res.status(400).json({ error: 'Tu Lightning address devolvi\xf3 una respuesta inv\xe1lida. Prueba pegando un invoice.' });
          cb.searchParams.set('amount', String(CLAIM_AMOUNT * 1000));
          const invoiceData = await fetchJsonLimited(cb.toString());
          toPay = invoiceData && invoiceData.pr;
        } catch (e) {
          console.error('LNURL error:', e.message);
          return res.status(400).json({ error: 'No se pudo obtener un invoice de tu Lightning address. Prueba pegando un invoice.' });
        }
      }

      // 4) validacion estricta justo antes de pagar: monto exacto, no es nuestro propio nodo, vigente
      const chk = strictInvoiceCheck(toPay);
      if (!chk.ok) { console.error('Claim rechazado:', chk.error); return res.status(400).json({ error: chk.error }); }

      // 5) PARCHE-B-2026-11: la intencion se registra ANTES de pagar. La fila 'pending' ocupa el tope diario y su payment_hash (UNIQUE) impide pagar dos veces el mismo invoice.
      if (!claimsOpen()) return res.status(503).json({ error: 'El Baúl está en mantenimiento. Vuelve pronto.' });
      let intent;
      try {
        intent = recordClaimIntent(chk.hash, nodeRecord, walletRecord, clientIP, fresh && fresh.last_claim);
      } catch (e) {
        if (/UNIQUE/.test(String(e && e.message))) return res.status(400).json({ error: 'Ese invoice ya fue usado. Genera uno nuevo.' });
        throw e;
      }
      inflightTx = intent.txId;
      try {
        const out = await payClaim(chk.pr, chk.hash, intent.sinceMs);
        if (out.anomaly) tripBreaker('anomalia en el pago ' + chk.hash + ': ' + out.anomaly);
        if (out.state === 'paid') {
          settleClaimPaid(intent.txId);
          return res.json({ success: true, amount: CLAIM_AMOUNT });
        }
        if (out.state === 'failed') {
          console.error('Pago fallido (definitivo): ' + out.why);
          rollbackClaim(intent.txId);
          return res.status(500).json({ error: 'El pago no pudo completarse. Si usas Phoenix/Muun asegúrate de tener capacidad para recibir.' });
        }
        console.error('Pago en estado desconocido, queda pendiente: ' + out.why);
        return res.status(202).json({ error: 'Tu pago quedó en proceso. Revisa tu wallet en unos minutos y no vuelvas a intentarlo todavía.' });
      } finally {
        inflightTx = null;
      }

    } catch (paymentError) {
      console.error('Payment error:', paymentError.message);
      return res.status(500).json({ error: 'Error de conexión. Si recibiste los sats, tu reclamo fue exitoso. Si no, intenta en 21 días.' });
    } finally {
      claimBusy = false;
    }
  } catch (err) {
    console.error('Claim error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/donate', donateLimiter, async (req, res) => {
  // PARCHE-B-2026-11: las donaciones siguen a los reclamos. Con el Baul cerrado, el nodo sin verificar o el freno puesto NO se crea ningun invoice (no se fondea un nodo que todavia no se abrio).
  if (!claimsOpen()) return res.status(503).json({ error: 'Las donaciones están en pausa mientras el Baúl está en mantenimiento.' });
  const { amount, turnstile_token } = req.body;
  const clientIP = getClientIP(req);

  const turnstileOK = await verifyTurnstile(turnstile_token, clientIP);
  if (!turnstileOK) return res.status(403).json({ error: 'Verificación de seguridad fallida. Recarga la página.' });

  const parsedAmount = parseInt(amount);
  if (!parsedAmount || parsedAmount < MIN_DONATION || parsedAmount > MAX_FUND) return res.status(400).json({ error: 'Monto inválido. Mínimo ' + MIN_DONATION + ' sats.' });

  try {
    const r = await phx('POST', '/createinvoice', { form: { description: 'Donacion Fondo Soberano', amountSat: String(parsedAmount), expirySeconds: '3600' } });
    if (!r.ok || !r.json || typeof r.json.serialized !== 'string' || !/^[0-9a-f]{64}$/.test(r.json.paymentHash || '')) {
      console.error('Donate: respuesta inesperada de phoenixd (HTTP ' + r.status + ')');
      return res.status(500).json({ error: 'Error al generar invoice' });
    }
    return res.json({ payment_request: r.json.serialized, payment_hash: r.json.paymentHash });
  } catch (err) {
    console.error('Donate error:', err.message);
    return res.status(500).json({ error: 'Error al generar invoice' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const balanceRaw = await getPhoenixBalanceOrNull();
    const balance = balanceRaw === null ? 0 : balanceRaw;
    const reservedForOps = Math.max(OPERATIONS_RESERVE_MINIMUM, Math.floor(balance * OPERATIONS_RESERVE_PERCENT / 100));
    const availableBalance = Math.max(0, balance - reservedForOps);
    const walletUsers = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE total_claimed > 0').get();
    const nodeUsers = db.prepare('SELECT COUNT(*) as count FROM nodes WHERE total_claimed > 0').get();
    const totalDistributed = db.prepare('SELECT COALESCE(SUM(amount_sats),0) as total FROM transactions WHERE type = ? AND status = ?').get('claim', 'completed');
    res.json({ total_users: (walletUsers?.count || 0) + (nodeUsers?.count || 0), total_distributed: totalDistributed?.total || 0, balance: availableBalance, reserved_for_ops: reservedForOps, total_balance: balance, max_fund: MAX_FUND, fund_percentage: ((availableBalance / MAX_FUND) * 100).toFixed(2), claims_enabled: claimsOpen(), donations_enabled: claimsOpen(), balance_unavailable: balanceRaw === null });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

app.get('/api/payment/:hash', async (req, res) => {
  const hash = req.params.hash;
  if (typeof hash !== 'string' || hash.length > 128 || !/^[a-f0-9]+$/.test(hash)) return res.status(400).json({ paid: false });
  try {
    const r = await phx('GET', '/payments/incoming/' + hash);
    if (!r.ok || !r.json) return res.json({ paid: false });
    const paid = r.json.isPaid === true;
    return res.json({ paid, status: paid ? 'success' : (r.json.isExpired === true ? 'expired' : 'pending') });
  } catch (err) { return res.json({ paid: false }); }
});

app.post('/api/vision-email', rateLimit({ windowMs: 60 * 60 * 1000, max: 3, message: { error: 'Límite alcanzado' } }), (req, res) => {
  const email = sanitizeString(req.body.email, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Email inválido' });
  try {
    db.prepare('INSERT OR IGNORE INTO vision_emails (email) VALUES (?)').run(email);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Error interno' }); }
});

// ========== ENERGY PRODUCTS API ==========

app.get('/api/energy/products', (req, res) => {
  try {
    const products = db.prepare(`SELECT p.id, p.nombre, p.categoria, p.mj, p.descripcion, p.created_at, COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0) as votes_up, COALESCE(SUM(CASE WHEN v.vote = -1 THEN 1 ELSE 0 END), 0) as votes_down FROM energy_products p LEFT JOIN energy_votes v ON p.id = v.product_id WHERE p.is_active = 1 GROUP BY p.id ORDER BY p.created_at DESC`).all();
    res.json({ products });
  } catch (err) { res.status(500).json({ error: 'Error al obtener productos' }); }
});

app.post('/api/energy/products', productLimiter, async (req, res) => {
  const { nombre, categoria, mj, descripcion, turnstile_token } = req.body;
  const clientIP = getClientIP(req);

  const turnstileOK = await verifyTurnstile(turnstile_token, clientIP);
  if (!turnstileOK) return res.status(403).json({ error: 'Verificación de seguridad fallida.' });

  const cleanNombre = sanitizeString(nombre, 100);
  const cleanCategoria = sanitizeString(categoria, 50);
  const cleanDescripcion = sanitizeString(descripcion, 500);
  const parsedMJ = parseFloat(mj);

  if (!cleanNombre || cleanNombre.length < 3) return res.status(400).json({ error: 'Nombre debe tener al menos 3 caracteres' });
  const validCategorias = ['alimentos', 'artesanias', 'servicios', 'energia', 'transporte', 'vivienda'];
  if (!validCategorias.includes(cleanCategoria)) return res.status(400).json({ error: 'Categoría inválida' });
  if (!parsedMJ || parsedMJ <= 0 || parsedMJ > 100000) return res.status(400).json({ error: 'Energía (MJ) debe ser positiva y razonable' });
  if (!cleanDescripcion || cleanDescripcion.length < 10) return res.status(400).json({ error: 'Descripción debe tener al menos 10 caracteres' });

  try {
    const result = db.prepare('INSERT INTO energy_products (nombre, categoria, mj, descripcion) VALUES (?, ?, ?, ?)').run(cleanNombre, cleanCategoria, parsedMJ, cleanDescripcion);
    res.json({ success: true, id: result.lastInsertRowid, product: { id: result.lastInsertRowid, nombre: cleanNombre, categoria: cleanCategoria, mj: parsedMJ, descripcion: cleanDescripcion, votes_up: 0, votes_down: 0 } });
  } catch (err) { res.status(500).json({ error: 'Error al crear producto' }); }
});

app.post('/api/energy/vote', voteLimiter, (req, res) => {
  const { product_id, vote, is_predefined, categoria } = req.body;
  const voter_ip = getClientIP(req);
  if (!product_id) return res.status(400).json({ error: 'product_id requerido' });
  if (vote !== 1 && vote !== -1) return res.status(400).json({ error: 'vote debe ser 1 o -1' });

  try {
    if (is_predefined) {
      const cleanId = sanitizeString(String(product_id), 50);
      try { db.prepare('INSERT INTO energy_votes_predefined (product_id, voter_ip, vote) VALUES (?, ?, ?)').run(cleanId, voter_ip, vote); }
      catch (e) { if (e.message.includes('UNIQUE constraint')) return res.status(400).json({ error: 'Ya votaste por este producto' }); throw e; }
      const votes = db.prepare(`SELECT COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) as up, COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) as down FROM energy_votes_predefined WHERE product_id = ?`).get(cleanId);
      res.json({ success: true, eliminated: false, votes_up: votes.up, votes_down: votes.down });
    } else {
      const numericId = parseInt(product_id);
      if (!numericId || numericId <= 0) return res.status(400).json({ error: 'product_id inválido' });
      const product = db.prepare('SELECT * FROM energy_products WHERE id = ? AND is_active = 1').get(numericId);
      if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
      try { db.prepare('INSERT INTO energy_votes (product_id, voter_ip, vote) VALUES (?, ?, ?)').run(numericId, voter_ip, vote); }
      catch (e) { if (e.message.includes('UNIQUE constraint')) return res.status(400).json({ error: 'Ya votaste por este producto' }); throw e; }
      const votes = db.prepare(`SELECT COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) as up, COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) as down FROM energy_votes WHERE product_id = ?`).get(numericId);
      const totalVotes = votes.up + votes.down;
      const negativePercent = totalVotes > 0 ? (votes.down / totalVotes) * 100 : 0;
      const canBeEliminated = categoria === 'alimentos' || categoria === 'artesanias';
      if (canBeEliminated && totalVotes >= 21 && negativePercent >= 77) {
        db.prepare('UPDATE energy_products SET is_active = 0 WHERE id = ?').run(numericId);
        return res.json({ success: true, eliminated: true, votes_up: votes.up, votes_down: votes.down, message: 'Producto eliminado por la comunidad' });
      }
      res.json({ success: true, eliminated: false, votes_up: votes.up, votes_down: votes.down });
    }
  } catch (err) { res.status(500).json({ error: 'Error al procesar voto' }); }
});

app.get('/api/energy/voted/:product_id', (req, res) => {
  const voter_ip = getClientIP(req);
  const product_id = sanitizeString(req.params.product_id, 50);
  try {
    const vote = db.prepare('SELECT vote FROM energy_votes WHERE product_id = ? AND voter_ip = ?').get(product_id, voter_ip);
    res.json({ voted: !!vote, vote: vote ? vote.vote : null });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/energy/my-votes', (req, res) => {
  const voter_ip = getClientIP(req);
  try {
    const communityVotes = db.prepare('SELECT product_id, vote FROM energy_votes WHERE voter_ip = ?').all(voter_ip);
    const predefinedVotes = db.prepare('SELECT product_id, vote FROM energy_votes_predefined WHERE voter_ip = ?').all(voter_ip);
    const votesMap = {};
    communityVotes.forEach(v => { votesMap[v.product_id] = v.vote; });
    predefinedVotes.forEach(v => { votesMap[v.product_id] = v.vote; });
    res.json({ votes: votesMap });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/energy/predefined-votes', (req, res) => {
  try {
    const votes = db.prepare(`SELECT product_id, COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) as votes_up, COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) as votes_down FROM energy_votes_predefined GROUP BY product_id`).all();
    const votesMap = {};
    votes.forEach(v => { votesMap[v.product_id] = { up: v.votes_up, down: v.votes_down }; });
    res.json({ votes: votesMap });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});



// PARCHE-D-2026-11: /api/transparency eliminada (afirmaba pagos automaticos y enlazaba el fondeo del nodo viejo; ninguna pagina la usaba). La transparencia vive en /ledger/.

app.use((req, res) => { res.status(404).json({ error: 'Ruta no encontrada' }); });
app.use((err, req, res, next) => { console.error('Unhandled:', err.message); res.status(500).json({ error: 'Error interno' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, BIND_HOST, (err) => {
  if (err) { console.error('FATAL: no se pudo abrir ' + BIND_HOST + ':' + PORT + ' -> ' + err.message); process.exit(1); }
  console.log('Fondo Soberano v2.0 (secured) on ' + BIND_HOST + ':' + PORT);
});
setInterval(() => {}, 60000);
