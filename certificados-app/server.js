// server.js — Certificados directo a Shopify con auto-instalación OFFLINE
// y redirección a host canónico para evitar fallas de cookie en OAuth.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LATEST_API_VERSION, LogSeverity } from '@shopify/shopify-api';
import { SQLiteSessionStorage } from '@shopify/shopify-app-session-storage-sqlite';

// ---------- ENV ----------
const PORT   = Number(process.env.PORT || 3001);
const BRAND  = process.env.BRAND_NAME || 'Ritmo de Rever';
const VERIFY_BASE = (process.env.VERIFY_BASE || '').replace(/\/$/, '') || 'https://example.com';

const APP_HOST_RAW = (process.env.SHOPIFY_APP_HOST || '').trim().replace(/\/+$/, '');
const HOST_NAME = APP_HOST_RAW.replace(/^https?:\/\//, '');
const HOST_SCHEME = APP_HOST_RAW.startsWith('https') ? 'https' : 'http';

const DEFAULT_SHOP = process.env.DEFAULT_SHOP || '';
const SCOPES = (process.env.SHOPIFY_SCOPES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DB_PATH = (process.env.SESSION_DB_PATH || './tmp/shopify_sessions.sqlite').trim();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sessionStorage = new SQLiteSessionStorage(DB_PATH);

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: SCOPES,
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: false,
  hostName: HOST_NAME,
  hostScheme: HOST_SCHEME,
  sessionStorage,
  logger: { level: LogSeverity.Info },
});

console.log('[SHOPIFY CONFIG]', {
  APP_HOST_RAW, HOST_NAME,
  hasKey: !!process.env.SHOPIFY_API_KEY,
  hasSecret: !!process.env.SHOPIFY_API_SECRET,
  scopes: SCOPES,
  dbPath: DB_PATH,
  defaultShop: DEFAULT_SHOP,
});

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ---------- Redirección a host canónico ----------
app.use((req, res, next) => {
  const expectedHost = HOST_NAME;     // derivado de SHOPIFY_APP_HOST
  const expectedScheme = HOST_SCHEME; // 'https' o 'http'
  if (expectedHost && req.headers.host !== expectedHost) {
    const to = `${expectedScheme}://${expectedHost}${req.originalUrl}`;
    return res.redirect(301, to);
  }
  next();
});

// ---------- Helpers ----------
const isValidShop = (shop) => /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(String(shop||''));
const detectShop = (req) => (req.query.shop || req.body?.shop || DEFAULT_SHOP || '').toString();

function setReturnToCookie(res, url) {
  const isHttps = HOST_SCHEME === 'https';
  res.cookie('return_to', url || '/', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    path: '/',
    maxAge: 5 * 60 * 1000,
  });
}
function popReturnToCookie(req, res) {
  const v = req.cookies?.return_to || '/';
  res.clearCookie('return_to', { path: '/' });
  return v;
}

// Si hay offline la devuelve; si no, inicia OAuth y devuelve null (ya respondió).
async function getOrInstallOfflineSession(req, res) {
  const shop = detectShop(req);
  if (!isValidShop(shop)) {
    res.status(400).send('Configura DEFAULT_SHOP o pasa ?shop=xxx.myshopify.com');
    return null;
  }
  const offlineId = shopify.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(offlineId);
  if (session) return session;

  setReturnToCookie(res, req.originalUrl || '/');
  await shopify.auth.begin({
    shop,
    callbackPath: '/shopify/auth/offline/callback',
    isOnline: false,
    rawRequest: req,
    rawResponse: res,
  });
  return null;
}

// Código determinístico de certificado
function genCode({ orderId, lineItemId, unitIndex }) {
  const raw = `${orderId}|${lineItemId}|${unitIndex}`;
  return 'RR-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10).toUpperCase();
}

// Trae la orden con imágenes (GraphQL)
async function fetchOrderWithImages(session, { orderId, orderName }) {
  const gql = new shopify.clients.Graphql({ session });

  let gid = null;
  if (orderId) {
    gid = String(orderId).startsWith('gid://') ? String(orderId) : `gid://shopify/Order/${orderId}`;
  } else if (orderName) {
    const r = await gql.query({
      data: {
        query: `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id } } } }`,
        variables: { q: `name:${orderName}` },
      },
    });
    gid = r?.body?.data?.orders?.edges?.[0]?.node?.id || null;
  }
  if (!gid) throw new Error('No se pudo resolver el ID de la orden');

  const data = await gql.query({
    data: {
      query: `
        query($id:ID!){
          order(id:$id){
            id name createdAt currencyCode
            lineItems(first:100){
              edges{
                node{
                  id title sku quantity
                  variant{
                    id
                    image{ url }
                    product{ featuredImage{ url } }
                  }
                }
              }
            }
          }
        }`,
      variables: { id: gid },
    },
  });

  const order = data?.body?.data?.order;
  if (!order) throw new Error('Orden no encontrada');
  return order;
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'image/avif,image/webp,image/*,*/*' } });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('jpeg') && !ct.includes('jpg') && !ct.includes('png')) return null; // PDFKit soporta JPG/PNG
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

async function drawCertPage({ doc, brand, orderName, code, title, sku, unitIndex, titular, imageUrl }) {
  // Marco
  doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(1.2).strokeColor('#C6C6C6').stroke();

  // Encabezado
  doc.fontSize(12).fillColor('#6B7280').text(brand, { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(22).fillColor('#111827').text('CERTIFICADO DE AUTENTICIDAD', { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor('#4B5563').text(`Orden: ${orderName} · Código: ${code}`, { align: 'center' });

  const bodyX = 60, bodyW = doc.page.width - bodyX*2;
  doc.moveDown(1);
  doc.fontSize(12).fillColor('#111827')
     .text('Se certifica que la siguiente pieza pertenece a la colección:', bodyX, 200, { width: bodyW, align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(18).text(`“${title || ''}”`, { width: bodyW, align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(12).text(`SKU: ${sku || '-'}`, { width: bodyW, align: 'center' });
  doc.moveDown(0.2);
  doc.text(`Pieza / Unidad: ${unitIndex}`, { width: bodyW, align: 'center' });
  if (titular) { doc.moveDown(0.4); doc.text(`Titular: ${titular}`, { width: bodyW, align: 'center' }); }

  // Imagen
  const imgBuf = await fetchImageBuffer(imageUrl);
  const imgW = 360, imgH = 260;
  const imgX = (doc.page.width - imgW) / 2;
  const imgY = 340;
  doc.rect(imgX, imgY, imgW, imgH).strokeColor('#D1D5DB').lineWidth(0.8).stroke();
  if (imgBuf) {
    try { doc.image(imgBuf, imgX, imgY, { fit: [imgW, imgH], align: 'center', valign: 'center' }); } catch {}
  } else {
    doc.fontSize(10).fillColor('#6B7280').text('Imagen no disponible o formato no soportado', imgX, imgY + imgH/2 - 6, { width: imgW, align: 'center' });
  }

  // QR
  const verifyUrl = `${VERIFY_BASE}/certificados?code=${encodeURIComponent(code)}`;
  const qrBuf = await QRCode.toBuffer(verifyUrl, { margin: 0, scale: 6 });
  const qrSize = 120, qrX = (doc.page.width - qrSize)/2, qrY = imgY + imgH + 16;
  doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
  doc.fontSize(9).fillColor('#6B7280').text(verifyUrl, 50, qrY + qrSize + 6, { width: doc.page.width-100, align: 'center' });

  // Firmas
  const ySign = 720, col1 = 90, col2 = doc.page.width - 290;
  doc.moveTo(col1, ySign).lineTo(col1+200, ySign).strokeColor('#9CA3AF').lineWidth(0.8).stroke();
  doc.fontSize(10).fillColor('#4B5563').text('Dirección de Arte', col1, ySign + 6, { width: 200, align: 'center' });
  doc.moveTo(col2, ySign).lineTo(col2+200, ySign).strokeColor('#9CA3AF').lineWidth(0.8).stroke();
  doc.fontSize(10).fillColor('#4B5563').text('Curaduría', col2, ySign + 6, { width: 200, align: 'center' });
}

// ---------- OAuth OFFLINE ----------
app.get('/shopify/auth/offline', async (req, res) => {
  try {
    const shop = detectShop(req);
    if (!isValidShop(shop)) return res.status(400).send('Missing or invalid ?shop=xxx.myshopify.com');
    setReturnToCookie(res, req.get('referer') || '/');
    await shopify.auth.begin({
      shop,
      callbackPath: '/shopify/auth/offline/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (e) {
    console.error('OFFLINE AUTH BEGIN ERROR:', e);
    res.status(500).send('Offline auth start failed: ' + (e?.message || e));
  }
});

app.get('/shopify/auth/offline/callback', async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({ rawRequest: req, rawResponse: res });
    await shopify.config.sessionStorage.storeSession(session);
    const back = popReturnToCookie(req, res);
    res.redirect(back || '/');
  } catch (e) {
    console.error('OFFLINE AUTH CALLBACK ERROR:', e);
    res.status(400).send('Offline auth callback failed: ' + (e?.message || e));
  }
});

// ---------- UI ----------
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="es"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${BRAND} — Generar certificados</title>
<style>
  :root{ color-scheme: light dark }
  body{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
  .card{ max-width: 760px; margin: 0 auto; border:1px solid #ddd; border-radius: 16px; padding: 18px; }
  input,button{ padding:10px; border-radius:10px; border:1px solid #ccc; width:100%; }
  label{ font-size: 13px; color:#666 }
  .row{ display:grid; grid-template-columns: 1fr; gap:10px; margin:10px 0; }
  @media (min-width: 640px){ .row-2{ grid-template-columns: 1fr 1fr } }
  .btn{ background:#111; color:#fff; cursor:pointer }
  .muted{ color:#666; font-size: 13px }
</style>
<div class="card">
  <h1 class="h4">Generar certificados (PDF) por orden</h1>
  <p class="muted">Ingresa el número de orden (ej. <b>#1001</b>) y el <b>nombre del titular</b> que debe aparecer.</p>
  <form method="POST" action="/generate">
    <div class="row">
      <div>
        <label>Número de orden</label>
        <input name="order_name" placeholder="#1001" required />
      </div>
      <div>
        <label>Nombre del titular</label>
        <input name="titular" placeholder="Nombre Apellido" required />
      </div>
    </div>
    <div class="row">
      <button class="btn" type="submit">Generar PDF</button>
    </div>
    <p class="muted">Si es la primera vez, te pediremos conectar la tienda <b>${DEFAULT_SHOP || '(definir DEFAULT_SHOP)'}</b> y volverás aquí automáticamente.</p>
  </form>
</div>
</html>`);
});

// ---------- Generar PDF ----------
app.post('/generate', async (req, res) => {
  try {
    const session = await getOrInstallOfflineSession(req, res);
    if (!session) return;

    let orderName = String(req.body?.order_name || '').trim();
    const titular = String(req.body?.titular || '').trim();
    if (!orderName) return res.status(400).send('Falta order_name');
    if (!titular)   return res.status(400).send('Falta titular');
    if (!orderName.startsWith('#')) orderName = '#' + orderName;

    const order = await fetchOrderWithImages(session, { orderName });

    const safeName = String(order.name || 'orden').replace(/[^a-z0-9]+/gi, '-');
    const fname = `Certificados-${safeName}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    let firstPage = true;
    for (const edge of (order.lineItems?.edges || [])) {
      const li = edge.node;
      const img = li?.variant?.image?.url || li?.variant?.product?.featuredImage?.url || null;
      const qty = Math.max(1, Number(li.quantity || 1));
      for (let i = 1; i <= qty; i++) {
        const code = genCode({ orderId: order.id, lineItemId: li.id, unitIndex: i });
        if (!firstPage) doc.addPage();
        await drawCertPage({
          doc,
          brand: BRAND,
          orderName: order.name,
          code,
          title: li.title,
          sku: li.sku || '',
          unitIndex: i,
          titular,
          imageUrl: img,
        });
        firstPage = false;
      }
    }

    doc.end();
  } catch (e) {
    console.error('[POST /generate] error:', e);
    res.status(e.status || 500).send('Error: ' + (e?.message || e));
  }
});

// ---------- Link directo ----------
app.get('/order-pdf', async (req, res) => {
  try {
    const session = await getOrInstallOfflineSession(req, res);
    if (!session) return;

    const titular = String(req.query?.titular || '').trim();
    const orderName = String(req.query?.order_name || '').trim();
    const orderId = String(req.query?.order_id || '').trim() || null;
    if (!orderName && !orderId) return res.status(400).send('Falta order_name u order_id');
    if (!titular) return res.status(400).send('Falta titular');

    const order = await fetchOrderWithImages(session, { orderId, orderName });

    const safeName = String(order.name || 'orden').replace(/[^a-z0-9]+/gi, '-');
    const fname = `Certificados-${safeName}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    let first = true;
    for (const edge of (order.lineItems?.edges || [])) {
      const li = edge.node;
      const img = li?.variant?.image?.url || li?.variant?.product?.featuredImage?.url || null;
      const qty = Math.max(1, Number(li.quantity || 1));
      for (let i = 1; i <= qty; i++) {
        const code = genCode({ orderId: order.id, lineItemId: li.id, unitIndex: i });
        if (!first) doc.addPage();
        await drawCertPage({
          doc,
          brand: BRAND,
          orderName: order.name,
          code,
          title: li.title,
          sku: li.sku || '',
          unitIndex: i,
          titular,
          imageUrl: img,
        });
        first = false;
      }
    }
    doc.end();
  } catch (e) {
    console.error('[GET /order-pdf] error:', e);
    res.status(e.status || 500).send('Error: ' + (e?.message || e));
  }
});

// ---------- Diag ----------
app.get('/diag', (_req, res) => {
  res.json({
    host: APP_HOST_RAW || null,
    hostName: HOST_NAME,
    hasKey: !!process.env.SHOPIFY_API_KEY,
    hasSecret: !!process.env.SHOPIFY_API_SECRET,
    scopes: SCOPES,
    defaultShop: DEFAULT_SHOP,
    dbPath: DB_PATH,
  });
});

// ---------- Start ----------
app.get('/healthz', (_req, res) => res.send('ok'));
app.listen(PORT, () => console.log(`✅ Certificados app en ${HOST_SCHEME}://${HOST_NAME || 'localhost'}:${HOST_NAME ? '' : PORT}`));
