require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bolt11 = require('bolt11');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);  // Trust Nginx proxy for real IP

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
const LNBITS_URL = process.env.LNBITS_URL || 'http://localhost:5000';
const ADMIN_KEY = process.env.LNBITS_ADMIN_KEY;
const INVOICE_KEY = process.env.LNBITS_INVOICE_KEY;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const CLAIM_AMOUNT = parseInt(process.env.CLAIM_AMOUNT) || 10000;
const MIN_DONATION = parseInt(process.env.MIN_DONATION) || 20000;
const MAX_FUND = parseInt(process.env.MAX_FUND) || 100000000;
const OPERATIONS_RESERVE_PERCENT = parseInt(process.env.OPERATIONS_RESERVE_PERCENT) || 7;
const OPERATIONS_RESERVE_MINIMUM = parseInt(process.env.OPERATIONS_RESERVE_MINIMUM) || 37500;
const CLAIM_INTERVAL_DAYS = parseInt(process.env.CLAIM_INTERVAL_DAYS) || 21;
const DB_PATH = process.env.DB_PATH || '/opt/fondo/backend/fondo.db';

if (!ADMIN_KEY || !INVOICE_KEY) {
  console.error('FATAL: LNBITS_ADMIN_KEY and LNBITS_INVOICE_KEY must be set in .env');
  process.exit(1);
}
if (!TURNSTILE_SECRET) {
  console.warn('WARNING: TURNSTILE_SECRET not set — verification disabled');
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
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.ip || 'unknown';
}

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip })
    });
    const data = await response.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile error:', err.message);
    return false;
  }
}

async function getPhoenixBalance() {
  try {
    const response = await fetch(LNBITS_URL + '/api/v1/wallet', { headers: { 'X-Api-Key': INVOICE_KEY } });
    const data = await response.json();
    return Math.floor(data.balance / 1000);
  } catch (err) { return 0; }
}

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

async function checkPaymentStatus(paymentHash) {
  try {
    const response = await fetch(LNBITS_URL + '/api/v1/payments/' + paymentHash, { headers: { 'X-Api-Key': ADMIN_KEY } });
    return await response.json();
  } catch (err) { return { status: 'unknown', paid: false }; }
}

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

    const balance = await getPhoenixBalance();
    const reservedForOps = Math.max(OPERATIONS_RESERVE_MINIMUM, Math.floor(balance * OPERATIONS_RESERVE_PERCENT / 100));
    if (balance - reservedForOps < CLAIM_AMOUNT) return res.status(400).json({ error: 'Fondos insuficientes. El fondo necesita más donaciones.' });

    if (nodeRecord) db.prepare('UPDATE nodes SET last_claim = CURRENT_TIMESTAMP WHERE id = ?').run(nodeRecord.id);
    else db.prepare('UPDATE wallets SET last_claim = CURRENT_TIMESTAMP WHERE id = ?').run(walletRecord.id);

    let paymentResult;
    try {
      if (invoice) {
        const response = await fetch(LNBITS_URL + '/api/v1/payments', { method: 'POST', headers: { 'X-Api-Key': ADMIN_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ out: true, bolt11: invoice }) });
        paymentResult = await response.json();
      } else {
        const parts = walletRecord.lightning_address.split('@');
        const lnurlRes = await fetch('https://' + parts[1] + '/.well-known/lnurlp/' + parts[0]);
        const lnurlData = await lnurlRes.json();
        const invoiceRes = await fetch(lnurlData.callback + '?amount=' + (CLAIM_AMOUNT * 1000));
        const invoiceData = await invoiceRes.json();
        const response = await fetch(LNBITS_URL + '/api/v1/payments', { method: 'POST', headers: { 'X-Api-Key': ADMIN_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ out: true, bolt11: invoiceData.pr }) });
        paymentResult = await response.json();
      }

      if (!paymentResult.payment_hash) {
        if (nodeRecord) db.prepare('UPDATE nodes SET last_claim = NULL WHERE id = ? AND total_claimed = 0').run(nodeRecord.id);
        else db.prepare('UPDATE wallets SET last_claim = NULL WHERE id = ? AND total_claimed = 0').run(walletRecord.id);
        return res.status(500).json({ error: paymentResult.detail || 'Error al procesar pago' });
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
      const paymentStatus = await checkPaymentStatus(paymentResult.payment_hash);

      if (paymentStatus.status === 'failed') {
        if (nodeRecord) db.prepare('UPDATE nodes SET last_claim = NULL WHERE id = ? AND total_claimed = 0').run(nodeRecord.id);
        else db.prepare('UPDATE wallets SET last_claim = NULL WHERE id = ? AND total_claimed = 0').run(walletRecord.id);
        return res.status(500).json({ error: 'El pago no pudo completarse. Si usas Phoenix/Muun asegúrate de tener capacidad para recibir.' });
      }

      if (nodeRecord) {
        db.prepare('UPDATE nodes SET total_claimed = total_claimed + ? WHERE id = ?').run(CLAIM_AMOUNT, nodeRecord.id);
        db.prepare('INSERT INTO transactions (type, node_id, amount_sats, status, payment_hash) VALUES (?, ?, ?, ?, ?)').run('claim', nodeRecord.id, CLAIM_AMOUNT, 'completed', paymentResult.payment_hash);
      } else {
        db.prepare('UPDATE wallets SET total_claimed = total_claimed + ? WHERE id = ?').run(CLAIM_AMOUNT, walletRecord.id);
        db.prepare('INSERT INTO transactions (type, wallet_id, amount_sats, status, payment_hash) VALUES (?, ?, ?, ?, ?)').run('claim', walletRecord.id, CLAIM_AMOUNT, 'completed', paymentResult.payment_hash);
      }
      // Registrar IP para bloqueo anti-multicuenta
      db.prepare('INSERT INTO claim_ips (ip) VALUES (?)').run(clientIP);
      return res.json({ success: true, amount: CLAIM_AMOUNT });

    } catch (paymentError) {
      console.error('Payment error:', paymentError.message);
      return res.status(500).json({ error: 'Error de conexión. Si recibiste los sats, tu reclamo fue exitoso. Si no, intenta en 21 días.' });
    }
  } catch (err) {
    console.error('Claim error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/donate', donateLimiter, async (req, res) => {
  const { amount, turnstile_token } = req.body;
  const clientIP = getClientIP(req);

  const turnstileOK = await verifyTurnstile(turnstile_token, clientIP);
  if (!turnstileOK) return res.status(403).json({ error: 'Verificación de seguridad fallida. Recarga la página.' });

  const parsedAmount = parseInt(amount);
  if (!parsedAmount || parsedAmount < MIN_DONATION || parsedAmount > MAX_FUND) return res.status(400).json({ error: 'Monto inválido. Mínimo ' + MIN_DONATION + ' sats.' });

  try {
    const response = await fetch(LNBITS_URL + '/api/v1/payments', { method: 'POST', headers: { 'X-Api-Key': INVOICE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ out: false, amount: parsedAmount, memo: 'Donacion Fondo Soberano' }) });
    const data = await response.json();
    return res.json({ payment_request: data.payment_request, payment_hash: data.payment_hash });
  } catch (err) {
    console.error('Donate error:', err.message);
    return res.status(500).json({ error: 'Error al generar invoice' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const balance = await getPhoenixBalance();
    const reservedForOps = Math.max(OPERATIONS_RESERVE_MINIMUM, Math.floor(balance * OPERATIONS_RESERVE_PERCENT / 100));
    const availableBalance = balance - reservedForOps;
    const walletUsers = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE total_claimed > 0').get();
    const nodeUsers = db.prepare('SELECT COUNT(*) as count FROM nodes WHERE total_claimed > 0').get();
    const totalDistributed = db.prepare('SELECT COALESCE(SUM(amount_sats),0) as total FROM transactions WHERE type = ? AND status = ?').get('claim', 'completed');
    res.json({ total_users: (walletUsers?.count || 0) + (nodeUsers?.count || 0), total_distributed: totalDistributed?.total || 0, balance: availableBalance, reserved_for_ops: reservedForOps, total_balance: balance, max_fund: MAX_FUND, fund_percentage: ((availableBalance / MAX_FUND) * 100).toFixed(2) });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

app.get('/api/payment/:hash', async (req, res) => {
  const hash = req.params.hash;
  if (typeof hash !== 'string' || hash.length > 128 || !/^[a-f0-9]+$/.test(hash)) return res.status(400).json({ paid: false });
  try {
    const response = await fetch(LNBITS_URL + '/api/v1/payments/' + hash, { headers: { 'X-Api-Key': INVOICE_KEY } });
    const data = await response.json();
    return res.json({ paid: data.paid || false, status: data.status });
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

app.use((req, res) => { res.status(404).json({ error: 'Ruta no encontrada' }); });
app.use((err, req, res, next) => { console.error('Unhandled:', err.message); res.status(500).json({ error: 'Error interno' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log('Fondo Soberano v2.0 (secured) on port ' + PORT); });
