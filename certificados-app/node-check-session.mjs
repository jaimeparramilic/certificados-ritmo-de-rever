 // check-session.mjs
import dotenv from 'dotenv';
dotenv.config();
import path from 'path';
import fs from 'fs';
import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';
import { SQLiteSessionStorage } from '@shopify/shopify-app-session-storage-sqlite';

const DB_PATH = (process.env.SESSION_DB_PATH || './tmp/shopify_sessions.sqlite').trim();
const SHOP = process.argv[2] || 'kueh0y-ib.myshopify.com';

console.log('=== check-session ===');
console.log('SESSION_DB_PATH:', DB_PATH);
console.log('SHOPIFY_API_KEY present?', !!process.env.SHOPIFY_API_KEY);
console.log('SHOPIFY_APP_HOST:', process.env.SHOPIFY_APP_HOST || '[missing]');
console.log('node cwd:', process.cwd());
console.log('file exists DB?', fs.existsSync(DB_PATH));
if (fs.existsSync(DB_PATH)) {
  const stat = fs.statSync(DB_PATH);
  console.log('DB owner/perm:', stat.uid, stat.gid, stat.mode.toString(8));
}

const sessionStorage = new SQLiteSessionStorage(DB_PATH);
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: process.env.SHOPIFY_API_VERSION || LATEST_API_VERSION,
  isEmbeddedApp: false,
  hostName: (process.env.SHOPIFY_APP_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  hostScheme: (process.env.SHOPIFY_APP_HOST || '').startsWith('https') ? 'https' : 'http',
  sessionStorage,
});

(async () => {
  try {
    const offlineId = shopify.session.getOfflineId(SHOP);
    console.log('Computed offlineId:', offlineId);

    // Intentar cargar usando el mismo sessionStorage
    const session = await shopify.config.sessionStorage.loadSession(offlineId);
    if (!session) {
      console.log('-> NO session found for offlineId:', offlineId);
    } else {
      console.log('-> session FOUND:');
      console.log({
        id: session.id,
        shop: session.shop,
        isOnline: session.isOnline,
        scope: session.scope,
        expires: session.expires,
      });
    }

    // También listar algunas filas de la tabla sessions (si sqlite3 no está instalado)
    try {
      const sqlite3 = await import('sqlite3');
      const Database = sqlite3.verbose().Database;
      const db = new Database(DB_PATH);
      db.serialize(() => {
        db.all("SELECT id, shop, isOnline, expires, length(data) as data_len FROM sessions LIMIT 50;", (err, rows) => {
          if (err) {
            console.warn('sqlite query failed:', err.message);
          } else {
            console.log('Sample sessions rows (up to 50):', rows);
          }
          db.close();
        });
      });
    } catch (e) {
      console.log('Nota: no pude ejecutar query sqlite desde script (no está sqlite3 package). Ignora si prefieres usar sqlite3 CLI.');
    }

  } catch (err) {
    console.error('Error en check-session:', err?.message || err);
    process.exit(1);
  }
})();
