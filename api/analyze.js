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

const DETECTION_PROMPT = `You are a forensic AI content analyst. Your job is to determine with high accuracy whether the following content was written by an AI or a human. Accuracy is the only priority — do not guess or default to a verdict when evidence is thin.

CONTENT TO ANALYZE:
---
{CONTENT}
---
CONTENT TYPE: {TYPE}
SOURCE: {URL}

## YOUR ANALYSIS PROCESS

Work through these steps carefully:

**STEP 1 — VOCABULARY SCAN**
Flag any of these high-specificity AI words: "delve," "delves," "delving," "nuanced," "crucial," "multifaceted," "comprehensive," "leverage," "unlock," "empower," "elevate," "robust," "pivotal," "seamless," "streamline," "cutting-edge," "game-changing," "foster," "realm," "landscape," "utilize" (when "use" would do).
More than 2-3 of these = strong AI signal.

**STEP 2 — STRUCTURE SCAN**
Check for:
- Formulaic openers: "In today's [X] world", "In the ever-evolving landscape of", "As we navigate"
- Artificial transitions: "Furthermore," "Moreover," "Additionally," "In conclusion," "It is worth noting"
- Rule-of-three constructions: "Not only X, but also Y and Z"
- "But here's the thing:" / "The result?" / "Hot take:" patterns
- Suspiciously uniform paragraph lengths
- Em dash overuse for "dramatic tension—like this"
- Headers and bullet points that feel auto-generated rather than editorially chosen

**STEP 3 — VOICE & AUTHENTICITY SCAN**
Does the writing have a genuine, consistent personality? Ask:
- Does it express opinions that could be controversial, or does it stay diplomatically neutral on everything?
- Are there specific personal details, niche references, or lived-experience moments that would be unusual for AI to fabricate?
- Does it make any mistakes that reveal the author (consistent typos, regional slang, unconventional punctuation habits)?
- Does the emotional register feel earned or performed?
- Is the content genuinely specific or does it generalize when specifics would be expected?

**STEP 4 — BASE RATE ADJUSTMENT**
Consider the source and format:
- SEO blog posts, LinkedIn posts, product descriptions = high prior probability of AI
- Personal essays, news articles, opinion pieces with named bylines = lower prior probability
- Short social posts with slang/typos = likely human
- Academic or highly technical content = could be either

**STEP 5 — WEIGH THE EVIDENCE**
List every specific signal you found (quote exact phrases where possible). Weigh them. Reach a verdict.

**CONFIDENCE CALIBRATION — follow this strictly:**
- 90–100%: Multiple high-specificity AI signals found, or explicit AI self-reference. OR: clear personal voice, typos, specific lived details, and zero AI markers.
- 75–89%: Several strong signals clearly pointing one direction with minimal counterevidence.
- 60–74%: Moderate evidence leaning one direction but some counterevidence present.
- 50–59%: Mixed signals. Genuinely uncertain — still pick the more likely verdict but reflect the uncertainty.
- Never assign high confidence to a verdict you cannot support with specific textual evidence.

Respond in this exact JSON format (no other text):
{
  "verdict": "AI-Generated" | "Human-Written" | "Likely AI-Generated" | "Likely Human-Written",
  "confidence": <integer 50-100>,
  "summary": "<3-4 sentences citing specific evidence from the text that drove your verdict>",
  "signals": {
    "ai_indicators": ["<specific quoted phrase or pattern>", ...],
    "human_indicators": ["<specific quoted phrase or pattern>", ...]
  },
  "content_type": "<specific content type>"
}`;

const IMAGE_PROMPT = `You are a forensic AI image analyst specializing in detecting modern photorealistic AI generation. Your most important job is correctly identifying high-quality AI images that LACK obvious artifacts. Modern AI (Midjourney v6, DALL-E 3, Flux, Stable Diffusion XL) produces images with correct finger counts, readable text, and coherent backgrounds — do NOT rely on old artifact checklists alone.

## CRITICAL RULE
Absence of obvious artifacts (extra fingers, garbled text) does NOT mean the image is human-created. Modern AI is very good. You must look deeper.

## YOUR ANALYSIS PROCESS

**STEP 1 — MODERN AI TELLS (most important for high-quality AI)**
These are what catches modern photorealistic AI:
- **Skin micro-texture**: Real skin at close range shows actual pores, fine veins, subtle discoloration, and texture variation across the face. AI skin — even when not "waxy" — often has an internal glow or impossible uniformity. Zoom into skin areas mentally.
- **Lighting plausibility**: Is the lighting flattering in a way that would be unlikely in a candid or realistic setting? AI images are lit like professional shoots even in casual contexts (car selfies, snapshots). Real candid photos have harsh shadows, unflattering angles, blown highlights.
- **Composition perfection**: Is the scene composed like a stock photo or ad — subjects well-framed, all elements intentionally placed? Real photos have accidental clutter, slightly off framing, elements cut off. AI images feel "designed."
- **Expression authenticity**: AI subjects often have neutral, pleasant, or slightly vacant expressions. Real people in candid photos have micro-expressions, asymmetry, tension in the face from genuine emotion.
- **Scene plausibility**: Would this exact scene plausibly occur in real life with a real person holding a camera? Does the context make sense? AI often creates scenes that feel "assembled" from concepts rather than captured.
- **Background genericness**: Does the background look like a specific real location or a generic AI-rendered version of a type of location (e.g., "generic suburban street," "generic forest," "generic office")? Real backgrounds have specific, identifiable details.
- **Edge coherence on complex subjects**: Hair flyaways, fur, eyelashes, and fabric edges at the boundary between subject and background. AI frequently blends these incorrectly even when the center looks perfect.
- **Subject integration**: Do multiple subjects (people, animals, objects) feel naturally integrated in the same space and light, or does each look like it was placed into the scene separately?
- **The "too cute / too perfect" factor**: AI images of animals, children, and people together are often engineered to be maximally appealing. Real photos capture an imperfect moment.

**STEP 2 — CLASSIC ARTIFACT CHECK (still relevant)**
- Hands and fingers: count carefully, check proportions, look for fused/extra digits
- Eyes: check for authentic reflections, real iris detail, natural asymmetry
- Ears and teeth: simplified or melted geometry
- Text in the image: garbled, inconsistent, or misspelled
- Watermarks: Midjourney, DALL-E, Stable Diffusion, Adobe Firefly

**STEP 3 — CAMERA AUTHENTICITY CHECK**
Real photographs carry physical evidence of optics and sensors:
- Film grain or digital sensor noise (should be visible, especially in darker areas)
- Chromatic aberration at high-contrast edges (slight color fringing)
- Lens distortion appropriate to focal length (wide-angle barrel, telephoto compression)
- Natural bokeh with real aperture characteristics (not perfectly circular blur)
- Motion blur where expected (moving subjects, handheld shake)
- Depth-of-field that is optically correct — foreground subjects sharp, background blur gradual

**STEP 4 — WEIGH THE EVIDENCE**
List every signal found. Consider that a single strong modern-AI tell (e.g., impossibly flattering in-car lighting, generic suburb background, subjects with vacant expressions in a suspiciously well-composed scene) is worth more than the absence of obvious old artifacts.

**CONFIDENCE CALIBRATION:**
- 90–100%: Multiple strong signals clearly pointing one direction. For AI: combination of modern tells (perfect lighting, generic background, too-composed scene, smooth skin). For human: clear camera artifacts, specific real location, authentic imperfection.
- 75–89%: Several signals pointing one direction with minimal counterevidence.
- 60–74%: Moderate evidence, some ambiguity.
- 50–59%: Genuinely cannot determine — default to "Likely" rather than definitive.

Respond in this exact JSON format (no other text):
{
  "verdict": "AI-Generated" | "Human-Created" | "Likely AI-Generated" | "Likely Human-Created",
  "confidence": <integer 50-100>,
  "summary": "<3-4 sentences citing specific visual evidence from this image that drove your verdict — be specific about what you observed>",
  "signals": {
    "ai_indicators": ["<specific observation about this image>", ...],
    "human_indicators": ["<specific observation about this image>", ...]
  },
  "content_type": "<specific image type: portrait photo, landscape photo, digital illustration, etc.>"
}`;

function isTwitterUrl(url) {
  const host = new URL(url).hostname.replace('www.', '');
  return host === 'twitter.com' || host === 'x.com';
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

  const { url, text: rawText, imageUrl, imageData, mediaType } = req.body || {};

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  try {
    if (await isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
  } catch (e) {
    console.error('Rate limit check failed:', e.message);
  }

  try {
    let message;

    if (imageUrl || imageData) {
      // Image analysis mode
      const imageSource = imageData
        ? { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData }
        : { type: 'url', url: imageUrl };

      message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 12000,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: imageSource },
            { type: 'text', text: IMAGE_PROMPT },
          ],
        }],
      });
    } else {
      // Text / URL mode
      let text, title, contentType, isThread = false;

      if (rawText) {
        if (rawText.trim().length < 50) {
          return res.status(400).json({ error: 'Please paste at least a few sentences of text to analyze.' });
        }
        text = rawText.trim().slice(0, 8000);
        title = 'Pasted text';
        contentType = 'pasted text';
      } else {
        if (!url || typeof url !== 'string') {
          return res.status(400).json({ error: 'A URL, image, or pasted text is required.' });
        }
        let parsedUrl;
        try {
          parsedUrl = new URL(url);
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
        } catch {
          return res.status(400).json({ error: 'Invalid URL. Please include http:// or https://' });
        }
        const hostname = parsedUrl.hostname.toLowerCase();
        const ssrfBlocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.', '10.', '192.168.', '172.'];
        if (ssrfBlocked.some(b => hostname.startsWith(b) || hostname === b)) {
          return res.status(400).json({ error: 'Private or local URLs are not allowed.' });
        }
        ({ text, title, contentType, isThread } = isTwitterUrl(url)
          ? await fetchTwitterContent(url)
          : await fetchPageContent(url));
      }

      if (!text || text.trim().length < 50) {
        return res.status(422).json({ error: 'Could not extract enough text content. The page may require JavaScript or a login.' });
      }

      const threadNote = isThread
        ? '\n\nNOTE: This appears to be the opening tweet of a thread. The analysis is based on this tweet only. Factor in that threads are a common format for both AI-generated and human content, and note this limitation in your summary.'
        : '';

      const prompt = (DETECTION_PROMPT + threadNote)
        .replace('{CONTENT}', text)
        .replace('{TYPE}', contentType)
        .replace('{URL}', url || 'pasted text');

      message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 12000,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [{ role: 'user', content: prompt }],
      });
    }

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text response from model.');
    const responseText = textBlock.text.trim();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse analysis response.');

    const analysis = JSON.parse(jsonMatch[0]);
    analysis.title = imageData ? 'Uploaded image' : (imageUrl || url || 'Pasted text');
    analysis.url = url || imageUrl || null;
    analysis.is_thread = false;

    logAnalysis(ip, analysis.url, analysis).catch(e => console.error('Log failed:', e.message));

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
