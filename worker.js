/**
 * ShieldSmart Newsletter Worker
 * XNL Tech (affiliated: PromptMechanics.org)
 *
 * Routes:
 *   POST /subscribe          — Save subscriber to KV
 *   GET  /generate           — Generate newsletter with Anthropic (cron-triggered or manual)
 *   GET  /subscribers        — List subscribers (admin, requires secret header)
 *   POST /send               — Trigger send to all subscribers (admin)
 *
 * Env vars to set in Cloudflare dashboard:
 *   ANTHROPIC_API_KEY        — Your Anthropic API key
 *   ADMIN_SECRET             — Secret token for protected admin routes
 *   SEND_API_KEY             — (Optional) Your email sending service key (Mailgun, SendGrid, etc.)
 *   SEND_FROM                — e.g. "ShieldSmart <hello@xnltech.com>"
 *   SEND_DOMAIN              — e.g. "xnltech.com" (Mailgun domain)
 *
 * KV Namespace:
 *   SUBSCRIBERS              — Bind a KV namespace named SUBSCRIBERS in your Worker settings
 */

// ─── CORS HEADERS ───────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', ...CORS },
  });
}

// ─── ROUTER ─────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      return handleSubscribe(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/generate') {
      return handleGenerate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/subscribers') {
      return handleListSubscribers(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/send') {
      return handleSend(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/unsubscribe') {
      return handleUnsubscribePage(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      return handleUnsubscribeSubmit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/verify-subscriber') {
      return handleVerifySubscriber(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/archive') {
      return handleArchiveIndex(request, env);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/archive/')) {
      const issueId = url.pathname.replace('/archive/', '');
      return handleArchiveRead(issueId, env);
    }

    if (url.pathname === '/admin' && request.method === 'GET') {
      return handleAdminPage();
    }

    if (url.pathname === '/admin/generate' && request.method === 'POST') {
      return handleAdminGenerate(request, env);
    }

    if (url.pathname === '/admin/send' && request.method === 'POST') {
      return handleAdminSend(request, env);
    }

    if (url.pathname === '/admin/cron-logs' && request.method === 'POST') {
      return handleCronLogs(request, env);
    }

    if (url.pathname === '/admin/social' && request.method === 'POST') {
      return handleSocialGen(request, env);
    }

    if (url.pathname === '/admin/wrap' && request.method === 'POST') {
      return handleAdminWrap(request, env);
    }

    if (url.pathname === '/admin/list-issues' && request.method === 'POST') {
      return handleAdminListIssues(request, env);
    }

    if (url.pathname === '/admin/delete-issue' && request.method === 'POST') {
      return handleAdminDeleteIssue(request, env);
    }

    if (url.pathname === '/favicon.ico') {
      return Response.redirect(new URL('/logo.png', request.url).href, 301);
    }

    if (url.pathname === '/logo.png') {
      return handleLogo(env);
    }

    if (url.pathname === '/') {
      return handleLandingPage();
    }

    return json({ error: 'Not found' }, 404);
  },

  // ─── CRON TRIGGER ─────────────────────────────────────────────────────────
  // In wrangler.toml, add:
  //   [triggers]
  //   crons = ["0 11 * * 1", "0 11 * * 3", "0 11 * * 5"]
  //   (11am UTC / 7am EDT Mon, Wed, Fri)
  async scheduled(event, env, ctx) {
    const ts = new Date().toISOString();
    const issueType = getIssueType();
    const log = { event: 'cron', issueType, firedAt: ts, status: 'started' };
    console.log('Cron triggered:', ts, issueType);

    try {
      const newsletter = await generateNewsletter(env, issueType);
      log.subject = newsletter.subject;
      log.status = 'generated';
      console.log('Newsletter generated:', newsletter.subject);

      const result = await sendToAllSubscribers(newsletter, env);
      log.sent = result.sent;
      log.failed = result.failed;
      log.status = 'sent';
      console.log('Newsletter sent:', result.sent, 'delivered,', result.failed, 'failed');
    } catch (e) {
      log.status = 'error';
      log.error = e.message;
      console.error('Cron error:', e.message, e.stack);
    }

    // Persist cron log to KV so we can check it later
    try {
      await env.CONTENT.put(`cron:${ts}`, JSON.stringify(log));
    } catch (_) { /* best effort */ }
  },
};

// ─── SUBSCRIBE HANDLER ───────────────────────────────────────────────────────
async function handleSubscribe(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { firstName, lastName, email } = body;

  if (!email || !email.includes('@')) {
    return json({ error: 'Valid email is required' }, 400);
  }

  const key = `sub:${email.toLowerCase().trim()}`;
  const subscriber = {
    firstName: firstName || '',
    lastName: lastName || '',
    email: email.toLowerCase().trim(),
    subscribedAt: new Date().toISOString(),
    active: true,
  };

  await env.SUBSCRIBERS.put(key, JSON.stringify(subscriber));

  // Optional: send welcome email
  try {
    await sendEmail(
      { email: subscriber.email, firstName: subscriber.firstName },
      welcomeEmailHtml(subscriber.firstName),
      `Welcome to ShieldSmart — Your Cyber Safety Newsletter`,
      env
    );
  } catch (e) {
    console.error('Welcome email failed:', e.message);
    // Don't fail the subscription if welcome email fails
  }

  return json({ success: true, message: 'Subscribed successfully!' });
}

// ─── LIST SUBSCRIBERS (ADMIN) ────────────────────────────────────────────────
async function handleListSubscribers(request, env) {
  if (!isAdmin(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const list = await env.SUBSCRIBERS.list({ prefix: 'sub:' });
  const subscribers = [];

  for (const key of list.keys) {
    const val = await env.SUBSCRIBERS.get(key.name);
    if (val) subscribers.push(JSON.parse(val));
  }

  return json({ count: subscribers.length, subscribers });
}

// ─── GENERATE NEWSLETTER (ADMIN OR CRON) ────────────────────────────────────
async function handleGenerate(request, env) {
  if (!isAdmin(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type') || getIssueType();
  const newsletter = await generateNewsletter(env, type);

  return html(newsletter.html);
}

// ─── SEND TO ALL (ADMIN) ─────────────────────────────────────────────────────
async function handleSend(request, env) {
  if (!isAdmin(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type') || getIssueType();
  const newsletter = await generateNewsletter(env, type);
  const result = await sendToAllSubscribers(newsletter, env);

  return json({ success: true, ...result });
}

// ─── ADMIN: GENERATE FROM READER QUESTION ───────────────────────────────────
async function handleAdminGenerate(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const question = (body.question || '').trim();
  const issueType = body.issueType || 'friday';
  const readerName = (body.readerName || '').trim();
  if (!question) {
    return json({ error: 'Question is required' }, 400);
  }

  const newsletter = await generateQuestionNewsletter(env, question, issueType, readerName);
  return json({ success: true, subject: newsletter.subject, html: newsletter.html, issueType: newsletter.issueType });
}

async function handleAdminSend(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { subject, htmlContent, issueType } = body;
  if (!subject || !htmlContent) {
    return json({ error: 'subject and htmlContent are required' }, 400);
  }

  const newsletter = { subject, html: htmlContent, issueType: issueType || 'friday' };
  const result = await sendToAllSubscribers(newsletter, env);
  return json({ success: true, ...result });
}

// ─── CRON LOG VIEWER ─────────────────────────────────────────────────────────
async function handleCronLogs(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const list = await env.CONTENT.list({ prefix: 'cron:' });
  const logs = [];
  const keys = list.keys.sort((a, b) => b.name.localeCompare(a.name)).slice(0, 20);
  for (const key of keys) {
    const val = await env.CONTENT.get(key.name);
    if (val) logs.push(JSON.parse(val));
  }
  return json({ logs });
}

// ─── WRAP CUSTOM NEWSLETTER ──────────────────────────────────────────────────
async function handleAdminWrap(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { subject, rawHtml, issueType } = body;
  if (!subject || !rawHtml) {
    return json({ error: 'subject and rawHtml are required' }, 400);
  }

  const type = issueType || 'monday';
  const fullHtml = wrapInEmailShell(rawHtml, subject, type);

  // Save to archive (with unique suffix to avoid overwriting scheduled issues)
  try {
    const ds = new Date().toISOString().split('T')[0];
    const suffix = Date.now().toString(36);
    const archiveKey = `issue:${ds}-${type}-${suffix}`;
    const meta = { id: archiveKey, subject, issueType: type, generatedAt: new Date().toISOString(), dateStr: ds };
    await env.CONTENT.put(archiveKey, fullHtml);
    await env.CONTENT.put(`${archiveKey}:body`, rawHtml);
    await env.CONTENT.put(`${archiveKey}:meta`, JSON.stringify(meta));
  } catch (_) {}

  return json({ success: true, subject, html: fullHtml, issueType: type });
}

// ─── ADMIN LIST ISSUES ───────────────────────────────────────────────────────
async function handleAdminListIssues(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const list = await env.CONTENT.list({ prefix: 'issue:' });
  const metaKeys = list.keys
    .filter(k => k.name.endsWith(':meta'))
    .sort((a, b) => b.name.localeCompare(a.name));

  const issues = [];
  for (const key of metaKeys) {
    const val = await env.CONTENT.get(key.name);
    if (val) issues.push(JSON.parse(val));
  }
  return json({ issues });
}

// ─── ADMIN DELETE ISSUE ──────────────────────────────────────────────────────
async function handleAdminDeleteIssue(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const id = body.id;
  if (!id) return json({ error: 'id is required' }, 400);

  await env.CONTENT.delete(id);
  await env.CONTENT.delete(id + ':body');
  await env.CONTENT.delete(id + ':meta');

  return json({ success: true, deleted: id });
}

// ─── SOCIAL POST GENERATOR ───────────────────────────────────────────────────
async function handleSocialGen(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const topic = (body.topic || '').trim();

  // Grab the 3 most recent issue subjects as context
  let recentIssues = '';
  try {
    const list = await env.CONTENT.list({ prefix: 'issue:' });
    const metaKeys = list.keys
      .filter(k => k.name.endsWith(':meta'))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 3);
    const items = [];
    for (const key of metaKeys) {
      const val = await env.CONTENT.get(key.name);
      if (val) { const m = JSON.parse(val); items.push(m.subject); }
    }
    if (items.length) recentIssues = '\nRecent newsletter topics for context:\n' + items.map(s => '- ' + s).join('\n');
  } catch (_) {}

  const topicInstruction = topic
    ? `The admin wants posts specifically about this topic or angle: "${topic}"`
    : 'Pick an attention-grabbing cyber safety angle relevant this week.';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      system: `You write social media posts for ShieldSmart, a free cyber safety newsletter by XNL Tech. The newsletter delivers plain-English security tips 3x a week (Mon/Wed/Fri). The goal of every post is to get people to subscribe at xnltech.com. Tone: urgent but friendly, relatable, never jargon-heavy. Use the kind of language that makes non-tech people stop scrolling.`,
      messages: [{ role: 'user', content: `Generate social media posts to promote the ShieldSmart newsletter and drive subscriptions.

${topicInstruction}${recentIssues}

Generate EXACTLY this output format (plain text, no markdown):

FACEBOOK:
[A Facebook post, 2-4 short paragraphs. Hook with a scary/relatable scenario. Include 1-2 emojis per paragraph. End with a clear CTA to subscribe at xnltech.com. Can be slightly longer and conversational.]

TWITTER:
[A Twitter/X post, max 280 characters. Punchy, urgent, with a CTA link to xnltech.com. Include 1-2 relevant emojis.]

TWITTER_ALT:
[A second Twitter/X post option, different angle, max 280 characters.]

Output ONLY the posts in the exact format above. No commentary, no labels like "Here are", no markdown.` }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Anthropic API error: ' + err);
  }

  const data = await response.json();
  const text = data.content[0].text.trim();

  // Parse sections
  const fbMatch = text.match(/FACEBOOK:\s*\n([\s\S]*?)(?=\nTWITTER:|$)/i);
  const twMatch = text.match(/TWITTER:\s*\n([\s\S]*?)(?=\nTWITTER_ALT:|$)/i);
  const twAltMatch = text.match(/TWITTER_ALT:\s*\n([\s\S]*?)$/i);

  return json({
    success: true,
    facebook: fbMatch ? fbMatch[1].trim() : '',
    twitter: twMatch ? twMatch[1].trim() : '',
    twitterAlt: twAltMatch ? twAltMatch[1].trim() : '',
  });
}

// ─── GENERATE NEWSLETTER FROM READER QUESTION ────────────────────────────────
async function generateQuestionNewsletter(env, readerQuestion, issueType, readerName) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const system = `You are the editor of ShieldSmart, a no-nonsense cyber safety newsletter by XNL Tech (PromptMechanics.org is an affiliated partner, not part of XNL Tech). 
Your readers are everyday people who are NOT tech savvy. 
Tone: helpful, practical, like your patient tech-savvy nephew or niece.
CRITICAL: All content MUST be timely and current for ${dateStr}. Reference current OS versions (Windows 11, macOS Sonoma/Sequoia, iOS 18, Android 15), real software interfaces, and up-to-date solutions for ${today.getFullYear()}. Mention specific current scams in the scam alert section. Never give outdated advice or reference old software versions.`;

  const nameInstruction = readerName
    ? `The reader's first name is ${readerName}. You may use their first name when presenting the question (e.g., "${readerName} wrote in asking..."). Only use their first name — never invent a last name or location.`
    : `Do NOT use any name — present it anonymously: "One of our readers wrote in asking..."`;

  const prompt = `Today's date is ${dateStr}. A real reader submitted this question to help@xnltech.com:

"${readerQuestion}"

Write a special Friday "Fix-It Help Desk" newsletter issue that answers this reader's question.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the reader's question. Then leave a blank line and begin the HTML body.

Structure:
1. **Happy Friday opener** (2 sentences — light and friendly)
2. **Reader Question** — Present the question naturally. ${nameInstruction}
3. **The Fix** — Step-by-step solution in plain language. Use numbered steps. Cover both Windows and Mac if relevant. (5-8 steps)
4. **Bonus Tip** — One related quick tip that makes their digital life easier or safer
5. **Scam Alert Reminder** — One sentence reminder about common scams related to this topic
6. **Weekend Safety Reminder** — One quick safety reminder for the weekend
7. **Warm Friday sign-off** from the ShieldSmart Team at XNL Tech

Format as clean HTML with inline styles. Use ONLY these brand colors: background #111311, card/section background #1E201E, text #F2F5E8, accent lime #BCE600, highlight amber #F5A623, muted text #7A8070. Max-width 900px.
DO NOT include any ShieldSmart header, logo, branding banner, or newsletter title at the top. The header is added separately. Start directly with the content (the Friday opener).
DO NOT invite readers to "reply to this email" — replies are not monitored. If you want to direct them somewhere, use help@xnltech.com.
IMPORTANT: Output raw HTML only. No markdown, no code fences, no backticks, no \`\`\`html — just the raw HTML content starting directly with your first tag.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${err}`);
  }

  const data = await response.json();
  let rawHtml = data.content[0].text;
  rawHtml = rawHtml.replace(/```html\s*/gi, '').replace(/```\s*/gi, '').trim();

  let subject = generateSubject('friday');
  const subjectMatch = rawHtml.match(/^SUBJECT:\s*(.+)/i);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    rawHtml = rawHtml.replace(/^SUBJECT:\s*.+\n?\n?/i, '').trim();
  }

  const fullHtml = wrapInEmailShell(rawHtml, subject, issueType);

  const newsletter = {
    subject,
    html: fullHtml,
    issueType,
    generatedAt: new Date().toISOString(),
  };

  try {
    const ds = new Date().toISOString().split('T')[0];
    const suffix = Date.now().toString(36);
    const archiveKey = `issue:${ds}-${issueType}-${suffix}`;
    const meta = {
      id: archiveKey,
      subject: newsletter.subject,
      issueType: newsletter.issueType,
      generatedAt: newsletter.generatedAt,
      dateStr: ds,
    };
    await env.CONTENT.put(archiveKey, fullHtml);
    await env.CONTENT.put(`${archiveKey}:body`, rawHtml);
    await env.CONTENT.put(`${archiveKey}:meta`, JSON.stringify(meta));
  } catch (e) {
    console.error('Failed to save to archive:', e.message);
  }

  return newsletter;
}

// ─── ISSUE TYPE LOGIC ────────────────────────────────────────────────────────
function getIssueType() {
  const day = new Date().getDay(); // 0=Sun, 1=Mon, 3=Wed, 5=Fri
  if (day === 1) return 'monday';
  if (day === 3) return 'wednesday';
  if (day === 5) return 'friday';
  return 'monday'; // default
}

// ─── GENERATE WITH ANTHROPIC ─────────────────────────────────────────────────
async function generateNewsletter(env, issueType) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Fetch recent issue subjects to avoid repeating topics
  let recentTopics = '';
  try {
    const list = await env.CONTENT.list({ prefix: 'issue:' });
    const metaKeys = list.keys
      .filter(k => k.name.endsWith(':meta'))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 12);
    const subjects = [];
    for (const key of metaKeys) {
      const val = await env.CONTENT.get(key.name);
      if (val) {
        const meta = JSON.parse(val);
        subjects.push(meta.subject);
      }
    }
    if (subjects.length > 0) {
      recentTopics = `\n\nIMPORTANT — DO NOT repeat these topics already covered in recent issues:\n${subjects.map(s => `- ${s}`).join('\n')}\nChoose a COMPLETELY DIFFERENT topic that has NOT been covered above.`;
    }
  } catch(e) { /* continue without recent topics */ }

  const prompts = {
    monday: {
      fallbackSubject: generateSubject('monday'),
      system: `You are the editor of ShieldSmart, a no-nonsense cyber safety newsletter by XNL Tech (PromptMechanics.org is an affiliated partner, not part of XNL Tech). 
Your readers are everyday people — seniors, parents, non-tech workers — who are NOT tech savvy. 
Your tone is: warm, protective, like a knowledgeable friend who happens to work in cybersecurity.
NEVER use jargon without immediately explaining it in plain English.
Write as if you're talking to your mom or grandparent.
CRITICAL: All content MUST be timely and current for ${dateStr}. Write about threats that are ACTIVELY circulating right now in ${today.getFullYear()}. Include specific, realistic details — which platforms are affected, what the scam messages look like, and any recent warnings from the FTC, FBI, or cybersecurity agencies. Never write generic or outdated content.`,
      prompt: `Today's date is ${dateStr}. Write a Monday "Threat Radar" newsletter issue. 

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the specific threat covered in the issue. Then leave a blank line and begin the HTML body.

Pick from a WIDE variety of real threats — examples include (but don't limit yourself to): fake delivery texts, AI voice cloning scams, QR code phishing, fake tech support popups, romance scams, cryptocurrency fraud, fake job offers, grandparent scams, SIM swapping, malicious browser extensions, fake Wi-Fi hotspots, social media impersonation, fake charity scams, smishing attacks, deepfake video fraud, parking meter QR scams, fake app store apps, USB drop attacks, business email compromise, fake invoice scams. Always pick something DIFFERENT from recent issues.${recentTopics}

Structure:
1. **Friendly opener** (2-3 sentences, warm, urgent but not scary)
2. **This Week's Threat** — Pick one very real, current scam or hacking tactic. Name it clearly. (e.g., "The Fake Bank Text Scam")
3. **How It Works** — Explain it step by step like a story. What happens? What do they want? (3-4 paragraphs, PLAIN English)
4. **How To Spot It** — 3-5 clear bullet points with specific, concrete signs
5. **What To Do If You Get One** — Numbered action steps (keep it simple: 3-4 steps)
6. **Quick Win** — One 30-second thing they can do RIGHT NOW to be safer
7. **Closing** — Warm, encouraging sign-off from "The ShieldSmart Team at XNL Tech"

Format as clean HTML with inline styles. Use ONLY these brand colors: background #111311, card/section background #1E201E, text #F2F5E8, accent lime #BCE600, highlight amber #F5A623, danger red #E8443A, muted text #7A8070. Max-width 900px centered. Make it visually engaging with colored callout boxes.
DO NOT include any ShieldSmart header, logo, branding banner, or newsletter title at the top. The header is added separately. Start directly with the content (the friendly opener).
DO NOT invite readers to "reply to this email" — replies are not monitored. If you want to direct them somewhere, use help@xnltech.com.
IMPORTANT: Output raw HTML only. No markdown, no code fences, no backticks, no \`\`\`html — just the raw HTML content starting directly with your first tag.`,
    },
    wednesday: {
      fallbackSubject: generateSubject('wednesday'),
      system: `You are the editor of ShieldSmart, a no-nonsense cyber safety newsletter by XNL Tech (PromptMechanics.org is an affiliated partner, not part of XNL Tech). 
Your readers are everyday people who are NOT tech savvy. 
Tone: encouraging, simple, like a patient teacher. Make people feel CAPABLE, not overwhelmed.
CRITICAL: All content MUST be timely and current for ${dateStr}. Reference current software versions, real app interfaces, and up-to-date settings paths for ${today.getFullYear()}. If a feature has been updated recently, mention the latest version. Never reference outdated menus or deprecated features.`,
      prompt: `Today's date is ${dateStr}. Write a Wednesday "Safety Skill" newsletter issue.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the specific skill taught in the issue. Then leave a blank line and begin the HTML body.

Pick from a WIDE variety of safety skills — examples include (but don't limit yourself to): setting up two-factor authentication, creating strong passwords, using a password manager, checking app permissions, spotting phishing emails, securing home Wi-Fi, enabling automatic updates, backing up your phone, reviewing privacy settings on Facebook/Instagram, recognizing fake websites, setting up Find My Phone, creating a PIN for your SIM card, encrypting your phone, clearing saved passwords from browsers, checking for data breaches, setting up login alerts, using a VPN on public Wi-Fi, reviewing connected apps, enabling biometric login, setting up email filters. Always pick something DIFFERENT from recent issues.${recentTopics}

Structure:
1. **Opener** — "This Wednesday, we're building one simple habit" (2 sentences)
2. **The Skill** — ONE specific security habit or setting. Give it a plain-language name.
3. **Why It Matters** — A brief real-world story or example showing what happens without this skill (2 paragraphs)
4. **How To Do It** — Step-by-step instructions with numbered steps. Write as if guiding someone by phone. Specify: iPhone vs Android or Windows vs Mac where relevant.
5. **You Did It!** — Brief celebration + what this skill protects them from
6. **Closing** from the ShieldSmart Team at XNL Tech

Format as clean HTML with inline styles. Use ONLY these brand colors: background #111311, card/section background #1E201E, text #F2F5E8, accent lime #BCE600, highlight amber #F5A623, muted text #7A8070. Max-width 900px. Include a visible "Steps" section with numbered boxes.
DO NOT include any ShieldSmart header, logo, branding banner, or newsletter title at the top. The header is added separately. Start directly with the content (the opener).
DO NOT invite readers to "reply to this email" — replies are not monitored. If you want to direct them somewhere, use help@xnltech.com.
IMPORTANT: Output raw HTML only. No markdown, no code fences, no backticks, no \`\`\`html — just the raw HTML content starting directly with your first tag.`,
    },
    friday: {
      fallbackSubject: generateSubject('friday'),
      system: `You are the editor of ShieldSmart, a no-nonsense cyber safety newsletter by XNL Tech (PromptMechanics.org is an affiliated partner, not part of XNL Tech). 
Your readers are everyday people who are NOT tech savvy. 
Tone: helpful, practical, like your patient tech-savvy nephew or niece.
CRITICAL: All content MUST be timely and current for ${dateStr}. Reference current OS versions (Windows 11, macOS Sonoma/Sequoia, iOS 18, Android 15), real software interfaces, and up-to-date solutions for ${today.getFullYear()}. Mention specific current scams in the scam alert section. Never give outdated advice or reference old software versions.`,
      prompt: `Today's date is ${dateStr}. Write a Friday "Fix-It Help Desk" newsletter issue.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the specific question or fix covered in the issue. Then leave a blank line and begin the HTML body.

Pick from a WIDE variety of real reader-style questions — examples include (but don't limit yourself to): slow computer fix, too many browser tabs, phone storage full, printer won't connect, suspicious email received, forgot password recovery, phone battery draining fast, computer won't start, weird pop-ups appearing, email got hacked, too many spam calls, Wi-Fi keeps disconnecting, computer fan running loud, accidentally clicked a bad link, how to transfer photos, screen frozen, Bluetooth won't pair, mystery charges on phone bill, apps crashing constantly, how to clear cookies. Always pick something DIFFERENT from recent issues.${recentTopics}

Structure:
1. **Happy Friday opener** (2 sentences — light and friendly)
2. **This Week's Topic** — Introduce a common tech problem or frustration that many people deal with (e.g., "Wi-Fi keeps dropping", "Phone storage is full"). Frame it naturally without pretending a specific person asked it.
3. **The Fix** — Step-by-step solution in plain language. Use numbered steps. Cover both Windows and Mac if relevant. (5-8 steps)
4. **Bonus Tip** — One related quick tip that makes their digital life easier or safer
5. **Scam Alert Reminder** — One sentence reminder about the most common scam circulating this week
6. **Weekend Safety Reminder** — One quick safety reminder for the weekend
7. **Warm Friday sign-off** from the ShieldSmart Team at XNL Tech

Format as clean HTML with inline styles. Use ONLY these brand colors: background #111311, card/section background #1E201E, text #F2F5E8, accent lime #BCE600, highlight amber #F5A623, muted text #7A8070. Max-width 900px. Include a visible Q&A styled section.
DO NOT include any ShieldSmart header, logo, branding banner, or newsletter title at the top. The header is added separately. Start directly with the content (the Friday opener).
DO NOT invite readers to "reply to this email" — replies are not monitored. If you want to direct them somewhere, use help@xnltech.com.
IMPORTANT: Output raw HTML only. No markdown, no code fences, no backticks, no \`\`\`html — just the raw HTML content starting directly with your first tag.`,
    },
  };

  // TODO: Future paid subscription feature — add a "Reader Question Box" back to the
  // Friday prompt with a CTA button for paid subscribers to get personalized help.
  // Could include a "Get Help" button linking to a paid subscription/support tier.

  const config = prompts[issueType] || prompts.monday;

  // Call Anthropic API
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      system: config.system,
      messages: [
        {
          role: 'user',
          content: config.prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${err}`);
  }

  const data = await response.json();
  let rawHtml = data.content[0].text;

  // Aggressively strip any code fences no matter where they appear
  rawHtml = rawHtml
    .replace(/```html\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim();

  // Extract AI-generated subject line from the first line (format: "SUBJECT: ...")
  let subject = config.fallbackSubject;
  const subjectMatch = rawHtml.match(/^SUBJECT:\s*(.+)/i);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    rawHtml = rawHtml.replace(/^SUBJECT:\s*.+\n?\n?/i, '').trim();
  }

  // Wrap in full email shell
  const fullHtml = wrapInEmailShell(rawHtml, subject, issueType);

  const newsletter = {
    subject,
    html: fullHtml,
    issueType,
    generatedAt: new Date().toISOString(),
  };

  // ── Save to archive in KV ──
  try {
    const dateStr = new Date().toISOString().split('T')[0]; // e.g. 2026-03-14
    const suffix = Date.now().toString(36);
    const archiveKey = `issue:${dateStr}-${issueType}-${suffix}`;
    const meta = {
      id: archiveKey,
      subject: newsletter.subject,
      issueType: newsletter.issueType,
      generatedAt: newsletter.generatedAt,
      dateStr,
    };
    // Store full HTML separately, store metadata in index
    await env.CONTENT.put(archiveKey, fullHtml);
    await env.CONTENT.put(`${archiveKey}:body`, rawHtml);
    await env.CONTENT.put(`${archiveKey}:meta`, JSON.stringify(meta));
  } catch (e) {
    console.error('Failed to save to archive:', e.message);
  }

  return newsletter;
}

// ─── EMAIL SHELL WRAPPER ─────────────────────────────────────────────────────
function wrapInEmailShell(innerHtml, subject, issueType) {
  const dayLabel = { monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
  const label = dayLabel[issueType] || 'ShieldSmart';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
<title>${subject}</title>
<!--[if mso]>
<xml>
  <o:OfficeDocumentSettings>
    <o:AllowPNG/>
    <o:PixelsPerInch>96</o:PixelsPerInch>
  </o:OfficeDocumentSettings>
</xml>
<style>
  table {border-collapse:collapse;}
  td {font-family:Arial,sans-serif;}
</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#111311;font-family:Arial,'Helvetica Neue',sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#111311" style="background-color:#111311;">
  <tr>
    <td align="center" bgcolor="#111311" style="padding:24px 16px;background-color:#111311;">
      <!--[if mso]><table width="900" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table width="900" cellpadding="0" cellspacing="0" border="0" bgcolor="#1E201E" style="max-width:900px;width:100%;background-color:#1E201E;color:#F2F5E8;">

      <!-- Header -->
      <tr><td bgcolor="#1E201E" style="background-color:#1E201E;padding:24px 32px;border-bottom:2px solid #BCE600;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:Arial,'Helvetica Neue',sans-serif;">
              <table cellpadding="0" cellspacing="0" border="0"><tr>
                <td style="vertical-align:middle;padding-right:12px;"><img src="https://xnltech.com/logo.png" alt="ShieldSmart" width="34" height="34" style="display:block;width:34px;height:34px;" /></td>
                <td style="vertical-align:middle;">
                  <div style="font-size:22px;font-weight:800;color:#FFFFFF;font-family:Arial,'Helvetica Neue',sans-serif;">SHIELD<span style="color:#BCE600;">SMART</span></div>
                  <div style="font-size:11px;color:#7A8070;text-transform:uppercase;letter-spacing:0.1em;margin-top:2px;">by XNL Tech</div>
                </td>
              </tr></table>
            </td>
            <td align="right">
              <span style="background-color:#1A2600;border:1px solid #4A6600;color:#BCE600;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:6px 14px;border-radius:100px;">
                ${label}
              </span>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Body -->
      <tr><td bgcolor="#1E201E" style="background-color:#1E201E;padding:32px;color:#F2F5E8;font-size:16px;line-height:1.7;border-top:1px solid #2A2C2A;">
        ${innerHtml}
      </td></tr>

      <!-- Footer -->
      <tr><td bgcolor="#111311" style="background-color:#111311;border-top:1px solid #2A2C2A;padding:24px 32px;text-align:center;">
        <p style="font-size:13px;color:#F2F5E8;margin:0 0 14px;font-family:Arial,sans-serif;">
          &#128218; Missed a tip? Browse all past issues at <a href="https://xnltech.com/archive" style="color:#BCE600;text-decoration:none;font-weight:700;">xnltech.com/archive</a>
        </p>
        <p style="font-size:12px;color:#7A8070;margin:0 0 8px;font-family:Arial,sans-serif;">
          You're receiving this because you joined ShieldSmart at <strong style="color:#F2F5E8;">xnltech.com</strong>
        </p>
        <p style="font-size:12px;color:#7A8070;margin:0;font-family:Arial,sans-serif;">
          <a href="{unsubscribe_url}" style="color:#BCE600;text-decoration:none;">Unsubscribe</a>
          &nbsp;&bull;&nbsp;
          <a href="mailto:help@xnltech.com" style="color:#BCE600;text-decoration:none;">Contact Us</a>
          &nbsp;&bull;&nbsp;
          <a href="https://XNLTech.com" style="color:#BCE600;text-decoration:none;">XNLTech.com</a>
        </p>
        <p style="font-size:11px;color:#5A6050;margin:16px 0 0;font-family:Arial,sans-serif;">
          &copy; 2026 XNL Tech. All rights reserved.
        </p>
      </td></tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ─── SEND TO ALL SUBSCRIBERS ─────────────────────────────────────────────────
async function sendToAllSubscribers(newsletter, env) {
  const list = await env.SUBSCRIBERS.list({ prefix: 'sub:' });
  let sent = 0;
  let failed = 0;

  for (const key of list.keys) {
    const val = await env.SUBSCRIBERS.get(key.name);
    if (!val) continue;
    const subscriber = JSON.parse(val);
    if (!subscriber.active) continue;

    try {
      await sendEmail(subscriber, newsletter.html, newsletter.subject, env);
      sent++;
    } catch (e) {
      console.error(`Failed to send to ${subscriber.email}:`, e.message);
      failed++;
    }
  }

  return { sent, failed, total: list.keys.length };
}

// ─── EMAIL SENDER (Resend) ───────────────────────────────────────────────────
async function sendEmail(subscriber, htmlContent, subject, env) {
  if (!env.SEND_API_KEY) {
    console.log(`[DEMO] Would send "${subject}" to ${subscriber.email}`);
    return;
  }

  const personalizedHtml = htmlContent.replace(
    '{unsubscribe_url}',
    `https://xnltech.com/unsubscribe?email=${encodeURIComponent(subscriber.email)}`
  );

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.SEND_FROM || 'ShieldSmart <noreply@xnltech.com>',
      to: subscriber.email,
      subject: subject,
      html: personalizedHtml,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
}

// ─── WELCOME EMAIL ───────────────────────────────────────────────────────────
function welcomeEmailHtml(firstName) {
  const name = firstName || 'there';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width" />
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
<title>Welcome to ShieldSmart</title>
</head>
<body style="margin:0;padding:0;background-color:#111311;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#111311" style="background-color:#111311;">
  <tr>
    <td align="center" bgcolor="#111311" style="padding:24px 16px;background-color:#111311;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#1E201E" style="max-width:600px;width:100%;background-color:#1E201E;border-radius:12px;">

        <!-- Header -->
        <tr>
          <td bgcolor="#1E201E" style="background-color:#1E201E;padding:28px 32px;border-bottom:2px solid #BCE600;text-align:center;">
            <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>
              <td style="vertical-align:middle;padding-right:12px;"><img src="https://xnltech.com/logo.png" alt="ShieldSmart" width="34" height="34" style="display:block;width:34px;height:34px;" /></td>
              <td style="vertical-align:middle;">
                <div style="font-size:24px;font-weight:800;color:#FFFFFF;font-family:Arial,sans-serif;">SHIELD<span style="color:#BCE600;">SMART</span></div>
              </td>
            </tr></table>
            <div style="font-size:11px;color:#7A8070;text-transform:uppercase;letter-spacing:0.1em;margin-top:4px;">by XNL Tech</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td bgcolor="#1E201E" style="background-color:#1E201E;padding:32px;">
            <h2 style="color:#BCE600;font-family:Arial,sans-serif;font-size:24px;margin:0 0 16px;">Welcome to ShieldSmart, ${name}! &#127737;</h2>
            <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;margin:0 0 16px;">
              You just took the first step toward protecting yourself online — and we're genuinely proud of you for it.
            </p>

            <!-- Mission -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:20px 24px;border-radius:8px;border-left:4px solid #BCE600;">
                  <p style="color:#BCE600;font-family:Arial,sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">Our Mission</p>
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;margin:0;">
                    At <strong>XNL Tech</strong>, we believe everyone deserves to feel safe online — not just the tech-savvy. Scammers and hackers count on regular people feeling confused and overwhelmed. We're here to change that. ShieldSmart breaks down real cyber threats into <strong style="color:#BCE600;">plain English</strong> so you can protect yourself, your family, and your community — no tech degree required.
                  </p>
                </td>
              </tr>
            </table>

            <!-- This is just the beginning -->
            <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;margin:24px 0 8px;">
              <strong style="color:#BCE600;">This newsletter is just the beginning.</strong>
            </p>
            <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;margin:0 0 20px;">
              We're building a community of people who look out for each other. The more of us who know how to spot scams, lock down our accounts, and stay safe — the harder we make it for the bad guys. Your inbox is our starting point, but the real goal is a world where nobody falls for these tricks.
            </p>

            <!-- Schedule -->
            <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;margin:0 0 12px;">
              <strong>Here's what you'll get 3&times; a week:</strong>
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128274; <strong>Mondays</strong> — We decode the week's biggest scam so you know exactly what to watch for</p>
                </td>
              </tr>
              <tr><td style="height:8px;"></td></tr>
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128161; <strong>Wednesdays</strong> — You learn one simple safety skill you can set up in minutes</p>
                </td>
              </tr>
              <tr><td style="height:8px;"></td></tr>
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128187; <strong>Fridays</strong> — We fix a common tech headache with plain-English steps</p>
                </td>
              </tr>
            </table>

            <!-- Make sure you see our emails -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:20px 24px;border-radius:8px;border-left:4px solid #F5A623;">
                  <p style="color:#F5A623;font-family:Arial,sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px;">&#128235; IMPORTANT: Don't miss your issues!</p>
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;margin:0 0 10px;">
                    Email providers sometimes send new newsletters to <strong>Spam</strong> or <strong>Junk</strong>. To make sure ShieldSmart lands in your inbox every time:
                  </p>
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:15px;line-height:1.8;margin:0;">
                    1. <strong style="color:#BCE600;">Move this email</strong> to your primary inbox (if it's in Spam/Junk)<br/>
                    2. <strong style="color:#BCE600;">Add us to your contacts</strong> &mdash; save <strong>noreply@xnltech.com</strong><br/>
                    3. <strong style="color:#BCE600;">Gmail users:</strong> If you see "This message is in your Promotions tab," click <em>"Move to Primary"</em>
                  </p>
                </td>
              </tr>
            </table>

            <!-- Spread the word -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
              <tr>
                <td bgcolor="#222522" style="background-color:#222522;padding:24px;border-radius:8px;text-align:center;border:1px solid #3A3D3A;">
                  <p style="color:#BCE600;font-family:Arial,sans-serif;font-size:20px;font-weight:700;margin:0 0 8px;">&#128149; Help Someone You Care About</p>
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;margin:0 0 16px;">
                    Think of one person — a parent, a friend, a neighbor — who could use a little help staying safe online. Forward this email to them, or share the link below. It's free, and it could save them from a scam.
                  </p>
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="https://xnltech.com" style="height:44px;v-text-anchor:middle;width:280px;" arcsize="18%" strokecolor="#BCE600" fillcolor="#BCE600">
                    <w:anchorlock/>
                    <center style="color:#0D0F0D;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Share ShieldSmart &rarr;</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <a href="https://xnltech.com" style="display:inline-block;background-color:#BCE600;color:#0D0F0D;font-family:Arial,sans-serif;font-size:16px;font-weight:700;text-decoration:none;padding:12px 32px;border-radius:8px;">Share ShieldSmart &rarr;</a>
                  <!--<![endif]-->
                  <p style="color:#7A8070;font-family:Arial,sans-serif;font-size:13px;margin:14px 0 0;">
                    Or share this link: <a href="https://xnltech.com" style="color:#BCE600;text-decoration:none;">xnltech.com</a>
                  </p>
                </td>
              </tr>
            </table>

            <p style="color:#7A8070;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;margin:24px 0 0;">
              Questions? Reply to this email or write us at <a href="mailto:help@xnltech.com" style="color:#BCE600;text-decoration:none;">help@xnltech.com</a>
            </p>
            <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;margin:20px 0 0;">
              Stay safe out there — and help others do the same,<br/>
              <strong>The ShieldSmart Team</strong><br/>
              <span style="color:#7A8070;font-size:13px;">XNL Tech</span>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td bgcolor="#111311" style="background-color:#111311;padding:20px 32px;text-align:center;border-top:1px solid #2A2C2A;">
            <p style="font-size:12px;color:#7A8070;margin:0 0 8px;font-family:Arial,sans-serif;">
              You're receiving this because you joined ShieldSmart at <strong style="color:#F2F5E8;">xnltech.com</strong>
            </p>
            <p style="font-size:12px;color:#7A8070;margin:0;font-family:Arial,sans-serif;">
              <a href="{unsubscribe_url}" style="color:#BCE600;text-decoration:none;">Unsubscribe</a>
              &nbsp;&bull;&nbsp;
              <a href="mailto:help@xnltech.com" style="color:#BCE600;text-decoration:none;">Contact Us</a>
            </p>
            <p style="font-size:11px;color:#5A6050;margin:12px 0 0;font-family:Arial,sans-serif;">
              &copy; 2026 XNL Tech. All rights reserved.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ─── GENERATE DYNAMIC SUBJECT LINES ──────────────────────────────────────────
function generateSubject(day) {
  const subjects = {
    monday: [
      "🚨 This scam is making the rounds — here's how to dodge it",
      "⚠️ Hackers tried a new trick this week. You need to see this.",
      "🛡️ Before you click that email — read this first",
      "🔍 Spotted: The scam hitting inboxes right now",
    ],
    wednesday: [
      "🔐 One setting that makes hackers give up on you",
      "💡 Wednesday Skill: 2 minutes that could save your accounts",
      "🛡️ Your Wednesday safety upgrade is here",
      "✅ This one habit stops most hacks cold",
    ],
    friday: [
      "🛠️ Fix-It Friday: Your tech question answered",
      "💻 That annoying computer problem? Here's the fix.",
      "🎉 Friday Help Desk — plus one quick safety reminder",
      "🔧 Fix-It Friday: We're in your corner",
    ],
  };
  const list = subjects[day] || subjects.monday;
  return list[Math.floor(Math.random() * list.length)];
}

// ─── UNSUBSCRIBE PAGE (GET) ───────────────────────────────────────────────────
async function handleUnsubscribePage(request, env) {
  const url = new URL(request.url);
  const email = url.searchParams.get('email') || '';

  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unsubscribe | ShieldSmart</title>
<link rel="icon" type="image/png" href="/logo.png" />
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Figtree',sans-serif;background:#111311;color:#F2F5E8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5rem;}
  .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(188,230,0,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(188,230,0,0.03) 1px,transparent 1px);background-size:32px 32px;pointer-events:none;z-index:0;}
  .card{position:relative;z-index:1;background:#1E201E;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:2.5rem 2rem;max-width:440px;width:100%;text-align:center;}
  input{width:100%;background:#222522;border:1px solid rgba(255,255,255,0.07);border-radius:9px;padding:0.75rem 1rem;font-family:'Figtree',sans-serif;font-size:0.9rem;color:#F2F5E8;outline:none;margin:1rem 0;transition:border-color 0.2s;}
  input:focus{border-color:#BCE600;}
  input::placeholder{color:#5A6050;}
  button{width:100%;background:#BCE600;color:#0D0F0D;border:none;border-radius:9px;padding:0.85rem;font-family:'Figtree',sans-serif;font-weight:700;font-size:0.95rem;cursor:pointer;transition:background 0.2s;}
  button:hover{background:#A8CE00;}
</style>
</head>
<body>
<div class="grid-bg"></div>
<div class="card">
  <div style="font-size:2.5rem;margin-bottom:1rem;">&#128274;</div>
  <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;letter-spacing:0.05em;color:#fff;margin-bottom:0.5rem;">Unsubscribe</div>
  <p style="font-size:0.85rem;color:#7A8070;margin-bottom:0.25rem;line-height:1.6;">We're sorry to see you go. Enter your email below and we'll remove you immediately.</p>

  <div id="form-area">
    <form method="POST" action="/unsubscribe">
      <input type="email" name="email" placeholder="your@email.com" value="${email}" required />
      <button type="submit">Remove Me From the List</button>
    </form>
    <p style="font-size:0.72rem;color:#5A6050;margin-top:0.75rem;">Changed your mind? <a href="https://xnltech.com" style="color:#BCE600;text-decoration:none;">Re-subscribe here.</a></p>
  </div>
</div>
</body>
</html>`);
}

// ─── UNSUBSCRIBE SUBMIT (POST) ────────────────────────────────────────────────
async function handleUnsubscribeSubmit(request, env) {
  let email;
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const body = await request.json();
    email = body.email;
  } else {
    const formData = await request.formData();
    email = formData.get('email');
  }

  if (!email || !email.includes('@')) {
    return html(`<!DOCTYPE html><html><body style="background:#111311;color:#F2F5E8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;">
      <div><h2 style="color:#FF5C5C;">Invalid email address.</h2><br/><a href="/unsubscribe" style="color:#BCE600;">Try again</a></div>
    </body></html>`, 400);
  }

  const key = `sub:${email.toLowerCase().trim()}`;
  const existing = await env.SUBSCRIBERS.get(key);

  if (existing) {
    const subscriber = JSON.parse(existing);
    subscriber.active = false;
    subscriber.unsubscribedAt = new Date().toISOString();
    await env.SUBSCRIBERS.put(key, JSON.stringify(subscriber));
  }

  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unsubscribed | ShieldSmart</title>
<link rel="icon" type="image/png" href="/logo.png" />
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Figtree',sans-serif;background:#111311;color:#F2F5E8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;}
  .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(188,230,0,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(188,230,0,0.03) 1px,transparent 1px);background-size:32px 32px;pointer-events:none;z-index:0;}
  .card{position:relative;z-index:1;background:#1E201E;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:2.5rem 2rem;max-width:440px;width:100%;text-align:center;}
</style>
</head>
<body>
<div class="grid-bg"></div>
<div class="card">
  <div style="font-size:2.5rem;margin-bottom:1rem;">&#10003;</div>
  <div style="font-family:'Bebas Neue',sans-serif;font-size:1.8rem;letter-spacing:0.05em;color:#fff;margin-bottom:0.75rem;">You're Unsubscribed</div>
  <p style="font-size:0.88rem;color:#7A8070;line-height:1.7;margin-bottom:1.5rem;">
    <strong style="color:#F2F5E8;">${email}</strong> has been removed from ShieldSmart. You won't receive any more emails from us.
  </p>
  <p style="font-size:0.8rem;color:#5A6050;margin-bottom:1.5rem;">Changed your mind? You can always re-subscribe below.</p>
  <a href="https://xnltech.com" style="display:inline-block;background:#BCE600;color:#0D0F0D;font-weight:700;font-size:0.88rem;padding:0.7rem 1.5rem;border-radius:8px;text-decoration:none;">Re-subscribe Free &rarr;</a>
</div>
</body>
</html>`);
}

// ─── VERIFY SUBSCRIBER ───────────────────────────────────────────────────────
async function handleVerifySubscriber(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ verified: false }); }

  const email = (body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return json({ verified: false });

  const val = await env.SUBSCRIBERS.get(`sub:${email}`);
  if (!val) return json({ verified: false, reason: 'not_found' });

  const subscriber = JSON.parse(val);
  if (!subscriber.active) return json({ verified: false, reason: 'unsubscribed' });

  return json({ verified: true, firstName: subscriber.firstName || '' });
}

// ─── ARCHIVE INDEX (PUBLIC) ───────────────────────────────────────────────────
async function handleArchiveIndex(request, env) {
  const list = await env.CONTENT.list({ prefix: 'issue:' });

  // Filter to only meta keys, sort newest first
  const metaKeys = list.keys
    .filter(k => k.name.endsWith(':meta'))
    .sort((a, b) => b.name.localeCompare(a.name));

  const issues = [];
  for (const key of metaKeys) {
    const val = await env.CONTENT.get(key.name);
    if (val) issues.push(JSON.parse(val));
  }

  const typeLabel = { monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
  const typeColor = { monday: '#E8443A', wednesday: '#BCE600', friday: '#F5A623' };

  const rows = issues.length === 0
    ? `<p style="color:#7A8070;text-align:center;padding:3rem 0;font-family:'Figtree',sans-serif;">No issues published yet. Check back soon!</p>`
    : issues.map(issue => {
        const date = new Date(issue.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const label = typeLabel[issue.issueType] || 'ShieldSmart';
        const color = typeColor[issue.issueType] || '#BCE600';
        const id = encodeURIComponent(issue.id);
        return `
          <a href="/archive/${id}" class="issue-link">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="background:${color}18;border:1px solid ${color}44;color:${color};font-size:0.58rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:3px 10px;border-radius:100px;white-space:nowrap;flex-shrink:0;">${label}</span>
              <span style="color:#F2F5E8;font-size:0.9rem;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${issue.subject}</span>
              <span style="color:#7A8070;font-size:0.75rem;white-space:nowrap;flex-shrink:0;">${date}</span>
            </div>
          </a>`;
      }).join('');

  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ShieldSmart Archive | XNL Tech</title>
<link rel="icon" type="image/png" href="/logo.png" />
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Figtree',sans-serif;background:#111311;color:#F2F5E8;min-height:100vh;}
  .topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;padding:0 2rem;height:56px;background:rgba(13,15,13,0.88);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.07);}
  .brand{display:flex;align-items:center;gap:10px;text-decoration:none;}
  .brand-shield{width:38px;height:38px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .brand-shield img{width:38px;height:38px;display:block;}
  .brand-name{font-family:'Bebas Neue',sans-serif;font-size:1.35rem;letter-spacing:0.05em;color:#fff;line-height:1;}
  .brand-sub{font-family:'Figtree',sans-serif;font-size:0.58rem;font-weight:500;color:#7A8070;text-transform:uppercase;letter-spacing:0.1em;margin-left:6px;}
  .nav-cta{font-size:0.78rem;color:#0D0F0D;background:#BCE600;text-decoration:none;font-weight:700;padding:7px 16px;border-radius:7px;transition:background 0.2s;}
  .nav-cta:hover{background:#A8CE00;}
  .issue-link{display:block;text-decoration:none;background:#1E201E;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:1.25rem 1.5rem;margin-bottom:0.75rem;transition:border-color 0.2s,background 0.2s;}
  .issue-link:hover{border-color:rgba(188,230,0,0.35);background:#222522;}
  .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(188,230,0,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(188,230,0,0.03) 1px,transparent 1px);background-size:32px 32px;pointer-events:none;z-index:0;}
</style>
</head>
<body>
<div class="grid-bg"></div>

<nav class="topbar">
  <a href="https://xnltech.com" class="brand">
    <div class="brand-shield"><img src="/logo.png" alt="ShieldSmart" width="38" height="38" /></div>
    <div>
      <span class="brand-name">SHIELD<span style="color:#BCE600;">SMART</span></span>
      <span class="brand-sub">by XNL Tech</span>
    </div>
  </a>
  <a href="https://xnltech.com" class="nav-cta">Subscribe Free &rarr;</a>
</nav>

<div style="position:relative;z-index:1;max-width:960px;margin:0 auto;padding:5rem 1.5rem 3rem;">

  <div style="margin-bottom:0.75rem;">
    <span style="font-size:0.68rem;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#BCE600;">Every issue, all in one place</span>
  </div>
  <div style="font-family:'Bebas Neue',sans-serif;font-size:clamp(2.5rem,5vw,3.8rem);letter-spacing:0.03em;color:#fff;line-height:0.95;margin-bottom:0.75rem;">ISSUE ARCHIVE</div>
  <p style="color:#7A8070;font-size:0.95rem;margin-bottom:2rem;line-height:1.6;">Plain English cyber safety delivered 3&times; a week by <strong style="color:#F2F5E8;">XNL Tech</strong>. Subscribe free to read any issue.</p>

  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:2rem;">
    <span style="background:rgba(232,68,58,0.1);border:1px solid rgba(232,68,58,0.25);color:#E8443A;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">Mon &mdash; Threat Radar</span>
    <span style="background:rgba(188,230,0,0.08);border:1px solid rgba(188,230,0,0.25);color:#BCE600;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">Wed &mdash; Safety Skill</span>
    <span style="background:rgba(245,166,35,0.1);border:1px solid rgba(245,166,35,0.25);color:#F5A623;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">Fri &mdash; Fix-It Desk</span>
  </div>

  <div>${rows}</div>

  <div style="margin-top:3rem;padding-top:1.5rem;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
    <p style="font-size:0.73rem;color:#5A6050;">&copy; 2026 XNL Tech &bull; ShieldSmart Newsletter</p>
    <a href="https://xnltech.com" style="font-size:0.73rem;color:#7A8070;text-decoration:none;">XNLTech.com</a>
  </div>

</div>
</body>
</html>`);
}

// ─── ARCHIVE READ SINGLE ISSUE (PUBLIC) ───────────────────────────────────────
async function handleArchiveRead(issueId, env) {
  const decoded = decodeURIComponent(issueId);
  const issueHtml = await env.CONTENT.get(decoded);
  const issueBody = await env.CONTENT.get(`${decoded}:body`);
  const metaRaw = await env.CONTENT.get(`${decoded}:meta`);
  const meta = metaRaw ? JSON.parse(metaRaw) : {};

  if (!issueHtml) {
    return html(`<!DOCTYPE html><html><body style="background:#111311;color:#F2F5E8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;">
      <div><h2 style="font-size:2rem;margin-bottom:1rem;">Issue not found</h2>
      <a href="/archive" style="color:#BCE600;">Back to archive &rarr;</a></div>
    </body></html>`, 404);
  }

  const subject = meta.subject || 'ShieldSmart Issue';
  const typeLabel = { monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
  const label = typeLabel[meta.issueType] || 'ShieldSmart';
  const date = meta.generatedAt ? new Date(meta.generatedAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';

  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${subject} | ShieldSmart</title>
<link rel="icon" type="image/png" href="/logo.png" />
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Figtree',sans-serif;background:#111311;color:#F2F5E8;min-height:100vh;}
  .topbar{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 2rem;height:56px;background:rgba(13,15,13,0.92);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.07);}
  .brand{display:flex;align-items:center;gap:10px;text-decoration:none;}
  .brand-shield{width:38px;height:38px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .brand-shield img{width:38px;height:38px;display:block;}
  .brand-name{font-family:'Bebas Neue',sans-serif;font-size:1.35rem;letter-spacing:0.05em;color:#fff;line-height:1;}
  .brand-sub{font-family:'Figtree',sans-serif;font-size:0.58rem;font-weight:500;color:#7A8070;text-transform:uppercase;letter-spacing:0.1em;margin-left:6px;}
  .nav-cta{font-size:0.78rem;color:#0D0F0D;background:#BCE600;text-decoration:none;font-weight:700;padding:7px 16px;border-radius:7px;}
  .nav-cta:hover{background:#A8CE00;}
  .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(188,230,0,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(188,230,0,0.03) 1px,transparent 1px);background-size:32px 32px;pointer-events:none;z-index:0;}

  /* Issue header */
  .issue-header{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:5rem 1.5rem 2rem;}

  /* Preview wrapper — shows top portion */
  .preview-wrap{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:0 1.5rem;}
  .preview-inner{max-height:420px;overflow:hidden;position:relative;}
  .preview-inner iframe{width:100%;border:none;border-radius:12px;display:block;}

  /* Blur overlay */
  .blur-overlay{position:absolute;bottom:0;left:0;right:0;height:280px;background:linear-gradient(to bottom, transparent 0%, #111311 75%);pointer-events:none;}

  /* Gate card */
  .gate-wrap{position:relative;z-index:1;max-width:480px;margin:0 auto;padding:0 1.5rem 4rem;}
  .gate-card{background:#1E201E;border:1px solid rgba(188,230,0,0.2);border-radius:16px;padding:2rem 1.75rem;text-align:center;}
  .gate-card h3{font-family:'Bebas Neue',sans-serif;font-size:1.7rem;letter-spacing:0.04em;color:#fff;margin-bottom:0.5rem;}
  .gate-card p{font-size:0.85rem;color:#7A8070;line-height:1.7;margin-bottom:1.5rem;}
  .gate-input{width:100%;background:#222522;border:1px solid rgba(255,255,255,0.07);border-radius:9px;padding:0.75rem 1rem;font-family:'Figtree',sans-serif;font-size:0.9rem;color:#F2F5E8;outline:none;margin-bottom:10px;transition:border-color 0.2s;}
  .gate-input:focus{border-color:#BCE600;}
  .gate-input::placeholder{color:#5A6050;}
  .gate-btn{width:100%;background:#BCE600;color:#0D0F0D;border:none;border-radius:9px;padding:0.85rem;font-family:'Figtree',sans-serif;font-weight:700;font-size:0.95rem;cursor:pointer;transition:background 0.2s;}
  .gate-btn:hover{background:#A8CE00;}
  .gate-note{font-size:0.7rem;color:#5A6050;margin-top:0.75rem;}

  /* Popup overlay */
  .popup-overlay{display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:1rem;}
  .popup-card{background:#1E201E;border:1px solid rgba(188,230,0,0.25);border-radius:16px;max-width:420px;width:100%;padding:2rem 1.75rem;position:relative;text-align:center;}
  .popup-close{position:absolute;top:12px;right:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#F2F5E8;width:28px;height:28px;border-radius:7px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;}
  .popup-icon{font-size:2rem;margin-bottom:0.75rem;}
  .popup-card h3{font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:0.04em;color:#fff;margin-bottom:0.4rem;}
  .popup-card p{font-size:0.82rem;color:#7A8070;line-height:1.7;margin-bottom:1.25rem;}

  /* Success state */
  .success-state{display:none;text-align:center;padding:0.5rem 0;}
</style>
</head>
<body>
<div class="grid-bg"></div>

<nav class="topbar">
  <a href="https://xnltech.com" class="brand">
    <div class="brand-shield"><img src="/logo.png" alt="ShieldSmart" width="38" height="38" /></div>
    <div>
      <span class="brand-name">SHIELD<span style="color:#BCE600;">SMART</span></span>
      <span class="brand-sub">by XNL Tech</span>
    </div>
  </a>
  <a href="https://xnltech.com" class="nav-cta">Subscribe Free &rarr;</a>
</nav>

<!-- Issue header -->
<div class="issue-header">
  <a href="/archive" style="font-size:0.75rem;color:#7A8070;text-decoration:none;display:inline-flex;align-items:center;gap:5px;margin-bottom:1.5rem;">&larr; All issues</a>
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:0.75rem;flex-wrap:wrap;">
    <span style="background:rgba(188,230,0,0.08);border:1px solid rgba(188,230,0,0.25);color:#BCE600;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">${label}</span>
    <span style="font-size:0.78rem;color:#7A8070;">${date}</span>
  </div>
  <h1 style="font-family:'Bebas Neue',sans-serif;font-size:clamp(1.8rem,4vw,2.8rem);letter-spacing:0.03em;color:#fff;line-height:1;margin-bottom:0.5rem;">${subject}</h1>
  <p style="font-size:0.85rem;color:#7A8070;">by <strong style="color:#F2F5E8;">XNL Tech</strong> &bull; ShieldSmart Newsletter</p>
</div>

<!-- Preview: shows top ~420px of issue then fades out -->
<div class="preview-wrap">
  <div class="preview-inner" id="preview-inner">
    <div id="issue-content" style="pointer-events:none;background:#1E201E;border-radius:12px;padding:32px;color:#F2F5E8;font-size:16px;line-height:1.7;">${issueBody || issueHtml}</div>
    <div class="blur-overlay"></div>
  </div>
</div>

<!-- Gate: shown below the preview -->
<div class="gate-wrap" style="margin-top:-1rem;" id="gate-wrap">
  <div class="gate-card">
    <div style="font-size:1.75rem;margin-bottom:0.75rem;">&#128274;</div>
    <h3>Read the Full Issue</h3>
    <p>Already subscribed? Enter your email to unlock. Not subscribed yet? Enter your email to join free and read instantly.</p>
    <input type="email" id="gate-email" class="gate-input" placeholder="your@email.com" />
    <div id="gate-msg" style="font-size:0.75rem;color:#E8443A;margin-bottom:8px;display:none;"></div>
    <button class="gate-btn" onclick="gateAccess()">Unlock Full Issue &rarr;</button>
    <p class="gate-note">No spam. Unsubscribe anytime.</p>
  </div>
</div>

<!-- Scroll-triggered popup -->
<div class="popup-overlay" id="scroll-popup">
  <div class="popup-card">
    <button class="popup-close" onclick="closePopup()">&times;</button>
    <div id="popup-form">
      <div class="popup-icon">&#128737;</div>
      <h3>Want to Read More?</h3>
      <p>Already subscribed? Enter your email to unlock instantly. New here? Subscribe free — it only takes a second.</p>
      <input type="email" id="popup-email" class="gate-input" placeholder="your@email.com" />
      <div id="popup-msg" style="font-size:0.75rem;color:#E8443A;margin-bottom:8px;display:none;"></div>
      <button class="gate-btn" onclick="popupAccess()">Unlock Full Issue &rarr;</button>
      <p class="gate-note">No spam. No credit card. Unsubscribe anytime.</p>
    </div>
    <div class="success-state" id="popup-success">
      <div style="font-size:2rem;margin-bottom:0.75rem;">&#10003;</div>
      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;color:#fff;margin-bottom:0.5rem;">YOU'RE ALL SET!</h3>
      <p style="font-size:0.85rem;color:#7A8070;">Welcome to ShieldSmart! Unlocking your issue now...</p>
    </div>
  </div>
</div>

<script>
  const WORKER = 'https://xnltech.com';
  let popupShown = false;
  let scrollTriggered = false;

  // Trigger popup on scroll past preview
  window.addEventListener('scroll', () => {
    if (scrollTriggered) return;
    const preview = document.getElementById('preview-inner');
    if (!preview) return;
    const rect = preview.getBoundingClientRect();
    if (rect.bottom < window.innerHeight * 0.6) {
      scrollTriggered = true;
      setTimeout(showPopup, 400);
    }
  });

  function showPopup() {
    if (popupShown) return;
    popupShown = true;
    const p = document.getElementById('scroll-popup');
    p.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closePopup() {
    document.getElementById('scroll-popup').style.display = 'none';
    document.body.style.overflow = '';
  }

  document.getElementById('scroll-popup').addEventListener('click', (e) => {
    if (e.target.id === 'scroll-popup') closePopup();
  });

  // Check if already subscribed, if not subscribe them, then unlock
  async function accessCheck(email) {
    // First check if already subscribed
    const verifyRes = await fetch(WORKER + '/verify-subscriber', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const verifyData = await verifyRes.json();

    if (verifyData.verified) {
      return { success: true, message: null };
    }

    // Not subscribed — sign them up
    await fetch(WORKER + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, firstName: '', lastName: '' }),
    });

    return { success: true, message: null };
  }

  async function gateAccess() {
    const email = document.getElementById('gate-email').value.trim();
    const msgEl = document.getElementById('gate-msg');
    if (!email || !email.includes('@')) {
      document.getElementById('gate-email').style.borderColor = '#E8443A';
      return;
    }
    const btn = document.querySelector('#gate-wrap .gate-btn');
    btn.textContent = 'Checking\u2026';
    btn.disabled = true;
    msgEl.style.display = 'none';

    const result = await accessCheck(email);
    if (result.success) {
      unlockContent();
      document.getElementById('gate-wrap').style.display = 'none';
    } else {
      msgEl.textContent = result.message;
      msgEl.style.display = 'block';
      btn.textContent = 'Unlock Full Issue \u2192';
      btn.disabled = false;
    }
  }

  async function popupAccess() {
    const email = document.getElementById('popup-email').value.trim();
    const msgEl = document.getElementById('popup-msg');
    if (!email || !email.includes('@')) {
      document.getElementById('popup-email').style.borderColor = '#E8443A';
      return;
    }
    const btn = document.querySelector('#popup-form .gate-btn');
    btn.textContent = 'Checking\u2026';
    btn.disabled = true;
    msgEl.style.display = 'none';

    const result = await accessCheck(email);
    if (result.success) {
      document.getElementById('popup-form').style.display = 'none';
      document.getElementById('popup-success').style.display = 'block';
      setTimeout(() => {
        closePopup();
        unlockContent();
        document.getElementById('gate-wrap').style.display = 'none';
      }, 1800);
    } else {
      msgEl.textContent = result.message;
      msgEl.style.display = 'block';
      btn.textContent = 'Unlock Full Issue \u2192';
      btn.disabled = false;
    }
  }

  function unlockContent() {
    const preview = document.getElementById('preview-inner');
    preview.style.maxHeight = 'none';
    preview.style.overflow = 'visible';
    const overlay = preview.querySelector('.blur-overlay');
    if (overlay) overlay.style.display = 'none';
    document.getElementById('issue-content').style.pointerEvents = 'auto';
  }
</script>
</body>
</html>`);
}

// ─── ADMIN PAGE ──────────────────────────────────────────────────────────────
function handleAdminPage() {
  return html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ShieldSmart Admin — Reader Question Generator</title>
  <link rel="icon" type="image/png" href="/logo.png" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0D0F0D; color: #F2F5E8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; }
    .wrap { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
    .logo-row { display: flex; align-items: center; gap: 12px; margin-bottom: 32px; }
    .logo-row img { width: 38px; height: 38px; }
    .logo-row h1 { font-size: 24px; font-weight: 700; }
    .logo-row h1 span.s { color: #fff; } .logo-row h1 span.m { color: #BCE600; }
    .badge { display: inline-block; background: #F5A623; color: #111311; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 4px; margin-left: 10px; vertical-align: middle; }

    /* Login */
    .login-box, .gen-box { background: #111311; border: 1px solid #1E201E; border-radius: 12px; padding: 32px; margin-bottom: 24px; }
    label { display: block; color: #7A8070; font-size: 13px; margin-bottom: 6px; }
    input, textarea, select { width: 100%; background: #1E201E; border: 1px solid #2a2d2a; border-radius: 8px; color: #F2F5E8; padding: 12px 14px; font-size: 15px; font-family: inherit; }
    input:focus, textarea:focus, select:focus { outline: none; border-color: #BCE600; }
    textarea { min-height: 120px; resize: vertical; }
    .row { display: flex; gap: 16px; margin-bottom: 16px; }
    .row > * { flex: 1; }
    .field { margin-bottom: 16px; }

    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 28px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: .15s; }
    .btn-lime { background: #BCE600; color: #111311; }
    .btn-lime:hover { background: #d4ff1a; }
    .btn-amber { background: #F5A623; color: #111311; }
    .btn-amber:hover { background: #ffb940; }
    .btn-red { background: #e04040; color: #fff; }
    .btn-red:hover { background: #ff5555; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn-group { display: flex; gap: 12px; margin-top: 20px; }

    .status { margin-top: 16px; padding: 14px 18px; border-radius: 8px; font-size: 14px; display: none; }
    .status.ok { display: block; background: #1a2b1a; border: 1px solid #BCE600; color: #BCE600; }
    .status.err { display: block; background: #2b1a1a; border: 1px solid #e04040; color: #f88; }
    .status.info { display: block; background: #1a1f2b; border: 1px solid #5599ff; color: #88bbff; }

    .preview-frame { width: 100%; border: 1px solid #2a2d2a; border-radius: 8px; margin-top: 20px; background: #111311; min-height: 400px; }
    .hidden { display: none; }

    .send-confirm { background: #1E201E; border: 1px solid #F5A623; border-radius: 12px; padding: 24px; margin-top: 20px; }
    .send-confirm p { margin-bottom: 16px; color: #F2F5E8; }
    .send-confirm strong { color: #F5A623; }

    /* Section editor */
    .sec-card { background: #1a1c1a; border: 1px solid #2a2d2a; border-radius: 10px; padding: 18px; margin-bottom: 14px; position: relative; }
    .sec-card:hover { border-color: #3a3d3a; }
    .sec-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .sec-header .sec-num { background: #BCE600; color: #111311; font-weight: 700; font-size: 12px; min-width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 6px; }
    .sec-header input { flex: 1; font-size: 15px; font-weight: 600; }
    .sec-actions { display: flex; gap: 6px; }
    .sec-actions button { background: #222522; border: 1px solid #2a2d2a; color: #7A8070; width: 30px; height: 30px; border-radius: 6px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: .15s; padding: 0; }
    .sec-actions button:hover { border-color: #BCE600; color: #BCE600; }
    .sec-style-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .sec-style-opt { padding: 5px 12px; border: 1px solid #2a2d2a; border-radius: 6px; background: #222522; color: #7A8070; cursor: pointer; font-size: 12px; font-weight: 600; transition: .15s; }
    .sec-style-opt:hover { border-color: rgba(188,230,0,0.3); }
    .sec-style-opt.active { border-color: #BCE600; color: #BCE600; background: rgba(188,230,0,0.08); }
    .sec-body { min-height: 90px; }
    .sec-toolbar { display: flex; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; }
    .sec-toolbar button { background: #222522; border: 1px solid #2a2d2a; color: #F2F5E8; padding: 4px 10px; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 600; transition: .15s; }
    .sec-toolbar button:hover { border-color: #BCE600; color: #BCE600; }
    .sec-editor { background: #1E201E; border: 1px solid #2a2d2a; border-radius: 8px; padding: 14px; color: #F2F5E8; font-size: 15px; line-height: 1.7; min-height: 90px; outline: none; }
    .sec-editor:focus { border-color: #BCE600; }
    .sec-editor ul, .sec-editor ol { margin-left: 20px; }
  </style>
</head>
<body>
<div class="wrap">
  <div class="logo-row">
    <img src="/logo.png" alt="ShieldSmart" />
    <h1><span class="s">SHIELD</span><span class="m">SMART</span> <span class="badge">ADMIN</span></h1>
  </div>

  <!-- Login -->
  <div class="login-box" id="loginBox">
    <h2 style="margin-bottom:16px; font-size:18px;">🔐 Admin Login</h2>
    <div class="field">
      <label for="secret">Admin Secret</label>
      <input type="password" id="secret" placeholder="Enter admin secret..." />
    </div>
    <button class="btn btn-lime" onclick="doLogin()">Unlock</button>
    <div class="status" id="loginStatus"></div>
  </div>

  <!-- Main panel (hidden until login) -->
  <div id="mainPanel" class="hidden">
    <div style="display:flex; gap:16px; margin-bottom:24px;">
      <div style="flex:1; background:#111311; border:1px solid #1E201E; border-radius:12px; padding:20px; text-align:center;">
        <div style="color:#7A8070; font-size:12px; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Active Subscribers</div>
        <div id="subCount" style="color:#BCE600; font-size:36px; font-weight:700;">—</div>
      </div>
      <div style="flex:1; background:#111311; border:1px solid #1E201E; border-radius:12px; padding:20px; text-align:center;">
        <div style="color:#7A8070; font-size:12px; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">Total Subscribers</div>
        <div id="subTotal" style="color:#F2F5E8; font-size:36px; font-weight:700;">—</div>
      </div>
    </div>
    <div class="gen-box">
      <h2 style="margin-bottom:20px; font-size:18px;">📨 Generate Newsletter from Reader Question</h2>
      <div class="row">
        <div class="field">
          <label for="readerName">Reader's First Name (optional)</label>
          <input type="text" id="readerName" placeholder="e.g. Sarah" />
        </div>
        <div class="field">
          <label for="issueType">Issue Type</label>
          <select id="issueType">
            <option value="friday" selected>Friday — Fix-It Help Desk</option>
            <option value="monday">Monday — Threat Radar</option>
            <option value="wednesday">Wednesday — Safety Skill</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="question">Reader's Question (from help@xnltech.com)</label>
        <textarea id="question" placeholder="Paste the reader's question here... e.g. &quot;My phone battery dies by noon every day. How do I fix it?&quot;"></textarea>
      </div>
      <button class="btn btn-lime" id="genBtn" onclick="doGenerate()">⚡ Generate Newsletter</button>
      <div class="status" id="genStatus"></div>
    </div>

    <!-- Preview area -->
    <div id="previewArea" class="hidden">
      <div class="gen-box">
        <h2 style="margin-bottom:8px; font-size:18px;">👁️ Preview</h2>
        <p style="color:#7A8070; font-size:14px; margin-bottom:12px;" id="previewSubject"></p>
        <iframe class="preview-frame" id="previewFrame" sandbox="allow-same-origin"></iframe>
        <div class="btn-group">
          <button class="btn btn-lime" onclick="doGenerate()">🔄 Regenerate</button>
          <button class="btn btn-amber" id="sendBtn" onclick="showSendConfirm()">📤 Send to All Subscribers</button>
        </div>
        <div class="send-confirm hidden" id="sendConfirm">
          <p>⚠️ This will send this newsletter to <strong>all active subscribers</strong>. Are you sure?</p>
          <div class="btn-group">
            <button class="btn btn-red" id="confirmSendBtn" onclick="doSend()">Yes, Send It</button>
            <button class="btn btn-lime" onclick="hideSendConfirm()">Cancel</button>
          </div>
        </div>
        <div class="status" id="sendStatus"></div>
      </div>
    </div>

    <!-- Custom Newsletter Writer -->
    <div class="gen-box" style="margin-top:24px;">
      <h2 style="margin-bottom:16px; font-size:18px;">✍️ Write Custom Newsletter</h2>
      <p style="color:#7A8070; font-size:13px; margin-bottom:16px;">Add sections visually — styling matches the AI-generated newsletters automatically.</p>
      <div class="row">
        <div class="field">
          <label for="customSubject">Subject Line</label>
          <input type="text" id="customSubject" placeholder="e.g. 🔐 Special Announcement from ShieldSmart" />
        </div>
        <div class="field">
          <label for="customType">Issue Type (for styling)</label>
          <select id="customType">
            <option value="monday">Monday — Threat Radar</option>
            <option value="wednesday">Wednesday — Safety Skill</option>
            <option value="friday">Friday — Fix-It Help Desk</option>
          </select>
        </div>
      </div>

      <!-- Intro paragraph (optional) -->
      <div class="field">
        <label>Intro Paragraph <span style="color:#5A6050; font-weight:400;">(optional — shows before sections)</span></label>
        <textarea id="customIntro" rows="3" placeholder="Hey ShieldSmart readers! This week we have something special…"></textarea>
      </div>

      <!-- Section builder -->
      <label style="margin-bottom:10px;">Sections</label>
      <div id="sectionList"></div>
      <button class="btn btn-lime" style="margin-bottom:20px;" onclick="addSection()">＋ Add Section</button>

      <div class="btn-group">
        <button class="btn btn-lime" id="customPreviewBtn" onclick="doCustomPreview()">👁️ Preview</button>
      </div>
      <div class="status" id="customStatus"></div>
      <div id="customPreviewArea" class="hidden" style="margin-top:20px;">
        <iframe class="preview-frame" id="customPreviewFrame" sandbox="allow-same-origin" style="height:600px;"></iframe>
        <div class="btn-group" style="margin-top:12px;">
          <button class="btn btn-lime" onclick="doCustomPreview()">🔄 Refresh Preview</button>
          <button class="btn btn-amber" onclick="showCustomSendConfirm()">📤 Send to All Subscribers</button>
        </div>
        <div class="send-confirm hidden" id="customSendConfirm">
          <p>⚠️ This will send this custom newsletter to <strong>all active subscribers</strong>. Are you sure?</p>
          <div class="btn-group">
            <button class="btn btn-red" id="customConfirmSendBtn" onclick="doCustomSend()">Yes, Send It</button>
            <button class="btn btn-lime" onclick="hideCustomSendConfirm()">Cancel</button>
          </div>
        </div>
        <div class="status" id="customSendStatus"></div>
      </div>
    </div>

    <!-- Social Post Generator -->
    <div class="gen-box" style="margin-top:24px;">
      <h2 style="margin-bottom:16px; font-size:18px;">📱 Social Media Post Generator</h2>
      <p style="color:#7A8070; font-size:13px; margin-bottom:16px;">Generate ready-to-paste posts for Facebook and X to promote ShieldSmart and drive subscriptions.</p>
      <div class="field">
        <label for="socialTopic">Topic / Angle (optional)</label>
        <input type="text" id="socialTopic" placeholder="e.g. &quot;phone scams targeting seniors&quot; — leave blank for AI to pick" />
      </div>
      <button class="btn btn-lime" id="socialBtn" onclick="doSocialGen()">📱 Generate Posts</button>
      <div class="status" id="socialStatus"></div>
      <div id="socialResults" class="hidden" style="margin-top:20px;">
        <div style="margin-bottom:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <label style="margin:0; font-size:14px; color:#5599ff;">Facebook</label>
            <button class="btn btn-lime" style="padding:4px 14px; font-size:12px;" onclick="copyText('fbPost')">📋 Copy</button>
          </div>
          <div id="fbPost" style="background:#1E201E; border:1px solid #2a2d2a; border-radius:8px; padding:14px; color:#F2F5E8; font-size:14px; line-height:1.6; white-space:pre-wrap;"></div>
        </div>
        <div style="margin-bottom:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <label style="margin:0; font-size:14px; color:#F2F5E8;">𝕏 Post (Option 1)</label>
            <button class="btn btn-lime" style="padding:4px 14px; font-size:12px;" onclick="copyText('twPost')">📋 Copy</button>
          </div>
          <div id="twPost" style="background:#1E201E; border:1px solid #2a2d2a; border-radius:8px; padding:14px; color:#F2F5E8; font-size:14px; line-height:1.6; white-space:pre-wrap;"></div>
        </div>
        <div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <label style="margin:0; font-size:14px; color:#F2F5E8;">𝕏 Post (Option 2)</label>
            <button class="btn btn-lime" style="padding:4px 14px; font-size:12px;" onclick="copyText('twAltPost')">📋 Copy</button>
          </div>
          <div id="twAltPost" style="background:#1E201E; border:1px solid #2a2d2a; border-radius:8px; padding:14px; color:#F2F5E8; font-size:14px; line-height:1.6; white-space:pre-wrap;"></div>
        </div>
      </div>
    </div>

    <!-- Manage Newsletters -->
    <div class="gen-box" style="margin-top:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h2 style="font-size:18px;">🗂️ Manage Newsletters</h2>
        <button class="btn btn-lime" style="padding:8px 18px; font-size:13px;" onclick="loadIssues()">Refresh</button>
      </div>
      <div id="issueList" style="color:#7A8070; font-size:14px;">Loading issues...</div>
    </div>

    <!-- Cron Log section -->
    <div class="gen-box" style="margin-top:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h2 style="font-size:18px;">⏰ Cron Job History</h2>
        <button class="btn btn-lime" style="padding:8px 18px; font-size:13px;" onclick="loadCronLogs()">Refresh</button>
      </div>
      <div id="cronLogs" style="color:#7A8070; font-size:14px;">Click Refresh to load cron logs.</div>
    </div>
  </div>
</div>

<script>
  let adminSecret = '';
  let lastGenerated = null;

  function $(id) { return document.getElementById(id); }

  function setStatus(id, cls, msg) {
    const el = $(id);
    el.className = 'status ' + cls;
    el.textContent = msg;
  }

  function doLogin() {
    adminSecret = $('secret').value.trim();
    if (!adminSecret) { setStatus('loginStatus', 'err', 'Please enter the admin secret.'); return; }
    $('loginBox').classList.add('hidden');
    $('mainPanel').classList.remove('hidden');
    loadCronLogs();
    loadSubCount();
    loadIssues();
    setInterval(loadSubCount, 30000);
    setInterval(loadCronLogs, 60000);
  }

  async function loadSubCount() {
    try {
      const res = await fetch('/subscribers', { headers: { 'X-Admin-Secret': adminSecret } });
      const data = await res.json();
      if (data.subscribers) {
        const active = data.subscribers.filter(s => s.active).length;
        $('subCount').textContent = active;
        $('subTotal').textContent = data.subscribers.length;
      }
    } catch (_) {}
  }

  async function loadIssues() {
    var el = $('issueList');
    el.innerHTML = '<span style="color:#88bbff;">Loading...</span>';
    try {
      var res = await fetch('/admin/list-issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret }),
      });
      var data = await res.json();
      if (!data.issues || data.issues.length === 0) {
        el.innerHTML = '<span style="color:#7A8070;">No newsletters in archive yet.</span>';
        return;
      }
      var typeLabel = { monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
      var typeColor = { monday: '#E8443A', wednesday: '#BCE600', friday: '#F5A623' };
      el.innerHTML = data.issues.map(function(issue) {
        var d = new Date(issue.generatedAt).toLocaleString();
        var label = typeLabel[issue.issueType] || 'ShieldSmart';
        var color = typeColor[issue.issueType] || '#BCE600';
        var badge = '<span style="display:inline-block;background:' + color + '18;border:1px solid ' + color + '44;color:' + color + ';font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.05em;">' + label + '</span>';
        var subj = issue.subject || '(no subject)';
        return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #1E201E;">'
          + badge
          + '<span style="flex:1;color:#F2F5E8;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + subj + '</span>'
          + '<span style="color:#7A8070;font-size:12px;white-space:nowrap;">' + d + '</span>'
          + '<button style="background:#2b1a1a;border:1px solid #e04040;color:#f88;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;" onclick="deleteIssue(&apos;' + issue.id.replace(/'/g, '') + '&apos;)">🗑️ Delete</button>'
          + '</div>';
      }).join('');
    } catch (e) {
      el.innerHTML = '<span style="color:#f88;">Failed to load: ' + e.message + '</span>';
    }
  }

  async function deleteIssue(id) {
    if (!confirm('Delete this newsletter?\\n\\n' + id + '\\n\\nThis cannot be undone.')) return;
    try {
      var res = await fetch('/admin/delete-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret, id: id }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      loadIssues();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  async function loadCronLogs() {
    const el = $('cronLogs');
    el.innerHTML = '<span style="color:#88bbff;">Loading...</span>';
    try {
      const res = await fetch('/admin/cron-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret }),
      });
      const data = await res.json();
      if (!data.logs || data.logs.length === 0) {
        el.innerHTML = '<span style="color:#7A8070;">No cron logs yet. Logs will appear after the next scheduled run.</span>';
        return;
      }
      el.innerHTML = data.logs.map(l => {
        const d = new Date(l.firedAt).toLocaleString();
        const color = l.status === 'sent' ? '#BCE600' : l.status === 'error' ? '#f88' : '#F5A623';
        const badge = '<span style="display:inline-block;background:' + color + ';color:#111;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;">' + l.status.toUpperCase() + '</span>';
        let detail = l.subject ? ' — ' + l.subject : '';
        if (l.sent !== undefined) detail += ' (' + l.sent + ' sent, ' + l.failed + ' failed)';
        if (l.error) detail += ' — ' + l.error;
        return '<div style="padding:8px 0;border-bottom:1px solid #1E201E;">' + badge + ' <span style="color:#7A8070;margin:0 8px;">' + d + '</span> <strong style="color:#F2F5E8;">' + l.issueType + '</strong>' + detail + '</div>';
      }).join('');
    } catch (e) {
      el.innerHTML = '<span style="color:#f88;">Failed to load: ' + e.message + '</span>';
    }
  }

  async function doGenerate() {
    const question = $('question').value.trim();
    const issueType = $('issueType').value;
    const readerName = $('readerName').value.trim();
    if (!question) { setStatus('genStatus', 'err', 'Please enter a reader question.'); return; }

    $('genBtn').disabled = true;
    $('genBtn').textContent = '⏳ Generating...';
    setStatus('genStatus', 'info', 'Calling AI to generate newsletter... this may take 30-60 seconds.');
    $('previewArea').classList.add('hidden');
    $('sendConfirm').classList.add('hidden');

    try {
      const res = await fetch('/admin/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret, question, issueType, readerName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');

      lastGenerated = data;
      $('previewSubject').textContent = '📋 Subject: ' + data.subject;
      const frame = $('previewFrame');
      frame.srcdoc = data.html;
      frame.style.height = '600px';
      $('previewArea').classList.remove('hidden');
      setStatus('genStatus', 'ok', 'Newsletter generated! Preview it below, then send when ready.');
    } catch (e) {
      setStatus('genStatus', 'err', 'Error: ' + e.message);
    } finally {
      $('genBtn').disabled = false;
      $('genBtn').textContent = '⚡ Generate Newsletter';
    }
  }

  async function doSocialGen() {
    const topic = $('socialTopic').value.trim();
    $('socialBtn').disabled = true;
    $('socialBtn').textContent = '⏳ Generating...';
    setStatus('socialStatus', 'info', 'Generating social posts... ~15 seconds.');
    $('socialResults').classList.add('hidden');

    try {
      const res = await fetch('/admin/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret, topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');

      $('fbPost').textContent = data.facebook;
      $('twPost').textContent = data.twitter;
      $('twAltPost').textContent = data.twitterAlt;
      $('socialResults').classList.remove('hidden');
      setStatus('socialStatus', 'ok', 'Posts generated! Copy and paste into each platform.');
    } catch (e) {
      setStatus('socialStatus', 'err', 'Error: ' + e.message);
    } finally {
      $('socialBtn').disabled = false;
      $('socialBtn').textContent = '📱 Generate Posts';
    }
  }

  function copyText(id) {
    const text = $(id).textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = $(id).parentElement.querySelector('.btn');
      const orig = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => btn.textContent = orig, 1500);
    });
  }

  function showSendConfirm() { $('sendConfirm').classList.remove('hidden'); }
  function hideSendConfirm() { $('sendConfirm').classList.add('hidden'); }

  let lastCustom = null;
  let sectionCount = 0;

  function addSection(title, content, style) {
    sectionCount++;
    const id = sectionCount;
    const div = document.createElement('div');
    div.className = 'sec-card';
    div.dataset.id = id;
    div.innerHTML = '<div class="sec-header">'
      + '<span class="sec-num">' + id + '</span>'
      + '<input type="text" class="sec-title" placeholder="Section heading (e.g. What Happened, Why It Matters, What To Do)" value="' + (title || '').replace(/"/g, '&quot;') + '" />'
      + '<div class="sec-actions">'
      + '<button title="Move up" onclick="moveSection(this,-1)">▲</button>'
      + '<button title="Move down" onclick="moveSection(this,1)">▼</button>'
      + '<button title="Remove" onclick="removeSection(this)">✕</button>'
      + '</div></div>'
      + '<div class="sec-style-row">'
      + '<span class="sec-style-opt' + ((!style || style === 'default') ? ' active' : '') + '" onclick="pickStyle(this,&apos;default&apos;)">Default</span>'
      + '<span class="sec-style-opt' + ((style === 'callout') ? ' active' : '') + '" onclick="pickStyle(this,&apos;callout&apos;)">⚡ Callout</span>'
      + '<span class="sec-style-opt' + ((style === 'warning') ? ' active' : '') + '" onclick="pickStyle(this,&apos;warning&apos;)">⚠️ Warning</span>'
      + '<span class="sec-style-opt' + ((style === 'tip') ? ' active' : '') + '" onclick="pickStyle(this,&apos;tip&apos;)">💡 Tip</span>'
      + '<span class="sec-style-opt' + ((style === 'steps') ? ' active' : '') + '" onclick="pickStyle(this,&apos;steps&apos;)">📋 Steps</span>'
      + '</div>'
      + '<div class="sec-body">'
      + '<div class="sec-toolbar">'
      + '<button onclick="fmt(this,&apos;bold&apos;)"><b>B</b></button>'
      + '<button onclick="fmt(this,&apos;italic&apos;)"><i>I</i></button>'
      + '<button onclick="fmt(this,&apos;insertUnorderedList&apos;)">• List</button>'
      + '<button onclick="fmt(this,&apos;insertOrderedList&apos;)">1. List</button>'
      + '<button onclick="fmtLink(this)">🔗 Link</button>'
      + '</div>'
      + '<div class="sec-editor" contenteditable="true" data-placeholder="Write your content here…">' + (content || '') + '</div>'
      + '</div>';
    $('sectionList').appendChild(div);
    renumberSections();
  }

  function removeSection(btn) {
    btn.closest('.sec-card').remove();
    renumberSections();
  }

  function moveSection(btn, dir) {
    const card = btn.closest('.sec-card');
    const list = $('sectionList');
    if (dir === -1 && card.previousElementSibling) {
      list.insertBefore(card, card.previousElementSibling);
    } else if (dir === 1 && card.nextElementSibling) {
      list.insertBefore(card.nextElementSibling, card);
    }
    renumberSections();
  }

  function renumberSections() {
    document.querySelectorAll('#sectionList .sec-card').forEach(function(c, i) {
      c.querySelector('.sec-num').textContent = i + 1;
    });
  }

  function pickStyle(el, style) {
    el.parentElement.querySelectorAll('.sec-style-opt').forEach(function(s) { s.classList.remove('active'); });
    el.classList.add('active');
  }

  function fmt(btn, cmd) {
    var editor = btn.closest('.sec-body').querySelector('.sec-editor');
    editor.focus();
    document.execCommand(cmd, false, null);
  }

  function fmtLink(btn) {
    var url = prompt('Enter URL:');
    if (url) {
      var editor = btn.closest('.sec-body').querySelector('.sec-editor');
      editor.focus();
      document.execCommand('createLink', false, url);
    }
  }

  function getActiveStyle(card) {
    const active = card.querySelector('.sec-style-opt.active');
    if (!active) return 'default';
    if (active.textContent.includes('Callout')) return 'callout';
    if (active.textContent.includes('Warning')) return 'warning';
    if (active.textContent.includes('Tip')) return 'tip';
    if (active.textContent.includes('Steps')) return 'steps';
    return 'default';
  }

  function buildSectionHtml(title, content, style) {
    var bg, border, headerColor, icon;
    switch (style) {
      case 'callout':
        bg = '#1A2600'; border = '#4A6600'; headerColor = '#BCE600'; icon = '⚡';
        break;
      case 'warning':
        bg = '#2B1A00'; border = '#8B5E00'; headerColor = '#F5A623'; icon = '⚠️';
        break;
      case 'tip':
        bg = '#0D1A2B'; border = '#1A4070'; headerColor = '#5599FF'; icon = '💡';
        break;
      case 'steps':
        bg = '#1A1E1A'; border = '#3A3D3A'; headerColor = '#BCE600'; icon = '📋';
        break;
      default:
        bg = '#1E201E'; border = '#2A2C2A'; headerColor = '#BCE600'; icon = '';
    }

    var html = '<div style="background-color:' + bg + ';border:1px solid ' + border + ';border-radius:12px;padding:28px 30px;margin-bottom:25px;">';
    if (title) {
      html += '<h2 style="color:' + headerColor + ';font-family:Arial,sans-serif;font-size:20px;font-weight:700;margin:0 0 16px;">' + (icon ? icon + ' ' : '') + escHtml(title) + '</h2>';
    }
    html += '<div style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;">' + content + '</div>';
    html += '</div>';
    return html;
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function buildRawHtml() {
    var parts = [];
    var intro = $('customIntro').value.trim();
    if (intro) {
      parts.push('<p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;margin-bottom:25px;">' + escHtml(intro).replace(/\\n/g, '<br/>') + '</p>');
    }
    document.querySelectorAll('#sectionList .sec-card').forEach(function(card) {
      var title = card.querySelector('.sec-title').value.trim();
      var content = card.querySelector('.sec-editor').innerHTML.trim();
      var style = getActiveStyle(card);
      if (content || title) {
        parts.push(buildSectionHtml(title, content, style));
      }
    });
    return parts.join('\\n');
  }

  // Seed the editor with one section by default
  addSection('', '', 'default');

  async function doCustomPreview() {
    const subject = $('customSubject').value.trim();
    const rawHtml = buildRawHtml();
    const issueType = $('customType').value;
    if (!subject || !rawHtml) { setStatus('customStatus', 'err', 'Subject and at least one section with content are required.'); return; }

    $('customPreviewBtn').disabled = true;
    $('customPreviewBtn').textContent = '⏳ Wrapping...';
    setStatus('customStatus', 'info', 'Wrapping in email template...');

    try {
      const res = await fetch('/admin/wrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret, subject, rawHtml, issueType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Wrap failed');

      lastCustom = data;
      $('customPreviewFrame').srcdoc = data.html;
      $('customPreviewArea').classList.remove('hidden');
      setStatus('customStatus', 'ok', 'Preview ready. Saved to archive.');
    } catch (e) {
      setStatus('customStatus', 'err', 'Error: ' + e.message);
    } finally {
      $('customPreviewBtn').disabled = false;
      $('customPreviewBtn').textContent = '👁️ Preview';
    }
  }

  function showCustomSendConfirm() { $('customSendConfirm').classList.remove('hidden'); }
  function hideCustomSendConfirm() { $('customSendConfirm').classList.add('hidden'); }

  async function doCustomSend() {
    if (!lastCustom) return;
    $('customConfirmSendBtn').disabled = true;
    $('customConfirmSendBtn').textContent = '⏳ Sending...';
    setStatus('customSendStatus', 'info', 'Sending to all subscribers...');

    try {
      const res = await fetch('/admin/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: adminSecret,
          subject: lastCustom.subject,
          htmlContent: lastCustom.html,
          issueType: lastCustom.issueType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');

      setStatus('customSendStatus', 'ok', 'Sent! ' + data.sent + ' delivered, ' + data.failed + ' failed out of ' + data.total + ' subscribers.');
      hideCustomSendConfirm();
      loadSubCount();
    } catch (e) {
      setStatus('customSendStatus', 'err', 'Error: ' + e.message);
    } finally {
      $('customConfirmSendBtn').disabled = false;
      $('customConfirmSendBtn').textContent = 'Yes, Send It';
    }
  }

  async function doSend() {
    if (!lastGenerated) return;
    $('confirmSendBtn').disabled = true;
    $('confirmSendBtn').textContent = '⏳ Sending...';
    setStatus('sendStatus', 'info', 'Sending to all subscribers...');

    try {
      const res = await fetch('/admin/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: adminSecret,
          subject: lastGenerated.subject,
          htmlContent: lastGenerated.html,
          issueType: lastGenerated.issueType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');

      setStatus('sendStatus', 'ok', 'Sent! ' + data.sent + ' delivered, ' + data.failed + ' failed out of ' + data.total + ' subscribers.');
      hideSendConfirm();
    } catch (e) {
      setStatus('sendStatus', 'err', 'Error: ' + e.message);
    } finally {
      $('confirmSendBtn').disabled = false;
      $('confirmSendBtn').textContent = 'Yes, Send It';
    }
  }
</script>
</body>
</html>`);
}

// ─── LANDING PAGE ────────────────────────────────────────────────────────────
function handleLandingPage() {
  return html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ShieldSmart | Cyber Safety Newsletter by XNL Tech</title>
  <meta name="description" content="Plain-English cyber safety tips 3x a week. No jargon. Real protection for real people." />
  <link rel="icon" type="image/png" href="/logo.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@300;400;500;600;700&display=swap" rel="stylesheet" />

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0D0F0D;
      --panel-l:   #111311;
      --panel-r:   #181A18;
      --card:      #1E201E;
      --card2:     #222522;
      --border:    rgba(255,255,255,0.07);
      --border2:   rgba(188,230,0,0.25);
      --lime:      #BCE600;
      --lime2:     #A8CE00;
      --lime-dim:  rgba(188,230,0,0.08);
      --white:     #FFFFFF;
      --off:       #F2F5E8;
      --muted:     #7A8070;
      --muted2:    #5A6050;
      --danger:    #FF5C5C;
      --font-head: 'Bebas Neue', sans-serif;
      --font-body: 'Figtree', sans-serif;
    }

    body {
      font-family: var(--font-body);
      background: var(--panel-l);
      color: var(--off);
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* ─── TOPBAR ─── */
    .topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 2.5rem;
      height: 56px;
      background: rgba(13,15,13,0.88);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
    }

    .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }

    .brand-shield {
      width: 38px; height: 38px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }

    .brand-shield img {
      width: 38px; height: 38px;
      display: block;
    }

    .brand-name {
      font-family: var(--font-head);
      font-size: 1.35rem;
      letter-spacing: 0.05em;
      color: var(--white);
      line-height: 1;
    }

    .brand-sub {
      font-family: var(--font-body);
      font-size: 0.58rem;
      font-weight: 500;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-left: 6px;
    }

    .topbar-right { font-size: 0.8rem; color: var(--muted); }
    .topbar-right a { color: var(--lime); text-decoration: none; font-weight: 600; }

    /* ─── SPLIT ─── */
    .split {
      display: flex;
      min-height: 100vh;
      padding-top: 56px;
      max-width: 1200px;
      margin: 0 auto;
      width: 100%;
    }

    /* ─── LEFT ─── */
    .left {
      flex: 1.15;
      background: var(--panel-l);
      padding: 4rem 2.5rem 3rem;
      display: flex;
      flex-direction: column;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .left::before {
      content: '';
      position: absolute; inset: 0;
      background-image:
        linear-gradient(rgba(188,230,0,0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(188,230,0,0.035) 1px, transparent 1px);
      background-size: 32px 32px;
      pointer-events: none;
    }

    .left::after {
      content: '';
      position: absolute;
      top: -80px; right: -100px;
      width: 380px; height: 380px;
      background: radial-gradient(circle, rgba(188,230,0,0.06) 0%, transparent 68%);
      pointer-events: none;
    }

    .left-inner {
      position: relative;
      z-index: 1;
      max-width: 490px;
      animation: fadeUp 0.5s ease both;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--lime);
      margin-bottom: 1.2rem;
    }

    .eyebrow-dot {
      width: 5px; height: 5px;
      background: var(--lime);
      border-radius: 50%;
      animation: blink 2s ease infinite;
    }

    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.25} }

    h1 {
      font-family: var(--font-head);
      font-size: clamp(3.2rem, 5vw, 5rem);
      line-height: 0.94;
      letter-spacing: 0.02em;
      color: var(--white);
      margin-bottom: 1.4rem;
    }

    h1 .lime { color: var(--lime); }

    .hero-desc {
      font-size: 0.97rem;
      color: var(--muted);
      line-height: 1.7;
      font-weight: 400;
      margin-bottom: 2.75rem;
      max-width: 390px;
    }

    .features { display: flex; flex-direction: column; gap: 1.4rem; }

    .feature {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      animation: fadeUp 0.5s ease both;
    }
    .feature:nth-child(1){animation-delay:0.08s}
    .feature:nth-child(2){animation-delay:0.16s}
    .feature:nth-child(3){animation-delay:0.24s}

    .feat-icon {
      width: 36px; height: 36px;
      flex-shrink: 0;
      background: var(--lime-dim);
      border: 1px solid var(--border2);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.95rem;
    }

    .feat-title {
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--off);
      margin-bottom: 2px;
    }

    .feat-body {
      font-size: 0.78rem;
      color: var(--muted);
      line-height: 1.6;
    }

    .schedule {
      display: flex;
      gap: 8px;
      margin-top: 2.25rem;
      flex-wrap: wrap;
    }

    .sched-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 100px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.025);
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 0.04em;
    }

    .sched-pill .day { font-weight: 700; color: var(--lime); }

    .partner-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 2.75rem;
      padding-top: 1.75rem;
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
    }

    .partner-row > span {
      font-size: 0.63rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted2);
    }

    .partner-chip {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--muted);
    }

    .partner-chip .dot { width: 6px; height: 6px; border-radius: 50%; }

    /* ─── RIGHT ─── */
    .right {
      flex: 0.85;
      background: var(--panel-r);
      padding: 3.5rem 2rem;
      display: flex;
      flex-direction: column;
      justify-content: center;
      border-left: 1px solid var(--border);
    }

    .form-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2.25rem 1.875rem;
      max-width: 410px;
      width: 100%;
      margin: 0 auto;
      animation: fadeUp 0.5s 0.12s ease both;
    }

    .threat-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255,92,92,0.06);
      border: 1px solid rgba(255,92,92,0.18);
      border-radius: 8px;
      padding: 8px 12px;
      margin-bottom: 1.5rem;
    }

    .threat-label {
      font-size: 0.58rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--danger);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .threat-text {
      font-size: 0.73rem;
      color: rgba(242,245,232,0.55);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: opacity 0.4s;
    }

    .form-headline {
      font-family: var(--font-head);
      font-size: 1.65rem;
      letter-spacing: 0.04em;
      color: var(--white);
      margin-bottom: 0.3rem;
    }

    .form-sub {
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 1.6rem;
      line-height: 1.5;
    }

    .free-badge {
      display: inline-block;
      background: var(--lime-dim);
      border: 1px solid var(--border2);
      color: var(--lime);
      font-size: 0.62rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 4px;
      margin-left: 5px;
      vertical-align: middle;
    }

    .field-row { display: flex; gap: 10px; margin-bottom: 11px; }

    .field { display: flex; flex-direction: column; gap: 5px; flex: 1; }

    .field label {
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .field input {
      background: var(--card2);
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 0.72rem 0.95rem;
      font-family: var(--font-body);
      font-size: 0.88rem;
      color: var(--white);
      outline: none;
      transition: border-color 0.2s, background 0.2s;
      width: 100%;
    }

    .field input::placeholder { color: var(--muted2); }
    .field input:focus { border-color: var(--lime); background: rgba(188,230,0,0.04); }

    .field-full { margin-bottom: 11px; }

    .freq-label {
      font-size: 0.68rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 7px;
    }

    .freq-row { display: flex; gap: 8px; margin-bottom: 1.2rem; }

    .freq-opt {
      flex: 1;
      padding: 9px 4px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: var(--card2);
      cursor: pointer;
      text-align: center;
      transition: all 0.18s;
      user-select: none;
    }

    .freq-opt:hover { border-color: rgba(188,230,0,0.3); }
    .freq-opt.active { border-color: var(--lime); background: var(--lime-dim); }

    .freq-day {
      font-family: var(--font-head);
      font-size: 1.05rem;
      letter-spacing: 0.05em;
      color: var(--white);
      display: block;
      line-height: 1;
    }

    .freq-opt.active .freq-day { color: var(--lime); }

    .freq-topic {
      font-size: 0.58rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: block;
      margin-top: 3px;
    }

    .submit-btn {
      width: 100%;
      background: var(--lime);
      color: var(--bg);
      border: none;
      border-radius: 10px;
      padding: 0.88rem;
      font-family: var(--font-body);
      font-size: 0.93rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s, transform 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .submit-btn:hover { background: var(--lime2); transform: translateY(-1px); }
    .submit-btn:active { transform: scale(0.99); }
    .submit-btn:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }

    .terms-note {
      font-size: 0.67rem;
      color: var(--muted2);
      text-align: center;
      margin-top: 0.9rem;
      line-height: 1.65;
    }

    .terms-note a { color: var(--muted); text-decoration: underline; }

    .sub-count {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 1.1rem;
      padding-top: 1.1rem;
      border-top: 1px solid var(--border);
    }

    .avatars-sm { display: flex; }

    .av {
      width: 22px; height: 22px;
      border-radius: 50%;
      border: 1.5px solid var(--card);
      margin-right: -6px;
      font-size: 8px;
      font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }

    .av:nth-child(1){background:#4A90D9;color:#fff}
    .av:nth-child(2){background:#9B59B6;color:#fff}
    .av:nth-child(3){background:#E67E22;color:#fff}
    .av:nth-child(4){background:#27AE60;color:#fff}

    .sub-text { font-size: 0.7rem; color: var(--muted); padding-left: 8px; }
    .sub-text strong { color: var(--off); }

    /* Success */
    .success-screen {
      display: none;
      text-align: center;
      padding: 0.5rem 0;
      animation: fadeUp 0.4s ease both;
    }

    .success-icon {
      width: 60px; height: 60px;
      background: var(--lime-dim);
      border: 2px solid var(--lime);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 1.6rem;
      margin: 0 auto 1.1rem;
    }

    .success-screen h3 {
      font-family: var(--font-head);
      font-size: 1.8rem;
      letter-spacing: 0.05em;
      color: var(--white);
      margin-bottom: 0.5rem;
    }

    .success-screen p { font-size: 0.83rem; color: var(--muted); line-height: 1.7; }

    /* Footer */
    footer {
      background: var(--panel-l);
      border-top: 1px solid var(--border);
      padding: 1.1rem 2.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.73rem;
      color: var(--muted2);
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    footer a { color: var(--muted); text-decoration: none; }
    footer a:hover { color: var(--lime); }

    @keyframes fadeUp {
      from { opacity:0; transform:translateY(14px); }
      to   { opacity:1; transform:translateY(0); }
    }

    @media (max-width: 860px) {
      .split { flex-direction: column; min-height: auto; }
      .left, .right { flex: none; padding: 2.5rem 1.5rem; }
      .left { min-height: auto; padding-bottom: 2rem; }
      .left-inner { max-width: 100%; }
      h1 { font-size: 3rem; }
      .form-card { max-width: 100%; }
      footer { justify-content: center; text-align: center; }
    }

    @media (max-width: 480px) {
      .field-row { flex-direction: column; }
      .topbar-right { display: none; }
      .topbar { padding: 0 1rem; }
    }
  </style>
</head>
<body>

<nav class="topbar">
  <a href="#" class="brand">
    <div class="brand-shield"><img src="/logo.png" alt="ShieldSmart" width="38" height="38" /></div>
    <div>
      <span class="brand-name">SHIELD<span style="color:#BCE600;">SMART</span></span>
      <span class="brand-sub">by XNL Tech</span>
    </div>
  </a>
</nav>

<main class="split">

  <!-- LEFT -->
  <section class="left">
    <div class="left-inner">
      <div class="eyebrow">
        <span class="eyebrow-dot"></span>
        Free Cyber Safety Newsletter &mdash; 3&times; a week
      </div>

      <h1>
        STAY ONE STEP<br/>
        AHEAD OF<br/>
        <span class="lime">HACKERS.</span>
      </h1>

      <p class="hero-desc">
        Plain English alerts and practical tips to keep you safe online &mdash;
        no tech degree required. Built for everyday people by <strong style="color:var(--off)">XNL Tech</strong>.
      </p>

      <div class="features">
        <div class="feature">
          <div class="feat-icon">&#128270;</div>
          <div>
            <div class="feat-title">Scam alerts before they reach you</div>
            <div class="feat-body">We track the latest phishing tricks, AI voice scams, and fake texts &mdash; decoded in plain language so you spot them before clicking.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feat-icon">&#128274;</div>
          <div>
            <div class="feat-title">One safety skill every Wednesday</div>
            <div class="feat-body">Passwords, two-factor login, privacy settings &mdash; we build your defenses one step at a time. No overwhelm.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feat-icon">&#128187;</div>
          <div>
            <div class="feat-title">Friday Fix-It help desk</div>
            <div class="feat-body">Slow computer? Mystery charge? Every Friday we answer a real reader question with clear, step-by-step guidance.</div>
          </div>
        </div>
      </div>

      <div class="schedule">
        <div class="sched-pill"><span class="day">MON</span>&nbsp;Threat Radar</div>
        <div class="sched-pill"><span class="day">WED</span>&nbsp;Safety Skill</div>
        <div class="sched-pill"><span class="day">FRI</span>&nbsp;Fix-It Desk</div>
      </div>

      <div class="partner-row">
        <span>In partnership with</span>
        <div class="partner-chip"><div class="dot" style="background:var(--lime)"></div>XNL Tech</div>
        <span style="color:var(--muted2);font-size:0.65rem;">&times;</span>
        <div class="partner-chip"><div class="dot" style="background:#F5A623"></div>PromptMechanics.org</div>
      </div>
    </div>
  </section>

  <!-- RIGHT -->
  <section class="right">
    <div class="form-card">

      <div class="threat-bar">
        <span class="threat-label">&#9888;&nbsp;Active</span>
        <span class="threat-text" id="threat-ticker">AI voice cloning scams targeting seniors up 340% this year</span>
      </div>

      <div id="form-wrapper">
        <div class="form-headline">JOIN FOR FREE</div>
        <p class="form-sub">
          Get the knowledge to stay one step ahead.
          <span class="free-badge">Always Free</span>
        </p>

        <div class="field-row">
          <div class="field">
            <label>First Name</label>
            <input type="text" id="fname" placeholder="Linda" autocomplete="given-name" />
          </div>
          <div class="field">
            <label>Last Name</label>
            <input type="text" id="lname" placeholder="Smith" autocomplete="family-name" />
          </div>
        </div>

        <div class="field field-full">
          <label>Email Address</label>
          <input type="email" id="email" placeholder="you@example.com" autocomplete="email" />
        </div>

        <div class="freq-label">Issues you'll receive</div>
        <div class="freq-row">
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">MON</span>
            <span class="freq-topic">Threat Radar</span>
          </div>
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">WED</span>
            <span class="freq-topic">Safety Skill</span>
          </div>
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">FRI</span>
            <span class="freq-topic">Fix-It Desk</span>
          </div>
        </div>

        <button class="submit-btn" id="submit-btn" onclick="handleJoin()">
          Stay Informed &mdash; It's Free &nbsp;&#8594;
        </button>

        <p class="terms-note">
          No spam. Unsubscribe any time in one click.<br/>
        By joining you agree to our <a href="#" onclick="openModal('privacy-modal');return false;">Privacy Policy</a>.
        </p>

        <div class="sub-count">
          <span style="font-size:1rem;">&#11088;</span>
          <span class="sub-text"><strong style="color:var(--lime)">Founding subscriber</strong> &mdash; get in early</span>
        </div>
      </div>

      <div class="success-screen" id="success-screen">
        <div class="success-icon">&#128737;</div>
        <h3>YOU'RE ALL SET!</h3>
        <p>Welcome to ShieldSmart. Check your inbox &mdash; a welcome message is on its way.<br/><br/>
        Your first issue arrives <strong style="color:var(--off)">this Monday.</strong></p>
        <div style="background:rgba(188,230,0,0.08);border:1px solid rgba(188,230,0,0.25);border-radius:10px;padding:16px 20px;margin-top:18px;text-align:left;font-size:0.92rem;line-height:1.6;color:var(--muted);">
          <strong style="color:#BCE600;">&#128235; Don't see it?</strong> Check your <strong style="color:var(--off)">Spam</strong> or <strong style="color:var(--off)">Junk</strong> folder &mdash; sometimes new senders land there. To make sure you never miss an issue:<br/>
          &bull; Move our welcome email to your Inbox<br/>
          &bull; Add <strong style="color:var(--off)">noreply@xnltech.com</strong> to your contacts
        </div>
      </div>

    </div>
  </section>

</main>

<footer>
  <div>&copy; 2026 <strong style="color:var(--muted)">XNL Tech</strong> &bull; ShieldSmart Newsletter</div>
  <div style="display:flex;gap:1.4rem;flex-wrap:wrap;justify-content:center;">
    <a href="#" onclick="openModal('privacy-modal');return false;">Privacy Policy</a>
    <a href="/archive" target="_blank">Archive</a>
    <a href="/unsubscribe" target="_blank">Unsubscribe</a>
    <a href="mailto:help@xnltech.com">Contact</a>
    <a href="https://XNLTech.com" target="_blank">XNL Tech</a>
  </div>
</footer>

<!-- PRIVACY POLICY MODAL -->
<div id="privacy-modal" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:1rem;">
  <div style="background:#1E201E;border:1px solid rgba(188,230,0,0.2);border-radius:16px;max-width:620px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;">
    <!-- Modal header -->
    <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
      <div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:0.05em;color:#fff;">Privacy Policy</div>
        <div style="font-size:0.7rem;color:#7A8070;margin-top:1px;">ShieldSmart &bull; XNL Tech &bull; Effective: March 2026</div>
      </div>
      <button onclick="closeModal('privacy-modal')" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#F2F5E8;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;">&times;</button>
    </div>
    <!-- Modal body -->
    <div style="overflow-y:auto;padding:1.5rem;font-size:0.85rem;color:#B0B8A8;line-height:1.8;">

      <p style="margin-bottom:1.25rem;">This Privacy Policy describes how <strong style="color:#F2F5E8;">XNL Tech</strong> ("we," "us," or "our") collects, uses, and protects information you provide when subscribing to the ShieldSmart newsletter.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">1. Information We Collect</h3>
      <p style="margin-bottom:1.25rem;">We collect your first name, last name, and email address when you subscribe. We do not collect payment information, passwords, or sensitive personal data.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">2. How We Use Your Information</h3>
      <p style="margin-bottom:0.5rem;">We use your information solely to:</p>
      <ul style="margin:0 0 1.25rem 1.25rem;">
        <li>Send you the ShieldSmart newsletter (Monday, Wednesday, Friday)</li>
        <li>Send you a welcome email upon subscribing</li>
        <li>Respond to questions or support requests you send us</li>
      </ul>
      <p style="margin-bottom:1.25rem;">We do not use your information for advertising, profiling, or any purpose beyond delivering the newsletter.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">3. We Never Sell Your Data</h3>
      <p style="margin-bottom:1.25rem;">We will never sell, rent, trade, or share your personal information with third parties for marketing purposes. Ever.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">4. Data Storage</h3>
      <p style="margin-bottom:1.25rem;">Your subscriber data is stored securely using Cloudflare's infrastructure, which is encrypted at rest and in transit. We retain your data only as long as you remain subscribed.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">5. Email Communications</h3>
      <p style="margin-bottom:1.25rem;">By subscribing you consent to receive the ShieldSmart newsletter. Every email includes an unsubscribe link. You may opt out at any time and your data will be removed within 7 days of your request.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">6. Third-Party Services</h3>
      <p style="margin-bottom:1.25rem;">We use <strong style="color:#F2F5E8;">Resend</strong> to deliver emails and <strong style="color:#F2F5E8;">Cloudflare</strong> to host our infrastructure. These services may process your email address solely for delivery purposes. They are bound by their own privacy policies.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">7. Your Rights</h3>
      <p style="margin-bottom:0.5rem;">You have the right to:</p>
      <ul style="margin:0 0 1.25rem 1.25rem;">
        <li>Access the personal data we hold about you</li>
        <li>Request correction of inaccurate data</li>
        <li>Request deletion of your data at any time</li>
        <li>Unsubscribe from all communications</li>
      </ul>
      <p style="margin-bottom:1.25rem;">To exercise any of these rights, email us at <a href="mailto:help@xnltech.com" style="color:#BCE600;">help@xnltech.com</a>.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">8. Children's Privacy</h3>
      <p style="margin-bottom:1.25rem;">ShieldSmart is not directed at children under 13. We do not knowingly collect personal information from anyone under 13 years of age.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">9. Changes to This Policy</h3>
      <p style="margin-bottom:1.25rem;">We may update this policy from time to time. We will notify subscribers of material changes via email. Continued subscription after changes constitutes acceptance.</p>

      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.06em;color:#BCE600;margin-bottom:0.5rem;">10. Contact</h3>
      <p>Questions about this policy? Contact us at <a href="mailto:help@xnltech.com" style="color:#BCE600;">help@xnltech.com</a> or write to XNL Tech.</p>

    </div>
    <!-- Modal footer -->
    <div style="padding:1rem 1.5rem;border-top:1px solid rgba(255,255,255,0.07);flex-shrink:0;text-align:right;">
      <button onclick="closeModal('privacy-modal')" style="background:#BCE600;color:#0D0F0D;border:none;padding:0.6rem 1.5rem;border-radius:8px;font-family:'Figtree',sans-serif;font-weight:700;font-size:0.85rem;cursor:pointer;">Got It</button>
    </div>
  </div>
</div>

<script>
  function openModal(id) {
    const m = document.getElementById(id);
    m.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    const m = document.getElementById(id);
    m.style.display = 'none';
    document.body.style.overflow = '';
  }

  // Close on backdrop click
  document.addEventListener('click', (e) => {
    if (e.target.id === 'privacy-modal') closeModal('privacy-modal');
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal('privacy-modal');
  });

  const threats = [
    'AI voice cloning scams targeting seniors up 340% this year',
    'Fake IRS text messages surging ahead of tax season',
    '"Your package was undeliverable" SMS scam spreading fast',
    'New phishing kit bypasses 2-factor authentication codes',
    'Fake McAfee renewal emails dropping dangerous malware',
    'Public WiFi credential theft rising at airports and hotels',
  ];
  let ti = 0;
  const el = document.getElementById('threat-ticker');
  setInterval(() => {
    ti = (ti + 1) % threats.length;
    el.style.opacity = '0';
    setTimeout(() => { el.textContent = threats[ti]; el.style.opacity = '1'; }, 400);
  }, 4800);

  const WORKER_URL = '/subscribe';

  async function handleJoin() {
    const fname = document.getElementById('fname').value.trim();
    const lname = document.getElementById('lname').value.trim();
    const email = document.getElementById('email').value.trim();
    if (!fname) { shake('fname'); return; }
    if (!email || !email.includes('@')) { shake('email'); return; }

    const btn = document.getElementById('submit-btn');
    btn.textContent = 'Signing you up\u2026';
    btn.disabled = true;

    try {
      await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: fname, lastName: lname, email }),
      });
    } catch (_) {}

    document.getElementById('form-wrapper').style.display = 'none';
    document.getElementById('success-screen').style.display = 'block';
  }

  function shake(id) {
    const f = document.getElementById(id);
    f.style.borderColor = '#FF5C5C';
    f.animate([
      {transform:'translateX(0)'},{transform:'translateX(-5px)'},
      {transform:'translateX(5px)'},{transform:'translateX(-4px)'},
      {transform:'translateX(4px)'},{transform:'translateX(0)'}
    ], { duration: 380, easing: 'ease' });
    setTimeout(() => { f.style.borderColor = ''; }, 1400);
  }
</script>
</body>
</html>
`);
}

// ─── LOGO HANDLER ─────────────────────────────────────────────────────────────
async function handleLogo(env) {
  const cached = await env.CONTENT.get('asset:logo.png', 'arrayBuffer');
  if (!cached) {
    return new Response('Logo not found', { status: 404 });
  }
  return new Response(cached, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...CORS,
    },
  });
}

// ─── ADMIN AUTH ───────────────────────────────────────────────────────────────
function isAdmin(request, env) {
  const secret = request.headers.get('X-Admin-Secret');
  return secret && secret === env.ADMIN_SECRET;
}