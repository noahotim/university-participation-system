const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');

loadEnv();
const app = express();
const PORT = process.env.PORT || 3002;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

db.init({ databaseUrl: process.env.DATABASE_URL, sqliteFile: process.env.SQLITE_FILE });

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key || req.body.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// --- events (general system) ---
app.get('/api/events', async (req, res, next) => {
  try { res.json(await db.listEvents()); } catch (e) { next(e); }
});
app.post('/api/admin/events', requireAdmin, async (req, res, next) => {
  try {
    const { slug, title, description } = req.body;
    if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });
    const ev = await db.createEvent(slug, title, description);
    res.json(ev);
  } catch (e) { next(e); }
});

// --- admin API ---
app.post('/api/admin/import', requireAdmin, async (req, res, next) => {
  try {
    const rows = req.body.participants || req.body.rows || [];
    const eventSlug = req.body.event || req.query.event || 'deans-cup-2026';
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'participants array required: [{reg_number, full_name, email}]' });
    const results = await db.importParticipants(rows, eventSlug);
    res.json({ imported: results.length, results });
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
    const rows = await db.listResponses(req.query.event);
    const header = 'reg_number,full_name,gender,phone,year_of_study,sports,football_position,other_position,submitted_at\n';
    const csv = header + rows.map(r =>
      [r.reg_number, r.full_name, r.gender, r.phone, r.year_of_study, '"' + String(r.sports||'').replace(/"/g,'""') + '"', r.football_position, '"' + String(r.other_position||'').replace(/"/g,'""') + '"', r.submitted_at]
        .map(v => String(v||'').replace(/\n/g,' ')).join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="responses.csv"');
    res.send(csv);
  } catch (e) { next(e); }
});

// --- email OTP (secure, NOT password) ---
app.post('/api/auth/request-otp', async (req, res, next) => {
  try {
    const { token, email } = req.body;
    if (!token || !email) return res.status(400).json({ error: 'token and email required' });
    // validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    const otp = await db.createOTP(token, email);
    // In production, send via SMTP (configure SMTP_HOST etc.). For demo, return otp and log it.
    const isProd = !!process.env.SMTP_HOST;
    res.json({ ok: true, message: isProd ? 'Code sent to your email' : 'Demo code (would be emailed in production)', demo_otp: isProd ? undefined : otp });
  } catch (e) {
    if (e.message.includes('Invalid token') || e.message.includes('Email does not match')) return res.status(400).json({ error: e.message });
    next(e);
  }
});
app.post('/api/auth/verify-otp', async (req, res, next) => {
  try {
    const { token, email, otp } = req.body;
    if (!token || !email || !otp) return res.status(400).json({ error: 'token, email and otp required' });
    await db.verifyOTP(token, email, otp);
    res.json({ ok: true, verified: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// --- survey ---
app.get('/s', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) return res.status(400).send(htmlPage('Missing token','<div class="max-w-xl mx-auto mt-12 p-6 bg-amber-50 border border-amber-200 rounded-xl text-center"><h2 class="text-xl font-bold">Missing token</h2><p class="mt-2">Use your personal link: <code>/s?token=YOUR_TOKEN</code></p><p class="mt-2 text-sm text-slate-600">Contact admin if you are currently enrolled and did not receive a link.</p></div>'));
  const p = await db.getParticipantByToken(token);
  if (!p) return res.status(404).send(htmlPage('Invalid token','<div class="max-w-xl mx-auto mt-12 p-6 bg-red-50 border border-red-200 rounded-xl text-center"><h2 class="text-xl font-bold text-red-700">Invalid link</h2><p class="mt-2">This link is not valid. You must be on the currently-enrolled list for this event.</p></div>'));
  if (p.used) return res.status(410).send(htmlPage('Already submitted','<div class="max-w-xl mx-auto mt-12 p-6 bg-slate-50 border rounded-xl text-center"><h2 class="text-xl font-bold">Already submitted</h2><p class="mt-2">This token has already been used. Each student can submit only once.</p></div>'));
  res.send(renderSurvey(p, token));
});

app.post('/api/submit', async (req, res, next) => {
  try {
    const { token, email, full_name, reg_number, gender, phone, year_of_study, sports, football_position, other_position } = req.body;
    if (!token || !email) return res.status(400).json({ error: 'token and email required - verify your email first' });
    const p = await db.getParticipantByToken(token);
    if (!p) return res.status(404).json({ error: 'Invalid token - you are not on the currently-enrolled list' });
    if (p.used) return res.status(409).json({ error: 'Token already used - you have already submitted' });
    if (reg_number && reg_number.trim() !== p.reg_number) return res.status(400).json({ error: 'Registration number does not match token' });
    // require verified OTP
    const verified = await db.hasVerifiedOTP(token, email);
    if (!verified) return res.status(401).json({ error: 'Email not verified - please request and verify code' });
    if (!full_name || !reg_number || !gender || !year_of_study || !sports) return res.status(400).json({ error: 'Missing required fields' });
    await db.submitResponse(token, {
      reg_number: p.reg_number, full_name, gender, phone: phone || '', year_of_study,
      sports: Array.isArray(sports) ? sports.join(';') : String(sports),
      football_position: football_position || '', other_position: other_position || '', email
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('already used') || e.message.includes('Invalid token') || e.message.includes('Email not verified')) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// home - general entry point
app.get('/', async (req, res) => {
  const events = await db.listEvents();
  res.send(htmlPage('University Participation System', `
    <div class="max-w-5xl mx-auto">
      <div class="bg-gradient-to-br from-indigo-600 to-violet-600 text-white rounded-2xl p-8 shadow-lg">
        <h1 class="text-3xl font-bold">University Participation System</h1>
        <p class="mt-2 text-indigo-100">Secure, token-based surveys and event registrations. Only currently-enrolled students with a personal link can participate - one submission per student.</p>
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
            <p class="text-sm text-slate-600 mt-1">${escapeHtml(ev.description||'')}</p>
            <p class="text-xs text-slate-500 mt-2">Slug: <code>${escapeHtml(ev.slug)}</code></p>
            <a href="/admin.html" class="inline-block mt-3 text-indigo-600 font-semibold">Manage →</a>
          </div>
        `).join('')}
      </div>
      <div class="mt-8 p-5 bg-slate-50 rounded-xl border">
        <h3 class="font-bold">How to participate</h3>
        <ol class="list-decimal ml-6 mt-2 text-sm text-slate-700">
          <li>Admin imports CSV of currently-enrolled students - each gets a unique personal link.</li>
          <li>You receive your link: <code>/s?token=YOUR_TOKEN</code></li>
          <li>Open link, enter your university email, request code, verify code.</li>
          <li>Fill the form and submit. Token becomes invalid after one use.</li>
        </ol>
      </div>
    </div>
  `));
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

app.listen(PORT, () => console.log(`Token survey on http://localhost:${PORT}  admin key=${ADMIN_KEY}`));

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
function htmlPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-50 min-h-screen"><div class="max-w-6xl mx-auto p-6">${body}</div></body></html>`;
}
function renderSurvey(p, token) {
  const name = escapeHtml(p.full_name);
  const reg = escapeHtml(p.reg_number);
  const email = escapeHtml(p.email || '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECS Dean's Cup 2026 - Registration</title>
<script src="https://cdn.tailwindcss.com"></script>
</head><body class="bg-gradient-to-br from-slate-50 to-indigo-50 min-h-screen">
<div class="max-w-2xl mx-auto p-4 md:p-6">
  <div class="bg-white rounded-2xl shadow-lg overflow-hidden">
    <div class="bg-gradient-to-r from-indigo-600 to-violet-600 p-6 text-white">
      <h1 class="text-2xl font-bold">ECS – Dean's Cup 2026</h1>
      <p class="text-indigo-100 text-sm mt-1">Sports Registration Form - 4th Edition</p>
      <p class="text-indigo-200 text-xs mt-2">Secure token + email verification. We never ask for your email password - only a one-time code sent to your email.</p>
    </div>
    <div class="p-6">
      <div class="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold">✓</div>
        <div><p class="font-semibold text-indigo-900">Token verified</p><p class="text-sm text-indigo-700">${name} (${reg})</p></div>
      </div>

      <!-- Step 1: Email verification -->
      <div id="verifyBox" class="mt-6 p-5 border rounded-xl bg-amber-50 border-amber-200">
        <h2 class="font-bold text-amber-900">Step 1: Verify your university email</h2>
        <p class="text-sm text-amber-800 mt-1">Enter your university email that matches the token. We will send a 6-digit code (demo code shown on screen - in production it is emailed).</p>
        <label class="block text-sm font-semibold mt-3">University email *</label>
        <input id="email" type="email" value="${email}" placeholder="name@soroti.ac.ug" class="mt-1 w-full border rounded-lg px-3 py-2">
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

      <!-- Step 2: Survey form (hidden until verified) -->
      <form id="f" class="hidden mt-6">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="hidden" name="email" id="verifiedEmail">
        <div class="grid gap-4">
          <div><label class="block text-sm font-semibold">1. Full name *</label><input name="full_name" value="${name}" required class="mt-1 w-full border rounded-lg px-3 py-2"></div>
          <div><label class="block text-sm font-semibold">2. Registration Number *</label><input name="reg_number" value="${reg}" required readonly class="mt-1 w-full border rounded-lg px-3 py-2 bg-slate-100"></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="block text-sm font-semibold">3. Gender *</label><select name="gender" required class="mt-1 w-full border rounded-lg px-3 py-2"><option value="">-- select --</option><option>Male</option><option>Female</option></select></div>
            <div><label class="block text-sm font-semibold">5. Year of Study *</label><select name="year_of_study" required class="mt-1 w-full border rounded-lg px-3 py-2"><option value="">-- select --</option><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
          </div>
          <div><label class="block text-sm font-semibold">4. Phone Number</label><input name="phone" type="text" placeholder="e.g. 077..." class="mt-1 w-full border rounded-lg px-3 py-2"></div>
          <div>
            <label class="block text-sm font-semibold">6. Which sport(s) do you play? *</label>
            <div class="mt-2 grid grid-cols-2 gap-2 text-sm">
              ${["E-Sports","Football","Omweso","Ludo","Draughts","Scrabble","Chess","Darts","Woodball","Pool Table","Table Tennis","Badminton","Rugby","Handball","Volleyball"].map(s=>`<label class="flex items-center gap-2 border rounded-lg px-3 py-2 bg-white"><input type="checkbox" name="sports" value="${s}"> ${s}</label>`).join('')}
            </div>
            <input type="text" id="otherSport" placeholder="Other sport (specify)" class="mt-2 w-full border rounded-lg px-3 py-2">
          </div>
          <div><label class="block text-sm font-semibold">7. If you selected Football, what position do you play?</label><select name="football_position" class="mt-1 w-full border rounded-lg px-3 py-2"><option value="">-- select --</option><option>Striker</option><option>Attacking Midfielder</option><option>Winger</option><option>Central Midfielder</option><option>Full Back</option><option>Goalkeeper</option><option>Defensive Midfielder</option><option>Centre Back</option></select></div>
          <div><label class="block text-sm font-semibold">8. For other sports, state your position/event/category.</label><input name="other_position" type="text" placeholder="e.g. Chess - Open category" class="mt-1 w-full border rounded-lg px-3 py-2"></div>
        </div>
        <button type="submit" id="btn" class="mt-6 w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow">Submit Registration</button>
        <p id="msg" class="text-sm mt-3 text-center"></p>
      </form>
    </div>
  </div>
  <p class="text-center text-xs text-slate-500 mt-4">One submission per token. Alumni or non-enrolled students cannot submit even with a valid university email.</p>
</div>
<script>
const token="${escapeHtml(token)}";
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
  if(r.ok){
    sendMsg.innerHTML='Code sent. '+(j.demo_otp?'<b>Demo code: '+j.demo_otp+'</b> (in production this is emailed)':'Check your email.');
    sendMsg.style.color='green'; otpRow.classList.remove('hidden');
  } else { sendMsg.textContent=j.error||'Error'; sendMsg.style.color='crimson'; }
  sendBtn.disabled=false;
});
verifyBtn.addEventListener('click', async ()=>{
  const email=emailEl.value.trim(), otp=otpEl.value.trim();
  if(!otp){ verifyMsg.textContent='Enter code.'; verifyMsg.style.color='crimson'; return; }
  verifyBtn.disabled=true; verifyMsg.textContent='Verifying...';
  const r=await fetch('/api/auth/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,email,otp})});
  const j=await r.json();
  if(r.ok){
    verifyMsg.textContent='Verified! You can now fill the form.'; verifyMsg.style.color='green';
    document.getElementById('verifiedEmail').value=email;
    verifyBox.classList.add('opacity-50'); form.classList.remove('hidden'); window.scrollTo({top:form.offsetTop,behavior:'smooth'});
  } else { verifyMsg.textContent=j.error||'Invalid code'; verifyMsg.style.color='crimson'; }
  verifyBtn.disabled=false;
});
form.addEventListener('submit', async e=>{
  e.preventDefault();
  const fd=new FormData(form);
  const sports=[...form.querySelectorAll('input[name=sports]:checked')].map(c=>c.value);
  const other=document.getElementById('otherSport').value.trim();
  if(other) sports.push(other);
  if(!sports.length){ document.getElementById('msg').textContent='Select at least one sport.'; return; }
  const body={token:fd.get('token'), email:fd.get('email'), full_name:fd.get('full_name'), reg_number:fd.get('reg_number'), gender:fd.get('gender'), phone:fd.get('phone'), year_of_study:fd.get('year_of_study'), sports, football_position:fd.get('football_position'), other_position:fd.get('other_position')};
  document.getElementById('btn').disabled=true; document.getElementById('msg').textContent='Submitting...';
  const r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(r.ok){ form.innerHTML='<div class="text-center py-8"><div class="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto text-2xl">✓</div><h2 class="text-2xl font-bold mt-4">Registration submitted!</h2><p class="text-slate-600 mt-2">Thank you for registering for the Dean\\'s Cup 2026.</p></div>'; }
  else { document.getElementById('msg').textContent=j.error||'Error'; document.getElementById('msg').style.color='crimson'; document.getElementById('btn').disabled=false; }
});
</script>
</body></html>`;
}
