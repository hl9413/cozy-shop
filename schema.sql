-- Cozy Luxe Shop - D1 Database Schema
-- Run: wrangler d1 execute cozy-shop-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  title_en    TEXT NOT NULL,
  title_zh    TEXT,
  description_en TEXT,
  description_zh TEXT,
  price_usd   REAL NOT NULL,
  stock       INTEGER DEFAULT 999,
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url   TEXT NOT NULL,
  is_primary  INTEGER DEFAULT 0,
  sort_order  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  tg_user_id    TEXT,
  tg_username   TEXT,
  total_usd     REAL NOT NULL,
  payment_method TEXT, -- "paypal" or "ton"
  payment_ref   TEXT, -- PayPal order ID or TON tx hash
  status        TEXT DEFAULT 'pending', -- pending, paid, shipped, cancelled
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL,
  title_en    TEXT NOT NULL,
  price_usd   REAL NOT NULL
);

-- Seed sample products
INSERT OR IGNORE INTO products (id, title_en, title_zh, description_en, description_zh, price_usd) VALUES
  ('p1', 'Cozy Knit Beanie',   '针织毛线帽',   'Soft and warm knit beanie, perfect for all seasons. Available in multiple colors.',  '柔软温暖的针织帽，适合各个季节，多种颜色可选。', 19.99),
  ('p2', 'Luxury Silk Scarf',  '真丝围巾',     'Elegant 100% silk scarf with delicate prints. A timeless fashion accessory.',         '100%真丝印花围巾，优雅时尚，经典百搭。',         29.99),
  ('p3', 'Satin Hair Tie Set', '缎面发饰套装', 'Premium satin scrunchies and hair ties. Gentle on hair, beautiful in style.',         '高级缎面发圈套装，温柔呵护发丝，时尚美观。',   39.99);

INSERT OR IGNORE INTO product_images (product_id, image_url, is_primary, sort_order) VALUES
  ('p1', '/images/product1.jpg',   1, 0),
  ('p1', '/images/product1_2.jpg', 0, 1),
  ('p1', '/images/product1_3.jpg', 0, 2),
  ('p1', '/images/product1_4.jpg', 0, 3),
  ('p2', '/images/product2.jpg',   1, 0),
  ('p2', '/images/product2_2.jpg', 0, 1),
  ('p2', '/images/product2_3.jpg', 0, 2),
  ('p2', '/images/product2_4.jpg', 0, 3),
  ('p3', '/images/product3.jpg',   1, 0),
  ('p3', '/images/product3_2.jpg', 0, 1),
  ('p3', '/images/product3_3.jpg', 0, 2),
  ('p3', '/images/product3_4.jpg', 0, 3);
