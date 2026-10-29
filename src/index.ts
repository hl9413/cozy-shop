// ============================================================
// Cozy Luxe Shop - Cloudflare Worker
// Supports: TON Connect payments, PayPal (REST API), Telegram Mini App
// Orders: D1 storage + Email / Telegram notifications
// ============================================================

declare global {
  interface Env {
    ASSETS?: { fetch(request: RequestInfo): Promise<Response> };
    DB?: D1Database;
    BOT_TOKEN?: string;
    PAYPAL_CLIENT_ID?: string;
    PAYPAL_CLIENT_SECRET?: string;
    PAYPAL_MODE?: string; // "sandbox" or "live"
    TON_RECEIVER_ADDRESS?: string;
    // --- notifications ---
    TELEGRAM_CHAT_ID?: string;   // where order alerts are sent on Telegram
    NOTIFY_EMAIL?: string;       // where order alert emails are sent
    NOTIFY_FROM?: string;        // e.g. "VIBE STORE <orders@milanstreet.store>"
    RESEND_API_KEY?: string;     // Resend email API key (optional)
    EMAIL?: { send(msg: any): Promise<any> }; // Cloudflare Email Routing binding (optional)
    ADMIN_KEY?: string;          // protects /api/admin/orders
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // ===================== ROUTES =====================

    // TON Connect manifest (required for TON Connect wallet integration)
    if (url.pathname === '/tonconnect-manifest.json' && request.method === 'GET') {
      return jsonResponse({
        url: `https://${url.hostname}`,
        name: "Cozy Luxe Shop",
        iconUrl: `https://${url.hostname}/icon.png`
      });
    }

    // Public products API (reads from products.json static file or D1 if populated)
    if (url.pathname === '/api/products' && request.method === 'GET') {
      return await handleGetProducts(request, env, url);
    }

    // Telegram initData verification
    if (url.pathname === '/api/verify-telegram' && request.method === 'POST') {
      return await handleVerifyTelegram(request, env);
    }

    // PayPal: create order
    if (url.pathname === '/api/paypal/create-order' && request.method === 'POST') {
      return await handlePayPalCreateOrder(request, env);
    }

    // PayPal: capture order (after user approves) -> also records the order + notifies
    if (url.pathname === '/api/paypal/capture-order' && request.method === 'POST') {
      return await handlePayPalCaptureOrder(request, env, ctx);
    }

    // TON receiver address (for frontend)
    if (url.pathname === '/api/ton/address' && request.method === 'GET') {
      const address = env.TON_RECEIVER_ADDRESS || '';
      return jsonResponse({ address });
    }

    // TON/USD live rate (real price, not 1:1)
    if (url.pathname === '/api/ton/rate' && request.method === 'GET') {
      return await handleTonRate(request, env);
    }

    // Create / record an order (used by TON payments and as generic fallback)
    if (url.pathname === '/api/orders' && request.method === 'POST') {
      return await handleCreateOrder(request, env, ctx);
    }

    // Admin: list recent orders
    if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
      return await handleAdminOrders(request, env, url);
    }

    // Admin: discover Telegram chat ids that recently messaged the bot
    if (url.pathname === '/api/admin/telegram-updates' && request.method === 'GET') {
      return await handleTelegramUpdates(request, env, url);
    }

    // Admin: temporary probe of price sources
    if (url.pathname === '/api/admin/rate-probe' && request.method === 'GET') {
      return await handleRateProbe(request, env, url);
    }

    // Admin: send a test notification through all configured channels
    if (url.pathname === '/api/admin/test-notify' && request.method === 'GET') {
      return await handleTestNotify(request, env, url);
    }

    // Static assets fallback
    if (env.ASSETS && typeof (env.ASSETS as any).fetch === 'function') {
      return (env.ASSETS as any).fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ===================== HANDLERS =====================

async function handleGetProducts(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    // Try D1 database first (only if it actually has products seeded)
    if (env.DB) {
      try {
        const rows = await env.DB.prepare(`
          SELECT p.id, p.title_en, p.title_zh, p.description_en, p.description_zh, p.price_usd,
                 GROUP_CONCAT(pi.image_url ORDER BY pi.sort_order) as images_csv
          FROM products p
          LEFT JOIN product_images pi ON pi.product_id = p.id
          GROUP BY p.id
          ORDER BY p.id ASC
        `).all();

        const list = (rows.results || []) as any[];
        if (list.length > 0) {
          const products = list.map((p: any) => ({
            id: p.id,
            title_en: p.title_en,
            title_zh: p.title_zh,
            description_en: p.description_en,
            description_zh: p.description_zh,
            price_usd: Number(p.price_usd),
            images: p.images_csv ? p.images_csv.split(',') : [`https://${url.hostname}/images/default-placeholder.jpg`]
          }));
          return jsonResponse(products);
        }
      } catch {
        // D1 empty / table missing -> fall through to static file
      }
    }

    // Fallback: read from static products.json file
    if (env.ASSETS && typeof (env.ASSETS as any).fetch === 'function') {
      const assetReq = new Request(`${url.origin}/products.json`);
      const assetRes = await (env.ASSETS as any).fetch(assetReq);
      if (assetRes.ok) {
        const data = await assetRes.json();
        return jsonResponse(data);
      }
    }

    return jsonResponse({ error: 'No product data source available' }, 500);
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleVerifyTelegram(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const initData: string = body?.initData || '';
    if (!initData) return jsonResponse({ error: 'Missing initData' }, 400);

    const botToken = env.BOT_TOKEN || '';
    if (!botToken) return jsonResponse({ error: 'BOT_TOKEN not configured' }, 500);

    const valid = await verifyTelegramInitData(initData, botToken);
    return jsonResponse({ valid });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleRateProbe(request: Request, env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  const urls = [
    'https://data-api.binance.vision/api/v3/ticker/price?symbol=TONUSDT',
    'https://api.bitget.com/api/v2/spot/market/tickers?symbol=TONUSDT',
    'https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=TON-USDT',
    'https://api.huobi.pro/market/detail/merged?symbol=tonusdt',
    'https://min-api.cryptocompare.com/data/price?fsym=TON&tsyms=USD',
    'https://api.coinbase.com/v2/prices/TON-USD/spot',
    'https://api.kraken.com/0/public/Ticker?pair=TONUSD',
    'https://api.coinlore.net/api/ticker/?id=54683',
    'https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT',
    'https://www.okx.com/api/v5/market/ticker?instId=TON-USDT'
  ];

  const results = await Promise.all(urls.map(async (u) => {
    const started = Date.now();
    try {
      const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
      const text = (await r.text()).slice(0, 160);
      return { url: u, status: r.status, ms: Date.now() - started, body: text };
    } catch (e: any) {
      return { url: u, status: 'ERR', ms: Date.now() - started, body: String(e?.message || e) };
    }
  }));

  return jsonResponse({ results });
}

async function handleTonRate(request: Request, env: Env): Promise<Response> {
  const cache = (caches as any).default;
  const freshKey = new Request('https://ton-rate.internal/ton-usd-fresh', { method: 'GET' });
  const lastKey = new Request('https://ton-rate.internal/ton-usd-last', { method: 'GET' });

  try {
    const hit = await cache.match(freshKey);
    if (hit) return hit;
  } catch { /* cache unavailable */ }

  const sources = [
    {
      name: 'coinbase',
      url: 'https://api.coinbase.com/v2/prices/TON-USD/spot',
      pick: (d: any) => d?.data?.amount
    },
    {
      name: 'kraken',
      url: 'https://api.kraken.com/0/public/Ticker?pair=TONUSD',
      pick: (d: any) => d?.result?.TONUSD?.c?.[0]
    },
    {
      name: 'coinlore',
      url: 'https://api.coinlore.net/api/ticker/?id=54683',
      pick: (d: any) => d?.[0]?.price_usd
    },
    {
      name: 'coingecko',
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
      pick: (d: any) => d?.['the-open-network']?.usd
    }
  ];

  const errors: string[] = [];
  const attempts = sources.map((s) => {
    const work = (async () => {
      const r = await fetch(s.url, {
        headers: { accept: 'application/json', 'user-agent': 'vibe-store/1.0' }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: any = await r.json();
      const price = Number(s.pick(data));
      if (!isFinite(price) || price <= 0.05 || price >= 500) throw new Error(`bad price ${price}`);
      return { price, source: s.name };
    })().catch((e: any) => {
      errors.push(`${s.name}: ${e?.message || e}`);
      throw e;
    });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4500));
    return Promise.race([work, timeout]);
  });

  const debug = new URL(request.url).searchParams.get('debug') === '1';

  try {
    const best = await new Promise<{ price: number; source: string }>((resolve, reject) => {
      let pending = attempts.length;
      attempts.forEach(p => p.then(v => resolve(v)).catch(() => {
        pending -= 1;
        if (pending === 0) reject(new Error('all rate sources failed'));
      }));
    });
    const body = JSON.stringify({
      price_usd: best.price,
      source: best.source,
      stale: false,
      ts: new Date().toISOString()
    });
    const resp = new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=90',
        'Access-Control-Allow-Origin': '*'
      }
    });
    try {
      await cache.put(freshKey, resp.clone());
      // keep a 15-minute stale fallback copy
      const staleCopy = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' }
      });
      await cache.put(lastKey, staleCopy);
    } catch { /* ignore */ }
    return resp;
  } catch {
    // All live sources failed -> try last known price (max 15 min old)
    try {
      const stale = await cache.match(lastKey);
      if (stale) {
        const d: any = await stale.json();
        return jsonResponse({
          price_usd: d.price_usd,
          source: d.source,
          stale: true,
          ts: d.ts,
          note: 'last known rate'
        });
      }
    } catch { /* ignore */ }

    if (debug) return jsonResponse({ error: 'TON rate unavailable', details: errors }, 503);
    return jsonResponse({ error: 'TON rate unavailable' }, 503);
  }
}

async function handlePayPalCreateOrder(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const amount: number = Number(body?.amount_usd || 0);
    if (!amount || amount <= 0) return jsonResponse({ error: 'Invalid amount' }, 400);

    const { clientId, clientSecret, baseUrl } = getPayPalConfig(env);
    if (!clientId || !clientSecret) {
      return jsonResponse({ error: 'PayPal not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET secrets.' }, 500);
    }

    // Get access token
    const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return jsonResponse({
      error: 'Failed to get PayPal access token',
      detail: tokenData,
      status: tokenRes.status,
      mode: env.PAYPAL_MODE || 'sandbox'
    }, 500);

    // Create order
    const orderRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: amount.toFixed(2)
          },
          description: 'Cozy Luxe Shop Purchase'
        }]
      })
    });
    const orderData: any = await orderRes.json();
    const approveLink = orderData.links?.find((l: any) => l.rel === "approve");
    return jsonResponse({ orderId: orderData.id, status: orderData.status, approveUrl: approveLink?.href });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handlePayPalCaptureOrder(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const body: any = await request.json();
    const orderId: string = body?.orderId || '';
    if (!orderId) return jsonResponse({ error: 'Missing orderId' }, 400);

    const { clientId, clientSecret, baseUrl } = getPayPalConfig(env);
    if (!clientId || !clientSecret) {
      return jsonResponse({ error: 'PayPal not configured' }, 500);
    }

    // Get access token
    const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return jsonResponse({ error: 'Failed to get PayPal access token' }, 500);

    // Capture order
    const captureRes = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const captureData: any = await captureRes.json();
    const success = captureData.status === 'COMPLETED';

    // Record + notify (never let notification failures break the payment response)
    let orderNo = '';
    if (success) {
      try {
        const payload = body?.order || {};
        const amt = captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value
          || captureData?.purchase_units?.[0]?.amount?.value;
        const order = normalizeOrder(env, {
          ...payload,
          total_usd: Number(amt || payload?.total_usd || 0),
          payment_method: 'paypal',
          payment_ref: orderId,
          status: 'paid'
        });
        orderNo = order.order_no;
        ctx.waitUntil(processOrder(env, order));
      } catch (e) {
        console.error('order record failed', e);
      }
    }

    return jsonResponse({ success, status: captureData.status, orderNo, data: captureData });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleCreateOrder(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const body: any = await request.json();
    const order = normalizeOrder(env, body);
    if (!order.items.length) return jsonResponse({ error: 'Cart is empty' }, 400);
    if (!order.total_usd || order.total_usd <= 0) return jsonResponse({ error: 'Invalid total' }, 400);

    ctx.waitUntil(processOrder(env, order));
    return jsonResponse({ ok: true, orderNo: order.order_no });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleAdminOrders(request: Request, env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!env.DB) return jsonResponse({ error: 'DB not configured' }, 500);

  const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
    return jsonResponse({ count: (rows.results || []).length, orders: rows.results || [] });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleTelegramUpdates(request: Request, env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!env.BOT_TOKEN) return jsonResponse({ error: 'BOT_TOKEN not configured' }, 500);

  try {
    const [meRes, res, whRes] = await Promise.all([
      fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`),
      fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getUpdates?limit=20`),
      fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`)
    ]);
    const me: any = await meRes.json();
    const data: any = await res.json();
    const wh: any = await whRes.json();
    if (!data.ok) return jsonResponse({ error: 'telegram api error', detail: data }, 500);

    const chats = new Map<string, any>();
    for (const u of data.result || []) {
      const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
      const chat = msg?.chat;
      if (chat && chat.id) {
        chats.set(String(chat.id), {
          chat_id: chat.id,
          type: chat.type,
          name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '',
          username: chat.username || ''
        });
      }
    }
    return jsonResponse({
      bot: me.ok ? { username: me.result.username, name: me.result.first_name, id: me.result.id } : { error: me.description },
      webhook: wh.ok ? { url: wh.result.url, pending: wh.result.pending_update_count, last_error: wh.result.last_error_message } : { error: wh.description },
      updates_ok: data.ok,
      updates_count: Array.isArray(data.result) ? data.result.length : null,
      count: chats.size,
      chats: Array.from(chats.values())
    });
  } catch (err: any) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleTestNotify(request: Request, env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const sample: OrderRecord = {
    id: 'TEST', order_no: 'MS-TEST-0001', tg_user_id: '', tg_username: '',
    customer_name: 'Test Customer', customer_email: 'test@example.com',
    customer_phone: '+86 138 0000 0000',
    shipping_address: 'No.1 Test Road, Chaoyang District, Beijing, CN 100000',
    note: 'Automatic test notification from VIBE STORE.',
    total_usd: 158, payment_method: 'test', payment_ref: 'TEST-ONLY',
    status: 'test', crypto_amount: '0 (test)',
    items: [{ product_id: 'p18', title_en: 'Chanel Women Scarf 2026', size: 'Free Size', qty: 1, price_usd: 158 }],
    created_at: new Date().toISOString()
  };
  const [tg, mail] = await Promise.allSettled([
    sendTelegramNotification(env, sample),
    sendEmailNotification(env, sample)
  ]);
  return jsonResponse({
    telegram: {
      configured: !!(env.BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      sent: tg.status === 'fulfilled' && tg.value === true
    },
    email: {
      configured: !!env.NOTIFY_EMAIL,
      provider: env.RESEND_API_KEY ? 'resend' : (env.EMAIL ? 'cloudflare-email' : 'none'),
      sent: mail.status === 'fulfilled' && mail.value === true
    }
  });
}

// ===================== ORDERS =====================
interface OrderItem { product_id: string; title_en: string; size?: string; qty: number; price_usd: number }
interface OrderRecord {
  id: string;
  order_no: string;
  tg_user_id: string;
  tg_username: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  shipping_address: string;
  note: string;
  total_usd: number;
  payment_method: string;
  payment_ref: string;
  status: string;
  crypto_amount: string;
  items: OrderItem[];
  created_at: string;
}

function makeOrderNo(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `MS-${ymd}-${rand}`;
}

function normalizeOrder(env: Env, raw: any): OrderRecord {
  const c = raw?.customer || {};
  const items: OrderItem[] = Array.isArray(raw?.items) ? raw.items.map((it: any) => ({
    product_id: String(it.product_id || it.id || ''),
    title_en: String(it.title_en || it.title || 'Item'),
    size: it.size ? String(it.size) : (it.selectedSize ? String(it.selectedSize) : ''),
    qty: Math.max(1, Number(it.qty || 1)),
    price_usd: Number(it.price_usd || 0)
  })) : [];

  const computed = items.reduce((s, i) => s + i.price_usd * i.qty, 0);
  const orderNo = makeOrderNo();

  return {
    id: orderNo,
    order_no: orderNo,
    tg_user_id: String(raw?.tg_user_id || c?.tg_user_id || ''),
    tg_username: String(raw?.tg_username || c?.tg_username || ''),
    customer_name: String(c.name || raw?.name || '').trim(),
    customer_email: String(c.email || raw?.email || '').trim(),
    customer_phone: String(c.phone || raw?.phone || '').trim(),
    shipping_address: String(c.address || raw?.address || '').trim(),
    note: String(c.note || raw?.note || '').trim(),
    total_usd: Number(raw?.total_usd || computed || 0),
    payment_method: String(raw?.payment_method || 'unknown'),
    payment_ref: String(raw?.payment_ref || ''),
    status: String(raw?.status || 'paid'),
    crypto_amount: String(raw?.crypto_amount || ''),
    items,
    created_at: new Date().toISOString()
  };
}

async function processOrder(env: Env, order: OrderRecord): Promise<void> {
  // 1) persist (skip silently if D1 is not configured)
  let existing = false;
  if (env.DB) {
    try {
      if (order.payment_ref) {
        const dup = await env.DB.prepare(
          `SELECT id FROM orders WHERE payment_ref = ? AND payment_ref <> '' LIMIT 1`
        ).bind(order.payment_ref).first();
        existing = !!dup;
      }
      if (!existing) {
        const stmts: D1PreparedStatement[] = [
          env.DB.prepare(
            `INSERT OR IGNORE INTO orders
             (id, order_no, tg_user_id, tg_username, customer_name, customer_email, customer_phone,
              shipping_address, note, total_usd, payment_method, payment_ref, status, items_json, crypto_amount, notified)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
          ).bind(
            order.id, order.order_no, order.tg_user_id, order.tg_username, order.customer_name,
            order.customer_email, order.customer_phone, order.shipping_address, order.note,
            order.total_usd, order.payment_method, order.payment_ref, order.status,
            JSON.stringify(order.items), order.crypto_amount
          )
        ];
        for (const it of order.items) {
          stmts.push(env.DB.prepare(
            `INSERT INTO order_items (order_id, product_id, title_en, size, qty, price_usd) VALUES (?,?,?,?,?,?)`
          ).bind(order.id, it.product_id, it.title_en, it.size || '', it.qty, it.price_usd));
        }
        await env.DB.batch(stmts);
      }
    } catch (e) {
      console.error('D1 order save failed', e);
    }
  }
  if (existing) return; // already notified on a previous capture call

  // 2) notify (email + telegram in parallel, failures isolated)
  const results = await Promise.allSettled([
    sendEmailNotification(env, order),
    sendTelegramNotification(env, order)
  ]);
  const ok = results.some(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value === true);

  if (ok && env.DB) {
    try {
      await env.DB.prepare(`UPDATE orders SET notified = 1, updated_at = datetime('now') WHERE id = ?`)
        .bind(order.id).run();
    } catch (e) {
      console.error('notified flag update failed', e);
    }
  }
}

function buildOrderText(order: OrderRecord): string {
  const lines: string[] = [];
  lines.push(`🧾 NEW ORDER ${order.order_no}`);
  lines.push('');
  lines.push(`Amount: $${order.total_usd.toFixed(2)} USD`);
  lines.push(`Payment: ${order.payment_method.toUpperCase()}${order.crypto_amount ? ` — ${order.crypto_amount}` : ''}${order.payment_ref ? ` (ref ${order.payment_ref})` : ''}`);
  lines.push('');
  lines.push(`Customer: ${order.customer_name}`);
  lines.push(`Email: ${order.customer_email}`);
  lines.push(`Phone: ${order.customer_phone}`);
  lines.push(`Ship to: ${order.shipping_address}`);
  if (order.note) lines.push(`Note: ${order.note}`);
  lines.push('');
  lines.push('Items:');
  order.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title_en}${it.size ? ` / ${it.size}` : ''} x${it.qty} — $${(it.price_usd * it.qty).toFixed(2)}`);
  });
  if (order.tg_username || order.tg_user_id) {
    lines.push('');
    lines.push(`Telegram: ${order.tg_username ? '@' + order.tg_username : ''} ${order.tg_user_id ? `(id ${order.tg_user_id})` : ''}`.trim());
  }
  return lines.join('\n');
}

async function sendTelegramNotification(env: Env, order: OrderRecord): Promise<boolean> {
  const token = env.BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: buildOrderText(order), disable_web_page_preview: true })
    });
    const data: any = await res.json();
    if (!data.ok) console.error('telegram notify failed', data);
    return !!data.ok;
  } catch (e) {
    console.error('telegram notify error', e);
    return false;
  }
}

function buildOrderHtml(order: OrderRecord): string {
  const rows = order.items.map(it =>
    `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(it.title_en)}${it.size ? ` / ${escapeHtml(it.size)}` : ''}</td>
     <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">${it.qty}</td>
     <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">$${(it.price_usd * it.qty).toFixed(2)}</td></tr>`
  ).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:600px">
  <h2 style="margin:0 0 4px">🧾 New Order ${escapeHtml(order.order_no)}</h2>
  <p style="margin:0 0 16px;color:#666">${escapeHtml(order.created_at)}</p>
  <p style="font-size:22px;margin:0 0 16px"><b>$${order.total_usd.toFixed(2)} USD</b> · ${escapeHtml(order.payment_method.toUpperCase())}</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${rows}
    <tr><td style="padding:8px;font-weight:700">Total</td><td></td>
    <td style="padding:8px;text-align:right;font-weight:700">$${order.total_usd.toFixed(2)}</td></tr>
  </table>
  <h3 style="margin:16px 0 8px">Ship to</h3>
  <p style="margin:0;line-height:1.6">
    ${escapeHtml(order.customer_name)}<br>
    ${escapeHtml(order.customer_phone)}<br>
    ${escapeHtml(order.customer_email)}<br>
    ${escapeHtml(order.shipping_address).replace(/\n/g, '<br>')}
  </p>
  ${order.note ? `<h3 style="margin:16px 0 8px">Note</h3><p style="margin:0;white-space:pre-wrap">${escapeHtml(order.note)}</p>` : ''}
  ${order.payment_ref ? `<p style="margin-top:16px;color:#666;font-size:12px">Payment ref: ${escapeHtml(order.payment_ref)}</p>` : ''}
  </div>`;
}

async function sendEmailNotification(env: Env, order: OrderRecord): Promise<boolean> {
  const to = env.NOTIFY_EMAIL;
  if (!to) return false;
  const from = env.NOTIFY_FROM || 'VIBE STORE <orders@milanstreet.store>';
  const subject = `🧾 New order ${order.order_no} — $${order.total_usd.toFixed(2)}`;
  const text = buildOrderText(order);
  const html = buildOrderHtml(order);

  // Channel A: Resend HTTP API
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to: [to], subject, text, html })
      });
      const data: any = await res.json().catch(() => ({}));
      if (res.ok) return true;
      console.error('resend email failed', res.status, data);
    } catch (e) {
      console.error('resend email error', e);
    }
  }

  // Channel B: Cloudflare Email Routing send_email binding
  if (env.EMAIL && typeof env.EMAIL.send === 'function') {
    try {
      await env.EMAIL.send({ to, from, subject, text, html });
      return true;
    } catch (e) {
      console.error('cf email send error', e);
    }
  }

  return false;
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===================== HELPERS =====================

function getPayPalConfig(env: Env) {
  const mode = env.PAYPAL_MODE || 'sandbox';
  const baseUrl = mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
  return {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    baseUrl
  };
}

function jsonResponse(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function corsResponse(body: any, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    }
  });
}

async function verifyTelegramInitData(initData: string, botToken: string): Promise<boolean> {
  try {
    if (!botToken) return false;
    const params = Object.fromEntries(
      initData.split('&').map(p => {
        const [k, ...rest] = p.split('=');
        return [k, decodeURIComponent(rest.join('='))];
      })
    );
    const hashFromClient = params['hash'];
    if (!hashFromClient) return false;
    delete params['hash'];

    const dataCheckString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('\n');
    const encoder = new TextEncoder();

    // HMAC-SHA256 with key = HMAC-SHA256("WebAppData", botToken)
    const secretKeyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secretKey = await crypto.subtle.sign('HMAC', secretKeyMaterial, encoder.encode(botToken));
    const cryptoKey = await crypto.subtle.importKey(
      'raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(dataCheckString));
    const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    return sigHex === hashFromClient;
  } catch {
    return false;
  }
}
