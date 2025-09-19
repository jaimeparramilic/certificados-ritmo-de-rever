// check-session.mjs (versión corregida — incluye adapter node)
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import fs from 'fs';

// IMPORTAR adapter de Node (necesario)
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';
import { SQLiteSessionStorage } from '@shopify/shopify-app-session-storage-sqlite';

const DB_PATH = (process.env.SESSION_DB_PATH || './tmp/shopify_sessions.sqlite').trim();
const RAW_HOST = (process.env.SHOPIFY_APP_HOST || '').trim();
const NORMALIZED_HOST = RAW_HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '');
const HOST_SCHEME = RAW_HOST.startsWith('https') ? 'https' : 'http';
const SHOP = process.argv[2] || 'kueh0y-ib.myshopify.com';

console.log('=== check-session ===');
console.log('cwd:', process.cwd());
console.log('RAW SHOPIFY_APP_HOST:', RAW_HOST || '[missing]');
console.log('NORMALIZED hostName used by SDK:', NORMALIZED_HOST || '[missing]');
console.log('SESSION_DB_PATH:', DB_PATH);
console.log('SHOPIFY_API_KEY present?', !!process.env.SHOPIFY_API_KEY);
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
  hostName: NORMALIZED_HOST,
  hostScheme: HOST_SCHEME,
  sessionStorage,
});

(async () => {
  try {
    const offlineId = shopify.session.getOfflineId(SHOP);
    console.log('Computed offlineId:', offlineId);

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

    // Intento opcional de leer la tabla sessions con sqlite3 package si está instalado
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
      console.log('Nota: sqlite3 package no instalado — puedes usar sqlite3 CLI para inspeccionar la DB.');
    }

  } catch (err) {
    console.error('Error en check-session:', err?.message || err);
    process.exit(1);
  }
})();
