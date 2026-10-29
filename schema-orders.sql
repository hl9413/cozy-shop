-- Orders schema (customer info + notification tracking)
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  order_no        TEXT,
  tg_user_id      TEXT,
  tg_username     TEXT,
  customer_name   TEXT,
  customer_email  TEXT,
  customer_phone  TEXT,
  shipping_address TEXT,
  note            TEXT,
  total_usd       REAL NOT NULL,
  currency        TEXT DEFAULT 'USD',
  payment_method  TEXT,
  payment_ref     TEXT,
  status          TEXT DEFAULT 'paid',
  items_json      TEXT,
  crypto_amount   TEXT,
  notified        INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  title_en    TEXT NOT NULL,
  size        TEXT,
  qty         INTEGER DEFAULT 1,
  price_usd   REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(payment_ref);
