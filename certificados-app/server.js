// server.js — App de certificados usando la app principal para consultar órdenes
import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import fetch from 'node-fetch';
import sizeOf from 'image-size';

dotenv.config({ path: path.join(process.cwd(), '.env') });

// ---------- CONFIG ----------
const PORT = Number(process.env.PORT || 3001);
const BRAND = process.env.BRAND_NAME || 'RITMODEREVER';
const DEFAULT_SHOP = process.env.DEFAULT_SHOP || '';
const APP_PRINCIPAL_URL = process.env.SHOPIFY_APP_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!APP_PRINCIPAL_URL) throw new Error('Debe definir SHOPIFY_APP_URL en .env');
if (!INTERNAL_API_KEY) throw new Error('Debe definir INTERNAL_API_KEY en .env');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Servir archivos estáticos (CSS, JS, imágenes, etc.) desde la carpeta 'public'
app.use(express.static(path.join(process.cwd(), 'public')));

// ---------- HELPERS ----------
const isValidShop = (shop) =>
  /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(String(shop || ''));

// Consulta a la app principal para obtener los datos de la orden
async function fetchOrderFromAppPrincipal(shop, orderName) {
  if (!shop || !orderName) throw new Error('shop y orderName son requeridos');
  const url = new URL('/api/order-data', APP_PRINCIPAL_URL);
  url.searchParams.set('shop', shop);
  url.searchParams.set('order_name', orderName);

  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': INTERNAL_API_KEY },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Error al consultar app principal: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  if (!data.ok || !data.data) throw new Error('No se obtuvo la orden desde la app principal');
  return data.data;
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    console.warn('Error fetch image:', e.message);
    return null;
  }
}

async function drawCertPage({ doc, titular, order }) {
  const headerPath = path.join(process.cwd(), 'assets', 'header.png');
  const footerPath = path.join(process.cwd(), 'assets', 'footer.png');
  const signaturePath = path.join(process.cwd(), 'assets', 'firma.png');

  if (fs.existsSync(headerPath)) {
    doc.image(headerPath, 0, 0, { width: doc.page.width });
  }
  if (fs.existsSync(footerPath)) {
    doc.image(footerPath, 0, doc.page.height - 80, { width: doc.page.width, height: 80 });
  }

  doc.y = 140;

  doc.font('Helvetica-Bold').fontSize(28).fillColor('#2c3e50')
    .text('CERTIFICADO DE AUTENTICIDAD', { align: 'center' });
  doc.moveDown(2);

  doc.font('Helvetica').fontSize(15).fillColor('#34495e')
    .text(`Se certifica la autenticidad de:`, { align: 'center' });
  doc.moveDown(1);
  
  const lineItem = order?.lineItems?.edges?.[0]?.node;
  const productName = lineItem?.title || 'Producto sin título';
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#111827')
    .text(productName, { align: 'center' });
  doc.moveDown(1.5);
  
  doc.font('Helvetica').fontSize(14).fillColor('#5c6a78')
    .text(`A nombre de: ${titular}`, { align: 'center' });
  doc.moveDown(3);

  const imageY = doc.y;

  if (lineItem && lineItem.variant?.image?.url) {
    const productImageUrl = lineItem.variant.image.url;
    const imgBuf = await fetchImageBuffer(productImageUrl);

    if (imgBuf) {
      try {
        const fixedHeight = 100;
        
        const dimensions = sizeOf(imgBuf);
        
        // --- SALVAGUARDA CONTRA ERRORES ---
        // Se comprueba que las dimensiones sean válidas antes de calcular.
        if (dimensions && dimensions.width && dimensions.height > 0) {
            const scaledWidth = dimensions.width * (fixedHeight / dimensions.height);
            const xPos = (doc.page.width - scaledWidth) / 2;
            
            doc.image(imgBuf, xPos, imageY, { height: fixedHeight });
            doc.y = imageY + fixedHeight;
        } else {
            throw new Error('Dimensiones de imagen inválidas.');
        }

      } catch (e) {
        doc.y = imageY;
        console.warn('Error al dibujar la imagen:', e.message);
        doc.fontSize(10).fillColor('#e74c3c').text('Error al cargar la imagen del producto.', { align: 'center' });
        doc.y += 20; // Añade espacio para que el error sea visible.
      }
    } else {
        doc.fontSize(10).fillColor('#e74c3c').text('No se pudo cargar el buffer de la imagen.', { align: 'center' });
    }
  } else {
      doc.fontSize(10).fillColor('#e74c3c').text('No hay imagen de producto disponible.', { align: 'center' });
  }
  
  doc.moveDown(3);

  doc.font('Helvetica').fontSize(12).fillColor('#34495e')
    .text(`Artista: Juliana Revelo`, { align: 'center' });
  doc.moveDown(0.5);
  doc.text(`Fecha de emisión: ${new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'center' });

  const signatureBlockY = doc.page.height - 190;
  const signatureImageHeight = 50;
  const spaceBetween = 8;

  if (fs.existsSync(signaturePath)) {
    try {
      const signatureWidth = 150;
      const signatureX = (doc.page.width - signatureWidth) / 2;

      doc.image(signaturePath, signatureX, signatureBlockY, {
        width: signatureWidth,
        height: signatureImageHeight,
      });

      const nameY = signatureBlockY + signatureImageHeight + spaceBetween;
      doc.y = nameY;

      doc.font('Helvetica-Bold').fontSize(12).fillColor('#2c3e50')
         .text('Juliana Revelo', { align: 'center' });
    } catch (e) {
      doc.y = signatureBlockY;
      console.warn('Error al dibujar la firma:', e.message);
      doc.fontSize(10).fillColor('#e74c3c').text('Error al cargar la firma.', { align: 'center' });
    }
  }
}


// ---------- RUTAS ----------
app.get('/', (_req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html lang="es">
    <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${BRAND} — Generar Certificados</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
        <link rel="stylesheet" href="/css/style.css">
    </head>
    <body class="bg-light">
        <div class="container py-5">
            <div class="card shadow-lg p-4 p-md-5 mx-auto" style="max-width: 600px;">
                <div class="text-center mb-4">
                    <img src="assets/logo-ritmoderever.png" alt="${BRAND} Logo" class="img-fluid mb-3" style="max-height: 80px;">
                    <h1 class="card-title h3 mb-3 text-dark">${BRAND}</h1>
                    <p class="lead text-secondary">Generador de Certificados</p>
                </div>
                <form method="POST" action="/generate">
                    <div class="mb-3">
                        <label for="order_name" class="form-label">Número de orden:</label>
                        <input type="text" class="form-control" id="order_name" name="order_name" placeholder="Ej: #12345" required>
                    </div>
                    <div class="mb-4">
                        <label for="titular" class="form-label">Nombre del titular:</label>
                        <input type="text" class="form-control" id="titular" name="titular" placeholder="Ej: Juan Pérez" required>
                    </div>
                    <div class="d-grid gap-2">
                        <button type="submit" class="btn btn-dark btn-lg">Generar PDF</button>
                    </div>
                </form>
            </div>
            <p class="text-center text-muted mt-4">
                &copy; ${new Date().getFullYear()} ${BRAND}. Todos los derechos reservados.
            </p>
        </div>

        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>
        <script src="/js/scripts.js"></script>
    </body>
    </html>
  `);
});

app.post('/generate', async (req, res) => {
  try {
    const shop = req.body.shop || DEFAULT_SHOP;
    const orderName = String(req.body?.order_name || '').trim();
    const titular = String(req.body?.titular || '').trim();
    if (!orderName || !titular) {
      // Redirigir o mostrar un mensaje de error más amigable con Bootstrap
      return res.status(400).send(`
        <!doctype html>
        <html lang="es">
        <head>
            <meta charset="utf-8"/>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>${BRAND} — Error</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
            <link rel="stylesheet" href="/css/style.css">
        </head>
        <body class="bg-light d-flex align-items-center justify-content-center" style="min-height: 100vh;">
            <div class="card shadow-lg p-4 p-md-5 mx-auto text-center" style="max-width: 500px;">
                <img src="/assets/logo-ritmoderever.png" alt="${BRAND} Logo" class="img-fluid mb-3" style="max-height: 60px;">
                <h2 class="card-title h4 mb-3 text-dark">Error al generar certificado</h2>
                <p class="card-text text-secondary">Faltan datos en el formulario. Por favor, asegúrate de llenar todos los campos.</p>
                <a href="/" class="btn btn-dark mt-3">Volver al inicio</a>
            </div>
            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>
        </body>
        </html>
      `);
    }

    // --- Consulta la app principal ---
    const order = await fetchOrderFromAppPrincipal(shop, orderName);

    const safeName = (order?.name ?? orderName).replace(/[^a-z0-9]+/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Certificado-${safeName}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 0 }); // Margen 0 para controlar el diseño manualmente
    doc.pipe(res);
    await drawCertPage({ doc, titular, order });
    doc.end();
  } catch (e) {
    console.error('[POST /generate] error:', e);
    // Mostrar un mensaje de error más amigable con Bootstrap
    res.status(500).send(`
      <!doctype html>
      <html lang="es">
      <head>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${BRAND} — Error</title>
          <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
          <link rel="stylesheet" href="/css/style.css">
      </head>
      <body class="bg-light d-flex align-items-center justify-content-center" style="min-height: 100vh;">
          <div class="card shadow-lg p-4 p-md-5 mx-auto text-center" style="max-width: 500px;">
              <img src="/assets/logo-ritmoderever.png" alt="${BRAND} Logo" class="img-fluid mb-3" style="max-height: 60px;">
              <h2 class="card-title h4 mb-3 text-dark">Error al generar certificado</h2>
              <p class="card-text text-secondary">Ocurrió un error inesperado. Detalles: ${e?.message || e}</p>
              <a href="/" class="btn btn-dark mt-3">Volver al inicio</a>
          </div>
          <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>
      </body>
      </html>
    `);
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`✅ App certificados escuchando en http://localhost:${PORT}`));