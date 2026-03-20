#!/usr/bin/env python3
"""Scrape Mercedes EQS listings from Japan, score them, detect options, save to JSON."""
import json, re, os, datetime, hashlib, sys, ssl
from urllib.request import urlopen, Request
from urllib.parse import quote_plus
from urllib.error import URLError, HTTPError

# SSL context that skips verification (for sites with expired/mismatched certs)
SSL_NOVERIFY = ssl.create_default_context()
SSL_NOVERIFY.check_hostname = False
SSL_NOVERIFY.verify_mode = ssl.CERT_NONE

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
OUT_FILE = os.path.join(DATA_DIR, 'eqs-listings.json')
YEN_PER_USD = 149

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}

# Option tags to detect in title/description/grade
OPTION_TAGS = [
    ('HYPERSCREEN', re.compile(r'hyperscreen|hyper\s*screen', re.I)),
    ('Chauffeur Package', re.compile(r'chauffeur\s*package|chauffeur\s*pkg', re.I)),
    ('Rear Entertainment', re.compile(r'rear\s*entertain', re.I)),
    ('AMG Line', re.compile(r'amg\s*line', re.I)),
    ('Night Package', re.compile(r'night\s*pack', re.I)),
    ('Burmester 3D', re.compile(r'burmester\s*3d', re.I)),
    ('Burmester', re.compile(r'burmester(?!\s*3d)', re.I)),
    ('Panoramic Roof', re.compile(r'panoram|pano\s*roof', re.I)),
    ('AIRMATIC', re.compile(r'airmatic|air\s*suspension|air\s*body', re.I)),
    ('HUD', re.compile(r'head[\s-]*up[\s-]*display|h\.?u\.?d\.?(?:\s|$)', re.I)),
    ('53 AMG', re.compile(r'(?:eqs\s*)?53\s*(?:4matic)?.*amg|amg.*53|eqs\s*53', re.I)),
    ('4MATIC', re.compile(r'4\s*matic', re.I)),
    ('7 seats', re.compile(r'7[\s-]*seat|7[\s-]*place|seven[\s-]*seat', re.I)),
    ('Digital Light', re.compile(r'digital\s*light', re.I)),
]

def fetch_url(url, timeout=25, verify_ssl=True):
    req = Request(url, headers=HEADERS)
    try:
        ctx = None if verify_ssl else SSL_NOVERIFY
        with urlopen(req, timeout=timeout, context=ctx) as r:
            return r.read().decode('utf-8', errors='replace')
    except Exception as e:
        # Retry without SSL verification if SSL error
        if verify_ssl and 'SSL' in str(e):
            try:
                with urlopen(req, timeout=timeout, context=SSL_NOVERIFY) as r:
                    return r.read().decode('utf-8', errors='replace')
            except Exception as e2:
                print(f"  ⚠️ fetch error for {url[:80]}: {e2}", file=sys.stderr)
                return ''
        print(f"  ⚠️ fetch error for {url[:80]}: {e}", file=sys.stderr)
        return ''

def detect_options(text):
    """Detect premium option tags in text. Returns list of tag names."""
    tags = []
    for name, pattern in OPTION_TAGS:
        if pattern.search(text):
            # Avoid duplicate: if we already have 'Burmester 3D', skip plain 'Burmester'
            if name == 'Burmester' and 'Burmester 3D' in tags:
                continue
            # Avoid duplicate: if we already have '53 AMG', it implies AMG Line
            if name == 'AMG Line' and '53 AMG' in tags:
                continue
            tags.append(name)
    return tags

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

    g = (grade or '').upper()
    is_amg = 'AMG' in g or '53' in g

    # Price scoring — no budget cap, just relative value scoring
    if is_amg:
        if price_usd <= 40000: p_score = 5.0
        elif price_usd <= 50000: p_score = 4.5
        elif price_usd <= 60000: p_score = 4.0
        elif price_usd <= 70000: p_score = 3.5
        elif price_usd <= 80000: p_score = 3.0
        elif price_usd <= 100000: p_score = 2.5
        else: p_score = 2.0
    else:
        if price_usd <= 25000: p_score = 5.0
        elif price_usd <= 33000: p_score = 4.5
        elif price_usd <= 40000: p_score = 4.0
        elif price_usd <= 50000: p_score = 3.5
        elif price_usd <= 60000: p_score = 3.0
        elif price_usd <= 75000: p_score = 2.5
        elif price_usd <= 100000: p_score = 2.0
        else: p_score = 1.5

    if '53' in g and 'AMG' in g: o_score = 5.0
    elif 'EDITION 1' in g: o_score = 5.0
    elif '580' in g: o_score = 4.5
    elif 'AMG' in g: o_score = 4.0
    else: o_score = 3.0

    total = p_score * 0.30 + m_score * 0.25 + y_score * 0.25 + o_score * 0.20
    return round(total, 1), {
        'year': round(y_score, 1),
        'mileage': round(m_score, 1),
        'price': round(p_score, 1),
        'options': round(o_score, 1)
    }

def make_listing(source, body_type, grade, year, month, km, price_usd, price_yen, color, url, uid_seed, extra_text='', **kwargs):
    """Create a standardized listing dict with option detection."""
    if price_usd <= 0:
        return None
    score, breakdown = score_listing(year, km, price_usd, grade)
    # Detect options from grade + any extra text (title, description)
    search_text = f"{grade} {extra_text}"
    options = detect_options(search_text)
    uid = hashlib.md5(uid_seed.encode()).hexdigest()[:12]
    listing = {
        'id': uid,
        'source': source,
        'type': body_type,
        'grade': grade,
        'year': year,
        'month': month,
        'km': km,
        'price_yen': price_yen,
        'price_usd': price_usd,
        'color': color,
        'url': url,
        'score': score,
        'score_breakdown': breakdown,
        'options': options,
    }
    listing.update(kwargs)
    return listing

# ==================== PARSERS ====================

def parse_goonet(url, body_type):
    """Parse Goo-net Exchange listings."""
    html = fetch_url(url)
    if not html:
        return []
    listings = []
    section = html.split('id="list-cars"')[1] if 'id="list-cars"' in html else html
    # Support both MERCEDES_BENZ and MERCEDES_AMG paths
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
            grade_m = re.search(r'(EQS\d+[^A-Z]*(?:AMG LINE PACKAGE|EDITION 1|4MATIC SUV[^A-Z]*(?:AMG LINE PACKAGE|SPORT))?)', clean, re.I)
            grade = grade_m.group(1).strip() if grade_m else f'EQS450+ {"SUV" if body_type == "SUV" else ""}'
            price_m = re.search(r'[¥￥]([\d,]+)', clean)
            price_yen = int(price_m.group(1).replace(',', '')) if price_m else 0
            price_usd = round(price_yen / YEN_PER_USD)
            ym_m = re.search(r'(20[2-9]\d)\.(\d{2})', clean)
            year = int(ym_m.group(1)) if ym_m else 2023
            month = int(ym_m.group(2)) if ym_m else 1
            km_m = re.search(r'([\d,]+)\s*km', clean)
            km = int(km_m.group(1).replace(',', '')) if km_m else 0
            color = 'N/A'
            for c in ['BLACK', 'WHITE', 'SILVER', 'GRAY', 'BLUE', 'RED', 'PEARL', 'GREEN', 'BROWN']:
                if c in clean.upper():
                    color = c.capitalize()
                    break
            full_url = 'https://www.goo-net-exchange.com' + url_path
            l = make_listing('Goo-net', body_type, grade, year, month, km, price_usd, price_yen, color, full_url, f"goonet-{url_path}", extra_text=clean)
            if l:
                listings.append(l)
        except Exception:
            continue
    return listings

def parse_beforward(url):
    """Parse BE FORWARD listings."""
    html = fetch_url(url)
    if not html:
        return []
    listings = []
    blocks = re.split(r'Ref No\.\s*([\w]+)', html)
    i = 1
    while i < len(blocks) - 1:
        ref = blocks[i]
        content = blocks[i + 1]
        i += 2
        raw = content
        try:
            clean = re.sub(r'<[^>]+>', ' ', raw)
            clean = re.sub(r'\s+', ' ', clean).strip()
            price_m = re.search(r'\$([\d,]+)', clean)
            price_usd = int(price_m.group(1).replace(',', '')) if price_m else 0
            year_m = re.search(r'vehicle-year[^>]*>.*?(\d{4})\s*(?:/\s*(\d+))?', raw, re.DOTALL)
            if not year_m:
                year_m = re.search(r'Year:\s*(\d{4})\s*(?:/\s*(\d+))?', clean)
            year = int(year_m.group(1)) if year_m else 2023
            month = int(year_m.group(2)) if year_m and year_m.group(2) else 1
            km_m = re.search(r'vehicle-mileage[^>]*>.*?([\d,]+)\s*(?:&nbsp;)?\s*km', raw, re.DOTALL)
            if not km_m:
                km_m = re.search(r'Mileage:.*?([\d,]+)\s*km', clean)
            km = int(km_m.group(1).replace(',', '')) if km_m else 0
            save_m = re.search(r'You Save\s*\$([\d,]+)', clean)
            discount = int(save_m.group(1).replace(',', '')) if save_m else 0
            is_suv = 'SUV' in clean.upper()[:200]
            body_type = 'SUV' if is_suv else 'Sedan'
            url_path_m = re.search(r'href="(/mercedes-benz/eqs/[^"]+)"', content)
            car_url = f'https://www.beforward.jp{url_path_m.group(1)}' if url_path_m else f'https://www.beforward.jp/mercedes-benz/eqs/{ref.lower()}/'
            grade = 'EQS450+ AMG Line'
            l = make_listing('BE FORWARD', body_type, grade, year, month, km, price_usd, price_usd * YEN_PER_USD, 'N/A', car_url, f"beforward-{ref}", extra_text=clean, ref=ref, discount=discount)
            if l:
                listings.append(l)
        except Exception:
            continue
    return listings

def parse_carsfromjapan():
    """Parse Cars From Japan — EQS listings."""
    listings = []
    urls = [
        ('https://carfromjapan.com/cheap-used-mercedes-benz-eqs-for-sale', 'Sedan'),
        ('https://carfromjapan.com/cheap-used-mercedes-benz-eqs-suv-for-sale', 'SUV'),
    ]
    for url, body_type in urls:
        html = fetch_url(url)
        if not html:
            continue
        # Each car card has price and details
        # Look for car blocks with links to detail pages
        cards = re.findall(r'<a[^>]*href="(https?://carfromjapan\.com/cheap-used-mercedes-benz-eqs[^"]*)"[^>]*>(.*?)</a>', html, re.DOTALL)
        if not cards:
            cards = re.findall(r'href="(/cheap-used-mercedes-benz-eqs[^"]*)"[^>]*>(.*?)</a>', html, re.DOTALL)
            cards = [(f'https://carfromjapan.com{u}', c) for u, c in cards]
        
        # Also try a broader approach - find all price/year/km data in listing blocks
        # CarsFromJapan typically shows cards with USD prices
        blocks = re.split(r'<(?:div|li)[^>]*class="[^"]*(?:car-item|listing|vehicle)[^"]*"', html)
        for block in blocks:
            try:
                clean = re.sub(r'<[^>]+>', ' ', block)
                clean = re.sub(r'\s+', ' ', clean).strip()
                
                if 'EQS' not in clean.upper() and 'eqs' not in clean.lower():
                    continue
                
                # URL
                url_m = re.search(r'href="([^"]*eqs[^"]*)"', block, re.I)
                car_url = url_m.group(1) if url_m else url
                if car_url.startswith('/'):
                    car_url = 'https://carfromjapan.com' + car_url
                
                # Price in USD
                price_m = re.search(r'(?:USD|US\$|\$)\s*([\d,]+)', clean)
                if not price_m:
                    price_m = re.search(r'([\d,]+)\s*(?:USD|US\$)', clean)
                price_usd = int(price_m.group(1).replace(',', '')) if price_m else 0
                
                # Year
                year_m = re.search(r'(?:Year|年式)[:\s]*(20[2-9]\d)', clean)
                if not year_m:
                    year_m = re.search(r'\b(20[2-9]\d)\b', clean)
                year = int(year_m.group(1)) if year_m else 0
                if year < 2020:
                    continue
                
                # Mileage
                km_m = re.search(r'([\d,]+)\s*km', clean, re.I)
                km = int(km_m.group(1).replace(',', '')) if km_m else 0
                
                # Grade/title
                grade_m = re.search(r'(EQS\s*\d*[^<,\n]{0,40})', clean, re.I)
                grade = grade_m.group(1).strip() if grade_m else f'EQS {body_type}'
                
                # Detect SUV in text
                if 'SUV' in clean.upper():
                    body_type_actual = 'SUV'
                else:
                    body_type_actual = body_type
                
                l = make_listing('CarsFromJapan', body_type_actual, grade, year, 1, km, price_usd, price_usd * YEN_PER_USD, 'N/A', car_url, f"cfj-{car_url}", extra_text=clean)
                if l:
                    listings.append(l)
            except Exception:
                continue
    
    # Deduplicate by URL
    seen = set()
    unique = []
    for l in listings:
        if l['url'] not in seen:
            seen.add(l['url'])
            unique.append(l)
    return unique

def parse_japancardirect():
    """Parse Japan Car Direct — search for EQS."""
    listings = []
    search_terms = ['mercedes+eqs', 'mercedes+eqs+suv', 'eqs+53+amg']
    
    for term in search_terms:
        url = f'https://www.japancardirect.com/vehicle-search?keyword={term}'
        html = fetch_url(url)
        if not html:
            continue
        
        # Find listing blocks
        blocks = re.split(r'<(?:div|article)[^>]*class="[^"]*(?:vehicle|listing|car-card|product)[^"]*"', html)
        for block in blocks:
            try:
                clean = re.sub(r'<[^>]+>', ' ', block)
                clean = re.sub(r'\s+', ' ', clean).strip()
                
                if 'EQS' not in clean.upper():
                    continue
                
                url_m = re.search(r'href="([^"]*(?:vehicle|stock|detail)[^"]*)"', block, re.I)
                car_url = url_m.group(1) if url_m else url
                if car_url.startswith('/'):
                    car_url = 'https://www.japancardirect.com' + car_url
                
                price_m = re.search(r'(?:USD|US\$|\$)\s*([\d,]+)', clean)
                if not price_m:
                    price_m = re.search(r'([\d,]+)\s*(?:USD)', clean)
                if not price_m:
                    # Try JPY
                    price_m_yen = re.search(r'[¥￥]\s*([\d,]+)', clean)
                    if price_m_yen:
                        price_usd = round(int(price_m_yen.group(1).replace(',', '')) / YEN_PER_USD)
                    else:
                        continue
                else:
                    price_usd = int(price_m.group(1).replace(',', ''))
                
                year_m = re.search(r'\b(20[2-9]\d)\b', clean)
                year = int(year_m.group(1)) if year_m else 0
                if year < 2020:
                    continue
                
                km_m = re.search(r'([\d,]+)\s*km', clean, re.I)
                km = int(km_m.group(1).replace(',', '')) if km_m else 0
                
                grade_m = re.search(r'(EQS\s*\d*[^<,\n]{0,40})', clean, re.I)
                grade = grade_m.group(1).strip() if grade_m else 'EQS'
                
                body_type = 'SUV' if 'SUV' in clean.upper() else 'Sedan'
                
                l = make_listing('JapanCarDirect', body_type, grade, year, 1, km, price_usd, price_usd * YEN_PER_USD, 'N/A', car_url, f"jcd-{car_url}", extra_text=clean)
                if l:
                    listings.append(l)
            except Exception:
                continue
    
    seen = set()
    unique = []
    for l in listings:
        if l['url'] not in seen:
            seen.add(l['url'])
            unique.append(l)
    return unique

def parse_stcjapan():
    """Parse STC Japan — search for EQS."""
    listings = []
    urls = [
        'https://stcjapan.net/make/Mercedes?keyword=EQS',
        'https://stcjapan.net/make/Mercedes?keyword=EQS+SUV',
        'https://stcjapan.net/make/Mercedes?keyword=EQS+53',
    ]
    
    for url in urls:
        html = fetch_url(url)
        if not html:
            continue
        
        blocks = re.split(r'<(?:div|article)[^>]*class="[^"]*(?:vehicle|listing|car-card|product|item)[^"]*"', html)
        for block in blocks:
            try:
                clean = re.sub(r'<[^>]+>', ' ', block)
                clean = re.sub(r'\s+', ' ', clean).strip()
                
                if 'EQS' not in clean.upper():
                    continue
                
                url_m = re.search(r'href="([^"]*(?:vehicle|stock|detail|car)[^"]*)"', block, re.I)
                car_url = url_m.group(1) if url_m else url
                if car_url.startswith('/'):
                    car_url = 'https://stcjapan.net' + car_url
                
                price_m = re.search(r'(?:USD|US\$|\$)\s*([\d,]+)', clean)
                if not price_m:
                    price_m_yen = re.search(r'[¥￥]\s*([\d,]+)', clean)
                    if price_m_yen:
                        price_usd = round(int(price_m_yen.group(1).replace(',', '')) / YEN_PER_USD)
                    else:
                        continue
                else:
                    price_usd = int(price_m.group(1).replace(',', ''))
                
                year_m = re.search(r'\b(20[2-9]\d)\b', clean)
                year = int(year_m.group(1)) if year_m else 0
                if year < 2020:
                    continue
                
                km_m = re.search(r'([\d,]+)\s*km', clean, re.I)
                km = int(km_m.group(1).replace(',', '')) if km_m else 0
                
                grade_m = re.search(r'(EQS\s*\d*[^<,\n]{0,40})', clean, re.I)
                grade = grade_m.group(1).strip() if grade_m else 'EQS'
                
                body_type = 'SUV' if 'SUV' in clean.upper() else 'Sedan'
                
                l = make_listing('STC Japan', body_type, grade, year, 1, km, price_usd, price_usd * YEN_PER_USD, 'N/A', car_url, f"stc-{car_url}", extra_text=clean)
                if l:
                    listings.append(l)
            except Exception:
                continue
    
    seen = set()
    unique = []
    for l in listings:
        if l['url'] not in seen:
            seen.add(l['url'])
            unique.append(l)
    return unique

def parse_autorec():
    """Parse Autorec — search for EQS."""
    listings = []
    urls = [
        'https://www.autorec.co.jp/truck/search?keyword=mercedes+eqs',
        'https://www.autorec.co.jp/car/search?keyword=mercedes+eqs',
    ]
    
    for url in urls:
        html = fetch_url(url)
        if not html:
            continue
        
        blocks = re.split(r'<(?:div|tr|article)[^>]*class="[^"]*(?:vehicle|listing|car|product|item|result)[^"]*"', html)
        for block in blocks:
            try:
                clean = re.sub(r'<[^>]+>', ' ', block)
                clean = re.sub(r'\s+', ' ', clean).strip()
                
                if 'EQS' not in clean.upper():
                    continue
                
                url_m = re.search(r'href="([^"]*(?:detail|stock|vehicle)[^"]*)"', block, re.I)
                car_url = url_m.group(1) if url_m else url
                if car_url.startswith('/'):
                    car_url = 'https://www.autorec.co.jp' + car_url
                
                price_m = re.search(r'(?:USD|US\$|\$)\s*([\d,]+)', clean)
                if not price_m:
                    price_m_yen = re.search(r'[¥￥]\s*([\d,]+)', clean)
                    if price_m_yen:
                        price_usd = round(int(price_m_yen.group(1).replace(',', '')) / YEN_PER_USD)
                    else:
                        continue
                else:
                    price_usd = int(price_m.group(1).replace(',', ''))
                
                year_m = re.search(r'\b(20[2-9]\d)\b', clean)
                year = int(year_m.group(1)) if year_m else 0
                if year < 2020:
                    continue
                
                km_m = re.search(r'([\d,]+)\s*km', clean, re.I)
                km = int(km_m.group(1).replace(',', '')) if km_m else 0
                
                grade_m = re.search(r'(EQS\s*\d*[^<,\n]{0,40})', clean, re.I)
                grade = grade_m.group(1).strip() if grade_m else 'EQS'
                
                body_type = 'SUV' if 'SUV' in clean.upper() else 'Sedan'
                
                l = make_listing('Autorec', body_type, grade, year, 1, km, price_usd, price_usd * YEN_PER_USD, 'N/A', car_url, f"autorec-{car_url}", extra_text=clean)
                if l:
                    listings.append(l)
            except Exception:
                continue
    
    seen = set()
    unique = []
    for l in listings:
        if l['url'] not in seen:
            seen.add(l['url'])
            unique.append(l)
    return unique


def main():
    all_listings = []

    # === Goo-net EQS Sedan ===
    print("Fetching Goo-net EQS Sedan...")
    try:
        sedans = parse_goonet('https://www.goo-net-exchange.com/usedcars/MERCEDES_BENZ/EQS/', 'Sedan')
        all_listings.extend(sedans)
        print(f"  → {len(sedans)} sedans")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # === Goo-net EQS SUV ===
    print("Fetching Goo-net EQS SUV...")
    try:
        suvs = parse_goonet('https://www.goo-net-exchange.com/usedcars/MERCEDES_BENZ/EQS_SUV/', 'SUV')
        all_listings.extend(suvs)
        print(f"  → {len(suvs)} SUVs")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # === Goo-net AMG EQS 53 ===
    print("Fetching Goo-net AMG EQS 53...")
    try:
        amgs = parse_goonet('https://www.goo-net-exchange.com/usedcars/MERCEDES_AMG/EQS/', 'Sedan')
        all_listings.extend(amgs)
        print(f"  → {len(amgs)} AMG EQS 53")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # === BE FORWARD ===
    print("Fetching BE FORWARD EQS...")
    try:
        bf = parse_beforward('https://sp.beforward.jp/stocklist/make=106/model=16944/sortkey=a')
        all_listings.extend(bf)
        print(f"  → {len(bf)} listings")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # === Cars From Japan ===
    print("Fetching Cars From Japan...")
    try:
        cfj = parse_carsfromjapan()
        all_listings.extend(cfj)
        print(f"  → {len(cfj)} listings")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # === Japan Car Direct ===
    print("Fetching Japan Car Direct...")
    try:
        jcd = parse_japancardirect()
        all_listings.extend(jcd)
        print(f"  → {len(jcd)} listings")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # === STC Japan ===
    print("Fetching STC Japan...")
    try:
        stc = parse_stcjapan()
        all_listings.extend(stc)
        print(f"  → {len(stc)} listings")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # === Autorec ===
    print("Fetching Autorec...")
    try:
        ar = parse_autorec()
        all_listings.extend(ar)
        print(f"  → {len(ar)} listings")
    except Exception as e:
        print(f"  ❌ Error: {e}")

    # Sort by score descending
    all_listings.sort(key=lambda x: -x['score'])

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

    # Count sources
    sources = {}
    for l in all_listings:
        sources[l['source']] = sources.get(l['source'], 0) + 1

    result = {
        'updatedAt': datetime.datetime.now().isoformat(),
        'rate': {'yen_per_usd': YEN_PER_USD},
        'total': len(all_listings),
        'sources': sources,
        'new_count': len(added),
        'removed_count': len(removed),
        'listings': all_listings
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_FILE, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"\n✅ {len(all_listings)} annonces total ({len(added)} nouvelles, {len(removed)} retirées)")
    print(f"   Sources: {sources}")
    print(f"\nTop 5:")
    for l in all_listings[:5]:
        stars = '⭐' * int(l['score'])
        new = ' 🆕' if l.get('is_new') else ''
        opts = ', '.join(l.get('options', []))
        print(f"  {l['score']}/5 {stars} ${l['price_usd']:,} — {l['year']}/{l['month']:02d}, {l['km']:,}km, {l['type']} [{l.get('grade','')}] ({l['source']}){new}")
        if opts:
            print(f"    🏷️ {opts}")

if __name__ == '__main__':
    main()
