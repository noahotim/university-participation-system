const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let backend = null;
let sqlite = null;
let pgPool = null;

function init(config = {}) {
  const url = (config.databaseUrl || '').trim();
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    backend = 'postgres';
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: url });
  } else {
    backend = 'sqlite';
    const { DatabaseSync } = require('node:sqlite');
    const file = config.sqliteFile || path.join(__dirname, 'data', 'survey.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new DatabaseSync(file);
    sqlite.exec('PRAGMA journal_mode = WAL;');
  }
  createSchema();
}

function createSchema() {
  if (backend === 'sqlite') {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        token TEXT PRIMARY KEY,
        reg_number TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        event_id INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL REFERENCES participants(token),
        reg_number TEXT NOT NULL,
        full_name TEXT,
        gender TEXT,
        phone TEXT,
        year_of_study TEXT,
        sports TEXT,
        football_position TEXT,
        other_position TEXT,
        event_id INTEGER DEFAULT 1,
        submitted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        email TEXT NOT NULL,
        otp TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        verified INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    // upgrades for existing DBs
    try { sqlite.exec('ALTER TABLE participants ADD COLUMN event_id INTEGER DEFAULT 1'); } catch {}
    try { sqlite.exec('ALTER TABLE responses ADD COLUMN event_id INTEGER DEFAULT 1'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_participants_reg ON participants(reg_number)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_responses_reg ON responses(reg_number)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_responses_event ON responses(event_id)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_otps_token ON otps(token, email)'); } catch {}
    try { sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_reg_event ON participants(reg_number, event_id)'); } catch {}
    const existing = sqlite.prepare('SELECT id FROM events WHERE slug=?').get('deans-cup-2026');
    if (!existing || existing.id == null) {
      sqlite.prepare('INSERT INTO events(slug, title, description, created_at) VALUES(?,?,?,?)')
        .run('deans-cup-2026', "ECS Dean's Cup 2026", 'Electronics and Computer Engineering sports registration - 4th Edition', new Date().toISOString());
    }
    return;
  }
  return (async () => {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        token TEXT PRIMARY KEY,
        reg_number TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        event_id INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL REFERENCES participants(token),
        reg_number TEXT NOT NULL,
        full_name TEXT,
        gender TEXT,
        phone TEXT,
        year_of_study TEXT,
        sports TEXT,
        football_position TEXT,
        other_position TEXT,
        event_id INTEGER DEFAULT 1,
        submitted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS otps (
        id SERIAL PRIMARY KEY,
        token TEXT NOT NULL,
        email TEXT NOT NULL,
        otp TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        verified INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    const { rows } = await pgPool.query('SELECT id FROM events WHERE slug=$1', ['deans-cup-2026']);
    if (!rows.length) {
      await pgPool.query('INSERT INTO events(slug, title, description, created_at) VALUES($1,$2,$3,$4)', ['deans-cup-2026', "ECS Dean's Cup 2026", 'Electronics and Computer Engineering sports registration - 4th Edition', new Date().toISOString()]);
    }
  })();
}

async function getEventId(slug) {
  const s = slug || 'deans-cup-2026';
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT id FROM events WHERE slug=$1', [s]);
    return rows[0] ? rows[0].id : 1;
  }
  const row = sqlite.prepare('SELECT id FROM events WHERE slug=?').get(s);
  return (row && row.id != null) ? row.id : 1;
}

async function listEvents() {
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT * FROM events ORDER BY created_at');
    return rows;
  }
  return sqlite.prepare('SELECT * FROM events ORDER BY created_at').all();
}

async function createEvent(slug, title, description) {
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('INSERT INTO events(slug, title, description, created_at) VALUES($1,$2,$3,$4) RETURNING *', [slug, title, description || '', new Date().toISOString()]);
    return rows[0];
  }
  const existing = sqlite.prepare('SELECT * FROM events WHERE slug=?').get(slug);
  if (existing) return existing;
  sqlite.prepare('INSERT INTO events(slug, title, description, created_at) VALUES(?,?,?,?)').run(slug, title, description || '', new Date().toISOString());
  return sqlite.prepare('SELECT * FROM events WHERE slug=?').get(slug);
}

async function importParticipants(rows, eventSlug) {
  const eventId = await getEventId(eventSlug);
  const results = [];
  for (const r of rows) {
    const reg = (r.reg_number || '').trim();
    const name = (r.full_name || '').trim();
    if (!reg || !name) continue;
    const token = crypto.randomBytes(16).toString('hex');
    if (backend === 'postgres') {
      const existing = await pgPool.query('SELECT token FROM participants WHERE reg_number=$1 AND event_id=$2', [reg, eventId]);
      if (existing.rows.length) { results.push({ reg_number: reg, token: existing.rows[0].token, status: 'exists' }); continue; }
      await pgPool.query('INSERT INTO participants(token, reg_number, full_name, email, used, event_id, created_at) VALUES($1,$2,$3,$4,0,$5,$6)', [token, reg, name, r.email || '', eventId, new Date().toISOString()]);
      results.push({ reg_number: reg, full_name: name, email: r.email || '', token, status: 'created' });
    } else {
      const existing = sqlite.prepare('SELECT token FROM participants WHERE reg_number=? AND event_id=?').get(reg, eventId);
      if (existing && existing.token) { results.push({ reg_number: reg, token: existing.token, status: 'exists' }); continue; }
      sqlite.prepare('INSERT INTO participants(token, reg_number, full_name, email, used, event_id, created_at) VALUES(?,?,?,?,0,?,?)').run(token, reg, name, r.email || '', eventId, new Date().toISOString());
      results.push({ reg_number: reg, full_name: name, email: r.email || '', token, status: 'created' });
    }
  }
  return results;
}

async function getParticipantByToken(token) {
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT * FROM participants WHERE token=$1', [token]);
    return rows[0] || null;
  }
  const row = sqlite.prepare('SELECT * FROM participants WHERE token=?').get(token);
  return (row && row.token) ? row : null;
}

async function listParticipants(eventSlug) {
  const eventId = eventSlug ? await getEventId(eventSlug) : null;
  if (backend === 'postgres') {
    if (eventId) {
      const { rows } = await pgPool.query('SELECT token, reg_number, full_name, email, used, event_id, created_at FROM participants WHERE event_id=$1 ORDER BY created_at', [eventId]);
      return rows;
    }
    const { rows } = await pgPool.query('SELECT token, reg_number, full_name, email, used, event_id, created_at FROM participants ORDER BY created_at');
    return rows;
  }
  if (eventId) return sqlite.prepare('SELECT token, reg_number, full_name, email, used, event_id, created_at FROM participants WHERE event_id=? ORDER BY created_at').all(eventId);
  return sqlite.prepare('SELECT token, reg_number, full_name, email, used, event_id, created_at FROM participants ORDER BY created_at').all();
}

async function markUsed(token) {
  if (backend === 'postgres') {
    await pgPool.query('UPDATE participants SET used=1 WHERE token=$1', [token]);
    return;
  }
  sqlite.prepare('UPDATE participants SET used=1 WHERE token=?').run(token);
}

async function createOTP(token, email) {
  const p = await getParticipantByToken(token);
  if (!p) throw new Error('Invalid token');
  if (p.email && p.email.toLowerCase() !== email.toLowerCase().trim()) throw new Error('Email does not match token');
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  if (backend === 'postgres') {
    await pgPool.query('DELETE FROM otps WHERE token=$1 AND email=$2', [token, email.toLowerCase().trim()]);
    await pgPool.query('INSERT INTO otps(token, email, otp, expires_at, verified, created_at) VALUES($1,$2,$3,$4,0,$5)', [token, email.toLowerCase().trim(), otp, expiresAt, now]);
  } else {
    sqlite.prepare('DELETE FROM otps WHERE token=? AND email=?').run(token, email.toLowerCase().trim());
    sqlite.prepare('INSERT INTO otps(token, email, otp, expires_at, verified, created_at) VALUES(?,?,?,?,0,?)').run(token, email.toLowerCase().trim(), otp, expiresAt, now);
  }
  console.log(`[OTP] token=${token.slice(0,8)} email=${email} otp=${otp} expires=${expiresAt}`);
  return otp;
}

async function verifyOTP(token, email, otp) {
  const now = new Date().toISOString();
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT * FROM otps WHERE token=$1 AND email=$2 AND otp=$3 ORDER BY created_at DESC LIMIT 1', [token, email.toLowerCase().trim(), otp]);
    const row = rows[0];
    if (!row) throw new Error('Invalid code');
    if (row.verified) throw new Error('Code already used');
    if (row.expires_at < now) throw new Error('Code expired');
    await pgPool.query('UPDATE otps SET verified=1 WHERE id=$1', [row.id]);
    return true;
  }
  const row = sqlite.prepare('SELECT * FROM otps WHERE token=? AND email=? AND otp=? ORDER BY created_at DESC LIMIT 1').get(token, email.toLowerCase().trim(), otp);
  if (!row || row.otp == null) throw new Error('Invalid code');
  if (row.verified) throw new Error('Code already used');
  if (row.expires_at < now) throw new Error('Code expired');
  sqlite.prepare('UPDATE otps SET verified=1 WHERE id=?').run(row.id);
  return true;
}

async function hasVerifiedOTP(token, email) {
  const now = new Date().toISOString();
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT * FROM otps WHERE token=$1 AND email=$2 AND verified=1 AND expires_at > $3 ORDER BY created_at DESC LIMIT 1', [token, email.toLowerCase().trim(), now]);
    return !!rows.length;
  }
  const row = sqlite.prepare('SELECT * FROM otps WHERE token=? AND email=? AND verified=1 AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(token, email.toLowerCase().trim(), now);
  return !!(row && row.otp != null);
}

async function submitResponse(token, data) {
  const p = await getParticipantByToken(token);
  if (!p) throw new Error('Invalid token');
  if (p.used) throw new Error('Token already used');
  if (data.email) {
    const ok = await hasVerifiedOTP(token, data.email);
    if (!ok) throw new Error('Email not verified - please verify with code');
  }
  const now = new Date().toISOString();
  const eventId = p.event_id || 1;
  if (backend === 'postgres') {
    await pgPool.query(
      'INSERT INTO responses(token, reg_number, full_name, gender, phone, year_of_study, sports, football_position, other_position, event_id, submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [token, data.reg_number, data.full_name, data.gender, data.phone, data.year_of_study, data.sports, data.football_position, data.other_position, eventId, now]
    );
  } else {
    sqlite.prepare('INSERT INTO responses(token, reg_number, full_name, gender, phone, year_of_study, sports, football_position, other_position, event_id, submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(token, data.reg_number, data.full_name, data.gender, data.phone, data.year_of_study, data.sports, data.football_position, data.other_position, eventId, now);
  }
  await markUsed(token);
}

async function listResponses(eventSlug) {
  const eventId = eventSlug ? await getEventId(eventSlug) : null;
  if (backend === 'postgres') {
    if (eventId) {
      const { rows } = await pgPool.query('SELECT * FROM responses WHERE event_id=$1 ORDER BY submitted_at DESC', [eventId]);
      return rows;
    }
    const { rows } = await pgPool.query('SELECT * FROM responses ORDER BY submitted_at DESC');
    return rows;
  }
  if (eventId) return sqlite.prepare('SELECT * FROM responses WHERE event_id=? ORDER BY submitted_at DESC').all(eventId);
  return sqlite.prepare('SELECT * FROM responses ORDER BY submitted_at DESC').all();
}

async function getStats(eventSlug) {
  const responses = await listResponses(eventSlug);
  const byYear = {}, byGender = {}, bySport = {}, byFootball = {};
  const timeline = {};
  for (const r of responses) {
    byYear[r.year_of_study || 'Unknown'] = (byYear[r.year_of_study || 'Unknown'] || 0) + 1;
    byGender[r.gender || 'Unknown'] = (byGender[r.gender || 'Unknown'] || 0) + 1;
    const sports = String(r.sports || '').split(';').map(s => s.trim()).filter(Boolean);
    for (const s of sports) bySport[s] = (bySport[s] || 0) + 1;
    if (r.football_position) byFootball[r.football_position] = (byFootball[r.football_position] || 0) + 1;
    const day = String(r.submitted_at).slice(0, 10);
    timeline[day] = (timeline[day] || 0) + 1;
  }
  return { total: responses.length, byYear, byGender, bySport, byFootball, timeline };
}

module.exports = { init, listEvents, createEvent, getEventId, importParticipants, getParticipantByToken, listParticipants, submitResponse, listResponses, createOTP, verifyOTP, hasVerifiedOTP, getStats };
