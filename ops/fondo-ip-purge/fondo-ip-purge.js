#!/usr/bin/env node
'use strict';
// fondo-ip-purge.js (v3) - quita de la base del fondo las direcciones IP con mas de N dias (por defecto 22):
//   - reclamos: se BORRAN las filas de claim_ips con mas de N dias;
//   - votos (energy_votes y energy_votes_predefined): el voto SE QUEDA y su IP se cambia por un marcador unico ('purgada:<rowid>')
//     cuando el voto tiene mas de N dias. Pasado ese plazo la misma persona podria volver a votar el mismo producto (a cambio de no guardar su IP).
// Solo imprime recuentos: nunca imprime IP, direcciones Lightning ni nada personal.
// IP_PURGE_VERSION = 3
//
// Uso:  node fondo-ip-purge.js [--dry] [--db RUTA] [--dias 22] [--backup-first CARPETA] [--modulo RUTA_BETTER_SQLITE3]
//   --dry                 solo cuenta (abre la base en solo lectura y no cambia nada)
//   --dias N              antiguedad a partir de la cual se quita la IP (21..365; nunca menos que el intervalo de reclamo de 21 dias)
//   --backup-first CARPETA  antes de borrar reclamos (y solo si hay algo que borrar) guarda una copia consistente de la base en CARPETA (API de respaldo de SQLite).
//                           No se hace copia previa por los votos: neutralizar una IP de voto no pierde nada que no se quiera perder.
//
// Por que 22 y no 21: el intervalo entre reclamos es de 21 dias; se deja un dia de margen para no abrir la puerta a un reclamo repetido desde la misma IP.
// La politica de privacidad publicada dice 22 dias para reclamos y para votos: si se cambia aqui, hay que cambiar el texto de la politica (build_privacy.py --ip-dias).
// Seguridad: cualquier opcion desconocida o sin valor aborta SIN tocar la base (asi un "--dry-run" mal escrito no ejecuta un borrado real).
// Si una tabla de votos existe pero no tiene las columnas esperadas (voter_ip, created_at), aborta con codigo 3 ANTES de cambiar nada.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function fail(msg, code) { console.error('ip-purge: ERROR: ' + msg); process.exit(code || 1); }

const VALUE_FLAGS = ['db', 'dias', 'backup-first', 'modulo'];
const BOOL_FLAGS = ['dry'];
const given = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) fail('argumento no reconocido: ' + a, 2);
  const k = a.slice(2);
  if (BOOL_FLAGS.includes(k)) { given[k] = true; continue; }
  if (!VALUE_FLAGS.includes(k)) fail('opcion no reconocida: ' + a + ' (validas: --dry --db --dias --backup-first --modulo)', 2);
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) fail('falta el valor de ' + a, 2);
  given[k] = v; i++;
}

const DRY = !!given.dry;
const DB = given.db || process.env.DB_PATH || '/opt/fondo/backend/fondo.db';
const RAW_DAYS = String(given.dias !== undefined ? given.dias : (process.env.IP_RETENTION_DAYS || '22'));
const DAYS = /^\d{1,3}$/.test(RAW_DAYS) ? parseInt(RAW_DAYS, 10) : NaN;
const BACKUP_DIR = given['backup-first'] || '';
const MOD = given.modulo || process.env.BETTER_SQLITE3 || '/opt/fondo/backend/node_modules/better-sqlite3';
const VOTE_TABLES = ['energy_votes', 'energy_votes_predefined'];

if (!(DAYS >= 21 && DAYS <= 365)) fail('--dias fuera de rango (21..365): ' + RAW_DAYS, 2);
if (!fs.existsSync(DB)) fail('no existe la base: ' + DB, 2);
let Database;
try { Database = require(MOD); } catch (e) { fail('no se pudo cargar better-sqlite3 desde ' + MOD + ' (' + e.message + ')', 2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Database(DB, { readonly: DRY, fileMustExist: true });
  db.pragma('busy_timeout = 15000');
  const modifier = '-' + DAYS + ' days';
  const COND = "(last_claim IS NULL OR last_claim < datetime('now', ?))";
  // votos: una IP ya neutralizada empieza por 'purgada:' (una IP real nunca: ni IPv4 ni IPv6 contienen esas letras)
  const NOTMARK = "substr(voter_ip, 1, 8) <> 'purgada:'";
  const VCOND = "(created_at IS NULL OR created_at < datetime('now', ?))";

  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claim_ips'").get();
  if (!exists) fail('la base no tiene la tabla claim_ips', 3);

  // esquema de las tablas de votos: se valida ANTES de cambiar nada
  const votes = [];
  for (const t of VOTE_TABLES) {
    const ex = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!ex) { votes.push({ t: t, present: false }); continue; }
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    for (const need of ['voter_ip', 'created_at']) {
      if (!cols.includes(need)) fail('la tabla ' + t + ' no tiene la columna ' + need, 3);
    }
    votes.push({ t: t, present: true });
  }
  const voteCounts = (v) => {
    v.total = db.prepare('SELECT COUNT(*) AS n FROM ' + v.t).get().n;
    v.conIp = db.prepare('SELECT COUNT(*) AS n FROM ' + v.t + ' WHERE ' + NOTMARK).get().n;
    v.viejos = db.prepare('SELECT COUNT(*) AS n FROM ' + v.t + ' WHERE ' + NOTMARK + ' AND ' + VCOND).get(modifier).n;
  };

  const total = db.prepare('SELECT COUNT(*) AS n FROM claim_ips').get().n;
  const old = db.prepare('SELECT COUNT(*) AS n FROM claim_ips WHERE ' + COND).get(modifier).n;
  for (const v of votes) if (v.present) voteCounts(v);

  if (DRY) {
    console.log('ip-purge (simulacro): filas=' + total + ' a_borrar=' + old + ' quedarian=' + (total - old) + ' limite=' + DAYS + 'd');
    console.log('ip-purge (simulacro): votos ' + votes.map((v) => v.present ? (v.t + ' filas=' + v.total + ' con_ip=' + v.conIp + ' a_neutralizar=' + v.viejos) : (v.t + ' ausente')).join('; ') + ' limite=' + DAYS + 'd');
    db.close();
    return;
  }

  if (BACKUP_DIR && old > 0) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    let dest = path.join(BACKUP_DIR, 'fondo-antes-purga-ip-' + stamp + '.db');
    if (fs.existsSync(dest)) dest = path.join(BACKUP_DIR, 'fondo-antes-purga-ip-' + stamp + '-' + process.pid + '.db');
    await db.backup(dest);
    fs.chmodSync(dest, 0o600);
    console.log('ip-purge: copia previa guardada (' + fs.statSync(dest).size + ' bytes): ' + dest);
  }

  // secure_delete: SQLite rellena con ceros el contenido borrado o reemplazado en lugar de dejarlo intacto en las paginas libres
  // (tambien en los indices de las columnas ip y voter_ip).
  db.pragma('secure_delete = ON');
  // todo en una sola transaccion: o se quitan las IP de reclamos y de votos, o no se cambia nada
  let deleted = 0;
  db.transaction(() => {
    deleted = db.prepare('DELETE FROM claim_ips WHERE ' + COND).run(modifier).changes;
    for (const v of votes) {
      v.changes = 0;
      if (!v.present) continue;
      v.changes = db.prepare('UPDATE ' + v.t + " SET voter_ip = 'purgada:' || rowid WHERE " + NOTMARK + ' AND ' + VCOND).run(modifier).changes;
    }
  }).immediate();
  const neutralized = votes.reduce((s, v) => s + (v.changes || 0), 0);
  const left = db.prepare('SELECT COUNT(*) AS n FROM claim_ips').get().n;
  for (const v of votes) if (v.present) voteCounts(v);
  let ck = 'n/d';
  if (deleted + neutralized > 0) {
    // Vacia el WAL hacia el archivo principal y lo deja en cero bytes, para que no queden copias antiguas de las paginas con las IP.
    // Si en ese instante el backend esta leyendo, reintenta unos segundos.
    ck = 'fallo';
    for (let i = 0; i < 6; i++) {
      try { const r = db.pragma('wal_checkpoint(TRUNCATE)')[0]; ck = r && r.busy === 0 ? 'ok' : 'parcial'; } catch (e) { ck = 'fallo'; }
      if (ck === 'ok') break;
      await sleep(2000);
    }
  }
  console.log('ip-purge: filas=' + total + ' borradas=' + deleted + ' quedan=' + left + ' limite=' + DAYS + 'd checkpoint=' + ck);
  console.log('ip-purge: votos ' + votes.map((v) => v.present ? (v.t + ' filas=' + v.total + ' neutralizadas=' + v.changes + ' con_ip=' + v.conIp) : (v.t + ' ausente')).join('; ') + ' limite=' + DAYS + 'd');
  db.close();
  if (deleted + neutralized > 0 && ck !== 'ok') {
    console.error('ip-purge: AVISO: el WAL no se pudo vaciar del todo; las IP quitadas pueden seguir en el archivo -wal hasta el proximo checkpoint del backend');
  }
})().catch((e) => fail(String((e && e.message) || e), 1));
