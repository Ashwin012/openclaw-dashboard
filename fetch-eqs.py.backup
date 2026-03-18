#!/usr/bin/env python3
"""Scrape Mercedes EQS listings from Japan, score them, save to JSON."""
import json, re, os, datetime, hashlib
from urllib.request import urlopen, Request

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
OUT_FILE = os.path.join(DATA_DIR, 'eqs-listings.json')
BUDGET_USD = 60000
YEN_PER_USD = 149

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

def fetch_url(url):
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=20) as r:
        return r.read().decode('utf-8', errors='replace')

def score_listing(year, km, price_usd, grade):
    """Score 0-5 stars based on year, mileage, price, options."""
    yr = int(year) if year else 2022
    if yr >= 2025: y_score = 5.0
    elif yr >= 2024: y_score = 4.5
    elif yr >= 2023: y_score = 4.0
    elif yr >= 2022: y_score = 3.0
    else: y_score = 2.0

    if km <= 500: m_score = 5.0
    elif km <= 3000: m_score = 4.5
    elif km <= 8000: m_score = 4.0
    elif km <= 15000: m_score = 3.5
    elif km <= 25000: m_score = 3.0
    elif km <= 35000: m_score = 2.0
    else: m_score = 1.0

    if price_usd <= 33000: p_score = 5.0
    elif price_usd <= 36000: p_score = 4.5
    elif price_usd <= 40000: p_score = 4.0
    elif price_usd <= 45000: p_score = 3.5
    elif price_usd <= 50000: p_score = 3.0
    elif price_usd <= 55000: p_score = 2.5
    elif price_usd <= 60000: p_score = 2.0
    else: p_score = 1.0

    g = (grade or '').upper()
    if 'EDITION 1' in g: o_score = 5.0
    elif '580' in g: o_score = 4.5
    elif 'AMG' in g: o_score = 4.0
    else: o_score = 3.0

    total = p_score * 0.35 + m_score * 0.25 + y_score * 0.25 + o_score * 0.15
    return round(total, 1), {
        'year': round(y_score, 1),
        'mileage': round(m_score, 1),
        'price': round(p_score, 1),
        'options': round(o_score, 1)
    }

def parse_goonet(url, body_type):
    """Parse Goo-net Exchange listings from raw HTML."""
    html = fetch_url(url)
    listings = []

    # Split by listing section
    section = html.split('id="list-cars"')[1] if 'id="list-cars"' in html else html

    # Each car is an <a> with href to /usedcars/...
    blocks = re.split(r'<a[^>]*href="(/usedcars/MERCEDES_(?:BENZ|AMG)/EQS[^"]*\d+/)"[^>]*>', section)

    i = 1
    while i < len(blocks) - 1:
        url_path = blocks[i]
        content = blocks[i + 1]
        i += 2

        end_a = content.find('</a>')
        if end_a > 0:
            content = content[:end_a]

        clean = re.sub(r'<[^>]+>', ' ', content)
        clean = re.sub(r'\s+', ' ', clean).strip()

        try:
            # Grade
            grade_m = re.search(r'(EQS\d+[^A-Z]*(?:AMG LINE PACKAGE|EDITION 1|4MATIC SUV[^A-Z]*(?:AMG LINE PACKAGE|SPORT))?)', clean, re.I)
            grade = grade_m.group(1).strip() if grade_m else f'EQS450+ {"SUV" if body_type == "SUV" else ""}'

            # Price
            price_m = re.search(r'[¥￥]([\d,]+)', clean)
            price_yen = int(price_m.group(1).replace(',', '')) if price_m else 0
            price_usd = round(price_yen / YEN_PER_USD)

            # Year.Month
            ym_m = re.search(r'(20[2-9]\d)\.(\d{2})', clean)
            year = int(ym_m.group(1)) if ym_m else 2023
            month = int(ym_m.group(2)) if ym_m else 1

            # Mileage
            km_m = re.search(r'([\d,]+)\s*km', clean)
            km = int(km_m.group(1).replace(',', '')) if km_m else 0

            # Color
            color = 'N/A'
            for c in ['BLACK', 'WHITE', 'SILVER', 'GRAY', 'BLUE', 'RED', 'PEARL', 'GREEN', 'BROWN']:
                if c in clean.upper():
                    color = c.capitalize()
                    break

            if price_usd == 0:
                continue

            full_url = 'https://www.goo-net-exchange.com' + url_path
            uid = hashlib.md5(f"goonet-{url_path}".encode()).hexdigest()[:12]
            score, breakdown = score_listing(year, km, price_usd, grade)

            listings.append({
                'id': uid,
                'source': 'Goo-net',
                'type': body_type,
                'grade': grade,
                'year': year,
                'month': month,
                'km': km,
                'price_yen': price_yen,
                'price_usd': price_usd,
                'color': color,
                'url': full_url,
                'score': score,
                'score_breakdown': breakdown
            })
        except Exception as e:
            continue

    return listings

def parse_beforward(url):
    """Parse BE FORWARD listings from raw HTML."""
    html = fetch_url(url)
    listings = []

    # Each listing is in a block with ref no and details
    blocks = re.split(r'Ref No\.\s*([\w]+)', html)
    i = 1
    while i < len(blocks) - 1:
        ref = blocks[i]
        content = blocks[i + 1]
        i += 2

        # Keep raw HTML for structured extraction
        raw = content

        try:
            clean = re.sub(r'<[^>]+>', ' ', raw)
            clean = re.sub(r'\s+', ' ', clean).strip()

            # Price USD
            price_m = re.search(r'\$([\d,]+)', clean)
            price_usd = int(price_m.group(1).replace(',', '')) if price_m else 0

            # Year - from vehicle-year div in raw HTML
            year_m = re.search(r'vehicle-year[^>]*>.*?(\d{4})\s*(?:/\s*(\d+))?', raw, re.DOTALL)
            if not year_m:
                year_m = re.search(r'Year:\s*(\d{4})\s*(?:/\s*(\d+))?', clean)
            year = int(year_m.group(1)) if year_m else 2023
            month = int(year_m.group(2)) if year_m and year_m.group(2) else 1

            # Mileage - from vehicle-mileage div
            km_m = re.search(r'vehicle-mileage[^>]*>.*?([\d,]+)\s*(?:&nbsp;)?\s*km', raw, re.DOTALL)
            if not km_m:
                km_m = re.search(r'Mileage:.*?([\d,]+)\s*km', clean)
            km = int(km_m.group(1).replace(',', '')) if km_m else 0

            # Discount
            save_m = re.search(r'You Save\s*\$([\d,]+)', clean)
            discount = int(save_m.group(1).replace(',', '')) if save_m else 0

            # Model code to detect SUV
            is_suv = 'SUV' in clean.upper()[:200]
            body_type = 'SUV' if is_suv else 'Sedan'

            if price_usd == 0:
                continue

            # Construct clickable URL
            url_path_m = re.search(r'href="(/mercedes-benz/eqs/[^"]+)"', content)
            if url_path_m:
                car_url = f'https://www.beforward.jp{url_path_m.group(1)}'
            else:
                car_url = f'https://www.beforward.jp/mercedes-benz/eqs/{ref.lower()}/'

            uid = hashlib.md5(f"beforward-{ref}".encode()).hexdigest()[:12]
            grade = 'EQS450+ AMG Line'
            score, breakdown = score_listing(year, km, price_usd, grade)

            listings.append({
                'id': uid,
                'source': 'BE FORWARD',
                'ref': ref,
                'type': body_type,
                'grade': grade,
                'year': year,
                'month': month,
                'km': km,
                'price_usd': price_usd,
                'price_yen': price_usd * YEN_PER_USD,
                'color': 'N/A',
                'url': car_url,
                'discount': discount,
                'score': score,
                'score_breakdown': breakdown
            })
        except Exception:
            continue

    return listings

def main():
    all_listings = []

    # Goo-net EQS Sedan
    print("Fetching Goo-net EQS Sedan...")
    try:
        sedans = parse_goonet('https://www.goo-net-exchange.com/usedcars/MERCEDES_BENZ/EQS/', 'Sedan')
        all_listings.extend(sedans)
        print(f"  → {len(sedans)} sedans")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # Goo-net EQS SUV
    print("Fetching Goo-net EQS SUV...")
    try:
        suvs = parse_goonet('https://www.goo-net-exchange.com/usedcars/MERCEDES_BENZ/EQS_SUV/', 'SUV')
        all_listings.extend(suvs)
        print(f"  → {len(suvs)} SUVs")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # Goo-net AMG EQS 53
    print("Fetching Goo-net AMG EQS 53...")
    try:
        amgs = parse_goonet('https://www.goo-net-exchange.com/usedcars/MERCEDES_AMG/EQS/', 'Sedan')
        all_listings.extend(amgs)
        print(f"  → {len(amgs)} AMG EQS 53")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # BE FORWARD
    print("Fetching BE FORWARD EQS...")
    try:
        bf = parse_beforward('https://sp.beforward.jp/stocklist/make=106/model=16944/sortkey=a')
        all_listings.extend(bf)
        print(f"  → {len(bf)} listings")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # Sort: within budget first (by score desc), then over budget (by price asc)
    all_listings.sort(key=lambda x: (0 if x['price_usd'] <= BUDGET_USD else 1, -x['score'] if x['price_usd'] <= BUDGET_USD else x['price_usd']))

    # Load previous for diff
    prev_ids = set()
    if os.path.exists(OUT_FILE):
        try:
            prev = json.load(open(OUT_FILE))
            prev_ids = {l['id'] for l in prev.get('listings', [])}
        except:
            pass

    new_ids = {l['id'] for l in all_listings}
    added = new_ids - prev_ids
    removed = prev_ids - new_ids

    for l in all_listings:
        l['is_new'] = l['id'] in added
        l['over_budget'] = l['price_usd'] > BUDGET_USD

    result = {
        'updatedAt': datetime.datetime.now().isoformat(),
        'rate': {'yen_per_usd': YEN_PER_USD},
        'budget_usd': BUDGET_USD,
        'total': len(all_listings),
        'new_count': len(added),
        'removed_count': len(removed),
        'listings': all_listings
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_FILE, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"\n✅ {len(all_listings)} annonces ({len(added)} nouvelles, {len(removed)} retirées)")
    for l in all_listings[:5]:
        stars = '⭐' * int(l['score'])
        new = ' 🆕' if l.get('is_new') else ''
        print(f"  {l['score']}/5 {stars} ${l['price_usd']:,} — {l['year']}/{l['month']:02d}, {l['km']:,}km, {l['type']} {l['color']} ({l['source']}){new}")

if __name__ == '__main__':
    main()
