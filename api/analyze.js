require('dotenv').config();
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic();

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function isRateLimited(ip) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase()
    .from('analyses')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', since);
  return count >= 5;
}

async function logAnalysis(ip, url, result) {
  await supabase().from('analyses').insert({
    ip,
    url,
    verdict: result.verdict,
    confidence: result.confidence,
    summary: result.summary,
    signals: result.signals,
    content_type: result.content_type,
    title: result.title,
  });
}

const DETECTION_PROMPT = `You are an expert AI content detector. Analyze the following content extracted from a webpage and determine whether it was created by AI or by a human.

Look for these AI indicators:
- Unnaturally uniform sentence structure and length
- Overuse of transitional phrases ("Furthermore", "Additionally", "Moreover", "In conclusion")
- Hedging language and excessive qualifications
- Generic, vague statements lacking personal voice or specific detail
- Perfect grammar with no colloquialisms or personality
- Repetitive or formulaic paragraph structure
- Lack of genuine opinion, humor, or emotional texture
- Suspiciously balanced "on one hand / on the other hand" framing
- Overuse of em-dashes, colons, and bullet points in predictable patterns
- Content that feels comprehensive but shallow

Also look for human indicators:
- Typos, informal language, or colloquialisms
- Strong personal opinions or unique perspective
- Specific anecdotes or niche references
- Inconsistent style or voice that evolves naturally
- Humor, sarcasm, or genuine emotional resonance
- Unusual structure that breaks conventions intentionally

CONTENT TO ANALYZE:
---
{CONTENT}
---

CONTENT TYPE: {TYPE}
SOURCE URL: {URL}

Respond in this exact JSON format:
{
  "verdict": "AI-Generated" | "Human-Written" | "Likely AI-Generated" | "Likely Human-Written",
  "confidence": <integer 0-100>,
  "summary": "<2-3 sentence confident explanation of your verdict>",
  "signals": {
    "ai_indicators": ["<indicator 1>", "<indicator 2>", ...],
    "human_indicators": ["<indicator 1>", "<indicator 2>", ...]
  },
  "content_type": "<what kind of content this is, e.g. news article, blog post, product description, social media post, etc.>"
}

Be direct and confident. Do not hedge your verdict. Give a clear answer.`;

async function fetchPageContent(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 15000,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const html = await response.text();
  const $ = cheerio.load(html);

  $('script, style, nav, footer, header, aside, .ad, .advertisement, .cookie-banner, noscript, iframe').remove();

  const selectors = [
    'article', '[role="main"]', 'main', '.post-content', '.article-body',
    '.entry-content', '.content', '#content', '.story-body', '.post-body',
  ];

  let text = '';
  for (const selector of selectors) {
    const el = $(selector);
    if (el.length && el.text().trim().length > 200) {
      text = el.text();
      break;
    }
  }

  if (!text || text.trim().length < 200) {
    text = $('body').text();
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 8000) {
    text = text.substring(0, 8000) + '... [content truncated]';
  }

  const title = $('title').text().trim() || $('h1').first().text().trim() || 'Unknown';

  return { text, title, contentType };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error();
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL. Please include http:// or https://' });
  }

  // SSRF protection
  const hostname = parsedUrl.hostname.toLowerCase();
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.', '10.', '192.168.', '172.'];
  if (blocked.some(b => hostname.startsWith(b) || hostname === b)) {
    return res.status(400).json({ error: 'Private or local URLs are not allowed.' });
  }

  // Rate limiting via Supabase
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  try {
    if (await isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
  } catch (e) {
    // Don't block the request if Supabase is unreachable
    console.error('Rate limit check failed:', e.message);
  }

  try {
    const { text, title, contentType } = await fetchPageContent(url);

    if (!text || text.trim().length < 50) {
      return res.status(422).json({ error: 'Could not extract enough text content from this URL. The page may require JavaScript or a login.' });
    }

    const prompt = DETECTION_PROMPT
      .replace('{CONTENT}', text)
      .replace('{TYPE}', contentType)
      .replace('{URL}', url);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = message.content[0].text.trim();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse analysis response.');

    const analysis = JSON.parse(jsonMatch[0]);
    analysis.title = title;
    analysis.url = url;

    // Log to Supabase (non-blocking)
    logAnalysis(ip, url, analysis).catch(e => console.error('Log failed:', e.message));

    return res.json(analysis);
  } catch (err) {
    console.error('Analysis error:', err);

    if (err.code === 'ENOTFOUND' || err.message.includes('fetch')) {
      return res.status(502).json({ error: 'Could not reach that URL. Check that it is publicly accessible.' });
    }
    if (err.message.includes('timeout')) {
      return res.status(504).json({ error: 'The URL took too long to respond.' });
    }

    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
};
