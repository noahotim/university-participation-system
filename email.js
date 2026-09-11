const nodemailer = require('nodemailer');

let transporter = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
  return transporter;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendOtp(to, otp, ctx = {}) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
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
  await getTransporter().sendMail({ from, to, subject, text, html });
}

module.exports = { isConfigured, sendOtp };
