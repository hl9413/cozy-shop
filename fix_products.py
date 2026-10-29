import json, os

products = [
  {
    "id": "p1",
    "category": "hat",
    "tag": "new",
    "title_en": "Vintage Corduroy Cap",
    "title_zh": "复古灯芯绒棒球帽",
    "price_usd": 29.99,
    "images": ["/images/product1.jpg","/images/product1_2.jpg","/images/product1_3.jpg","/images/product1_4.jpg"],
    "description_en": "Relaxed-fit corduroy cap with embroidered logo. Adjustable strap. One size fits all.",
    "description_zh": "宽松版灯芯绒帽，刺绣标志，可调节后扣，均码。"
  },
  {
    "id": "p2",
    "category": "scarf",
    "tag": "hot",
    "title_en": "Oversized Check Scarf",
    "title_zh": "超大格纹围巾",
    "price_usd": 39.99,
    "images": ["/images/product2.jpg","/images/product2_2.jpg","/images/product2_3.jpg","/images/product2_4.jpg"],
    "description_en": "Bold oversized plaid scarf. 100% wool blend. Wear it loose or draped.",
    "description_zh": "百搭格纹大围巾，羊毛混纺，宽松披挂两种穿法。"
  },
  {
    "id": "p3",
    "category": "accessories",
    "tag": "new",
    "title_en": "Silver Chain Set",
    "title_zh": "银链饰品套装",
    "price_usd": 49.99,
    "images": ["/images/product3.jpg","/images/product3_2.jpg","/images/product3_3.jpg","/images/product3_4.jpg"],
    "description_en": "Layered silver-tone chain necklace set. Statement streetwear accessory.",
    "description_zh": "层叠银色链条项链套装，潮流街头必备饰品。"
  }
]

# 写入当前目录下的 public/products.json
path = os.path.join("public", "products.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(products, f, ensure_ascii=False, indent=2)

print("✅ 写入成功！路径：" + path)