# University Participation System - Dean's Cup 2026

General token-based survey & event registration system. Only currently-enrolled students with a personal token + email OTP can submit - one submission per student. Prevents alumni with still-valid university emails.

**Live:** Host on Render via `render.yaml` or run locally.

## Quick start (30 minutes)

1. Export `currently-enrolled.csv` from SIS: `reg_number,full_name,email`
2. Run locally: `npm install && npm start` -> `http://localhost:3002/admin.html` [key `admin123`]
3. Import CSV -> each row gets `https://your-domain/s?token=...`
4. Send each student only their link. Student: open link -> enter email -> receive 6-digit code -> verify -> fill 8 Dean's Cup questions -> submit.
5. Admin > Responses > charts + export CSV.

## Security

- No open link. Token is single-use. `used` flag + email OTP verification.
- We **never** ask for email password - only a one-time code sent to the email (demo code shown on screen; configure `SMTP_HOST` etc. for real email in production).
- Alumni with valid `@soroti.ac.ug` but not in CSV: `404 Invalid token`.

## Visualizations

Admin dashboard shows Chart.js: Year of Study, Gender, Sports popularity, Football positions, Timeline.

## Deploy to Render

1. Push to GitHub (see below).
2. Render > New > Blueprint > Connect repo > Apply `render.yaml`.
3. Set `ADMIN_KEY` to a strong value in Render Environment.
4. For Postgres: add Render Postgres and set `DATABASE_URL`.

## Env

```
PORT=3002
ADMIN_KEY=admin123
SQLITE_FILE=data/survey.db
# DATABASE_URL=postgres://user:pass@host:5432/db
# SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (for real OTP email)
```

## API

- `POST /api/admin/import` `{participants:[{reg_number,full_name,email}], event}`
- `GET /api/admin/stats?event=&key=`
- `POST /api/auth/request-otp` `{token,email}` -> `{demo_otp}` in demo
- `POST /api/auth/verify-otp` `{token,email,otp}`
- `POST /api/submit` `{token,email, ...survey fields}`
