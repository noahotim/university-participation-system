const nodemailer = require('nodemailer');

let transporter = null;

function provider() {
  const p = (process.env.EMAIL_PROVIDER || '').toLowerCase();
  if (p) return p;
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.EMAIL_API_KEY) return 'sendgrid';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return '';
}

function apiKey() {
  return process.env.BREVO_API_KEY || process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY || process.env.EMAIL_API_KEY || '';
}

function isConfigured() {
  const p = provider();
  if (!p) return false;
  if (p === 'smtp') return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  return !!apiKey();
}

function parseFrom() {
  const raw = process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || '';
  const m = String(raw).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || 'Notifications', email: m[2].trim() };
  return { name: process.env.APP_NAME || 'Notifications', email: String(raw).trim() };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function deliver({ to, subject, html, text }) {
  const p = provider();
  const from = parseFrom();

  if (p === 'brevo') {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey(), 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: from.name, email: from.email }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
    });
    if (!r.ok) throw new Error('Brevo API ' + r.status + ': ' + (await r.text()).slice(0, 300));
    return;
  }

  if (p === 'sendgrid') {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from.email, name: from.name }, subject, content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }] })
    });
    if (!r.ok) throw new Error('SendGrid API ' + r.status + ': ' + (await r.text()).slice(0, 300));
    return;
  }

  if (p === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from.name + ' <' + from.email + '>', to: [to], subject, html, text })
    });
    if (!r.ok) throw new Error('Resend API ' + r.status + ': ' + (await r.text()).slice(0, 300));
    return;
  }

  if (p === 'smtp') {
    if (!transporter) {
      const port = parseInt(process.env.SMTP_PORT || '587', 10);
      const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port, secure,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
      });
    }
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
    return;
  }

  throw new Error('No email provider configured');
}

async function sendOtp(to, otp, ctx = {}) {
  const product = process.env.APP_NAME || 'University Participation System';
  const eventTitle = ctx.eventTitle || '';
  const subject = `${otp} is your verification code` + (eventTitle ? ` for ${eventTitle}` : '');
  const text = `Your verification code is ${otp}. It expires in 10 minutes. Never share this code with anyone.`;
  const html = `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;background:#f5f7fb;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:linear-gradient(90deg,#4f46e5,#7c3aed);color:#fff;padding:20px 24px">
      <h2 style="margin:0;font-size:18px">${esc(eventTitle || product)}</h2>
      <p style="margin:4px 0 0;opacity:.9;font-size:13px">Email verification</p>
    </div>
    <div style="padding:24px">
      <p>Hello,</p>
      <p>Use this one-time code to verify your email and continue your registration. It expires in <b>10 minutes</b>.</p>
      <div style="text-align:center;margin:24px 0">
        <span style="display:inline-block;font-size:32px;letter-spacing:8px;font-weight:700;color:#111;background:#f3f4f6;border-radius:10px;padding:12px 20px">${otp}</span>
      </div>
      <p style="color:#6b7280;font-size:13px">If you did not request this, you can safely ignore this email. Never share this code with anyone.</p>
    </div>
    <div style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">${esc(product)}</div>
  </div>
</body></html>`;
  await deliver({ to, subject, html, text });
}

module.exports = { isConfigured, sendOtp, provider };
