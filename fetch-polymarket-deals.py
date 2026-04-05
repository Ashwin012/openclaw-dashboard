#!/usr/bin/env python3
"""
Polymarket Deals Finder — scrapes news, cross-references with active Polymarket markets,
scores opportunities, and saves to data/polymarket-deals.json.
Designed to run every 2 hours via cron.
"""

import json
import os
import sys
import hashlib
import time
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from email.utils import parsedate_to_datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(SCRIPT_DIR, 'data', 'polymarket-deals.json')
REQUEST_TIMEOUT = 15
MAX_DEALS = 50
MAX_AGE_HOURS = 48  # Keep deals for 48h max

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; PolymarketDealsFinder/1.0)',
    'Accept': 'application/json, application/xml, text/xml, */*',
}

# ===== News Sources (prediction-market relevant) =====

NEWS_SOURCES = [
    {'type': 'rss', 'url': 'https://www.coindesk.com/arc/outboundfeeds/rss/', 'name': 'CoinDesk'},
    {'type': 'rss', 'url': 'https://cointelegraph.com/rss', 'name': 'CoinTelegraph'},
    {'type': 'rss', 'url': 'https://feeds.reuters.com/reuters/worldNews', 'name': 'Reuters World'},
    {'type': 'rss', 'url': 'https://feeds.bbci.co.uk/news/world/rss.xml', 'name': 'BBC World'},
    {'type': 'rss', 'url': 'https://feeds.reuters.com/reuters/businessNews', 'name': 'Reuters Business'},
    {'type': 'rss', 'url': 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', 'name': 'NYT Politics'},
    {'type': 'rss', 'url': 'https://feeds.bbci.co.uk/news/technology/rss.xml', 'name': 'BBC Tech'},
]


def make_id(s):
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def fetch_url(url, timeout=REQUEST_TIMEOUT):
    req = Request(url, headers=HEADERS)
    with urlopen(req, timeout=timeout) as resp:
        return resp.read()


def parse_date(date_str):
    if not date_str:
        return datetime.now(timezone.utc).isoformat()
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    try:
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    return datetime.now(timezone.utc).isoformat()


def get_text(elem, tag, default=''):
    if elem is None:
        return default
    child = elem.find(tag)
    if child is not None and child.text:
        return child.text.strip()
    return default


# ===== Fetch News =====

def fetch_rss_articles(source):
    """Fetch articles from an RSS feed."""
    url = source['url']
    name = source['name']
    articles = []
    print(f"  Fetching {name}...")
    try:
        raw = fetch_url(url)
        raw_str = raw.decode('utf-8', errors='replace')
        try:
            root = ET.fromstring(raw_str)
        except ET.ParseError:
            raw_str = raw_str.replace('&', '&amp;')
            try:
                root = ET.fromstring(raw_str)
            except ET.ParseError:
                return []

        items = root.findall('.//item')
        if not items:
            ns = {'atom': 'http://www.w3.org/2005/Atom'}
            items = root.findall('.//atom:entry', ns)
            for item in items:
                title_el = item.find('atom:title', ns)
                link_el = item.find('atom:link', ns)
                date_el = item.find('atom:updated', ns) or item.find('atom:published', ns)
                title = title_el.text.strip() if title_el is not None and title_el.text else ''
                link = link_el.get('href', '') if link_el is not None else ''
                pub_date = date_el.text.strip() if date_el is not None and date_el.text else ''
                if title and link:
                    articles.append({
                        'title': title, 'url': link, 'source': name,
                        'publishedAt': parse_date(pub_date),
                    })
            return articles

        for item in items:
            title = get_text(item, 'title')
            link = get_text(item, 'link') or get_text(item, 'guid')
            pub_date = get_text(item, 'pubDate') or get_text(item, 'dc:date')
            if title and link:
                articles.append({
                    'title': title, 'url': link, 'source': name,
                    'publishedAt': parse_date(pub_date),
                })
    except Exception as e:
        print(f"  ⚠ Error fetching {name}: {e}")
    return articles


def fetch_all_news():
    """Fetch news from all sources."""
    all_articles = []
    for source in NEWS_SOURCES:
        articles = fetch_rss_articles(source)
        # Only keep last 48h
        cutoff = datetime.now(timezone.utc) - timedelta(hours=MAX_AGE_HOURS)
        recent = []
        for a in articles:
            try:
                dt = datetime.fromisoformat(a['publishedAt'].replace('Z', '+00:00'))
                if dt >= cutoff:
                    recent.append(a)
            except Exception:
                recent.append(a)
        all_articles.extend(recent)
        print(f"  → {len(articles)} fetched, {len(recent)} recent")
    return all_articles


# ===== Fetch Polymarket Markets =====

def fetch_active_markets():
    """Fetch active markets from Polymarket Gamma API."""
    print("\n[POLYMARKET MARKETS]")
    markets = []
    try:
        # Fetch active, high-volume markets
        url = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false'
        raw = fetch_url(url, timeout=20)
        data = json.loads(raw)
        if isinstance(data, list):
            markets = data
        print(f"  → {len(markets)} active markets fetched")
    except Exception as e:
        print(f"  ⚠ Error fetching markets: {e}")

    # Normalize market data
    normalized = []
    for m in markets:
        try:
            outcomes = m.get('outcomes', '[]')
            if isinstance(outcomes, str):
                outcomes = json.loads(outcomes)
            prices = m.get('outcomePrices', '[]')
            if isinstance(prices, str):
                prices = json.loads(prices)

            normalized.append({
                'id': m.get('id', ''),
                'conditionId': m.get('conditionId', ''),
                'question': m.get('question', m.get('title', '')),
                'description': m.get('description', ''),
                'outcomes': outcomes,
                'outcomePrices': [float(p) for p in prices] if prices else [],
                'volume': float(m.get('volume', 0) or 0),
                'volume24hr': float(m.get('volume24hr', 0) or 0),
                'liquidity': float(m.get('liquidity', 0) or 0),
                'endDate': m.get('endDate', ''),
                'icon': m.get('icon', ''),
                'slug': m.get('slug', ''),
            })
        except Exception:
            continue
    return normalized


# ===== Cross-Reference & Scoring =====

def extract_keywords(text):
    """Extract meaningful keywords from text."""
    text = text.lower()
    # Remove common stop words
    stop_words = {
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'will', 'be', 'been',
        'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'would',
        'should', 'may', 'might', 'shall', 'to', 'of', 'in', 'for', 'on',
        'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
        'through', 'after', 'before', 'during', 'and', 'or', 'but', 'not',
        'this', 'that', 'these', 'those', 'it', 'its', 'they', 'their',
        'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
        'all', 'each', 'every', 'any', 'some', 'no', 'than', 'very',
        'just', 'also', 'more', 'most', 'new', 'says', 'said', 'over',
    }
    words = re.findall(r'[a-z]{3,}', text)
    return [w for w in words if w not in stop_words]


def compute_match_score(news_keywords, market):
    """Compute how well news matches a market. Returns 0-100 score."""
    market_text = (market['question'] + ' ' + market.get('description', '')).lower()
    market_keywords = set(extract_keywords(market_text))

    if not market_keywords or not news_keywords:
        return 0

    # Count keyword overlaps
    news_set = set(news_keywords)
    overlap = news_set & market_keywords
    if not overlap:
        return 0

    # Base score: % of news keywords that match
    base = len(overlap) / max(len(news_set), 1) * 60

    # Bonus for matching important/long words (likely proper nouns or specific terms)
    long_matches = [w for w in overlap if len(w) >= 5]
    base += min(len(long_matches) * 10, 30)

    # Cap at 90 from matching alone
    return min(base, 90)


def score_deal(market, match_score, news_article):
    """Compute final deal score (0-100) combining match + market characteristics."""
    score = match_score * 0.5  # 50% from news-market match

    # Price uncertainty bonus: closer to 50/50 = more uncertain = more opportunity
    prices = market.get('outcomePrices', [])
    if prices:
        max_price = max(prices)
        # Best when max_price is around 0.5 (uncertain), worst at 0.0 or 1.0
        uncertainty = 1 - abs(max_price - 0.5) * 2  # 0 to 1
        score += uncertainty * 20  # Up to 20 points

    # Volume bonus: higher volume = more liquid market
    vol24 = market.get('volume24hr', 0)
    if vol24 > 100000:
        score += 15
    elif vol24 > 10000:
        score += 10
    elif vol24 > 1000:
        score += 5

    # Liquidity bonus
    liq = market.get('liquidity', 0)
    if liq > 50000:
        score += 10
    elif liq > 10000:
        score += 5

    # News recency bonus
    try:
        pub = datetime.fromisoformat(news_article['publishedAt'].replace('Z', '+00:00'))
        hours_ago = (datetime.now(timezone.utc) - pub).total_seconds() / 3600
        if hours_ago < 2:
            score += 5
        elif hours_ago < 6:
            score += 3
    except Exception:
        pass

    return min(round(score), 100)


def find_deals(news_articles, markets):
    """Cross-reference news with markets to find deals."""
    print(f"\n[MATCHING] {len(news_articles)} articles × {len(markets)} markets")
    deals = []
    seen_combos = set()

    for article in news_articles:
        news_keywords = extract_keywords(article['title'])
        if len(news_keywords) < 2:
            continue

        for market in markets:
            combo_key = f"{article['url']}:{market['id']}"
            if combo_key in seen_combos:
                continue

            match_score = compute_match_score(news_keywords, market)
            if match_score < 20:
                continue

            seen_combos.add(combo_key)
            final_score = score_deal(market, match_score, article)

            if final_score < 25:
                continue

            prices = market.get('outcomePrices', [])
            outcomes = market.get('outcomes', [])

            deals.append({
                'id': make_id(combo_key),
                'score': final_score,
                'newsTitle': article['title'],
                'newsUrl': article['url'],
                'newsSource': article['source'],
                'newsPublishedAt': article['publishedAt'],
                'marketId': market['id'],
                'marketQuestion': market['question'],
                'marketSlug': market.get('slug', ''),
                'marketIcon': market.get('icon', ''),
                'outcomes': outcomes,
                'outcomePrices': prices,
                'volume24hr': market.get('volume24hr', 0),
                'liquidity': market.get('liquidity', 0),
                'endDate': market.get('endDate', ''),
                'matchedAt': datetime.now(timezone.utc).isoformat(),
            })

    # Sort by score descending, keep top N
    deals.sort(key=lambda d: d['score'], reverse=True)
    deals = deals[:MAX_DEALS]

    print(f"  → {len(deals)} deals found (score >= 25)")
    return deals


# ===== Persistence =====

def load_existing():
    if not os.path.exists(DATA_PATH):
        return {'updatedAt': '', 'deals': [], 'stats': {}}
    try:
        with open(DATA_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'updatedAt': '', 'deals': [], 'stats': {}}


def save_data(deals, stats):
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    data = {
        'updatedAt': datetime.now(timezone.utc).isoformat(),
        'deals': deals,
        'stats': stats,
    }
    # Atomic write
    tmp = DATA_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_PATH)


# ===== Main =====

def main():
    print("=== Polymarket Deals Finder ===")
    print(f"Output: {DATA_PATH}")

    # Load existing to merge dismissed/archived
    existing = load_existing()
    existing_deals = {d['id']: d for d in existing.get('deals', [])}

    # 1. Fetch news
    print("\n[NEWS]")
    news_articles = fetch_all_news()
    print(f"\nTotal news articles: {len(news_articles)}")

    # 2. Fetch active markets
    markets = fetch_active_markets()

    # 3. Cross-reference and score
    deals = find_deals(news_articles, markets)

    # 4. Merge with existing: preserve dismissed status
    for deal in deals:
        old = existing_deals.get(deal['id'])
        if old:
            deal['dismissed'] = old.get('dismissed', False)
            deal['starred'] = old.get('starred', False)
            deal['firstSeenAt'] = old.get('firstSeenAt', deal['matchedAt'])
        else:
            deal['dismissed'] = False
            deal['starred'] = False
            deal['firstSeenAt'] = deal['matchedAt']

    # 5. Compute stats
    stats = {
        'totalDeals': len(deals),
        'highScore': len([d for d in deals if d['score'] >= 70]),
        'mediumScore': len([d for d in deals if 40 <= d['score'] < 70]),
        'lowScore': len([d for d in deals if d['score'] < 40]),
        'sourceCount': len(set(d['newsSource'] for d in deals)),
        'marketCount': len(set(d['marketId'] for d in deals)),
        'avgScore': round(sum(d['score'] for d in deals) / max(len(deals), 1), 1),
    }

    # 6. Save
    save_data(deals, stats)

    print(f"\n✓ {len(deals)} deals saved to {DATA_PATH}")
    print(f"  High: {stats['highScore']} | Medium: {stats['mediumScore']} | Low: {stats['lowScore']}")
    print(f"  Avg score: {stats['avgScore']}")


if __name__ == '__main__':
    main()
