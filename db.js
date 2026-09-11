const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let backend = null;
let sqlite = null;
let pgPool = null;

const DEFAULT_FIELDS = [
  { name: 'full_name', label: '1. Full name', type: 'text', required: true, prefill: 'full_name' },
  { name: 'reg_number', label: '2. Registration Number', type: 'text', required: true, prefill: 'reg_number', readonly: true },
  { name: 'gender', label: '3. Gender', type: 'select', required: true, options: ['Male', 'Female'] },
  { name: 'phone', label: '4. Phone Number', type: 'tel', required: false },
  { name: 'year_of_study', label: '5. Year of Study', type: 'select', required: true, options: ['1', '2', '3', '4'] },
  { name: 'sports', label: '6. Which sport(s) do you play?', type: 'multiselect', required: true, options: ['E-Sports', 'Football', 'Omweso', 'Ludo', 'Draughts', 'Scrabble', 'Chess', 'Darts', 'Woodball', 'Pool Table', 'Table Tennis', 'Badminton', 'Rugby', 'Handball', 'Volleyball'] },
  { name: 'football_position', label: '7. If you selected Football, what position do you play?', type: 'select', required: false, options: ['Striker', 'Attacking Midfielder', 'Winger', 'Central Midfielder', 'Full Back', 'Goalkeeper', 'Defensive Midfielder', 'Centre Back'] },
  { name: 'other_position', label: '8. For other sports, state your position/event/category.', type: 'text', required: false }
];

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
        fields TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        token TEXT PRIMARY KEY,
        reg_number TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        event_id INTEGER DEFAULT 1,
        extra TEXT,
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
        data TEXT,
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
    try { sqlite.exec('ALTER TABLE events ADD COLUMN fields TEXT'); } catch {}
    try { sqlite.exec('ALTER TABLE participants ADD COLUMN event_id INTEGER DEFAULT 1'); } catch {}
    try { sqlite.exec('ALTER TABLE participants ADD COLUMN extra TEXT'); } catch {}
    try { sqlite.exec('ALTER TABLE responses ADD COLUMN event_id INTEGER DEFAULT 1'); } catch {}
    try { sqlite.exec('ALTER TABLE responses ADD COLUMN data TEXT'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_participants_reg ON participants(reg_number)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_responses_reg ON responses(reg_number)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_responses_event ON responses(event_id)'); } catch {}
    try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_otps_token ON otps(token, email)'); } catch {}
    try { sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_reg_event ON participants(reg_number, event_id)'); } catch {}
    const existing = sqlite.prepare('SELECT id FROM events WHERE slug=?').get('deans-cup-2026');
    if (!existing || existing.id == null) {
      sqlite.prepare('INSERT INTO events(slug, title, description, fields, created_at) VALUES(?,?,?,?,?)')
        .run('deans-cup-2026', "ECS Dean's Cup 2026", 'Electronics and Computer Engineering sports registration - 4th Edition', JSON.stringify(DEFAULT_FIELDS), new Date().toISOString());
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
        fields TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        token TEXT PRIMARY KEY,
        reg_number TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        event_id INTEGER DEFAULT 1,
        extra TEXT,
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
        data TEXT,
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
      await pgPool.query('INSERT INTO events(slug, title, description, fields, created_at) VALUES($1,$2,$3,$4,$5)', ['deans-cup-2026', "ECS Dean's Cup 2026", 'Electronics and Computer Engineering sports registration - 4th Edition', JSON.stringify(DEFAULT_FIELDS), new Date().toISOString()]);
    }
  })();
}

async function getEventId(slug) {
  const s = slug || 'deans-cup-2026';
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT id FROM events WHERE slug=$1', [s]);
    return (rows[0] && rows[0].id != null) ? rows[0].id : 1;
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

async function createEvent(slug, title, description, fields) {
  const f = fields === undefined ? null : (typeof fields === 'string' ? fields : JSON.stringify(fields));
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('INSERT INTO events(slug, title, description, fields, created_at) VALUES($1,$2,$3,$4,$5) RETURNING *', [slug, title, description || '', f, new Date().toISOString()]);
    return rows[0];
  }
  const existing = sqlite.prepare('SELECT * FROM events WHERE slug=?').get(slug);
  if (existing && existing.id != null) return existing;
  sqlite.prepare('INSERT INTO events(slug, title, description, fields, created_at) VALUES(?,?,?,?,?)').run(slug, title, description || '', f, new Date().toISOString());
  return sqlite.prepare('SELECT * FROM events WHERE slug=?').get(slug);
}

async function getEventFields(slug) {
  const s = slug || 'deans-cup-2026';
  let raw = null;
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT fields FROM events WHERE slug=$1', [s]);
    raw = rows[0] ? rows[0].fields : null;
  } else {
    const row = sqlite.prepare('SELECT fields FROM events WHERE slug=?').get(s);
    raw = (row && row.id !== undefined) ? row.fields : (row ? row.fields : null);
  }
  if (!raw) return DEFAULT_FIELDS;
  try { const p = JSON.parse(raw); return Array.isArray(p) && p.length ? p : DEFAULT_FIELDS; } catch { return DEFAULT_FIELDS; }
}

async function getEventFieldsById(eventId) {
  let raw = null;
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT fields FROM events WHERE id=$1', [eventId]);
    raw = rows[0] ? rows[0].fields : null;
  } else {
    const row = sqlite.prepare('SELECT fields FROM events WHERE id=?').get(eventId);
    raw = row ? row.fields : null;
  }
  if (!raw) return DEFAULT_FIELDS;
  try { const p = JSON.parse(raw); return Array.isArray(p) && p.length ? p : DEFAULT_FIELDS; } catch { return DEFAULT_FIELDS; }
}

async function setEventFields(slug, fields) {
  const json = typeof fields === 'string' ? fields : JSON.stringify(fields);
  const s = slug || 'deans-cup-2026';
  if (backend === 'postgres') {
    await pgPool.query('UPDATE events SET fields=$1 WHERE slug=$2', [json, s]);
    return;
  }
  sqlite.prepare('UPDATE events SET fields=? WHERE slug=?').run(json, s);
}

async function importParticipants(rows, eventSlug) {
  const eventId = await getEventId(eventSlug);
  const results = [];
  for (const r of rows) {
    const reg = (r.reg_number || '').trim();
    const name = (r.full_name || '').trim();
    if (!reg || !name) continue;
    const token = crypto.randomBytes(16).toString('hex');
    const extra = JSON.stringify(r);
    if (backend === 'postgres') {
      const existing = await pgPool.query('SELECT token FROM participants WHERE reg_number=$1 AND event_id=$2', [reg, eventId]);
      if (existing.rows.length && existing.rows[0].token) { results.push({ reg_number: reg, token: existing.rows[0].token, status: 'exists' }); continue; }
      await pgPool.query('INSERT INTO participants(token, reg_number, full_name, email, used, event_id, extra, created_at) VALUES($1,$2,$3,$4,0,$5,$6,$7)', [token, reg, name, r.email || '', eventId, extra, new Date().toISOString()]);
      results.push({ reg_number: reg, full_name: name, email: r.email || '', token, status: 'created' });
    } else {
      const existing = sqlite.prepare('SELECT token FROM participants WHERE reg_number=? AND event_id=?').get(reg, eventId);
      if (existing && existing.token) { results.push({ reg_number: reg, token: existing.token, status: 'exists' }); continue; }
      sqlite.prepare('INSERT INTO participants(token, reg_number, full_name, email, used, event_id, extra, created_at) VALUES(?,?,?,?,0,?,?,?)').run(token, reg, name, r.email || '', eventId, extra, new Date().toISOString());
      results.push({ reg_number: reg, full_name: name, email: r.email || '', token, status: 'created' });
    }
  }
  return results;
}

async function getParticipantByToken(token) {
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT * FROM participants WHERE token=$1', [token]);
    return (rows[0] && rows[0].token) ? rows[0] : null;
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
  if (backend === 'postgres') { await pgPool.query('UPDATE participants SET used=1 WHERE token=$1', [token]); return; }
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
  console.log(`[OTP] token=${token.slice(0,8)} email=${email} otp=${otp}`);
  return otp;
}

async function verifyOTP(token, email, otp) {
  const now = new Date().toISOString();
  if (backend === 'postgres') {
    const { rows } = await pgPool.query('SELECT * FROM otps WHERE token=$1 AND email=$2 AND otp=$3 ORDER BY created_at DESC LIMIT 1', [token, email.toLowerCase().trim(), otp]);
    const row = rows[0];
    if (!row || row.otp == null) throw new Error('Invalid code');
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
    return !!(rows[0] && rows[0].otp != null);
  }
  const row = sqlite.prepare('SELECT * FROM otps WHERE token=? AND email=? AND verified=1 AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(token, email.toLowerCase().trim(), now);
  return !!(row && row.otp != null);
}

async function submitResponse(token, payload) {
  const p = await getParticipantByToken(token);
  if (!p) throw new Error('Invalid token');
  if (p.used) throw new Error('Token already used');
  if (payload.email) {
    const ok = await hasVerifiedOTP(token, payload.email);
    if (!ok) throw new Error('Email not verified - please verify with code');
  }
  const answers = payload.answers || {};
  const val = (k) => { const v = answers[k]; return Array.isArray(v) ? v.join('; ') : (v == null ? '' : String(v)); };
  const now = new Date().toISOString();
  const eventId = p.event_id || 1;
  const dataJson = JSON.stringify(answers);
  const full_name = val('full_name') || p.full_name;
  const gender = val('gender');
  const phone = val('phone');
  const year_of_study = val('year_of_study');
  const sports = val('sports');
  const football_position = val('football_position');
  const other_position = val('other_position');
  if (backend === 'postgres') {
    await pgPool.query(
      'INSERT INTO responses(token, reg_number, full_name, gender, phone, year_of_study, sports, football_position, other_position, data, event_id, submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [token, p.reg_number, full_name, gender, phone, year_of_study, sports, football_position, other_position, dataJson, eventId, now]
    );
  } else {
    sqlite.prepare('INSERT INTO responses(token, reg_number, full_name, gender, phone, year_of_study, sports, football_position, other_position, data, event_id, submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(token, p.reg_number, full_name, gender, phone, year_of_study, sports, football_position, other_position, dataJson, eventId, now);
  }
  await markUsed(token);
}

async function listResponses(eventSlug) {
  const eventId = eventSlug ? await getEventId(eventSlug) : null;
  if (backend === 'postgres') {
    if (eventId) { const { rows } = await pgPool.query('SELECT * FROM responses WHERE event_id=$1 ORDER BY submitted_at DESC', [eventId]); return rows; }
    const { rows } = await pgPool.query('SELECT * FROM responses ORDER BY submitted_at DESC');
    return rows;
  }
  if (eventId) return sqlite.prepare('SELECT * FROM responses WHERE event_id=? ORDER BY submitted_at DESC').all(eventId);
  return sqlite.prepare('SELECT * FROM responses ORDER BY submitted_at DESC').all();
}

function parseData(r) {
  try { return r.data ? JSON.parse(r.data) : {}; } catch { return {}; }
}

async function getStats(eventSlug) {
  const fields = await getEventFields(eventSlug);
  const responses = await listResponses(eventSlug);
  const byYear = {}, byGender = {}, bySport = {}, byFootball = {}, byField = {}, fieldLabels = {};
  const timeline = {};
  for (const f of fields) {
    if (['select', 'radio', 'multiselect'].includes(f.type)) {
      byField[f.name] = {};
      fieldLabels[f.name] = f.label || f.name;
    }
  }
  for (const r of responses) {
    const a = parseData(r);
    const year = (a.year_of_study != null && a.year_of_study !== '') ? a.year_of_study : (r.year_of_study || 'Unknown');
    const gender = (a.gender != null && a.gender !== '') ? a.gender : (r.gender || 'Unknown');
    const sportsRaw = a.sports != null ? (Array.isArray(a.sports) ? a.sports.join(';') : String(a.sports)) : (r.sports || '');
    const fb = (a.football_position != null && a.football_position !== '') ? a.football_position : r.football_position;
    byYear[year] = (byYear[year] || 0) + 1;
    byGender[gender] = (byGender[gender] || 0) + 1;
    for (const s of String(sportsRaw).split(/[;|]/).map(x => x.trim()).filter(Boolean)) bySport[s] = (bySport[s] || 0) + 1;
    if (fb) byFootball[fb] = (byFootball[fb] || 0) + 1;
    for (const f of fields) {
      if (byField[f.name] === undefined) continue;
      const v = a[f.name];
      const arr = Array.isArray(v) ? v : (v != null && v !== '' ? [v] : []);
      for (const o of arr) byField[f.name][o] = (byField[f.name][o] || 0) + 1;
    }
    const day = String(r.submitted_at).slice(0, 10);
    timeline[day] = (timeline[day] || 0) + 1;
  }
  return { total: responses.length, byYear, byGender, bySport, byFootball, byField, fieldLabels, timeline };
}

module.exports = { DEFAULT_FIELDS, init, listEvents, createEvent, getEventId, getEventFields, getEventFieldsById, setEventFields, importParticipants, getParticipantByToken, listParticipants, submitResponse, listResponses, createOTP, verifyOTP, hasVerifiedOTP, getStats };
