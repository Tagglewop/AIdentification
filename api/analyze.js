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
- Content that feels comprehensive but shallow
- Excessive em dashes used for artificial tension between clauses (e.g. "like this—instead of using a comma")
- Forced sass or artificial edge: phrases like "But here's the thing:", "Then I realized:", "Hot take:", "The result?"
- AI buzzwords: "delve," "crucial," "significant," "important," "unlock," "empower," "elevate" used frequently
- Clichéd opening phrases: "In today's fast-paced digital landscape", "In the dynamic world of...", "As the world continues to evolve…"
- Obsession with "looming challenges" and diplomatic "advantages and disadvantages" framing
- Formulaic structures: rule-of-three, "No X. No Y. Just Z.", "It is not just X. It's also Y."
- Sudden unexplained bullet point lists or random emoji placement mid-prose
- Title patterns like "X Things You Should Know" or "From X to Y"
- Self-referential AI language: "As a large-scale language model" (major red flag)
- Longer-than-natural sentence length and inflated word count with little added meaning

Also look for human indicators:
- Typos, informal language, or colloquialisms
- Strong personal opinions or unique perspective
- Specific anecdotes or niche references
- Inconsistent style or voice that evolves naturally
- Humor, sarcasm, or genuine emotional resonance
- Unusual structure that breaks conventions intentionally
- Natural imperfection: sentence fragments, run-ons, or casual grammar used deliberately

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
  "content_type": "<what kind of content this is, e.g. news article, blog post, product description, social media post, tweet, etc.>"
}

Be direct and confident. Do not hedge your verdict. Give a clear answer.`;

function isTwitterUrl(url) {
  const host = new URL(url).hostname.replace('www.', '');
  return host === 'twitter.com' || host === 'x.com';
}

function isRedditUrl(url) {
  const host = new URL(url).hostname.replace('www.', '').replace('old.', '').replace('new.', '');
  return host === 'reddit.com';
}

async function getRedditToken() {
  if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
    throw new Error('Reddit API credentials are not configured. Add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in Vercel environment variables.');
  }

  const credentials = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'User-Agent': 'AIdetificator/1.0',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    timeout: 8000,
  });

  if (!response.ok) {
    throw new Error('Reddit authentication failed. Check that REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are correct.');
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Reddit did not return an access token. Check your API credentials.');
  }
  return data.access_token;
}

async function fetchRedditContent(url) {
  const match = url.match(/comments\/([a-z0-9]+)/i);
  if (!match) {
    throw new Error('Could not extract post ID from this Reddit URL.');
  }
  const postId = match[1];

  const token = await getRedditToken();

  const response = await fetch(`https://oauth.reddit.com/comments/${postId}?limit=1&depth=1&raw_json=1`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'AIdetificator/1.0',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });

  if (response.status === 403) {
    throw new Error('This Reddit post is from a private community.');
  }
  if (response.status === 404) {
    throw new Error('This Reddit post could not be found. It may have been deleted.');
  }
  if (!response.ok) {
    throw new Error(`Could not fetch Reddit post (${response.status}).`);
  }

  const data = await response.json();
  const post = data[0]?.data?.children?.[0]?.data;

  if (!post) {
    throw new Error('Could not parse Reddit post data.');
  }

  const title = post.title || '';
  const body = post.selftext || '';
  const author = post.author || 'unknown';
  const subreddit = post.subreddit_name_prefixed || 'Reddit';

  if (body === '[deleted]' || body === '[removed]') {
    throw new Error('This Reddit post has been deleted or removed.');
  }

  if (!body && !title) {
    throw new Error('This Reddit post has no text content to analyze. It may be a link or image post.');
  }

  const text = [title, `by u/${author} on ${subreddit}`, body]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    text,
    title: title || 'Reddit Post',
    contentType: 'Reddit post',
  };
}

async function fetchTwitterContent(url) {
  // Use Twitter's public oEmbed API — no auth required
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
  const response = await fetch(oembedUrl, { timeout: 10000 });

  if (!response.ok) {
    throw new Error('Could not fetch this tweet. It may be from a private account or no longer exist.');
  }

  const data = await response.json();
  const $ = cheerio.load(data.html);

  // Preserve line breaks before stripping tags
  $('br').replaceWith('\n');
  $('p a').each((_, el) => {
    const href = $(el).attr('href') || '';
    // Strip trailing hashtag/mention links that clutter the text
    if (href.startsWith('https://twitter.com/hashtag') || href.includes('/status/')) return;
  });

  const tweetText = $('p').first().text().trim();
  const author = data.author_name || 'Unknown';

  if (!tweetText) {
    throw new Error('Could not extract tweet text.');
  }

  const isThread = /🧵|^1\/|\/\d+$|\bthread\b/i.test(tweetText);

  return {
    text: `Tweet by ${author}:\n\n${tweetText}`,
    title: `Tweet by ${author}`,
    contentType: 'tweet',
    isThread,
  };
}

async function fetchPageContent(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 10000,
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
    console.error('Rate limit check failed:', e.message);
  }

  try {
    const { text, title, contentType, isThread } = isTwitterUrl(url)
      ? await fetchTwitterContent(url)
      : isRedditUrl(url)
        ? await fetchRedditContent(url)
        : await fetchPageContent(url);

    if (!text || text.trim().length < 50) {
      return res.status(422).json({ error: 'Could not extract enough text content from this URL. The page may require JavaScript or a login.' });
    }

    const threadNote = isThread
      ? '\n\nNOTE: This appears to be the opening tweet of a thread. The analysis is based on this tweet only. Factor in that threads are a common format for both AI-generated and human content, and note this limitation in your summary.'
      : '';

    const prompt = (DETECTION_PROMPT + threadNote)
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
    analysis.is_thread = isThread || false;

    logAnalysis(ip, url, analysis).catch(e => console.error('Log failed:', e.message));

    return res.json(analysis);
  } catch (err) {
    console.error('Analysis error:', err.message);

    // Only treat actual network/DNS errors as "can't reach URL"
    if (err.name === 'FetchError' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return res.status(502).json({ error: 'Could not reach that URL. Check that it is publicly accessible.' });
    }
    if (err.type === 'request-timeout' || err.message.includes('network timeout')) {
      return res.status(504).json({ error: 'The URL took too long to respond.' });
    }
    // Surface the real error — anything not caught above is user-facing
    return res.status(422).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
};
