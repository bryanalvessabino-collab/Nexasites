import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'nexasites.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, niche TEXT NOT NULL, html TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, place_id TEXT NOT NULL, name TEXT NOT NULL, address TEXT, phone TEXT, website TEXT, maps_url TEXT, niche TEXT, city TEXT, created_at TEXT NOT NULL, UNIQUE(owner_id, place_id));
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider_id TEXT NOT NULL UNIQUE, plan TEXT NOT NULL, amount REAL NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscriptions (owner_id TEXT PRIMARY KEY, plan TEXT NOT NULL, payment_id TEXT NOT NULL, activated_at TEXT NOT NULL);
`);
const plans = { Starter: 49, Pro: 99, Agency: 199 };
function owner(req) {
  const value = String(req.header('x-owner-id') || req.query.owner || '');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw Object.assign(new Error('Identificador de usuário inválido. Recarregue a página.'), { status: 400 });
  return value;
}
function fail(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor. Verifique as configurações e os logs.' : error.message });
}
app.get('/api/health', (_req, res) => res.json({ ok: true, services: { database: true, leads: Boolean(process.env.GOOGLE_MAPS_API_KEY), ai: Boolean(process.env.OPENAI_API_KEY), pix: Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN) } }));

app.post('/api/leads/search', async (req, res) => {
  try {
    const user = owner(req);
    if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(503).json({ error: 'Integração de leads não configurada: adicione GOOGLE_MAPS_API_KEY ao .env.' });
    const city = String(req.body.city || '').trim().slice(0, 100);
    const state = String(req.body.state || '').trim().slice(0, 80);
    const niche = String(req.body.niche || '').trim().slice(0, 80);
    const quantity = Math.max(1, Math.min(60, Number.parseInt(req.body.quantity, 10) || 20));
    if (!city) return res.status(400).json({ error: 'Informe a cidade.' });
    const query = [niche, 'em', city, state, 'Brasil'].filter(Boolean).join(' ');
    let token = undefined; const found = []; const seen = new Set();
    for (let page = 0; page < 3 && found.length < quantity; page++) {
      const body = { textQuery: query, pageSize: Math.min(20, quantity - found.length), languageCode: 'pt-BR', regionCode: 'BR' };
      if (token) body.pageToken = token;
      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,nextPageToken' }, body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error?.message || 'A API do Google Places recusou a busca.'), { status: 502 });
      for (const place of data.places || []) {
        if (!place.id || seen.has(place.id)) continue;
        seen.add(place.id);
        found.push({ placeId: place.id, name: place.displayName?.text || 'Empresa sem nome', address: place.formattedAddress || '', phone: place.nationalPhoneNumber || '', website: place.websiteUri || '', mapsUrl: place.googleMapsUri || '' });
        if (found.length >= quantity) break;
      }
      token = data.nextPageToken;
      if (!token) break;
      if (page < 2) await new Promise(resolve => setTimeout(resolve, 2200));
    }
    const insert = db.prepare(`INSERT INTO leads(id,owner_id,place_id,name,address,phone,website,maps_url,niche,city,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,place_id) DO UPDATE SET name=excluded.name,address=excluded.address,phone=excluded.phone,website=excluded.website,maps_url=excluded.maps_url,created_at=excluded.created_at`);
    const now = new Date().toISOString();
    const transaction = db.transaction(rows => rows.forEach(p => insert.run(crypto.randomUUID(), user, p.placeId, p.name, p.address, p.phone, p.website, p.mapsUrl, niche, city, now)));
    transaction(found);
    res.json({ leads: found.map(p => ({ name: p.name, address: p.address, phone: p.phone, website: p.website, mapsUrl: p.mapsUrl })), total: found.length, source: 'Google Places', note: 'Ausência de site listado não garante que a empresa não tenha site.' });
  } catch (e) { fail(res, e); }
});

app.post('/api/sites/generate', async (req, res) => {
  try {
    const user = owner(req);
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Gerador de sites não configurado: adicione OPENAI_API_KEY ao .env.' });
    const input = {
      name: String(req.body.name || '').trim().slice(0, 120), niche: String(req.body.niche || '').trim().slice(0, 100),
      location: String(req.body.location || '').trim().slice(0, 150), whatsapp: String(req.body.whatsapp || '').trim().slice(0, 40),
      style: String(req.body.style || 'Moderno e Tecnológico').slice(0, 100), goal: String(req.body.goal || '').trim().slice(0, 1000)
    };
    if (!input.name || !input.niche) return res.status(400).json({ error: 'Informe nome e nicho da empresa.' });
    const prompt = `Crie um site comercial completo, bonito, responsivo e pronto para pré-visualização, em português brasileiro, para o negócio descrito. Responda APENAS com HTML completo, sem Markdown. Use CSS no próprio HTML, acessibilidade, layout mobile-first, CTA claro e textos realistas sem inventar depoimentos, certificações, endereço, preços ou promessas. Não inclua scripts externos nem código de rastreamento. Escape corretamente os dados fornecidos.\nNegócio: ${JSON.stringify(input.name)}\nNicho: ${JSON.stringify(input.niche)}\nLocal: ${JSON.stringify(input.location)}\nWhatsApp: ${JSON.stringify(input.whatsapp)}\nEstilo: ${JSON.stringify(input.style)}\nObjetivo: ${JSON.stringify(input.goal)}\nSe houver WhatsApp, crie botão com link https://wa.me/ somente com dígitos do número; se faltar, não invente contato.`;
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.7, messages: [{ role: 'system', content: 'Você é um desenvolvedor web sênior. Retorne somente um documento HTML seguro e completo.' }, { role: 'user', content: prompt }] }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'A API de IA recusou a solicitação.'), { status: 502 });
    let html = String(data.choices?.[0]?.message?.content || '').trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
    if (!/^<!doctype html/i.test(html) && !/^<html/i.test(html)) throw Object.assign(new Error('A IA não retornou um documento HTML válido. Tente novamente.'), { status: 502 });
    // Remove inline JavaScript and external scripts; generated previews should not execute arbitrary JS.
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '').replace(/javascript:/gi, '');
    const id = crypto.randomUUID(); const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO projects(id,owner_id,name,niche,html,created_at) VALUES(?,?,?,?,?,?)').run(id, user, input.name, input.niche, html, createdAt);
    res.json({ project: { id, name: input.name, niche: input.niche, createdAt, url: `/sites/${id}` } });
  } catch (e) { fail(res, e); }
});
app.get('/api/projects', (req, res) => {
  try { const user = owner(req); const projects = db.prepare('SELECT id,name,niche,created_at AS createdAt FROM projects WHERE owner_id=? ORDER BY created_at DESC').all(user); res.json({ projects }); }
  catch (e) { fail(res, e); }
});
app.get('/sites/:id', (req, res) => {
  try { const user = owner(req); const project = db.prepare('SELECT html FROM projects WHERE id=? AND owner_id=?').get(req.params.id, user); if (!project) return res.status(404).send('Projeto não encontrado para este navegador.'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Security-Policy', "default-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data:; script-src 'none'; object-src 'none'; frame-ancestors 'self'"); res.send(project.html); }
  catch (e) { res.status(e.status || 400).send(e.message); }
});

app.post('/api/payments/create', async (req, res) => {
  try {
    const user = owner(req);
    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) return res.status(503).json({ error: 'PIX não configurado: adicione MERCADOPAGO_ACCESS_TOKEN ao .env.' });
    const plan = String(req.body.plan || ''); const amount = Number(req.body.amount); const email = String(req.body.email || '').trim();
    if (!plans[plan] || amount !== plans[plan]) return res.status(400).json({ error: 'Plano ou valor inválido.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    const internalId = crypto.randomUUID(); const now = new Date().toISOString();
    const payload = { transaction_amount: amount, description: `NexaSites AI - Plano ${plan}`, payment_method_id: 'pix', payer: { email }, external_reference: internalId, metadata: { owner_id: user, plan }, ...(process.env.PUBLIC_BASE_URL ? { notification_url: `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/payments/webhook` } : {}) };
    const response = await fetch('https://api.mercadopago.com/v1/payments', { method: 'POST', headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': internalId }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message || data.error || 'Mercado Pago não conseguiu criar a cobrança.'), { status: 502 });
    db.prepare('INSERT INTO payments(id,owner_id,provider_id,plan,amount,email,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(internalId, user, String(data.id), plan, amount, email, data.status || 'pending', now, now);
    res.json({ paymentId: String(data.id), status: data.status || 'pending', qrCodeBase64: data.point_of_interaction?.transaction_data?.qr_code_base64 || '', qrCode: data.point_of_interaction?.transaction_data?.qr_code || '', ticketUrl: data.point_of_interaction?.transaction_data?.ticket_url || '' });
  } catch (e) { fail(res, e); }
});
async function refreshPayment(providerId) {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) throw Object.assign(new Error('PIX não configurado no servidor.'), { status: 503 });
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(providerId)}`, { headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` } });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.message || 'Falha ao consultar pagamento no provedor.'), { status: 502 });
  const payment = db.prepare('SELECT * FROM payments WHERE provider_id=?').get(String(providerId));
  if (!payment || data.external_reference !== payment.id || Number(data.transaction_amount) !== payment.amount) throw Object.assign(new Error('Pagamento não corresponde à cobrança registrada.'), { status: 403 });
  const now = new Date().toISOString();
  db.prepare('UPDATE payments SET status=?,updated_at=? WHERE provider_id=?').run(data.status || 'pending', now, String(providerId));
  if (data.status === 'approved') db.prepare('INSERT INTO subscriptions(owner_id,plan,payment_id,activated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET plan=excluded.plan,payment_id=excluded.payment_id,activated_at=excluded.activated_at').run(payment.owner_id, payment.plan, payment.id, now);
  return { status: data.status || 'pending', plan: payment.plan };
}
app.get('/api/payments/:id', async (req, res) => {
  try { const user = owner(req); const payment = db.prepare('SELECT * FROM payments WHERE provider_id=? AND owner_id=?').get(String(req.params.id), user); if (!payment) return res.status(404).json({ error: 'Cobrança não encontrada.' }); const status = await refreshPayment(payment.provider_id); res.json(status); }
  catch (e) { fail(res, e); }
});
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const paymentId = req.query['data.id'] || req.body?.data?.id || req.body?.id;
    if (!paymentId) return res.status(400).send('missing payment id');
    await refreshPayment(String(paymentId)); res.status(200).send('ok');
  } catch (e) { console.error('Webhook PIX:', e.message); res.status(200).send('received'); }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`NexaSites AI rodando em http://localhost:${port}`));
