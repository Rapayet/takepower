#!/usr/bin/env node
// njalla-pay v2 (2026-11-20) - mantiene con saldo la billetera de Njalla para que el servidor se renueve solo.
// Una corrida al dia (temporizador). Si el saldo de Njalla es >= NJ_MIN_EUR no hace nada. Si es menor, pide a Njalla un cobro de
// NJ_PAY_EUR en bitcoin y lo paga desde phoenixd, con estas protecciones:
//   - el token de Njalla vive en /etc/njalla-pay.env (solo root) y DEBE estar limitado en Njalla a get-balance y add-payment y a la IP del servidor;
//   - no paga si existe el HALT del Baul, si ya hubo un pago en los ultimos NJ_MIN_DIAS dias o si ya hay una ventana del vigilante abierta;
//   - el monto pedido por Njalla tiene un tope duro (NJ_MAX_SATS) y debe cuadrar (+-NJ_TOL) con el precio del bitcoin en euros de mempool.space;
//   - la direccion debe ser una direccion bitcoin de la red principal con su suma de control correcta;
//   - no paga si con este pago las salidas de 24 h pasarian el tope del vigilante (espera al dia siguiente);
//   - antes de pagar abre una ventana del vigilante acotada al monto; despues anota el txid en permitidos.txt como "gasto njalla" (el libro lo
//     publica como gasto) y cierra la ventana;
//   - phoenix-cli se llama sin shell; avisa por ntfy (el tema del vigilante) de cada pago y de cada problema.
// Uso: njalla-pay.js            corrida normal
//      njalla-pay.js --dry      todo menos pedir el cobro y pagar (no escribe nada)
//      njalla-pay.js --probar-token   comprueba que el token lee el saldo y que NO puede hacer otra cosa (list-domains debe fallar)
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const E = process.env;
const TEST = E.NJ_TEST === '1';
const NJALLA_API = TEST && E.NJ_API ? E.NJ_API : 'https://njal.la/api/1/';
const MEMPOOL = TEST && E.NJ_MEMPOOL ? E.NJ_MEMPOOL : 'https://mempool.space';
const PHX_URL = E.NJ_PHX_URL || 'http://127.0.0.1:9740';
const PHX_CONF = E.NJ_PHX_CONF || '/root/.phoenix/phoenix.conf';
const PHX_CLI = E.NJ_PHX_CLI || '/opt/fondo/phoenixd-0.7.1-linux-x64/phoenix-cli';
const HALT_FILE = E.NJ_HALT || '/opt/fondo/backend/HALT';
const ALLOW_FILE = E.NJ_ALLOW || '/opt/fondo/vigilante/permitidos.txt';
const WINDOW_FILE = E.NJ_WINDOW || '/opt/fondo/vigilante/ventana.txt';
const VIG_ENV = E.NJ_VIG_ENV || '/etc/vigilante.env';
const STATE_DIR = E.NJ_STATE_DIR || '/var/lib/njalla-pay';
const STATE = path.join(STATE_DIR, 'estado.json');
const TOKEN = E.NJALLA_API_TOKEN || '';
const MIN_EUR = 20, PAY_EUR = 15;
const MAX_SATS = 40000, TOL = 0.15, MIN_DIAS = 7, FEE_MARGIN = 6000, WIN_MIN = 20;
const HTTP_TIMEOUT_MS = 20000;
const DRY = process.argv.includes('--dry'), PROBAR = process.argv.includes('--probar-token');
const nowMs = () => (TEST && E.NJ_NOW_MS ? parseInt(E.NJ_NOW_MS, 10) : Date.now());
const iso = (ms) => new Date(ms).toISOString();
const log = (s) => console.log(iso(nowMs()) + ' ' + s);
const limpio = (s) => { let t = String(s); if (TOKEN.length >= 8) t = t.split(TOKEN).join('[token]'); return t.replace(/[^\x20-\x7e]/g, '?').slice(0, 300); };

function readConf(file) {
  const o = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
let vigCfg = null;
function vig() { if (!vigCfg) { try { vigCfg = readConf(VIG_ENV); } catch (e) { vigCfg = {}; } } return vigCfg; }

async function notify(prio, title, text) {
  const url = vig().NOTIFY_URL;
  log('AVISO [' + prio + '] ' + title + ': ' + text);
  if (DRY || !url || !/^https:\/\//.test(url)) return;
  try {
    await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { Title: 'Njalla: ' + title.replace(/[^\x20-\x7e]/g, ''), Priority: prio === 'alta' ? 'high' : 'default' }, body: text });
  } catch (e) { log('no pude mandar el aviso: ' + limpio(e.message)); }
}

// ---------------------------------------------------------------- Njalla (JSON-RPC; responde 200 tambien con error: mirar error/result)
async function njalla(method, params) {
  const r = await fetch(NJALLA_API, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { Authorization: 'Njalla ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id: String(nowMs()) }) });
  const txt = (await r.text()).slice(0, 100000);
  let d = null; try { d = JSON.parse(txt); } catch (e) {}
  if (!d || typeof d !== 'object') throw new Error('Njalla (' + method + ') no respondio JSON (HTTP ' + r.status + ')');
  if (d.error !== undefined && d.error !== null) { const err = new Error('Njalla (' + method + ') respondio error: ' + limpio(JSON.stringify(d.error))); err.njalla = true; throw err; }
  if (r.status !== 200 || d.result === undefined || d.result === null || typeof d.result !== 'object') throw new Error('Njalla (' + method + ') respuesta sin result (HTTP ' + r.status + ')');
  return d.result;
}
function eurBalance(res) {
  const b = typeof res.balance === 'string' && /^\d{1,7}(\.\d{1,2})?$/.test(res.balance) ? parseFloat(res.balance) : res.balance;
  if (typeof b !== 'number' || !isFinite(b) || b < 0 || b > 1e6) throw new Error('Njalla devolvio un saldo con forma inesperada: ' + limpio(JSON.stringify(res.balance)));
  return b;
}

// ---------------------------------------------------------------- phoenixd (clave limitada para leer)
async function phx(pw, p) {
  const r = await fetch(PHX_URL + p, { redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { Authorization: 'Basic ' + Buffer.from(':' + pw).toString('base64') } });
  const txt = (await r.text()).slice(0, 5000000);
  let json = null; try { json = JSON.parse(txt); } catch (e) {}
  if (r.status !== 200 || json === null) throw new Error('phoenixd ' + p.split('?')[0] + ' no respondio bien (HTTP ' + r.status + ')');
  return json;
}
async function outgoingSince(pw, fromMs) {
  const all = [];
  for (let off = 0; off < 100000; off += 100) {
    const l = await phx(pw, '/payments/outgoing?all=true&from=' + fromMs + '&limit=100&offset=' + off);
    if (!Array.isArray(l)) throw new Error('la lista de pagos de phoenixd tiene forma inesperada');
    all.push(...l.filter((p) => p && typeof p === 'object'));
    if (l.length < 100) return all;
  }
  throw new Error('demasiados pagos para leer');
}
// lo mismo que suma el vigilante: salidas pagadas o en curso de las ultimas 24 h, sin la compra de liquidez
function outflow24(list, now) {
  let t = 0;
  for (const p of list) {
    if (typeof p.createdAt !== 'number' || now - p.createdAt > 24 * 3600000) continue;
    const moved = p.isPaid === true || (p.isPaid !== true && !p.completedAt);
    if (!moved || p.subType === 'auto_liquidity') continue;
    if (Number.isFinite(p.sent) && p.sent > 0) t += p.sent;
  }
  return t;
}

// ---------------------------------------------------------------- direcciones bitcoin (red principal)
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i]; } return c >>> 0; }
function bech32ok(a) {
  if (a !== a.toLowerCase() || !/^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,59}$/.test(a)) return false;
  const data = [...a.slice(3)].map((ch) => B32.indexOf(ch));
  const hrp = [...'bc'].map((c) => c.charCodeAt(0) >> 5).concat([0], [...'bc'].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod(hrp.concat(data));
  const ver = data[0];
  if (!(ver === 0 ? pm === 1 : pm === 0x2bc830a3)) return false;
  if (ver > 16) return false;
  // convertir de 5 a 8 bits el programa
  let acc = 0, bits = 0; const prog = [];
  for (const v of data.slice(1, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 255); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 255)) return false;
  if (ver === 0) return prog.length === 20 || prog.length === 32;
  if (ver === 1) return prog.length === 32;
  return false;                                 // otras versiones: no las aceptamos
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58ok(a) {
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return false;
  let n = 0n; for (const ch of a) n = n * 58n + BigInt(B58.indexOf(ch));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex'); let lead = 0; for (const ch of a) { if (ch === '1') lead++; else break; }
  bytes = Buffer.concat([Buffer.alloc(lead), bytes]);
  if (bytes.length !== 25) return false;
  const h = crypto.createHash('sha256').update(crypto.createHash('sha256').update(bytes.subarray(0, 21)).digest()).digest();
  if (!h.subarray(0, 4).equals(bytes.subarray(21))) return false;
  return (a[0] === '1' && bytes[0] === 0x00) || (a[0] === '3' && bytes[0] === 0x05);
}
const addrOk = (a) => typeof a === 'string' && a.length <= 90 && (a.startsWith('bc1') ? bech32ok(a) : base58ok(a));

// monto en BTC (texto o numero) a sats, exacto (sin errores de coma flotante); hacia arriba si trae mas de 8 decimales
function btcToSats(x) {
  const s = typeof x === 'number' && isFinite(x) ? x.toFixed(10) : String(x);
  const m = /^(\d{1,3})(?:\.(\d{1,12}))?$/.exec(s);
  if (!m) return null;
  const dec = (m[2] || '').padEnd(12, '0');
  let sats = BigInt(m[1]) * 100000000n + BigInt(dec.slice(0, 8));
  if (/[1-9]/.test(dec.slice(8))) sats += 1n;
  return Number(sats);
}

// ---------------------------------------------------------------- estado propio (no en la base del backend)
function readState() { try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('no puedo leer ' + STATE + ': ' + e.message); } }
function writeState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = STATE + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600); fs.writeSync(fd, JSON.stringify(s, null, 1) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(tmp, STATE);
}
function appendAllow(txid, note) {
  fs.mkdirSync(path.dirname(ALLOW_FILE), { recursive: true });
  fs.appendFileSync(ALLOW_FILE, txid + ' ' + iso(nowMs()).replace(/\.\d{3}Z$/, 'Z') + ' ' + note + '\n', { mode: 0o600 });
  fs.chmodSync(ALLOW_FILE, 0o600);
}

async function mempoolJson(p) {
  const r = await fetch(MEMPOOL + p, { redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (r.status !== 200) throw new Error('mempool.space ' + p + ' HTTP ' + r.status);
  return JSON.parse((await r.text()).slice(0, 100000));
}

async function main() {
  if (!/^[A-Za-z0-9._-]{20,200}$/.test(TOKEN)) throw new Error('falta el token de Njalla (NJALLA_API_TOKEN en /etc/njalla-pay.env) o tiene forma rara');
  if (PROBAR) {
    const b = eurBalance(await njalla('get-balance'));
    log('el token lee el saldo: ' + b + ' EUR');
    try { await njalla('list-domains'); }
    catch (e) { if (e.njalla) { log('bien: el token NO puede listar los dominios (' + e.message + ')'); console.log('TOKEN RESTRINGIDO OK'); return 0; } throw e; }
    console.log('PELIGRO: el token puede listar los dominios: NO esta restringido a get-balance y add-payment. Borralo en Njalla y crea otro.');
    return 4;
  }
  const now = nowMs();
  if (fs.existsSync(HALT_FILE)) { log('existe ' + HALT_FILE + ' (el Baul esta frenado): no pago nada'); return 0; }
  const nj = eurBalance(await njalla('get-balance'));
  log('saldo en Njalla: ' + nj + ' EUR (umbral ' + MIN_EUR + ')');
  if (nj >= MIN_EUR) { log('hay saldo suficiente: no hace falta pagar'); return 0; }
  const st = readState();
  if (st.en_curso) { await notify('alta', 'pago a medias', 'Una corrida anterior empezo a pagar (' + limpio(st.en_curso.desde) + ') y no termino. Revisa phoenixd y permitidos.txt; luego borra ' + STATE + '. No pago nada mas.'); return 3; }
  if (typeof st.ultimo_pago_ms === 'number' && now - st.ultimo_pago_ms < MIN_DIAS * 86400000) {
    const dias = (now - st.ultimo_pago_ms) / 86400000;
    log('ya hubo un pago hace ' + dias.toFixed(1) + ' dias (tx ' + limpio(st.ultimo_txid || '?').slice(0, 16) + '...): espero, Njalla lo acredita con 1 confirmacion');
    if (dias >= 3 && !st.avisado_lento) { await notify('media', 'el saldo no sube', 'El pago de hace ' + dias.toFixed(1) + ' dias aun no se refleja en Njalla (saldo ' + nj + ' EUR). Revisa la transaccion ' + limpio(st.ultimo_txid || '?')); if (!DRY) { st.avisado_lento = true; writeState(st); } }
    return 0;
  }
  if (fs.existsSync(WINDOW_FILE)) { await notify('media', 'no pague hoy', 'Hay una ventana del vigilante abierta (' + WINDOW_FILE + '): no la piso. Lo intento manana.'); return 0; }
  let pw = null; try { pw = readConf(PHX_CONF)['http-password-limited-access'] || null; } catch (e) {}
  if (!pw) throw new Error('no hay http-password-limited-access legible en ' + PHX_CONF);
  const bal = await phx(pw, '/getbalance');
  if (!Number.isSafeInteger(bal.balanceSat)) throw new Error('phoenixd devolvio un saldo con forma inesperada');
  const out = outflow24(await outgoingSince(pw, now - 25 * 3600000), now);
  const cap = parseInt(vig().MAX_OUTFLOW_24H_SATS, 10);
  if (!(cap > 0)) throw new Error('no encuentro MAX_OUTFLOW_24H_SATS en ' + VIG_ENV);
  const precio = (await mempoolJson('/api/v1/prices')).EUR;
  if (typeof precio !== 'number' || !isFinite(precio) || precio < 1000 || precio > 10000000) throw new Error('mempool.space dio un precio en EUR raro: ' + limpio(precio));
  const esperado = Math.round(PAY_EUR / precio * 1e8);
  log('phoenixd: ' + bal.balanceSat + ' sats; salidas 24 h: ' + out + ' de ' + cap + '; 1 BTC = ' + precio + ' EUR => ' + PAY_EUR + ' EUR ~ ' + esperado + ' sats');
  if (esperado > MAX_SATS) { await notify('alta', 'no pague', PAY_EUR + ' EUR ya son ' + esperado + ' sats, mas que el tope de ' + MAX_SATS + '. Hay que revisar el tope.'); return 3; }
  if (bal.balanceSat < esperado + FEE_MARGIN) { await notify('alta', 'no hay saldo para pagar', 'El nodo tiene ' + bal.balanceSat + ' sats y hacen falta ~' + (esperado + FEE_MARGIN) + '. Njalla tiene ' + nj + ' EUR: hay que recargar.'); return 3; }
  if (out + esperado + FEE_MARGIN > cap) { log('con este pago las salidas de 24 h pasarian el tope del vigilante (' + (out + esperado + FEE_MARGIN) + ' > ' + cap + '): lo intento manana'); return 0; }
  let fee = 6;
  try { const f = await mempoolJson('/api/v1/fees/recommended'); if (Number.isFinite(f.halfHourFee)) fee = Math.min(30, Math.max(2, Math.ceil(f.halfHourFee))); } catch (e) { log('sin tarifa de mempool.space: uso ' + fee + ' sat/vB'); }
  if (DRY) { log('SIMULACRO: aqui pediria a Njalla un cobro de ' + PAY_EUR + ' EUR y lo pagaria a ' + fee + ' sat/vB. No se pidio ni se pago nada.'); return 0; }

  const pay = await njalla('add-payment', { amount: PAY_EUR, via: 'bitcoin' });
  const addr = pay.address, sats = btcToSats(pay.amount_btc);
  if (!addrOk(addr)) { await notify('alta', 'no pague', 'Njalla dio una direccion que no es valida en la red principal: ' + limpio(addr)); return 3; }
  if (!Number.isSafeInteger(sats) || sats <= 0 || sats > MAX_SATS) { await notify('alta', 'no pague', 'Njalla pide ' + limpio(pay.amount_btc) + ' BTC (' + sats + ' sats): fuera del tope de ' + MAX_SATS); return 3; }
  if (Math.abs(sats / esperado - 1) > TOL) { await notify('alta', 'no pague', 'Njalla pide ' + sats + ' sats por ' + PAY_EUR + ' EUR y con el precio de mempool.space serian ~' + esperado + ' (diferencia de mas del ' + (TOL * 100) + ' %)'); return 3; }
  if (bal.balanceSat < sats + FEE_MARGIN || out + sats + FEE_MARGIN > cap) { log('el monto real (' + sats + ') no cabe en el saldo o en el tope de 24 h: lo intento manana'); return 0; }

  const desde = iso(now);
  writeState(Object.assign({}, st, { en_curso: { desde, sats, addr, njalla_id: limpio(pay.id || '') } }));
  fs.mkdirSync(path.dirname(WINDOW_FILE), { recursive: true });
  fs.writeFileSync(WINDOW_FILE, Math.floor(now / 1000 + WIN_MIN * 60) + ' ' + (sats + FEE_MARGIN) + ' njalla-pay ' + desde + '\n', { mode: 0o600 });
  log('ventana del vigilante abierta: ' + WIN_MIN + ' min, hasta ' + (sats + FEE_MARGIN) + ' sats');
  let salida = '';
  try {
    salida = execFileSync(PHX_CLI, ['sendtoaddress', '--amountSat=' + sats, '--address=' + addr, '--feerateSatByte=' + fee], { encoding: 'utf8', timeout: 180000, maxBuffer: 1000000 });
  } catch (e) {
    try { fs.unlinkSync(WINDOW_FILE); } catch (e2) {}
    // no se sabe si salio: se deja en_curso para que nadie vuelva a pagar sin mirar
    await notify('alta', 'el pago fallo o no se sabe si salio', 'phoenix-cli sendtoaddress: ' + limpio(e.message) + '. Revisa phoenixd; luego borra ' + STATE);
    return 3;
  }
  let txid = (/\b([0-9a-f]{64})\b/.exec(String(salida).toLowerCase()) || [])[1] || null;
  if (!txid) {      // buscar el pago en la lista de phoenixd
    for (let i = 0; i < 10 && !txid; i++) {
      const l = await outgoingSince(pw, now - 60000);
      const c = l.filter((p) => typeof p.txId === 'string' && /^[0-9a-fA-F]{64}$/.test(p.txId) && !p.paymentHash && p.subType !== 'auto_liquidity' && Number.isFinite(p.sent) && p.sent >= sats && p.sent <= sats + FEE_MARGIN && p.createdAt >= now - 60000);
      if (c.length === 1) txid = c[0].txId.toLowerCase();
      else if (!TEST) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!txid) {
    await notify('alta', 'pague pero no tengo el txid', 'Se mandaron ' + sats + ' sats a Njalla pero no pude leer el txid. Antes de que cierre la ventana (' + WIN_MIN + ' min) anotalo con vigilante-permitir <txid> gasto njalla; si no, el vigilante va a frenar.');
    return 3;
  }
  appendAllow(txid, 'gasto njalla servidor ' + PAY_EUR + ' EUR' + (pay.id ? ' id ' + limpio(pay.id).replace(/\s/g, '') : ''));
  try { fs.unlinkSync(WINDOW_FILE); } catch (e) {}
  const nuevo = { ultimo_pago_ms: now, ultimo_pago: desde, ultimo_txid: txid, ultimo_sats: sats, ultimo_eur: PAY_EUR, njalla_saldo_antes: nj };
  writeState(nuevo);
  await notify('default', 'pago hecho', PAY_EUR + ' EUR = ' + sats + ' sats a Njalla (tx ' + txid + ', ' + fee + ' sat/vB). Saldo de Njalla antes: ' + nj + ' EUR; se acredita con 1 confirmacion.');
  log('LISTO: pagado ' + sats + ' sats, tx ' + txid);
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c || 0), async (e) => { await notify('alta', 'error', limpio(e.message)); process.exit(1); });
} else {
  module.exports = { addrOk, btcToSats, outflow24 };
}
