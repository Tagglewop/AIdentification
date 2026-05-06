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

## HARD-STOP RULES — CHECK THESE FIRST
Some signals are definitive proof of AI generation. If you find any of the following, stop weighing evidence and immediately return "AI-Generated" at 90–98% confidence. Do not let authentic-looking surroundings, physically accurate details, or realistic lighting override these:

- **Garbled, nonsensical, or pseudo-alphabetic text anywhere in the image** — tire sidewalls, license plates, signs, labels, clothing, packaging, tattoos, dashboards. One instance of gibberish text is conclusive. AI cannot fabricate readable embedded text reliably.
- **Extra, fused, or missing fingers on a clearly visible hand**
- **Visible AI watermark** (Midjourney, DALL-E, Stable Diffusion, Adobe Firefly, etc.)
- **Anatomically impossible body geometry** on a clearly visible and in-focus subject

When a hard-stop signal is present: state it clearly as the primary finding, assign 90%+ confidence, and do not list surrounding realism (accurate physics, realistic grime, correct lighting) as counterevidence. Those details are irrelevant once a definitive artifact is confirmed — modern AI generates them routinely as filler. A convincingly rendered flat tire next to unreadable text is still AI.

## CRITICAL RULES
1. Absence of obvious artifacts (extra fingers, garbled text) does NOT mean the image is human-created. Modern AI is very good. You must look deeper.
2. The following are NOT reliable evidence of human creation — modern AI replicates all of them routinely. Do NOT list these as human signals:
   - Slightly awkward or off-center framing
   - Inexpressive, serious, or distracted-looking expressions
   - Readable text or signage in the background
   - Correct seatbelts, steering wheels, or car interiors
   - Slightly soft background blur (AI replicates computational portrait mode perfectly)
   - A scene that "makes sense" narratively (AI constructs plausible scenarios)
3. The more "authenticity checkboxes" an image appears to tick, the more suspicious you should be. Real photos don't need to prove themselves — they just exist. An image that feels like it was engineered to look candid often was.
4. Images submitted to an AI detection service have a high base rate of being AI. When genuinely uncertain, lean toward "Likely AI-Generated" rather than "Likely Human-Created."

## YOUR ANALYSIS PROCESS

**STEP 1 — IDENTIFY ANY PUBLIC FIGURES OR CELEBRITIES**
Before anything else, scan for public figures using ALL of these signals, not just facial recognition:

**A. Read any text in the image first.**
Captions, watermarks, name overlays, jersey names/numbers, event signage, title cards, and on-screen text are the highest-confidence identification signals available. If the image says someone's name, treat that as the primary identification — then verify whether the depicted face actually matches that person's known features.

**B. Use contextual signals.**
Setting and narrative context can confirm identity even without perfect facial match:
- Someone sitting ringside watching boxing: likely a celebrity who attends fights
- A private watching-party scene of Harry Potter: immediately raises Daniel Radcliffe as a candidate
- Political rally or podium with visible campaign branding: narrows the field instantly
- Sports event, jersey, trophy, or stadium context: cross-reference with athletes in that sport
- Fashion/gala/red carpet setting: narrow to entertainment industry figures

**C. Assess distinctive physical features.**
Go beyond just face — look for: height/build relative to others, distinctive hairstyle, known tattoos, glasses, birthmarks, posture, and signature style elements associated with known public figures.

**D. Cross-reference plausibility.**
Would this person realistically be in this setting? A world leader in a private setting, a reclusive celebrity at a fan event, a historical figure in a modern context — implausibility is itself a signal of fabrication.

**E. Once you identify anyone (at any confidence level), apply these rules:**

- **HIGH confidence match (75%+):** The face closely matches the real person's known features. Still flag as high AI suspicion — celebrity images are AI-fabricated constantly. Ask if this scene would have been photographed and published if real.

- **LOW-TO-MEDIUM confidence match (50–74%):** The face resembles the person but features are subtly off — wrong nose geometry, slightly different eye spacing, skin tone variation, or jaw shape. THIS IS A CRITICAL AI RED FLAG. Real photographs of real celebrities should produce high facial recognition confidence. A weak match means the AI attempted to render their likeness but got it slightly wrong — this is exactly what AI image generators do. Low recognition confidence on a claimed public figure is STRONG EVIDENCE of AI generation, not weak evidence.

- **Named in text overlay but low facial match:** Treat as very strong AI signal. If an image labels itself as featuring a celebrity but the face doesn't clearly match that celebrity's real features, it is almost certainly an AI-generated fabrication.

Flag any image containing a recognizable or claimed public figure as at minimum "Likely AI-Generated" unless there is overwhelming photographic evidence of authenticity (verifiable event context, consistent with known published photography, high facial match confidence).

If you do not recognize anyone and there are no identification signals, proceed to the next steps.

**STEP 2 — MODERN AI TELLS (most important for high-quality AI)**
These are what catches modern photorealistic AI:
- **Skin micro-texture**: Real skin at close range shows actual pores, fine veins, subtle discoloration, and texture variation across the face. AI skin — even when not "waxy" — often has an internal glow or impossible uniformity. Pay special attention to older subjects: real elderly skin has age spots, visible broken capillaries, uneven pigmentation, and deep texture variation. AI-generated older skin is often too smooth and uniformly "weathered" without these specifics.
- **Lighting plausibility**: Is the lighting flattering in a way that would be unlikely in a candid or realistic setting? AI images are lit like professional shoots even in casual contexts (car selfies, snapshots). Real candid photos have harsh shadows, unflattering angles, blown highlights.
- **Composition perfection**: Is the scene composed like a stock photo or ad — subjects well-framed, all elements intentionally placed? Real photos have accidental clutter, slightly off framing, elements cut off. AI images feel "designed."
- **Expression authenticity**: AI subjects often have neutral, pleasant, or slightly vacant expressions. Real people in candid photos have micro-expressions, asymmetry, tension in the face from genuine emotion.
- **Scene plausibility**: Would this exact scene plausibly occur in real life with a real person holding a camera? Does the context make sense? AI often creates scenes that feel "assembled" from concepts rather than captured.
- **Background genericness**: Does the background look like a specific real location or a generic AI-rendered version of a type of location (e.g., "generic suburban street," "generic forest," "generic office")? Real backgrounds have specific, identifiable details.
- **Edge coherence on complex subjects**: Hair flyaways, fur, eyelashes, and fabric edges at the boundary between subject and background. AI frequently blends these incorrectly even when the center looks perfect.
- **Subject integration**: Do multiple subjects (people, animals, objects) feel naturally integrated in the same space and light, or does each look like it was placed into the scene separately?
- **The "too cute / too perfect" factor**: AI images of animals, children, and people together are often engineered to be maximally appealing. Real photos capture an imperfect moment.

**STEP 3 — TEXT SCAN (treat this as a mandatory sweep, not an optional check)**
AI models struggle to render legible, meaningful text — especially text embedded on physical objects. This is one of the most reliable AI detection signals available. You MUST scan every piece of text in the image, no matter how small, peripheral, or obscured.

Scan ALL of these text locations:
- **On tires**: sidewall lettering, brand names, size markings (e.g., "205/55R16"), DOT codes — AI almost always garbles these into pseudo-letters or nonsensical strings
- **On clothing**: brand logos, jersey names/numbers, graphic tee text, labels
- **License plates**: letters and numbers should be a real, valid format for the apparent country/region
- **Storefront signs, street signs, billboards**: background text that AI renders as plausible-looking gibberish
- **Food/drink packaging**: label text, ingredient lists, brand names
- **Books, newspapers, screens**: any printed or displayed text in frame
- **Tattoos with text**: often rendered as decorative nonsense
- **Tool engravings, car dashboards, instrument panels**: small functional text AI consistently fails on
- **Watermarks, captions, stamps**: text that should be legible but may be garbled at edges

**Ruling:**
- ANY garbled, nonsensical, impossible, or pseudo-alphabetic text anywhere in the image = near-certain AI, assign 90%+ confidence immediately. This is one of the hardest things for AI to fake.
- Text that is partially legible but contains impossible letter combinations, mixed character sets, or wrong language for the context = strong AI signal.
- Perfectly legible, contextually correct text everywhere does NOT confirm human — modern AI can render clean text when it's large and prominent. Keep looking at small and incidental text.
- If you find garbled text on a specific object (e.g., tire sidewall, license plate), name it explicitly in your ai_indicators list with a description of what you observed.

**STEP 3B — CLASSIC ARTIFACT CHECK**
- Hands and fingers: count carefully, check proportions, look for fused/extra digits
- Eyes: check for authentic reflections, real iris detail, natural asymmetry
- Ears and teeth: simplified or melted geometry
- Watermarks: Midjourney, DALL-E, Stable Diffusion, Adobe Firefly

**STEP 4 — CAMERA AUTHENTICITY CHECK**
Real photographs carry physical evidence of optics and sensors:
- Film grain or digital sensor noise (should be visible, especially in darker areas)
- Chromatic aberration at high-contrast edges (slight color fringing)
- Lens distortion appropriate to focal length (wide-angle barrel, telephoto compression)
- Natural bokeh with real aperture characteristics (not perfectly circular blur)
- Motion blur where expected (moving subjects, handheld shake)
- Depth-of-field that is optically correct — foreground subjects sharp, background blur gradual

**STEP 5 — REVERSE-CHECK EACH "HUMAN" SIGNAL**
For every signal you think points to human creation, explicitly ask: "Can modern AI (Midjourney v6, Flux, DALL-E 3) produce this?" If yes, remove it from your human evidence. Only count as human evidence what AI genuinely cannot replicate reliably.

**STEP 6 — WEIGH THE EVIDENCE**
A single strong modern-AI tell outweighs many weak "absence of artifact" observations. Focus on:
- What is present that shouldn't be (skin too smooth, light too flattering, scene too composed)
- Not on what is absent (no extra fingers ≠ human)

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
  "subjects": [
    { "name": "<full name of recognized public figure>", "confidence": <integer 50-100>, "note": "<brief note about why their presence or depiction is significant>" }
  ],
  "content_type": "<specific image type: portrait photo, landscape photo, digital illustration, etc.>"
}

If no public figures are recognized, set "subjects" to an empty array [].`;

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
