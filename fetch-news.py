#!/usr/bin/env python3
"""
News aggregator for dev-dashboard.
Fetches from RSS feeds + Hacker News API, generates French AI summaries, saves to data/news.json.
"""

import json
import os
import sys
import hashlib
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from email.utils import parsedate_to_datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(SCRIPT_DIR, 'data', 'news.json')
MAX_AGE_DAYS = 7
MAX_PER_CATEGORY = 15
REQUEST_TIMEOUT = 15

CATEGORIES = {
    'ai': [
        {'type': 'hackernews', 'name': 'Hacker News'},
        {'type': 'rss', 'url': 'https://techcrunch.com/category/artificial-intelligence/feed/', 'name': 'TechCrunch AI'},
    ],
    'crypto': [
        {'type': 'rss', 'url': 'https://www.coindesk.com/arc/outboundfeeds/rss/', 'name': 'CoinDesk'},
        {'type': 'rss', 'url': 'https://cointelegraph.com/rss', 'name': 'CoinTelegraph'},
    ],
    'realestate': [
        {'type': 'rss', 'url': 'https://news.google.com/rss/search?q=immobilier+maurice+OR+real+estate+mauritius&hl=fr', 'name': 'Google News Immo MU'},
    ],
    'ev': [
        {'type': 'rss', 'url': 'https://electrek.co/feed/', 'name': 'Electrek'},
        {'type': 'rss', 'url': 'https://insideevs.com/rss/news/all/', 'name': 'InsideEVs'},
    ],
    'mauritius': [
        {'type': 'rss', 'url': 'https://news.google.com/rss/search?q=mauritius+business+OR+maurice+economie&hl=fr', 'name': 'Google News Maurice'},
    ],
    'world': [
        {'type': 'rss', 'url': 'https://feeds.reuters.com/reuters/worldNews', 'name': 'Reuters World'},
        {'type': 'rss', 'url': 'https://feeds.bbci.co.uk/news/world/rss.xml', 'name': 'BBC World'},
        {'type': 'rss', 'url': 'https://www.france24.com/fr/rss', 'name': 'France24'},
    ],
}

AI_KEYWORDS = [
    'ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'openai',
    'anthropic', 'claude', 'gemini', 'mistral', 'llama', 'neural', 'deep learning',
    'chatgpt', 'language model', 'generative', 'transformer', 'diffusion',
    'intel', 'nvidia', 'cuda', 'gpu', 'inference', 'training',
]


def make_id(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def load_existing() -> dict:
    if not os.path.exists(DATA_PATH):
        return {'updatedAt': '', 'articles': []}
    try:
        with open(DATA_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'updatedAt': '', 'articles': []}


def save_data(articles: list):
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    data = {
        'updatedAt': datetime.now(timezone.utc).isoformat(),
        'articles': articles,
    }
    with open(DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def fetch_url(url: str) -> bytes:
    req = Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; NewsFetcher/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    })
    with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.read()


def parse_date(date_str: str) -> str:
    """Parse various date formats and return ISO 8601 string."""
    if not date_str:
        return datetime.now(timezone.utc).isoformat()
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    try:
        # Try ISO format
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    return datetime.now(timezone.utc).isoformat()


def get_text(elem, tag: str, default: str = '') -> str:
    """Get text from XML child element."""
    if elem is None:
        return default
    child = elem.find(tag)
    if child is not None and child.text:
        return child.text.strip()
    return default


def extract_image_from_item(item) -> str:
    """Try to extract image URL from RSS item."""
    # media:content or media:thumbnail
    for ns in ['http://search.yahoo.com/mrss/', 'http://www.w3.org/2005/Atom']:
        for tag in [f'{{{ns}}}content', f'{{{ns}}}thumbnail']:
            el = item.find(tag)
            if el is not None:
                url = el.get('url', '')
                if url:
                    return url
    # enclosure
    enc = item.find('enclosure')
    if enc is not None:
        url = enc.get('url', '')
        if url and ('image' in enc.get('type', '') or url.endswith(('.jpg', '.jpeg', '.png', '.webp'))):
            return url
    # itunes:image
    itunes_img = item.find('{http://www.itunes.com/dtds/podcast-1.0.dtd}image')
    if itunes_img is not None:
        return itunes_img.get('href', '')
    return ''


def fetch_rss(source: dict, category: str) -> list:
    """Fetch and parse an RSS feed, return list of article dicts."""
    url = source['url']
    name = source['name']
    articles = []
    print(f"  Fetching {name} ({url[:60]}...)")
    try:
        raw = fetch_url(url)
        # Remove namespace declarations that confuse ElementTree
        raw_str = raw.decode('utf-8', errors='replace')
        # Parse XML
        try:
            root = ET.fromstring(raw_str)
        except ET.ParseError:
            # Try stripping problematic content
            raw_str = raw_str.replace('&', '&amp;')
            try:
                root = ET.fromstring(raw_str)
            except ET.ParseError as e:
                print(f"  ⚠ XML parse error for {name}: {e}")
                return []

        # Handle both RSS and Atom
        # RSS: rss/channel/item
        # Atom: feed/entry
        items = root.findall('.//item')
        if not items:
            # Try Atom
            ns = {'atom': 'http://www.w3.org/2005/Atom'}
            items = root.findall('.//atom:entry', ns)
            for item in items:
                title_el = item.find('atom:title', ns)
                link_el = item.find('atom:link', ns)
                date_el = item.find('atom:updated', ns) or item.find('atom:published', ns)
                title = title_el.text.strip() if title_el is not None and title_el.text else ''
                link = link_el.get('href', '') if link_el is not None else ''
                pub_date = date_el.text.strip() if date_el is not None and date_el.text else ''
                if not title or not link:
                    continue
                articles.append({
                    'id': make_id(link),
                    'title': title,
                    'url': link,
                    'source': name,
                    'category': category,
                    'publishedAt': parse_date(pub_date),
                    'imageUrl': '',
                    'summary': '',
                    'likes': 0,
                    'dislikes': 0,
                })
            return articles

        for item in items:
            title = get_text(item, 'title')
            link = get_text(item, 'link') or get_text(item, 'guid')
            pub_date = get_text(item, 'pubDate') or get_text(item, 'dc:date') or get_text(item, '{http://purl.org/dc/elements/1.1/}date')
            image_url = extract_image_from_item(item)

            if not title or not link:
                continue

            # Fix Google News redirect links — use the actual link from guid if possible
            if 'news.google.com' in link:
                guid = get_text(item, 'guid')
                if guid and guid.startswith('http') and 'news.google.com' not in guid:
                    link = guid

            articles.append({
                'id': make_id(link),
                'title': title,
                'url': link,
                'source': name,
                'category': category,
                'publishedAt': parse_date(pub_date),
                'imageUrl': image_url,
                'summary': '',
                'likes': 0,
                'dislikes': 0,
            })
    except (URLError, HTTPError) as e:
        print(f"  ⚠ Network error fetching {name}: {e}")
    except Exception as e:
        print(f"  ⚠ Error fetching {name}: {e}")
    return articles


def fetch_hackernews() -> list:
    """Fetch HN top stories and filter AI/LLM related ones."""
    articles = []
    print("  Fetching Hacker News top stories...")
    try:
        raw = fetch_url('https://hacker-news.firebaseio.com/v0/topstories.json')
        story_ids = json.loads(raw)[:80]  # Check top 80 stories

        fetched = 0
        for story_id in story_ids:
            if fetched >= 20:  # Check max 20 for AI relevance
                break
            try:
                item_raw = fetch_url(f'https://hacker-news.firebaseio.com/v0/item/{story_id}.json')
                item = json.loads(item_raw)
                if not item or item.get('type') != 'story':
                    continue
                title = item.get('title', '')
                url = item.get('url', '')
                if not url:
                    url = f'https://news.ycombinator.com/item?id={story_id}'
                # Filter for AI-related
                title_lower = title.lower()
                if not any(kw in title_lower for kw in AI_KEYWORDS):
                    continue
                timestamp = item.get('time', int(time.time()))
                pub_date = datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
                articles.append({
                    'id': make_id(url),
                    'title': title,
                    'url': url,
                    'source': 'Hacker News',
                    'category': 'ai',
                    'publishedAt': pub_date,
                    'imageUrl': '',
                    'summary': '',
                    'likes': 0,
                    'dislikes': 0,
                })
                fetched += 1
                time.sleep(0.1)  # Be gentle with the API
            except Exception:
                continue
    except Exception as e:
        print(f"  ⚠ Error fetching HN: {e}")
    return articles


def fetch_article_text(url, max_chars=2000):
    """Fetch article text content for summarization."""
    try:
        req = Request(url, headers=HEADERS)
        with urlopen(req, timeout=15) as r:
            html = r.read().decode('utf-8', errors='replace')
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text[:max_chars]
    except Exception:
        return ""

def generate_summary(title, url):
    """Generate a French AI summary using claude CLI."""
    import subprocess
    content = fetch_article_text(url)
    content_part = f"\n\nContenu:\n{content[:1500]}" if content else ""
    try:
        prompt = f"Résume cet article en 3-5 lignes en français. Titre: {title}{content_part}\n\nRéponds UNIQUEMENT avec le résumé, sans préambule."
        result = subprocess.run(
            ['claude', '--print', '-p', prompt, '--model', 'claude-sonnet-4-20250514'],
            capture_output=True, text=True, timeout=45,
            env={**os.environ, 'CLAUDE_CODE_OAUTH_TOKEN': os.environ.get('CLAUDE_CODE_OAUTH_TOKEN', '')}
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        print(f"  warn claude CLI: {result.stderr[:100]}")
        return title
    except subprocess.TimeoutExpired:
        print(f"  warn claude timeout")
        return title
    except Exception as e:
        print(f"  warn claude error: {e}")
        return title

def is_recent(published_at: str) -> bool:
    """Check if article is within the last 7 days."""
    try:
        dt = datetime.fromisoformat(published_at.replace('Z', '+00:00'))
        cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
        return dt >= cutoff
    except Exception:
        return True  # Keep if we can't parse


def main():
    print("=== News Aggregator ===")
    print(f"Output: {DATA_PATH}")

    # Load existing data
    existing = load_existing()
    existing_articles = existing.get('articles', [])
    existing_ids = {a['id'] for a in existing_articles}
    existing_map = {a['id']: a for a in existing_articles}

    print(f"Existing articles: {len(existing_articles)}")

    all_new = []

    # Fetch from all sources
    for category, sources in CATEGORIES.items():
        print(f"\n[{category.upper()}]")
        cat_articles = []

        for source in sources:
            if source['type'] == 'hackernews':
                fetched = fetch_hackernews()
            elif source['type'] == 'rss':
                fetched = fetch_rss(source, category)
            else:
                continue

            # Filter to new only
            new_articles = [a for a in fetched if a['id'] not in existing_ids]
            print(f"  → {len(fetched)} fetched, {len(new_articles)} new")
            cat_articles.extend(new_articles)

        all_new.extend(cat_articles)

    print(f"\nTotal new articles: {len(all_new)}")

    # Set summary = title for new articles (OpenClaw cron handles AI summarization)
    if all_new:
        print(f"\n{len(all_new)} new articles — summaries will be generated by OpenClaw cron")
        for article in all_new:
            article['summary'] = article['title']

    # Merge: new articles first, then existing (preserving likes/dislikes)
    # Keep existing likes/dislikes from existing_map
    merged = []
    seen_ids = set()

    # Add new articles first
    for article in all_new:
        if article['id'] not in seen_ids:
            merged.append(article)
            seen_ids.add(article['id'])

    # Add existing articles (preserving their data)
    for article in existing_articles:
        if article['id'] not in seen_ids:
            merged.append(article)
            seen_ids.add(article['id'])

    # Filter to last 7 days
    merged = [a for a in merged if is_recent(a.get('publishedAt', ''))]

    # Sort by date descending
    merged.sort(key=lambda a: a.get('publishedAt', ''), reverse=True)

    # Limit per category
    category_counts = {}
    final = []
    for article in merged:
        cat = article.get('category', '')
        count = category_counts.get(cat, 0)
        if count < MAX_PER_CATEGORY:
            final.append(article)
            category_counts[cat] = count + 1

    print(f"\nFinal articles: {len(final)}")
    for cat, count in sorted(category_counts.items()):
        print(f"  {cat}: {count}")

    save_data(final)
    print(f"\n✓ Saved to {DATA_PATH}")


if __name__ == '__main__':
    main()
