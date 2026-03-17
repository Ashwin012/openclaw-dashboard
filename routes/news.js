module.exports = function createNewsRoutes({ requireAuth }) {
  const router = require('express').Router();
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const { readJSON, writeJSON } = require('../lib/json-store');

  // ===== News CRUD =====

  const newsPath = path.join(__dirname, '..', '.dashboard', 'news.json');

  function readNews() {
    const data = readJSON(newsPath, { articles: [] });
    return Array.isArray(data.articles) ? data.articles : [];
  }

  function writeNews(articles) {
    writeJSON(newsPath, { articles });
  }

  router.get('/api/news', requireAuth, (req, res) => {
    let articles = readNews();
    const { category, read } = req.query;
    if (category) articles = articles.filter(a => a.category === category);
    if (read !== undefined) articles = articles.filter(a => String(a.read) === read);
    res.json(articles);
  });

  router.post('/api/news', requireAuth, (req, res) => {
    const { title, summary, url, source, category, publishedAt } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
    const article = {
      id: crypto.randomUUID(),
      title: title.trim(),
      summary: summary || '',
      url: url || '',
      source: source || '',
      category: category || 'ai',
      publishedAt: publishedAt || new Date().toISOString(),
      addedAt: new Date().toISOString(),
      read: false
    };
    const articles = readNews();
    articles.unshift(article);
    writeNews(articles);
    res.status(201).json(article);
  });

  router.put('/api/news/:id', requireAuth, (req, res) => {
    const articles = readNews();
    const idx = articles.findIndex(a => a.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Article not found' });
    articles[idx] = { ...articles[idx], ...req.body, id: articles[idx].id };
    writeNews(articles);
    res.json(articles[idx]);
  });

  router.delete('/api/news/:id', requireAuth, (req, res) => {
    const articles = readNews();
    const idx = articles.findIndex(a => a.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Article not found' });
    articles.splice(idx, 1);
    writeNews(articles);
    res.json({ ok: true });
  });

  // ===== Aggregated News Feed (from fetch-news.py output) =====

  const newsFeedPath = path.join(__dirname, '..', 'data', 'news.json');

  function readNewsFeed() {
    return readJSON(newsFeedPath, { updatedAt: null, articles: [] });
  }

  function writeNewsFeed(data) {
    writeJSON(newsFeedPath, data);
  }

  router.get('/api/news/feed', requireAuth, (req, res) => {
    const data = readNewsFeed();
    let articles = data.articles || [];
    const { category } = req.query;
    if (category && category !== 'all') articles = articles.filter(a => a.category === category);
    res.json({ updatedAt: data.updatedAt, articles });
  });

  router.post('/api/news/summarize', requireAuth, async (req, res) => {
    const { execFile } = require('child_process');
    const feedPath = path.join(__dirname, '..', 'data', 'news.json');
    const data = readNewsFeed();
    const articles = data.articles || [];
    const needSummary = articles.filter(a => !a.summary || a.summary === a.title || a.summary.includes('Je ne'));
    const count = needSummary.length;
    if (count === 0) return res.json({ count: 0, status: 'nothing_to_do' });
    // Fire and forget: spawn summarize script
    const script = `
import json, subprocess, sys, os
path = "${feedPath.replace(/\\/g, '/')}"
d = json.load(open(path))
updated = 0
for a in d["articles"]:
    s = a.get("summary","")
    if not s or s == a["title"] or "Je ne" in s:
        try:
            prompt = f"Résume cet article en français, 3-5 lignes, style journalistique. Titre: {a['title']}. Ne dis JAMAIS 'je ne peux pas'. Si tu n'as que le titre, reformule-le en 2-3 phrases informatives.\\n"
            result = subprocess.run(["claude", "--print", "-p", prompt], capture_output=True, text=True, timeout=30, env={**os.environ, "CLAUDE_CODE_OAUTH_TOKEN": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN","")})
            if result.returncode == 0 and result.stdout.strip():
                a["summary"] = result.stdout.strip()
                updated += 1
        except: pass
json.dump(d, open(path,"w"), indent=2, ensure_ascii=False)
print(f"Updated {updated} articles")
`;
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || '' };
    const child = execFile('python3', ['-c', script], { env, timeout: 600000 }, (err) => {
      if (err) console.error('Summarize error:', err.message);
    });
    child.unref();
    res.json({ count, status: 'triggered' });
  });

  router.post('/api/news/:id/like', requireAuth, (req, res) => {
    const data = readNewsFeed();
    const article = (data.articles || []).find(a => a.id === req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    article.likes = (article.likes || 0) + 1;
    writeNewsFeed(data);
    res.json({ likes: article.likes, dislikes: article.dislikes });
  });

  router.post('/api/news/:id/dislike', requireAuth, (req, res) => {
    const data = readNewsFeed();
    const article = (data.articles || []).find(a => a.id === req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    article.dislikes = (article.dislikes || 0) + 1;
    writeNewsFeed(data);
    res.json({ likes: article.likes, dislikes: article.dislikes });
  });

  return router;
};
