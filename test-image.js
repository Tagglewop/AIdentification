require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

// Pull IMAGE_PROMPT directly from analyze.js so we test the real prompt
const analyzeSource = fs.readFileSync(path.join(__dirname, 'api/analyze.js'), 'utf8');
const promptMatch = analyzeSource.match(/const IMAGE_PROMPT = `([\s\S]*?)`;/);
if (!promptMatch) { console.error('Could not extract IMAGE_PROMPT'); process.exit(1); }
const IMAGE_PROMPT = promptMatch[1];

const imagePath = path.join(__dirname, 'Fake photo 2.jpeg');
const imageData = fs.readFileSync(imagePath).toString('base64');

console.log('Submitting Fake photo 2.jpeg to Claude...\n');

(async () => {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
        { type: 'text', text: IMAGE_PROMPT },
      ],
    }],
  });

  const textBlock = message.content.find(b => b.type === 'text');
  const raw = textBlock.text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) { console.error('No JSON found in response:\n', raw); process.exit(1); }

  const result = JSON.parse(jsonMatch[0]);
  console.log('VERDICT:    ', result.verdict);
  console.log('CONFIDENCE: ', result.confidence + '%');
  console.log('SUMMARY:\n  ', result.summary);
  console.log('\nAI SIGNALS:');
  (result.signals?.ai_indicators || []).forEach(s => console.log('  -', s));
  console.log('\nHUMAN SIGNALS:');
  (result.signals?.human_indicators || []).forEach(s => console.log('  -', s));
  if (result.subjects?.length) {
    console.log('\nSUBJECTS:');
    result.subjects.forEach(s => console.log(`  - ${s.name} (${s.confidence}%): ${s.note}`));
  }
})().catch(err => { console.error('Error:', err.message); process.exit(1); });
