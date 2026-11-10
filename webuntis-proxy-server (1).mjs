// Read-only WebUntis proxy for the school timetable app.
// Render start command: node server.mjs
// No WebUntis credentials are needed for the public timetable endpoint.
// Configure CORS_ORIGINS to the deployed app's origin in production (comma-separated).

import http from 'node:http';

const PORT = Number(process.env.PORT || 10000);
const SCHOOL = process.env.WEBUNTIS_SCHOOL || 'hh5842';
const ELEMENT_TYPE = process.env.WEBUNTIS_ELEMENT_TYPE || '1';
const ELEMENT_ID = process.env.WEBUNTIS_ELEMENT_ID || '1669';
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
const cache = new Map();
const buckets = new Map();

function headers(res, origin) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Vary', 'Origin');
  if (ALLOWED_ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, payload) {
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function monday(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString || '')) return null;
  const d = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateString) return null;
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function allowRequest(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.started >= RATE_WINDOW_MS) b = { started: now, count: 0 };
  b.count++;
  buckets.set(ip, b);
  if (buckets.size > 1000) {
    for (const [key, value] of buckets) if (now - value.started > RATE_WINDOW_MS) buckets.delete(key);
  }
  return b.count <= RATE_LIMIT;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  headers(res, origin);

  if (req.method === 'OPTIONS') {
    if (origin && !ALLOWED_ORIGINS.includes('*') && !ALLOWED_ORIGINS.includes(origin)) return send(res, 403, { error: 'Origin not allowed' });
    res.statusCode = 204;
    return res.end();
  }
  if (origin && !ALLOWED_ORIGINS.includes('*') && !ALLOWED_ORIGINS.includes(origin)) return send(res, 403, { error: 'Origin not allowed' });
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'webuntis-timetable-proxy' });
  if (url.pathname !== '/api/webuntis/week') return send(res, 404, { error: 'Not found' });
  if (!allowRequest(req)) return send(res, 429, { error: 'Zu viele Anfragen. Bitte kurz warten.' });

  const school = url.searchParams.get('school') || SCHOOL;
  const elementType = url.searchParams.get('elementType') || ELEMENT_TYPE;
  const elementId = url.searchParams.get('elementId') || ELEMENT_ID;
  const date = monday(url.searchParams.get('date'));

  // This service is deliberately fixed to the user's public class endpoint;
  // it is not an open URL proxy and cannot be used to fetch arbitrary hosts.
  if (school !== SCHOOL || elementType !== ELEMENT_TYPE || elementId !== ELEMENT_ID) {
    return send(res, 400, { error: 'Nur der konfigurierte WebUntis-Stundenplan ist freigegeben.' });
  }
  if (!date) return send(res, 400, { error: 'Ungültiges Datum. Erwartet wird YYYY-MM-DD.' });

  const key = `${school}:${elementType}:${elementId}:${date}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return send(res, 200, hit.data);

  const upstreamUrl = new URL(`https://${school}.webuntis.com/WebUntis/api/public/timetable/weekly/data`);
  upstreamUrl.search = new URLSearchParams({ elementType, elementId, date, formatId: '1' }).toString();
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(12000),
    });
    const body = await upstream.text();
    if (!upstream.ok) return send(res, 502, { error: `WebUntis antwortete mit HTTP ${upstream.status}.` });
    let data;
    try { data = JSON.parse(body); }
    catch { return send(res, 502, { error: 'WebUntis lieferte keine lesbare JSON-Antwort.' }); }
    if (data?.error || !data?.data?.result?.data?.elementPeriods) {
      return send(res, 502, { error: 'WebUntis lieferte keine Stundenplandaten für diese Woche.' });
    }
    cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
    return send(res, 200, data);
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? 'Zeitüberschreitung beim Abruf von WebUntis.' : 'WebUntis ist momentan nicht erreichbar.';
    return send(res, 502, { error: message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebUntis timetable proxy listening on ${PORT}`);
});
