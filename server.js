const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const emailer = require('./email');

loadEnv();
const app = express();
const PORT = process.env.PORT || 3002;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

const ready = db.init({ databaseUrl: process.env.DATABASE_URL, sqliteFile: process.env.SQLITE_FILE });

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key || req.body.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- events ----------
app.get('/api/events', async (req, res, next) => {
  try { const evs = await db.listEvents(); res.json(evs.map(e => ({ id: e.id, slug: e.slug, title: e.title, description: e.description, created_at: e.created_at }))); } catch (e) { next(e); }
});
app.get('/api/events/:slug/fields', async (req, res, next) => {
  try { res.json(await db.getEventFields(req.params.slug)); } catch (e) { next(e); }
});
app.post('/api/admin/events', requireAdmin, async (req, res, next) => {
  try {
    const { slug, title, description, fields } = req.body;
    if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });
    res.json(await db.createEvent(slug, title, description, fields));
  } catch (e) { next(e); }
});
app.delete('/api/admin/events/:slug', requireAdmin, async (req, res, next) => {
  try { await db.deleteEvent(req.params.slug); res.json({ ok: true }); } catch (e) { next(e); }
});
app.get('/api/admin/fields', requireAdmin, async (req, res, next) => {
  try { res.json(await db.getEventFields(req.query.event)); } catch (e) { next(e); }
});
app.post('/api/admin/fields', requireAdmin, async (req, res, next) => {
  try {
    const { event, fields } = req.body;
    if (!Array.isArray(fields) || !fields.length) return res.status(400).json({ error: 'fields array required' });
    await db.setEventFields(event, fields);
    res.json({ ok: true, count: fields.length });
  } catch (e) { next(e); }
});
app.get('/api/admin/fields/sample.csv', requireAdmin, (req, res) => {
  const sample = db.DEFAULT_FIELDS.map(f =>
    [f.name, f.label, f.type, f.required ? 'yes' : 'no', (f.options || []).join('|')].join(',')
  ).join('\n');
  const csv = 'name,label,type,required,options\n' + sample;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="form-fields-template.csv"');
  res.send(csv);
});

// ---------- admin data ----------
app.post('/api/admin/import', requireAdmin, async (req, res, next) => {
  try {
    const rows = req.body.participants || req.body.rows || [];
    const eventSlug = req.body.event || req.query.event || 'deans-cup-2026';
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'participants array required: [{reg_number, full_name, email}]' });
    const results = await db.importParticipants(rows, eventSlug);
    const created = results.filter(x => x.status === 'created').length;
    const exists = results.filter(x => x.status === 'exists').length;
    const skipped = results.filter(x => x.status === 'skipped').length;
    res.json({ imported: created, created, exists, skipped, results });
  } catch (e) { next(e); }
});
app.get('/api/admin/participants', requireAdmin, async (req, res, next) => {
  try { res.json(await db.listParticipants(req.query.event)); } catch (e) { next(e); }
});
app.get('/api/admin/responses', requireAdmin, async (req, res, next) => {
  try { res.json(await db.listResponses(req.query.event)); } catch (e) { next(e); }
});
app.get('/api/admin/stats', requireAdmin, async (req, res, next) => {
  try { res.json(await db.getStats(req.query.event)); } catch (e) { next(e); }
});
app.get('/api/admin/export', requireAdmin, async (req, res, next) => {
  try {
    const eventSlug = req.query.event || 'deans-cup-2026';
    const fields = await db.getEventFields(eventSlug);
    const rows = await db.listResponses(eventSlug);
    const cols = ['reg_number', 'full_name', ...fields.map(f => f.name), 'submitted_at'];
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
    const lines = [cols.join(',')];
    for (const r of rows) {
      let a = {};
      try { a = r.data ? JSON.parse(r.data) : {}; } catch {}
      const vals = cols.map(c => {
        if (c === 'reg_number') return r.reg_number;
        if (c === 'full_name') return r.full_name;
        if (c === 'submitted_at') return r.submitted_at;
        let v = a[c];
        if (v == null) v = r[c];
        return Array.isArray(v) ? v.join('; ') : v;
      });
      lines.push(vals.map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="responses.csv"');
    res.send(lines.join('\n'));
  } catch (e) { next(e); }
});

// ---------- email OTP ----------
app.post('/api/auth/request-otp', async (req, res, next) => {
  try {
    const { token, email } = req.body;
    if (!token || !email) return res.status(400).json({ error: 'token and email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    const otp = await db.createOTP(token, email);
    if (emailer.isConfigured()) {
      let eventTitle = '';
      try {
        const p = await db.getParticipantByToken(token);
        const evs = await db.listEvents();
        const ev = evs.find(e => e.id === (p && p.event_id));
        eventTitle = ev ? ev.title : '';
      } catch { /* ignore */ }
      try {
        await emailer.sendOtp(email, otp, { eventTitle });
        return res.json({ ok: true, message: 'A verification code was sent to ' + email });
      } catch (err) {
        console.error('sendOtp failed:', err.message);
        return res.status(502).json({ error: 'Could not send the email right now. Please try again in a moment.' });
      }
    }
    console.log(`[OTP][demo] ${email} => ${otp} (no SMTP configured)`);
    res.json({ ok: true, message: 'Demo mode: email not configured', demo_otp: otp });
  } catch (e) {
    if (e.message.includes('Invalid token') || e.message.includes('Email does not match')) return res.status(400).json({ error: e.message });
    next(e);
  }
});
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { token, email, otp } = req.body;
    if (!token || !email || !otp) return res.status(400).json({ error: 'token, email and otp required' });
    await db.verifyOTP(token, email, otp);
    res.json({ ok: true, verified: true });
  } catch (e) { return res.status(400).json({ error: e.message }); }
});

// ---------- survey ----------
app.get('/s', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) return res.status(400).send(htmlPage('Missing token', msgCard('amber', 'Missing token', 'Use your personal link: <code>/s?token=YOUR_TOKEN</code>')));
  const p = await db.getParticipantByToken(token);
  if (!p) return res.status(404).send(htmlPage('Invalid token', msgCard('red', 'Invalid link', 'This link is not valid. You must be on the currently-enrolled list for this event.')));
  if (p.used) return res.status(410).send(htmlPage('Already submitted', msgCard('slate', 'Already submitted', 'This token has already been used. Each student can submit only once.')));
  const fields = await db.getEventFieldsById(p.event_id || 1);
  const evTitle = await eventTitle(p.event_id);
  res.send(renderSurvey(p, token, fields, evTitle));
});

app.post('/api/submit', async (req, res, next) => {
  try {
    const { token, email, answers } = req.body;
    if (!token || !email) return res.status(400).json({ error: 'token and email required - verify your email first' });
    const p = await db.getParticipantByToken(token);
    if (!p) return res.status(404).json({ error: 'Invalid token - you are not on the currently-enrolled list' });
    if (p.used) return res.status(409).json({ error: 'Token already used - you have already submitted' });
    const verified = await db.hasVerifiedOTP(token, email);
    if (!verified) return res.status(401).json({ error: 'Email not verified - please request and verify code' });
    if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'answers object required' });
    await db.submitResponse(token, { reg_number: p.reg_number, email, answers });
    res.json({ ok: true });
  } catch (e) {
    if (/already used|Invalid token|not verified/.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

app.get('/', async (req, res) => {
  const events = await db.listEvents();
  res.send(htmlPage('University Participation System', `
    <div class="max-w-5xl mx-auto">
      <div class="bg-gradient-to-br from-indigo-600 to-violet-600 text-white rounded-2xl p-8 shadow-lg">
        <h1 class="text-3xl font-bold">University Participation System</h1>
        <p class="mt-2 text-indigo-100">Secure, token-based surveys and event registrations with dynamic forms. Only currently-enrolled students with a personal link can participate - one submission per student.</p>
        <div class="mt-4 flex gap-3">
          <a href="/admin.html" class="bg-white text-indigo-700 px-5 py-2 rounded-lg font-semibold shadow">Admin Dashboard</a>
          <a href="/demo-currently-enrolled.csv" class="bg-indigo-800 text-white px-5 py-2 rounded-lg">Download Demo CSV</a>
        </div>
        <p class="mt-3 text-xs text-indigo-200">Secure email verification via one-time code. We never ask for your email password.</p>
      </div>
      <h2 class="text-xl font-bold mt-8">Available Events</h2>
      <div class="grid md:grid-cols-2 gap-4 mt-4">
        ${events.map(ev => `
          <div class="border rounded-xl p-5 shadow-sm bg-white">
            <h3 class="font-bold text-lg">${escapeHtml(ev.title)}</h3>
            <p class="text-sm text-slate-600 mt-1">${escapeHtml(ev.description || '')}</p>
            <p class="text-xs text-slate-500 mt-2">Slug: <code>${escapeHtml(ev.slug)}</code></p>
            <a href="/admin.html" class="inline-block mt-3 text-indigo-600 font-semibold">Manage →</a>
          </div>
        `).join('')}
      </div>
    </div>
  `));
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });
ready.then(() => app.listen(PORT, () => console.log(`Token survey on http://localhost:${PORT}  admin key=${ADMIN_KEY}`)))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });

function loadEnv() {
  const file = path.join(__dirname, '.env');
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([\w.]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
async function eventTitle(eventId) {
  try { const evs = await db.listEvents(); const e = evs.find(x => x.id === eventId); return e ? e.title : 'Event Registration'; } catch { return 'Event Registration'; }
}
function htmlPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-50 min-h-screen"><div class="max-w-6xl mx-auto p-6">${body}</div></body></html>`;
}
function msgCard(color, title, body) {
  return `<div class="max-w-xl mx-auto mt-12 p-6 bg-${color}-50 border border-${color}-200 rounded-xl text-center"><h2 class="text-xl font-bold">${title}</h2><p class="mt-2">${body}</p></div>`;
}

function renderSurvey(p, token, fields, evTitle) {
  const participant = { full_name: p.full_name || '', reg_number: p.reg_number || '', email: p.email || '' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(evTitle)}</title>
<script src="https://cdn.tailwindcss.com"></script>
</head><body class="bg-gradient-to-br from-slate-50 to-indigo-50 min-h-screen">
<div class="max-w-2xl mx-auto p-4 md:p-6">
  <div class="bg-white rounded-2xl shadow-lg overflow-hidden">
    <div class="bg-gradient-to-r from-indigo-600 to-violet-600 p-6 text-white">
      <h1 class="text-2xl font-bold">${escapeHtml(evTitle)}</h1>
      <p class="text-indigo-200 text-xs mt-2">Secure token + email verification. We never ask for your email password - only a one-time code sent to your email.</p>
    </div>
    <div class="p-6">
      <div class="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold">✓</div>
        <div><p class="font-semibold text-indigo-900">Token verified</p><p class="text-sm text-indigo-700">${escapeHtml(participant.full_name)} (${escapeHtml(participant.reg_number)})</p></div>
      </div>

      <div id="verifyBox" class="mt-6 p-5 border rounded-xl bg-amber-50 border-amber-200">
        <h2 class="font-bold text-amber-900">Step 1: Verify your university email</h2>
        <p class="text-sm text-amber-800 mt-1">Enter the university email tied to this token. We send a 6-digit code (demo code shown on screen - emailed in production).</p>
        <label class="block text-sm font-semibold mt-3">University email *</label>
        <input id="email" type="email" value="${escapeHtml(participant.email)}" placeholder="name@soroti.ac.ug" class="mt-1 w-full border rounded-lg px-3 py-2">
        <button id="sendBtn" class="mt-3 w-full bg-amber-600 text-white py-2 rounded-lg font-semibold">Send verification code</button>
        <p id="sendMsg" class="text-sm mt-2"></p>
        <div id="otpRow" class="hidden mt-4">
          <label class="block text-sm font-semibold">Enter 6-digit code *</label>
          <div class="flex gap-2 mt-1">
            <input id="otp" type="text" placeholder="123456" maxlength="6" class="flex-1 border rounded-lg px-3 py-2 tracking-widest text-center font-mono">
            <button id="verifyBtn" class="bg-indigo-600 text-white px-5 rounded-lg font-semibold">Verify</button>
          </div>
          <p id="verifyMsg" class="text-sm mt-2"></p>
        </div>
      </div>

      <form id="f" class="hidden mt-6">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="hidden" name="email" id="verifiedEmail">
        <div id="fields" class="grid gap-4"></div>
        <button type="submit" id="btn" class="mt-6 w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow">Submit</button>
        <p id="msg" class="text-sm mt-3 text-center"></p>
      </form>
    </div>
  </div>
  <p class="text-center text-xs text-slate-500 mt-4">One submission per token. Alumni or non-enrolled students cannot submit even with a valid university email.</p>
</div>
<script>
const token=${JSON.stringify(token)};
const SCHEMA=${JSON.stringify(fields)};
const PARTICIPANT=${JSON.stringify(participant)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function inputCls(){return 'mt-1 w-full border rounded-lg px-3 py-2';}
function renderField(f){
  const nm='f_'+f.name, req=f.required?' required':'', ro=f.readonly?' readonly':'';
  const label='<label class="block text-sm font-semibold">'+esc(f.label)+(f.required?' *':'')+'</label>';
  let inner='';
  const t=f.type||'text';
  if(t==='textarea') inner='<textarea data-field="'+esc(f.name)+'"'+req+' class="'+inputCls()+'" rows="3"></textarea>';
  else if(t==='select') inner='<select data-field="'+esc(f.name)+'"'+req+' class="'+inputCls()+'"><option value="">-- select --</option>'+((f.options||[]).map(o=>'<option>'+esc(o)+'</option>').join(''))+'</select>';
  else if(t==='radio') inner='<div class="mt-1 flex flex-wrap gap-4">'+((f.options||[]).map(o=>'<label class="inline-flex items-center gap-2"><input type="radio" name="'+nm+'" data-field="'+esc(f.name)+'" value="'+esc(o)+'"'+req+'> '+esc(o)+'</label>').join(''))+'</div>';
  else if(t==='multiselect') inner='<div class="mt-1 grid grid-cols-2 gap-2">'+((f.options||[]).map(o=>'<label class="flex items-center gap-2 border rounded-lg px-3 py-2 bg-white"><input type="checkbox" name="'+nm+'" data-field="'+esc(f.name)+'" value="'+esc(o)+'"> '+esc(o)+'</label>').join(''))+'</div>';
  else inner='<input type="'+esc(t)+'" data-field="'+esc(f.name)+'"'+req+ro+' class="'+inputCls()+'">';
  return '<div>'+label+inner+'</div>';
}
const fieldsEl=document.getElementById('fields');
fieldsEl.innerHTML=SCHEMA.map(renderField).join('');
// prefill
SCHEMA.forEach(f=>{ if(f.prefill){ const el=document.querySelector('[data-field="'+f.name+'"]'); if(el){ el.value=PARTICIPANT[f.prefill]||''; } } });
// toggle football position visibility if present
(function(){ const pos=document.querySelector('[data-field="football_position"]'); if(!pos) return; const fb=[...document.querySelectorAll('[data-field="sports"]')].find(x=>x.value==='Football'); if(!fb) return; const wrap=pos.closest('div'); function upd(){ wrap.style.opacity=fb.checked?'1':'0.5'; } fb.addEventListener('change',upd); upd(); })();

const sendBtn=document.getElementById('sendBtn'), verifyBtn=document.getElementById('verifyBtn');
const emailEl=document.getElementById('email'), otpEl=document.getElementById('otp');
const sendMsg=document.getElementById('sendMsg'), verifyMsg=document.getElementById('verifyMsg');
const otpRow=document.getElementById('otpRow'), verifyBox=document.getElementById('verifyBox'), form=document.getElementById('f');
sendBtn.addEventListener('click', async ()=>{
  const email=emailEl.value.trim();
  if(!email){ sendMsg.textContent='Enter your university email.'; sendMsg.style.color='crimson'; return; }
  sendBtn.disabled=true; sendMsg.textContent='Sending code...'; sendMsg.style.color='';
  const r=await fetch('/api/auth/request-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,email})});
  const j=await r.json();
  if(r.ok){ sendMsg.innerHTML = j.demo_otp ? ('Code generated. <b>Demo code: '+j.demo_otp+'</b> (email not configured)') : ('We emailed a 6-digit code to <b>'+esc(email)+'</b>. Check your inbox and spam folder.'); sendMsg.style.color='green'; otpRow.classList.remove('hidden'); }
  else { sendMsg.textContent=j.error||'Error'; sendMsg.style.color='crimson'; }
  sendBtn.disabled=false;
});
verifyBtn.addEventListener('click', async ()=>{
  const email=emailEl.value.trim(), otp=otpEl.value.trim();
  if(!otp){ verifyMsg.textContent='Enter code.'; verifyMsg.style.color='crimson'; return; }
  verifyBtn.disabled=true; verifyMsg.textContent='Verifying...';
  const r=await fetch('/api/auth/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,email,otp})});
  const j=await r.json();
  if(r.ok){ verifyMsg.textContent='Verified! Fill the form below.'; verifyMsg.style.color='green'; document.getElementById('verifiedEmail').value=email; verifyBox.classList.add('opacity-50'); form.classList.remove('hidden'); window.scrollTo({top:form.offsetTop,behavior:'smooth'}); }
  else { verifyMsg.textContent=j.error||'Invalid code'; verifyMsg.style.color='crimson'; }
  verifyBtn.disabled=false;
});
form.addEventListener('submit', async e=>{
  e.preventDefault();
  const answers={};
  document.querySelectorAll('[data-field]').forEach(el=>{
    const k=el.dataset.field;
    if(el.type==='checkbox'){ answers[k]=answers[k]||[]; if(el.checked) answers[k].push(el.value); }
    else if(el.type==='radio'){ if(el.checked) answers[k]=el.value; }
    else { answers[k]=el.value; }
  });
  // required multiselect check
  for(const f of SCHEMA){ if(f.required && f.type==='multiselect' && (!answers[f.name]||!answers[f.name].length)){ document.getElementById('msg').textContent='Please select at least one option for: '+f.label; document.getElementById('msg').style.color='crimson'; return; } }
  const body={token, email:document.getElementById('verifiedEmail').value||emailEl.value.trim(), answers};
  document.getElementById('btn').disabled=true; document.getElementById('msg').textContent='Submitting...';
  const r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(r.ok){ form.innerHTML='<div class="text-center py-8"><div class="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto text-2xl">✓</div><h2 class="text-2xl font-bold mt-4">Submitted!</h2><p class="text-slate-600 mt-2">Thank you for registering.</p></div>'; }
  else { document.getElementById('msg').textContent=j.error||'Error'; document.getElementById('msg').style.color='crimson'; document.getElementById('btn').disabled=false; }
});
</script>
</body></html>`;
}
