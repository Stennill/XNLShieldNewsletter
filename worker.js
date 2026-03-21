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

    if (url.pathname === '/admin/subscriber-report' && request.method === 'POST') {
      return handleAdminSubscriberReport(request, env);
    }

    if (url.pathname === '/admin/subscriber-baseline' && request.method === 'POST') {
      return handleAdminSubscriberBaseline(request, env);
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

    if (url.pathname === '/admin/drafts' && request.method === 'POST') {
      return handleAdminDrafts(request, env);
    }

    if (url.pathname === '/admin/draft-preview' && request.method === 'POST') {
      return handleAdminDraftPreview(request, env);
    }

    if (url.pathname === '/admin/draft-edit' && request.method === 'POST') {
      return handleAdminDraftEdit(request, env);
    }

    if (url.pathname === '/admin/draft-approve' && request.method === 'POST') {
      return handleAdminDraftApprove(request, env);
    }

    if (url.pathname === '/admin/draft-discard' && request.method === 'POST') {
      return handleAdminDraftDiscard(request, env);
    }

    if (url.pathname === '/admin/draft-regenerate' && request.method === 'POST') {
      return handleAdminDraftRegenerate(request, env);
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

  // ─── CRON TRIGGER (3-stage pipeline) ──────────────────────────────────────
  // Stage 1: 11:00 UTC (7am EST) — Generate draft
  // Stage 2: 12:00 UTC (8am EST) — QA check, auto-send or flag
  // Stage 3: 15:00 UTC (10am EST) — Deadline: auto-fix and send remaining
  async scheduled(event, env, ctx) {
    const ts = new Date().toISOString();
    const hour = new Date(event.scheduledTime).getUTCHours();
    const log = { event: 'cron', firedAt: ts, hour, status: 'started' };

    try {
      if (hour === 11) {
        // ── STAGE 1: Generate Draft ──
        log.stage = 'generate';
        const issueType = getIssueType();
        log.issueType = issueType;
        console.log('Stage 1: Generating draft for', issueType);

        const newsletter = await generateNewsletter(env, issueType);
        const dateKey = new Date().toISOString().split('T')[0];

        const draft = {
          dateKey,
          issueType: newsletter.issueType,
          subject: newsletter.subject,
          html: newsletter.html,
          rawHtml: newsletter.rawHtml,
          threatIntel: newsletter.threatIntel,
          topicTags: [],
          status: 'pending',
          generatedAt: newsletter.generatedAt,
          sentAt: null,
          qaResult: null,
          edits: [],
        };

        await saveDraft(env, draft);
        log.subject = newsletter.subject;
        log.status = 'draft_saved';
        console.log('Draft saved:', newsletter.subject);

      } else if (hour === 12) {
        // ── STAGE 2: Automated QA ──
        log.stage = 'qa';
        console.log('Stage 2: Running QA on pending drafts');

        const drafts = await listDrafts(env);
        const pending = drafts.filter(d => d.status === 'pending');

        if (pending.length === 0) {
          log.status = 'no_pending_drafts';
          console.log('No pending drafts to QA');
        }

        for (const draft of pending) {
          const programmaticResult = runProgrammaticQA(draft);
          let claudeResult = { pass: true, issues: [], severity: 'none', topicTags: [], summary: 'Skipped' };

          if (programmaticResult.severity !== 'major') {
            try {
              claudeResult = await runClaudeQA(draft, env);
            } catch (e) {
              console.error('Claude QA failed:', e.message);
              claudeResult = { pass: false, severity: 'major', issues: [{ type: 'structure', description: 'QA API call failed: ' + e.message }], topicTags: [], summary: 'QA error' };
            }
          }

          const allIssues = [...programmaticResult.issues, ...(claudeResult.issues || [])];
          const hasMajor = allIssues.some(i => i.severity === 'major' || i.type === 'factual');
          const combinedSeverity = hasMajor ? 'major' : allIssues.length > 0 ? 'minor' : 'none';
          const topicTags = claudeResult.topicTags || [];

          const qaResult = {
            pass: combinedSeverity !== 'major',
            issues: allIssues,
            severity: combinedSeverity,
            autoFixed: false,
            checkedAt: new Date().toISOString(),
            summary: claudeResult.summary || programmaticResult.issues.map(i => i.issue).join('; '),
          };

          if (combinedSeverity === 'none' || (combinedSeverity === 'minor' && allIssues.length <= 2)) {
            // Auto-fix minor issues if any, then approve + send
            let finalHtml = draft.html;
            if (combinedSeverity === 'minor') {
              try {
                finalHtml = await autoFixDraft(draft, qaResult, env);
                qaResult.autoFixed = true;
              } catch (e) {
                console.error('Auto-fix failed, sending original:', e.message);
              }
            }

            const newsletter = { subject: draft.subject, html: finalHtml, rawHtml: draft.rawHtml, issueType: draft.issueType, generatedAt: draft.generatedAt };
            const sendResult = await sendToAllSubscribers(newsletter, env);
            await archiveNewsletter(newsletter, topicTags, env);

            await updateDraft(env, draft.dateKey, {
              status: 'sent',
              html: finalHtml,
              sentAt: new Date().toISOString(),
              qaResult,
              topicTags,
            });

            log.status = 'sent';
            log.subject = draft.subject;
            log.sent = sendResult.sent;
            log.failed = sendResult.failed;

            await runPostSendPipeline(newsletter, sendResult, qaResult.autoFixed ? 'Auto-approved by QA (minor fixes applied)' : 'Auto-approved by QA (clean)', qaResult, env);

          } else {
            // Major issues — flag for review, email admin
            await updateDraft(env, draft.dateKey, {
              status: 'needs_review',
              qaResult,
              topicTags,
            });

            log.status = 'needs_review';
            log.subject = draft.subject;

            // Send review notification email
            const issuesSummary = allIssues.map(i => `• ${i.description || i.issue}`).join('\n');
            const notifyHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#111311;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#111311"><tr><td align="center" style="padding:24px;">
<table width="600" cellpadding="0" cellspacing="0" bgcolor="#1E201E" style="max-width:600px;width:100%;border-radius:12px;">
  <tr><td style="padding:24px;border-bottom:2px solid #E8443A;">
    <div style="font-size:20px;font-weight:800;color:#FFF;">SHIELD<span style="color:#BCE600;">SMART</span> <span style="font-size:12px;color:#E8443A;font-weight:700;">DRAFT NEEDS REVIEW</span></div>
  </td></tr>
  <tr><td style="padding:20px 24px;">
    <div style="color:#F2F5E8;font-size:16px;font-weight:700;margin-bottom:8px;">Subject: ${draft.subject}</div>
    <div style="color:#7A8070;font-size:13px;margin-bottom:16px;">Issue Type: ${draft.issueType} | Date: ${draft.dateKey}</div>
    <div style="background:#2B1A1A;border:1px solid #E8443A44;border-radius:8px;padding:16px;margin-bottom:16px;">
      <div style="color:#E8443A;font-size:13px;font-weight:700;margin-bottom:8px;">QA ISSUES FOUND:</div>
      <div style="color:#F2F5E8;font-size:14px;white-space:pre-wrap;">${issuesSummary}</div>
    </div>
    <div style="color:#F5A623;font-size:14px;margin-bottom:16px;">You have until <strong>10:00 AM EST</strong> to review. After that, Claude will auto-fix and send.</div>
    <a href="https://xnltech.com/admin" style="display:inline-block;background:#BCE600;color:#111311;padding:10px 24px;border-radius:8px;font-weight:700;font-size:14px;text-decoration:none;">Review in Admin Panel</a>
  </td></tr>
</table></td></tr></table></body></html>`;

            try {
              await sendEmail({ email: 'help@xnltech.com' }, notifyHtml, `⚠️ ShieldSmart Draft Needs Review: "${draft.subject}"`, env);
            } catch (e) {
              console.error('Review notification email failed:', e.message);
            }
          }
        }

      } else if (hour === 15) {
        // ── STAGE 3: Auto-Fix Deadline ──
        log.stage = 'deadline';
        console.log('Stage 3: Checking for unreviewed drafts');

        const drafts = await listDrafts(env);
        const needsReview = drafts.filter(d => d.status === 'needs_review');

        if (needsReview.length === 0) {
          log.status = 'no_action_needed';
          console.log('No drafts need auto-fixing');
        }

        for (const draft of needsReview) {
          console.log('Auto-fixing draft:', draft.subject);

          let fixedHtml = draft.html;
          try {
            fixedHtml = await autoFixDraft(draft, draft.qaResult || { issues: [] }, env);
          } catch (e) {
            console.error('Auto-fix failed at deadline, sending original:', e.message);
          }

          const newsletter = { subject: draft.subject, html: fixedHtml, rawHtml: draft.rawHtml, issueType: draft.issueType, generatedAt: draft.generatedAt };
          const sendResult = await sendToAllSubscribers(newsletter, env);
          await archiveNewsletter(newsletter, draft.topicTags || [], env);

          const updatedQa = draft.qaResult || {};
          updatedQa.autoFixed = true;

          await updateDraft(env, draft.dateKey, {
            status: 'auto_fixed',
            html: fixedHtml,
            sentAt: new Date().toISOString(),
            qaResult: updatedQa,
          });

          log.status = 'auto_fixed_and_sent';
          log.subject = draft.subject;
          log.sent = sendResult.sent;
          log.failed = sendResult.failed;

          await runPostSendPipeline(newsletter, sendResult, 'Auto-fixed at deadline (10am EST)', updatedQa, env);
        }

        // Expire old drafts (> 7 days) that were never sent
        try {
          const allDrafts = await listDrafts(env);
          const sevenDaysAgo = Date.now() - 7 * 86400000;
          for (const d of allDrafts) {
            if ((d.status === 'pending' || d.status === 'needs_review') && d.generatedAt) {
              const age = Date.now() - new Date(d.generatedAt).getTime();
              if (age > 7 * 86400000) {
                await updateDraft(env, d.dateKey, { status: 'expired' });
              }
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      log.status = 'error';
      log.error = e.message;
      console.error('Cron error:', e.message, e.stack);
    }

    try {
      await env.CONTENT.put(`cron:${ts}`, JSON.stringify(log));
    } catch (_) {}
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

// ─── ADMIN: SUBSCRIBER REPORT ───────────────────────────────────────────────
async function handleAdminSubscriberBaseline(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const now = new Date().toISOString();
  await env.CONTENT.put('meta:subscriber-baseline-at', now);
  return json({ success: true, baselineAt: now });
}

async function handleAdminSubscriberReport(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const baselineAt = await env.CONTENT.get('meta:subscriber-baseline-at');

  const list = await env.SUBSCRIBERS.list({ prefix: 'sub:' });
  const subscribers = [];
  for (const key of list.keys) {
    const val = await env.SUBSCRIBERS.get(key.name);
    if (val) subscribers.push(JSON.parse(val));
  }

  const active = subscribers.filter(s => s.active).length;
  const total = subscribers.length;

  const newSubscribers = baselineAt
    ? subscribers.filter(s => (s.subscribedAt || '') > baselineAt)
    : [];

  return json({
    baselineAt: baselineAt || null,
    total,
    active,
    newSubscribers,
  });
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

// ─── ADMIN DRAFT HANDLERS ─────────────────────────────────────────────────────
async function handleAdminDrafts(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
  const drafts = await listDrafts(env);
  return json({ drafts: drafts.map(d => ({ dateKey: d.dateKey, issueType: d.issueType, subject: d.subject, status: d.status, generatedAt: d.generatedAt, sentAt: d.sentAt, qaResult: d.qaResult ? { pass: d.qaResult.pass, severity: d.qaResult.severity, summary: d.qaResult.summary, autoFixed: d.qaResult.autoFixed, issueCount: (d.qaResult.issues || []).length } : null })) });
}

async function handleAdminDraftPreview(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
  const draft = await getDraft(env, body.dateKey);
  if (!draft) return json({ error: 'Draft not found' }, 404);
  return json({ draft });
}

async function handleAdminDraftEdit(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
  const draft = await getDraft(env, body.dateKey);
  if (!draft) return json({ error: 'Draft not found' }, 404);

  const edits = draft.edits || [];
  if (body.subject && body.subject !== draft.subject) {
    edits.push({ editedAt: new Date().toISOString(), field: 'subject', oldValue: draft.subject });
  }
  if (body.html && body.html !== draft.html) {
    edits.push({ editedAt: new Date().toISOString(), field: 'html', oldValue: '(changed)' });
  }

  const updates = { edits };
  if (body.subject) updates.subject = body.subject;
  if (body.html) {
    updates.html = body.html;
    updates.rawHtml = body.html;
  }

  const updated = await updateDraft(env, body.dateKey, updates);
  return json({ success: true, draft: updated });
}

async function handleAdminDraftApprove(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
  const draft = await getDraft(env, body.dateKey);
  if (!draft) return json({ error: 'Draft not found' }, 404);
  if (draft.status === 'sent') return json({ error: 'Already sent' }, 400);

  const newsletter = { subject: draft.subject, html: draft.html, rawHtml: draft.rawHtml, issueType: draft.issueType, generatedAt: draft.generatedAt };
  const sendResult = await sendToAllSubscribers(newsletter, env);
  await archiveNewsletter(newsletter, draft.topicTags || [], env);
  await updateDraft(env, body.dateKey, { status: 'sent', sentAt: new Date().toISOString() });

  await runPostSendPipeline(newsletter, sendResult, 'Manually approved by admin', draft.qaResult, env);

  return json({ success: true, sent: sendResult.sent, failed: sendResult.failed, total: sendResult.total });
}

async function handleAdminDraftDiscard(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
  await updateDraft(env, body.dateKey, { status: 'discarded' });
  return json({ success: true });
}

async function handleAdminDraftRegenerate(request, env) {
  const body = await request.json();
  if (!body.secret || body.secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
  const draft = await getDraft(env, body.dateKey);
  if (!draft) return json({ error: 'Draft not found' }, 404);

  const newsletter = await generateNewsletter(env, draft.issueType);
  const updates = {
    subject: newsletter.subject,
    html: newsletter.html,
    rawHtml: newsletter.rawHtml,
    threatIntel: newsletter.threatIntel,
    status: 'pending',
    generatedAt: newsletter.generatedAt,
    qaResult: null,
    edits: [...(draft.edits || []), { editedAt: new Date().toISOString(), field: 'regenerated', oldValue: draft.subject }],
  };

  const updated = await updateDraft(env, body.dateKey, updates);
  return json({ success: true, subject: newsletter.subject, html: newsletter.html });
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
      system: `You write social media posts for ShieldSmart, a free cyber safety newsletter by XNL Tech. The newsletter delivers plain-English security tips every weekday (Mon-Fri). The goal of every post is to get people to subscribe at xnltech.com. Tone: urgent but friendly, relatable, never jargon-heavy. Use the kind of language that makes non-tech people stop scrolling.`,
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

  let subject = generateSubject('fix-it');
  const subjectMatch = rawHtml.match(/^SUBJECT:\s*(.+)/i);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    rawHtml = rawHtml.replace(/^SUBJECT:\s*.+\n?\n?/i, '').trim();
  }

  const fullHtml = wrapInEmailShell(rawHtml, subject, issueType);

  const newsletter = {
    subject,
    html: fullHtml,
    rawHtml,
    issueType,
    generatedAt: new Date().toISOString(),
  };

  await archiveNewsletter(newsletter, [], env);

  return newsletter;
}

// ─── ISSUE TYPE LOGIC ────────────────────────────────────────────────────────
function getIssueType() {
  const day = new Date().getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  if (day === 1) return 'threat-radar';
  if (day === 2) return 'scam-spotlight';
  if (day === 3) return 'safety-skill';
  if (day === 4) return 'news-brief';
  if (day === 5) return 'fix-it';
  return 'threat-radar'; // default fallback for weekends (shouldn't trigger)
}

// ─── GENERATE WITH ANTHROPIC ─────────────────────────────────────────────────
async function generateNewsletter(env, issueType) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Fetch real-time threat intelligence from RSS feeds
  let threatIntel = null;
  let threatIntelPrompt = '';
  try {
    threatIntel = await fetchThreatIntel(env);
    threatIntelPrompt = formatThreatIntelForPrompt(threatIntel);
  } catch (e) {
    console.error('Threat intel fetch failed:', e.message);
  }

  // Enhanced topic deduplication (30 issues + pending drafts + topic tags)
  let dedupPrompt = '';
  try {
    const recentTopics = await getRecentTopicsForDedup(env);
    dedupPrompt = formatDedupForPrompt(recentTopics);
  } catch (e) {
    console.error('Dedup fetch failed:', e.message);
  }

  const baseSystem = `You are the editor of ShieldSmart, a no-nonsense cyber safety newsletter by XNL Tech (PromptMechanics.org is an affiliated partner, not part of XNL Tech). 
Your readers are everyday people — seniors, parents, non-tech workers — who are NOT tech savvy. 
NEVER use jargon without immediately explaining it in plain English. Write as if you're talking to your mom or grandparent.
CRITICAL: All content MUST be timely and current for ${dateStr}. Write about threats and topics that are ACTIVELY relevant right now in ${today.getFullYear()}.`;

  const htmlInstructions = `Format as clean HTML with inline styles. Use ONLY these brand colors: background #111311, card/section background #1E201E, text #F2F5E8, accent lime #BCE600, highlight amber #F5A623, danger red #E8443A, muted text #7A8070. Max-width 900px centered. Make it visually engaging with colored callout boxes.
DO NOT include any ShieldSmart header, logo, branding banner, or newsletter title at the top. The header is added separately. Start directly with the content.
DO NOT invite readers to "reply to this email" — replies are not monitored. If you want to direct them somewhere, use help@xnltech.com.
IMPORTANT: Output raw HTML only. No markdown, no code fences, no backticks, no \`\`\`html — just the raw HTML content starting directly with your first tag.`;

  const prompts = {
    'threat-radar': {
      fallbackSubject: generateSubject('threat-radar'),
      system: baseSystem + `\nYour tone is: warm, protective, like a knowledgeable friend who happens to work in cybersecurity. Include specific, realistic details — which platforms are affected, what the scam messages look like, and any recent warnings from the FTC, FBI, or cybersecurity agencies.`,
      prompt: `Today's date is ${dateStr}. Write a Monday "Threat Radar" newsletter issue.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the specific threat covered in the issue. Then leave a blank line and begin the HTML body.
${threatIntelPrompt}${dedupPrompt}

Structure:
1. **Friendly opener** (2-3 sentences, warm, urgent but not scary)
2. **This Week's Threat** — Pick one very real, current scam or hacking tactic from the threat intel above. Name it clearly.
3. **How It Works** — Explain it step by step like a story. What happens? What do they want? (3-4 paragraphs, PLAIN English)
4. **How To Spot It** — 3-5 clear bullet points with specific, concrete signs
5. **What To Do If You Get One** — Numbered action steps (keep it simple: 3-4 steps)
6. **Quick Win** — One 30-second thing they can do RIGHT NOW to be safer
7. **Closing** — Warm, encouraging sign-off from "The ShieldSmart Team at XNL Tech"

${htmlInstructions}`,
    },
    'scam-spotlight': {
      fallbackSubject: generateSubject('scam-spotlight'),
      system: baseSystem + `\nYour tone is: investigative but accessible, like a reporter explaining a scam to a friend over coffee. You break down exactly how the scam works, who's behind it, and what makes people fall for it.`,
      prompt: `Today's date is ${dateStr}. Write a Tuesday "Scam Spotlight" newsletter issue — a deep dive into one specific active scam.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the specific scam covered. Then leave a blank line and begin the HTML body.
${threatIntelPrompt}${dedupPrompt}

Structure:
1. **Hook opener** (2 sentences — grab attention with the scale or impact of this scam)
2. **The Scam** — Name it clearly and explain what it is in one paragraph
3. **The Setup** — How do scammers reach you? (text, email, phone call, social media ad?) Include actual examples of what the messages look like
4. **The Trap** — What makes this scam convincing? Why do smart people fall for it? (2-3 paragraphs)
5. **The Damage** — What happens if you fall for it? Real consequences (money lost, identity stolen, etc.)
6. **Your Defense** — 4-5 specific, actionable steps to protect yourself
7. **Who To Report It To** — Specific agencies and websites (FTC, FBI IC3, etc.)
8. **Closing** — Empowering sign-off from "The ShieldSmart Team at XNL Tech"

${htmlInstructions}`,
    },
    'safety-skill': {
      fallbackSubject: generateSubject('safety-skill'),
      system: baseSystem + `\nTone: encouraging, simple, like a patient teacher. Make people feel CAPABLE, not overwhelmed. Reference current software versions, real app interfaces, and up-to-date settings paths for ${today.getFullYear()}.`,
      prompt: `Today's date is ${dateStr}. Write a Wednesday "Safety Skill" newsletter issue.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the specific skill taught. Then leave a blank line and begin the HTML body.
${threatIntelPrompt}${dedupPrompt}

Structure:
1. **Opener** — "This Wednesday, we're building one simple habit" (2 sentences)
2. **The Skill** — ONE specific security habit or setting. Give it a plain-language name.
3. **Why It Matters** — A brief real-world story or example showing what happens without this skill (2 paragraphs). Reference current threats from the intel if relevant.
4. **How To Do It** — Step-by-step instructions with numbered steps. Write as if guiding someone by phone. Specify: iPhone vs Android or Windows vs Mac where relevant.
5. **You Did It!** — Brief celebration + what this skill protects them from
6. **Closing** from the ShieldSmart Team at XNL Tech

${htmlInstructions}`,
    },
    'news-brief': {
      fallbackSubject: generateSubject('news-brief'),
      system: baseSystem + `\nTone: concise, informative, like a trusted news anchor who simplifies complex stories. Keep each item brief but impactful. Your goal is to make readers feel informed without overwhelming them.`,
      prompt: `Today's date is ${dateStr}. Write a Thursday "News Brief" newsletter issue — a quick-hit digest of this week's cybersecurity news that matters to everyday people.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject should capture the most important story. Then leave a blank line and begin the HTML body.
${threatIntelPrompt}${dedupPrompt}

Structure:
1. **Opener** (1-2 sentences — "Here's your Thursday security briefing")
2. **Top Story** — The biggest cybersecurity news item this week, explained in 2-3 short paragraphs. Use the threat intel above.
3. **Quick Hits** — 3-4 additional news items, each in 2-3 sentences with a bold headline. Cover different topics (data breach, new scam, software update, policy change, etc.)
4. **What This Means For You** — 2-3 bullet points translating the news into actionable takeaways for non-tech readers
5. **One Thing To Do Today** — A single, simple action inspired by this week's news
6. **Closing** from the ShieldSmart Team at XNL Tech

${htmlInstructions}`,
    },
    'fix-it': {
      fallbackSubject: generateSubject('fix-it'),
      system: baseSystem + `\nTone: helpful, practical, like your patient tech-savvy nephew or niece. Reference current OS versions (Windows 11, macOS Sonoma/Sequoia, iOS 18, Android 15) and up-to-date solutions for ${today.getFullYear()}.`,
      prompt: `Today's date is ${dateStr}. Write a Friday "Fix-It Help Desk" newsletter issue.

IMPORTANT: Your VERY FIRST LINE must be the email subject line in this exact format:
SUBJECT: [emoji] Your catchy subject line here
The subject MUST directly reference the specific question or fix. Then leave a blank line and begin the HTML body.
${threatIntelPrompt}${dedupPrompt}

Structure:
1. **Happy Friday opener** (2 sentences — light and friendly)
2. **This Week's Topic** — Introduce a common tech problem or frustration that many people deal with. Frame it naturally.
3. **The Fix** — Step-by-step solution in plain language. Use numbered steps. Cover both Windows and Mac if relevant. (5-8 steps)
4. **Bonus Tip** — One related quick tip that makes their digital life easier or safer
5. **Scam Alert Reminder** — One sentence about a current scam from the threat intel
6. **Weekend Safety Reminder** — One quick safety reminder for the weekend
7. **Warm Friday sign-off** from the ShieldSmart Team at XNL Tech

${htmlInstructions}`,
    },
  };

  // Legacy aliases for backward compatibility
  if (issueType === 'monday') issueType = 'threat-radar';
  if (issueType === 'wednesday') issueType = 'safety-skill';
  if (issueType === 'friday') issueType = 'fix-it';

  const config = prompts[issueType] || prompts['threat-radar'];

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
    rawHtml,
    issueType,
    generatedAt: new Date().toISOString(),
    threatIntel: threatIntel ? { itemCount: threatIntel.items.length, feedStatus: threatIntel.feedStatus } : null,
  };

  return newsletter;
}

// ─── ARCHIVE NEWSLETTER ──────────────────────────────────────────────────────
async function archiveNewsletter(newsletter, topicTags, env) {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const suffix = Date.now().toString(36);
    const archiveKey = `issue:${dateStr}-${newsletter.issueType}-${suffix}`;
    const meta = {
      id: archiveKey,
      subject: newsletter.subject,
      issueType: newsletter.issueType,
      generatedAt: newsletter.generatedAt,
      topicTags: topicTags || [],
      dateStr,
    };
    await env.CONTENT.put(archiveKey, newsletter.html);
    await env.CONTENT.put(`${archiveKey}:body`, newsletter.rawHtml || '');
    await env.CONTENT.put(`${archiveKey}:meta`, JSON.stringify(meta));
    return archiveKey;
  } catch (e) {
    console.error('Failed to save to archive:', e.message);
    return null;
  }
}

// ─── EMAIL SHELL WRAPPER ─────────────────────────────────────────────────────
function wrapInEmailShell(innerHtml, subject, issueType) {
  const dayLabel = {
    'threat-radar': 'Threat Radar', 'scam-spotlight': 'Scam Spotlight', 'safety-skill': 'Safety Skill',
    'news-brief': 'News Brief', 'fix-it': 'Fix-It Help Desk',
    monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk',
  };
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
              <strong>Here's what you'll get every weekday:</strong>
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128274; <strong>Mondays</strong> — Threat Radar: We decode the week's biggest threat</p>
                </td>
              </tr>
              <tr><td style="height:8px;"></td></tr>
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128270; <strong>Tuesdays</strong> — Scam Spotlight: Deep dive into one active scam</p>
                </td>
              </tr>
              <tr><td style="height:8px;"></td></tr>
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128161; <strong>Wednesdays</strong> — Safety Skill: One simple habit you can set up in minutes</p>
                </td>
              </tr>
              <tr><td style="height:8px;"></td></tr>
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128240; <strong>Thursdays</strong> — News Brief: Quick-hit cybersecurity news digest</p>
                </td>
              </tr>
              <tr><td style="height:8px;"></td></tr>
              <tr>
                <td bgcolor="#111311" style="background-color:#111311;padding:14px 20px;border-radius:8px;">
                  <p style="color:#F2F5E8;font-family:Arial,sans-serif;font-size:16px;line-height:1.8;margin:0;">&#128187; <strong>Fridays</strong> — Fix-It Help Desk: Plain-English solutions to tech problems</p>
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
    'threat-radar': [
      "🚨 This scam is making the rounds — here's how to dodge it",
      "⚠️ Hackers tried a new trick this week. You need to see this.",
      "🛡️ Before you click that email — read this first",
      "🔍 Spotted: The scam hitting inboxes right now",
    ],
    'scam-spotlight': [
      "🔎 Scam Spotlight: This one's fooling thousands right now",
      "⚠️ Deep Dive: The scam your neighbor almost fell for",
      "🚫 Don't fall for this — here's exactly how it works",
      "🔍 We dissected this scam so you don't have to",
    ],
    'safety-skill': [
      "🔐 One setting that makes hackers give up on you",
      "💡 Wednesday Skill: 2 minutes that could save your accounts",
      "🛡️ Your Wednesday safety upgrade is here",
      "✅ This one habit stops most hacks cold",
    ],
    'news-brief': [
      "📰 This week in cyber: What you need to know",
      "⚡ Quick Hits: Today's top cybersecurity news",
      "📋 Your Thursday security briefing is here",
      "🗞️ Cyber News Digest: The headlines that matter to you",
    ],
    'fix-it': [
      "🛠️ Fix-It Friday: Your tech question answered",
      "💻 That annoying computer problem? Here's the fix.",
      "🎉 Friday Help Desk — plus one quick safety reminder",
      "🔧 Fix-It Friday: We're in your corner",
    ],
    // Legacy aliases
    monday: ["🚨 This scam is making the rounds — here's how to dodge it"],
    wednesday: ["🔐 One setting that makes hackers give up on you"],
    friday: ["🛠️ Fix-It Friday: Your tech question answered"],
  };
  const list = subjects[day] || subjects['threat-radar'];
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

  const typeLabel = { 'threat-radar': 'Threat Radar', 'scam-spotlight': 'Scam Spotlight', 'safety-skill': 'Safety Skill', 'news-brief': 'News Brief', 'fix-it': 'Fix-It Help Desk', monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
  const typeColor = { 'threat-radar': '#E8443A', 'scam-spotlight': '#FF6B35', 'safety-skill': '#BCE600', 'news-brief': '#5599FF', 'fix-it': '#F5A623', monday: '#E8443A', wednesday: '#BCE600', friday: '#F5A623' };

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
  <p style="color:#7A8070;font-size:0.95rem;margin-bottom:2rem;line-height:1.6;">Plain English cyber safety delivered every weekday by <strong style="color:#F2F5E8;">XNL Tech</strong>. Subscribe free to read any issue.</p>

  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:2rem;">
    <span style="background:rgba(232,68,58,0.1);border:1px solid rgba(232,68,58,0.25);color:#E8443A;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">Mon &mdash; Threat Radar</span>
    <span style="background:rgba(255,107,53,0.1);border:1px solid rgba(255,107,53,0.25);color:#FF6B35;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">Tue &mdash; Scam Spotlight</span>
    <span style="background:rgba(188,230,0,0.08);border:1px solid rgba(188,230,0,0.25);color:#BCE600;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">Wed &mdash; Safety Skill</span>
    <span style="background:rgba(85,153,255,0.1);border:1px solid rgba(85,153,255,0.25);color:#5599FF;font-size:0.62rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:4px 12px;border-radius:100px;">Thu &mdash; News Brief</span>
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
  const typeLabel = { 'threat-radar': 'Threat Radar', 'scam-spotlight': 'Scam Spotlight', 'safety-skill': 'Safety Skill', 'news-brief': 'News Brief', 'fix-it': 'Fix-It Help Desk', monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
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
    <!-- Draft Queue -->
    <div class="gen-box" id="draftSection">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h2 style="font-size:18px;">📋 Draft Queue</h2>
        <button class="btn btn-lime" style="padding:8px 18px; font-size:13px;" onclick="loadDrafts()">Refresh</button>
      </div>
      <div id="draftList" style="color:#7A8070; font-size:14px;">Loading drafts...</div>
    </div>

    <!-- Draft Preview/Edit Modal -->
    <div id="draftPreviewArea" class="hidden">
      <div class="gen-box">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h2 style="font-size:18px;">📝 Draft Editor</h2>
          <button class="btn" style="background:#222;color:#7A8070;padding:6px 14px;font-size:13px;" onclick="closeDraftPreview()">✕ Close</button>
        </div>
        <div id="draftQAReport" class="hidden" style="margin-bottom:16px;"></div>
        <div class="field" style="margin-bottom:12px;">
          <label for="draftSubjectEdit">Subject Line</label>
          <input type="text" id="draftSubjectEdit" />
        </div>
        <iframe class="preview-frame" id="draftPreviewFrame" sandbox="allow-same-origin" style="height:500px;"></iframe>
        <div class="field" style="margin-top:12px;">
          <label for="draftHtmlEdit">HTML Content <span style="color:#5A6050;font-weight:400;">(advanced — edit with care)</span></label>
          <textarea id="draftHtmlEdit" style="min-height:200px; font-family:monospace; font-size:12px;"></textarea>
        </div>
        <div class="btn-group" style="flex-wrap:wrap;">
          <button class="btn btn-lime" onclick="saveDraftEdits()">💾 Save Edits</button>
          <button class="btn btn-lime" onclick="refreshDraftPreview()">👁️ Refresh Preview</button>
          <button class="btn btn-lime" onclick="regenerateDraft()">🔄 Regenerate</button>
          <button class="btn btn-amber" onclick="approveDraft()">📤 Approve &amp; Send</button>
          <button class="btn btn-red" onclick="discardDraft()">🗑️ Discard</button>
        </div>
        <div class="status" id="draftEditStatus"></div>
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
            <option value="fix-it" selected>Friday — Fix-It Help Desk</option>
            <option value="threat-radar">Monday — Threat Radar</option>
            <option value="scam-spotlight">Tuesday — Scam Spotlight</option>
            <option value="safety-skill">Wednesday — Safety Skill</option>
            <option value="news-brief">Thursday — News Brief</option>
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
            <option value="threat-radar">Monday — Threat Radar</option>
            <option value="scam-spotlight">Tuesday — Scam Spotlight</option>
            <option value="safety-skill">Wednesday — Safety Skill</option>
            <option value="news-brief">Thursday — News Brief</option>
            <option value="fix-it">Friday — Fix-It Help Desk</option>
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

    <!-- Subscriber Report -->
    <div class="gen-box" style="margin-top:24px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h2 style="font-size:18px;">👥 Subscriber Report</h2>
        <button class="btn btn-lime" style="padding:8px 18px; font-size:13px;" onclick="loadSubscriberReport()">Refresh</button>
      </div>
      <div style="display:flex; gap:12px; margin-bottom:12px;">
        <button class="btn btn-lime" style="padding:8px 14px; font-size:13px;" onclick="markSubscriberBaseline()">Set Baseline (start tracking)</button>
        <div style="color:#7A8070; font-size:13px; display:flex; align-items:center;">Baseline: <span id="baselineLabel" style="margin-left:8px; color:#F2F5E8;">—</span></div>
      </div>
      <div id="subReport" style="color:#7A8070; font-size:14px;">Loading report...</div>
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
    loadDrafts();
    loadCronLogs();
    loadSubCount();
    loadSubscriberReport();
    loadIssues();
    setInterval(loadSubCount, 30000);
    setInterval(loadCronLogs, 60000);
    setInterval(loadDrafts, 60000);
  }

  let currentDraftKey = null;

  var draftTypeLabel = { 'threat-radar': 'Threat Radar', 'scam-spotlight': 'Scam Spotlight', 'safety-skill': 'Safety Skill', 'news-brief': 'News Brief', 'fix-it': 'Fix-It Help Desk', monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
  var draftTypeColor = { 'threat-radar': '#E8443A', 'scam-spotlight': '#FF6B35', 'safety-skill': '#BCE600', 'news-brief': '#5599FF', 'fix-it': '#F5A623', monday: '#E8443A', wednesday: '#BCE600', friday: '#F5A623' };
  var statusColor = { pending: '#F5A623', qa_passed: '#BCE600', needs_review: '#E8443A', sent: '#BCE600', discarded: '#7A8070', auto_fixed: '#5599FF', expired: '#7A8070' };
  var statusLabel = { pending: 'PENDING', qa_passed: 'QA PASSED', needs_review: 'NEEDS REVIEW', sent: 'SENT', discarded: 'DISCARDED', auto_fixed: 'AUTO-FIXED', expired: 'EXPIRED' };

  async function loadDrafts() {
    var el = $('draftList');
    try {
      var res = await fetch('/admin/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: adminSecret }) });
      var data = await res.json();
      if (!data.drafts || data.drafts.length === 0) { el.innerHTML = '<span style="color:#7A8070;">No drafts. The next draft will be generated at 7:00 AM EST.</span>'; return; }
      el.innerHTML = data.drafts.map(function(d) {
        var color = draftTypeColor[d.issueType] || '#BCE600';
        var sColor = statusColor[d.status] || '#7A8070';
        var badge = '<span style="display:inline-block;background:' + color + '18;border:1px solid ' + color + '44;color:' + color + ';font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;">' + (draftTypeLabel[d.issueType] || d.issueType) + '</span>';
        var sBadge = '<span style="display:inline-block;background:' + sColor + '18;border:1px solid ' + sColor + '44;color:' + sColor + ';font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;text-transform:uppercase;">' + (statusLabel[d.status] || d.status) + '</span>';
        var qaInfo = '';
        if (d.qaResult) { qaInfo = ' <span style="color:' + (d.qaResult.pass ? '#BCE600' : '#E8443A') + ';font-size:11px;">(' + (d.qaResult.issueCount || 0) + ' issues)</span>'; }
        var dt = d.generatedAt ? new Date(d.generatedAt).toLocaleString() : '';
        return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #1E201E;cursor:pointer;" onclick="openDraftPreview(&apos;' + d.dateKey + '&apos;)">'
          + badge + ' ' + sBadge + qaInfo
          + '<span style="flex:1;color:#F2F5E8;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (d.subject || '(no subject)') + '</span>'
          + '<span style="color:#7A8070;font-size:12px;white-space:nowrap;">' + dt + '</span>'
          + '</div>';
      }).join('');
    } catch (e) { el.innerHTML = '<span style="color:#f88;">Failed: ' + e.message + '</span>'; }
  }

  async function openDraftPreview(dateKey) {
    currentDraftKey = dateKey;
    setStatus('draftEditStatus', '', '');
    try {
      var res = await fetch('/admin/draft-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: adminSecret, dateKey: dateKey }) });
      var data = await res.json();
      if (!data.draft) { alert('Draft not found'); return; }
      var d = data.draft;
      $('draftSubjectEdit').value = d.subject || '';
      $('draftHtmlEdit').value = d.html || '';
      $('draftPreviewFrame').srcdoc = d.html || '';
      $('draftPreviewArea').classList.remove('hidden');
      $('draftPreviewArea').scrollIntoView({ behavior: 'smooth' });

      var qaEl = $('draftQAReport');
      if (d.qaResult) {
        qaEl.classList.remove('hidden');
        var qr = d.qaResult;
        var bgc = qr.pass ? '#1a2b1a' : '#2b1a1a';
        var brc = qr.pass ? '#BCE600' : '#E8443A';
        var issues = (qr.issues || []).map(function(i) { return '<div style="padding:4px 0;border-bottom:1px solid #2a2d2a;font-size:13px;"><strong style="color:#F5A623;">' + (i.type || i.severity || '') + ':</strong> ' + (i.description || i.issue || '') + (i.suggestion ? ' <span style="color:#BCE600;">Fix: ' + i.suggestion + '</span>' : '') + '</div>'; }).join('');
        qaEl.innerHTML = '<div style="background:' + bgc + ';border:1px solid ' + brc + ';border-radius:8px;padding:16px;">'
          + '<div style="font-size:14px;font-weight:700;color:' + brc + ';margin-bottom:8px;">QA Report: ' + (qr.pass ? 'PASSED' : 'ISSUES FOUND') + (qr.autoFixed ? ' (auto-fixed)' : '') + '</div>'
          + '<div style="color:#7A8070;font-size:13px;margin-bottom:8px;">' + (qr.summary || '') + '</div>'
          + issues + '</div>';
      } else { qaEl.classList.add('hidden'); qaEl.innerHTML = ''; }
    } catch (e) { alert('Error: ' + e.message); }
  }

  function closeDraftPreview() { $('draftPreviewArea').classList.add('hidden'); currentDraftKey = null; }

  function refreshDraftPreview() { $('draftPreviewFrame').srcdoc = $('draftHtmlEdit').value; }

  async function saveDraftEdits() {
    if (!currentDraftKey) return;
    try {
      var res = await fetch('/admin/draft-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: adminSecret, dateKey: currentDraftKey, subject: $('draftSubjectEdit').value, html: $('draftHtmlEdit').value }) });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus('draftEditStatus', 'ok', 'Edits saved!');
      refreshDraftPreview();
      loadDrafts();
    } catch (e) { setStatus('draftEditStatus', 'err', 'Save failed: ' + e.message); }
  }

  async function approveDraft() {
    if (!currentDraftKey) return;
    if (!confirm('Send this newsletter to ALL active subscribers?')) return;
    setStatus('draftEditStatus', 'info', 'Sending to all subscribers...');
    try {
      var res = await fetch('/admin/draft-approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: adminSecret, dateKey: currentDraftKey }) });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus('draftEditStatus', 'ok', 'Sent! ' + data.sent + ' delivered, ' + data.failed + ' failed.');
      loadDrafts();
    } catch (e) { setStatus('draftEditStatus', 'err', 'Send failed: ' + e.message); }
  }

  async function discardDraft() {
    if (!currentDraftKey) return;
    if (!confirm('Discard this draft? It will not be sent.')) return;
    try {
      var res = await fetch('/admin/draft-discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: adminSecret, dateKey: currentDraftKey }) });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error);
      closeDraftPreview();
      loadDrafts();
    } catch (e) { alert('Discard failed: ' + e.message); }
  }

  async function regenerateDraft() {
    if (!currentDraftKey) return;
    if (!confirm('Regenerate this draft from scratch? Current content will be replaced.')) return;
    setStatus('draftEditStatus', 'info', 'Regenerating with fresh threat intel... this may take 30-60 seconds.');
    try {
      var res = await fetch('/admin/draft-regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: adminSecret, dateKey: currentDraftKey }) });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error);
      $('draftSubjectEdit').value = data.subject;
      $('draftHtmlEdit').value = data.html;
      $('draftPreviewFrame').srcdoc = data.html;
      setStatus('draftEditStatus', 'ok', 'Regenerated! New subject: ' + data.subject);
      loadDrafts();
    } catch (e) { setStatus('draftEditStatus', 'err', 'Regenerate failed: ' + e.message); }
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

  async function loadSubscriberReport() {
    const el = $('subReport');
    el.innerHTML = '<span style="color:#88bbff;">Loading...</span>';
    try {
      const res = await fetch('/admin/subscriber-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load report');

      const baseline = data.baselineAt ? new Date(data.baselineAt).toLocaleString() : '—';
      $('baselineLabel').textContent = baseline;

      const newCount = (data.newSubscribers || []).length;
      const total = data.total || 0;
      const active = data.active || 0;

      let rows = '';
      if (newCount === 0) {
        rows = '<div style="color:#7A8070;">No new subscribers since baseline.</div>';
      } else {
        rows = '<div style="margin-bottom:10px;color:#F2F5E8;">New subscribers since baseline: <strong style="color:#BCE600;">' + newCount + '</strong></div>'
          + '<div style="border-top:1px solid #1E201E; margin-top:10px; padding-top:10px;">'
          + (data.newSubscribers || []).sort((a,b)=> (a.subscribedAt||'').localeCompare(b.subscribedAt||'')).map(function(s){
              var name = ((s.firstName||'') + ' ' + (s.lastName||'')).trim() || '(no name)';
              var when = s.subscribedAt ? new Date(s.subscribedAt).toLocaleString() : '';
              return '<div style="display:flex; gap:10px; padding:8px 0; border-bottom:1px solid #1E201E;">'
                + '<span style="flex:1; color:#F2F5E8;">' + escapeHtml(name) + ' <span style="color:#7A8070;">(' + escapeHtml(s.email||'') + ')</span></span>'
                + '<span style="color:#7A8070; font-size:12px; white-space:nowrap;">' + escapeHtml(when) + '</span>'
                + '</div>';
            }).join('')
          + '</div>';
      }

      el.innerHTML = ''
        + '<div style="display:flex; gap:18px; margin-bottom:10px; color:#7A8070; font-size:13px;">'
        + '<div>Total: <span style="color:#F2F5E8;">' + total + '</span></div>'
        + '<div>Active: <span style="color:#BCE600;">' + active + '</span></div>'
        + '</div>'
        + rows;
    } catch (e) {
      el.innerHTML = '<span style="color:#f88;">Failed: ' + e.message + '</span>';
    }
  }

  async function markSubscriberBaseline() {
    try {
      const res = await fetch('/admin/subscriber-baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminSecret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set baseline');
      await loadSubscriberReport();
    } catch (e) {
      alert('Baseline failed: ' + e.message);
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function(c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c] || c;
    });
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
      var typeLabel = { 'threat-radar': 'Threat Radar', 'scam-spotlight': 'Scam Spotlight', 'safety-skill': 'Safety Skill', 'news-brief': 'News Brief', 'fix-it': 'Fix-It Help Desk', monday: 'Threat Radar', wednesday: 'Safety Skill', friday: 'Fix-It Help Desk' };
      var typeColor = { 'threat-radar': '#E8443A', 'scam-spotlight': '#FF6B35', 'safety-skill': '#BCE600', 'news-brief': '#5599FF', 'fix-it': '#F5A623', monday: '#E8443A', wednesday: '#BCE600', friday: '#F5A623' };
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
  <meta name="description" content="Plain-English cyber safety tips every weekday. No jargon. Real protection for real people." />
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
    .feature:nth-child(1){animation-delay:0.06s}
    .feature:nth-child(2){animation-delay:0.12s}
    .feature:nth-child(3){animation-delay:0.18s}
    .feature:nth-child(4){animation-delay:0.24s}
    .feature:nth-child(5){animation-delay:0.30s}

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
        Free Cyber Safety Newsletter &mdash; 5&times; a week
      </div>

      <h1>
        STAY ONE STEP<br/>
        AHEAD OF<br/>
        <span class="lime">HACKERS.</span>
      </h1>

      <p class="hero-desc">
        Real-time cybersecurity alerts and practical tips delivered to your inbox every weekday &mdash;
        no tech degree required. Powered by live threat intelligence, built for everyday people by <strong style="color:var(--off)">XNL Tech</strong>.
      </p>

      <div class="features">
        <div class="feature">
          <div class="feat-icon">&#128680;</div>
          <div>
            <div class="feat-title">Monday &mdash; Threat Radar</div>
            <div class="feat-body">We decode the week's biggest cyber threat using live intelligence from top security sources &mdash; so you know what to watch for.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feat-icon">&#128270;</div>
          <div>
            <div class="feat-title">Tuesday &mdash; Scam Spotlight</div>
            <div class="feat-body">A deep dive into one active scam: how it works, who it targets, and exactly how to protect yourself.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feat-icon">&#128274;</div>
          <div>
            <div class="feat-title">Wednesday &mdash; Safety Skill</div>
            <div class="feat-body">One simple security habit you can set up in minutes. Passwords, 2FA, privacy settings &mdash; we build your defenses step by step.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feat-icon">&#128240;</div>
          <div>
            <div class="feat-title">Thursday &mdash; News Brief</div>
            <div class="feat-body">A quick-hit digest of the cybersecurity headlines that actually matter to you &mdash; no jargon, just the facts.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feat-icon">&#128187;</div>
          <div>
            <div class="feat-title">Friday &mdash; Fix-It Help Desk</div>
            <div class="feat-body">Slow computer? Mystery charge? We tackle a common tech headache with clear, step-by-step guidance anyone can follow.</div>
          </div>
        </div>
      </div>

      <div class="schedule">
        <div class="sched-pill"><span class="day">MON</span>&nbsp;Threat Radar</div>
        <div class="sched-pill"><span class="day">TUE</span>&nbsp;Scam Spotlight</div>
        <div class="sched-pill"><span class="day">WED</span>&nbsp;Safety Skill</div>
        <div class="sched-pill"><span class="day">THU</span>&nbsp;News Brief</div>
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
          5 issues a week. Real threats. Plain English. Zero jargon.
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

        <div class="freq-label">Your weekday lineup</div>
        <div class="freq-row">
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">MON</span>
            <span class="freq-topic">Threats</span>
          </div>
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">TUE</span>
            <span class="freq-topic">Scams</span>
          </div>
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">WED</span>
            <span class="freq-topic">Skills</span>
          </div>
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">THU</span>
            <span class="freq-topic">News</span>
          </div>
          <div class="freq-opt active" onclick="this.classList.toggle('active')">
            <span class="freq-day">FRI</span>
            <span class="freq-topic">Fix-It</span>
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
        Your first issue arrives <strong style="color:var(--off)">tomorrow morning.</strong> We send every weekday.</p>
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
        <li>Send you the ShieldSmart newsletter (Monday through Friday)</li>
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

// ─── RSS THREAT INTELLIGENCE FETCHER ──────────────────────────────────────────
const THREAT_FEEDS = [
  { name: 'KrebsOnSecurity', url: 'https://krebsonsecurity.com/feed/' },
  { name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { name: 'CISA Alerts', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
  { name: 'Naked Security', url: 'https://nakedsecurity.sophos.com/feed/' },
];

function parseRSSItems(xmlText, sourceName) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const desc = (block.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
    const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    const cleanDesc = desc.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim().slice(0, 200);
    if (cleanTitle) {
      items.push({
        title: cleanTitle,
        summary: cleanDesc,
        date: pubDate.trim(),
        source: sourceName,
        link: link.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
      });
    }
  }
  // Also try <entry> for Atom feeds
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const summary = (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '';
    const updated = (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/) || [])[1] || '';
    const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    const cleanSummary = summary.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim().slice(0, 200);
    if (cleanTitle) {
      items.push({ title: cleanTitle, summary: cleanSummary, date: updated.trim(), source: sourceName, link: '' });
    }
  }
  return items;
}

async function fetchThreatIntel(env) {
  const CACHE_KEY = 'cache:threat-intel';
  const CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

  try {
    const cached = await env.CONTENT.get(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      const age = (Date.now() - parsed.fetchedAt) / 1000;
      if (age < CACHE_TTL) return parsed;
    }
  } catch (_) {}

  const results = await Promise.allSettled(
    THREAT_FEEDS.map(async (feed) => {
      const resp = await fetch(feed.url, {
        headers: { 'User-Agent': 'ShieldSmart-Newsletter/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      return parseRSSItems(xml, feed.name);
    })
  );

  let allItems = [];
  const feedStatus = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      allItems = allItems.concat(r.value);
      feedStatus.push({ name: THREAT_FEEDS[i].name, ok: true, count: r.value.length });
    } else {
      feedStatus.push({ name: THREAT_FEEDS[i].name, ok: false, error: r.reason?.message });
    }
  });

  // Filter to last 5 days and sort by date descending
  const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
  allItems = allItems.filter(item => {
    if (!item.date) return true; // keep items without dates
    const d = new Date(item.date).getTime();
    return !isNaN(d) ? d > fiveDaysAgo : true;
  });
  allItems.sort((a, b) => {
    const da = new Date(a.date || 0).getTime() || 0;
    const db = new Date(b.date || 0).getTime() || 0;
    return db - da;
  });

  // Deduplicate by similar titles
  const seen = new Set();
  allItems = allItems.filter(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const intel = {
    items: allItems.slice(0, 20),
    feedStatus,
    fetchedAt: Date.now(),
    totalItems: allItems.length,
  };

  try {
    await env.CONTENT.put(CACHE_KEY, JSON.stringify(intel), { expirationTtl: CACHE_TTL });
  } catch (_) {}

  return intel;
}

function formatThreatIntelForPrompt(intel) {
  if (!intel || !intel.items || intel.items.length === 0) {
    return '';
  }
  const lines = intel.items.slice(0, 15).map((item, i) => {
    const dateStr = item.date ? new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return `${i + 1}. ${item.title} — [${item.source}${dateStr ? ', ' + dateStr : ''}]\n   ${item.summary}`;
  });
  return `\n\nREAL-TIME THREAT INTELLIGENCE — Base your content on these ACTUAL current stories from the last few days:\n${lines.join('\n\n')}\n\nYou MUST reference or draw from the real stories above. Do NOT make up threats.`;
}

// ─── DRAFT KV HELPERS ─────────────────────────────────────────────────────────
async function saveDraft(env, draft) {
  const key = `draft:${draft.dateKey || new Date().toISOString().split('T')[0]}`;
  await env.CONTENT.put(key, JSON.stringify(draft));
  return key;
}

async function getDraft(env, dateKey) {
  const key = dateKey.startsWith('draft:') ? dateKey : `draft:${dateKey}`;
  const val = await env.CONTENT.get(key);
  return val ? JSON.parse(val) : null;
}

async function updateDraft(env, dateKey, updates) {
  const draft = await getDraft(env, dateKey);
  if (!draft) return null;
  Object.assign(draft, updates);
  const key = dateKey.startsWith('draft:') ? dateKey : `draft:${dateKey}`;
  await env.CONTENT.put(key, JSON.stringify(draft));
  return draft;
}

async function listDrafts(env) {
  const list = await env.CONTENT.list({ prefix: 'draft:' });
  const drafts = [];
  for (const key of list.keys) {
    const val = await env.CONTENT.get(key.name);
    if (val) {
      const d = JSON.parse(val);
      d._key = key.name;
      drafts.push(d);
    }
  }
  return drafts.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
}

async function deleteDraft(env, dateKey) {
  const key = dateKey.startsWith('draft:') ? dateKey : `draft:${dateKey}`;
  await env.CONTENT.delete(key);
}

// ─── TOPIC DEDUP (ENHANCED) ──────────────────────────────────────────────────
async function getRecentTopicsForDedup(env) {
  const subjects = [];

  // Fetch last 30 archived issues
  try {
    const list = await env.CONTENT.list({ prefix: 'issue:' });
    const metaKeys = list.keys
      .filter(k => k.name.endsWith(':meta'))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 30);
    for (const key of metaKeys) {
      const val = await env.CONTENT.get(key.name);
      if (val) {
        const meta = JSON.parse(val);
        subjects.push({
          subject: meta.subject,
          tags: meta.topicTags || [],
          type: meta.issueType,
        });
      }
    }
  } catch (_) {}

  // Also include pending/needs_review drafts
  try {
    const drafts = await listDrafts(env);
    for (const d of drafts) {
      if (d.status === 'pending' || d.status === 'needs_review') {
        subjects.push({
          subject: d.subject,
          tags: d.topicTags || [],
          type: d.issueType,
        });
      }
    }
  } catch (_) {}

  return subjects;
}

function formatDedupForPrompt(recentTopics) {
  if (!recentTopics || recentTopics.length === 0) return '';
  const lines = recentTopics.map(t => {
    const tags = t.tags && t.tags.length > 0 ? ` (tags: ${t.tags.join(', ')})` : '';
    return `- ${t.subject}${tags}`;
  });
  return `\n\nALREADY COVERED — Do NOT repeat any of these topics or angles:\n${lines.join('\n')}\nChoose a COMPLETELY DIFFERENT topic that has NOT been covered above.`;
}

// ─── AUTOMATED QA CHECKER ─────────────────────────────────────────────────────
function runProgrammaticQA(draft) {
  const issues = [];

  if (!draft.html || !draft.subject) {
    issues.push({ severity: 'major', issue: 'Missing HTML content or subject line' });
    return { pass: false, issues, severity: 'major' };
  }

  const textContent = draft.html.replace(/<[^>]+>/g, '');

  // Check content length
  if (textContent.length < 500) {
    issues.push({ severity: 'major', issue: `Content too short (${textContent.length} chars, minimum 500)` });
  }
  if (textContent.length > 20000) {
    issues.push({ severity: 'minor', issue: `Content very long (${textContent.length} chars)` });
  }

  // Check for garbled/weird characters
  const mojibake = /[\x00-\x08\x0B\x0C\x0E-\x1F]|[\uFFFD]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const weirdChars = textContent.match(mojibake);
  if (weirdChars && weirdChars.length > 0) {
    issues.push({ severity: 'major', issue: `Found ${weirdChars.length} garbled/malformed characters` });
  }

  // Check for excessive special unicode
  const excessiveSymbols = textContent.match(/[\u2000-\u2BFF\u2E00-\u2E7F\u3000-\u303F]/g);
  if (excessiveSymbols && excessiveSymbols.length > 50) {
    issues.push({ severity: 'minor', issue: `Excessive special Unicode symbols (${excessiveSymbols.length})` });
  }

  // Check for broken HTML patterns
  if (draft.html.includes('undefined') || draft.html.includes('[object Object]')) {
    issues.push({ severity: 'major', issue: 'HTML contains "undefined" or "[object Object]"' });
  }

  // Check for code fences that weren't stripped
  if (/```/.test(draft.html)) {
    issues.push({ severity: 'major', issue: 'HTML contains markdown code fences (```)' });
  }

  // Check subject line
  if (draft.subject.length < 10) {
    issues.push({ severity: 'major', issue: 'Subject line too short' });
  }
  if (draft.subject.length > 150) {
    issues.push({ severity: 'minor', issue: 'Subject line very long (may get truncated)' });
  }

  // Check for brand colors presence
  const hasBrandColor = /#BCE600|#F2F5E8|#1E201E|#111311/i.test(draft.html);
  if (!hasBrandColor) {
    issues.push({ severity: 'minor', issue: 'Missing brand colors in HTML' });
  }

  // Check for empty sections
  const emptyDivs = draft.html.match(/<div[^>]*>\s*<\/div>/g);
  if (emptyDivs && emptyDivs.length > 3) {
    issues.push({ severity: 'minor', issue: `Found ${emptyDivs.length} empty div elements` });
  }

  const hasMajor = issues.some(i => i.severity === 'major');
  return {
    pass: issues.length === 0,
    issues,
    severity: hasMajor ? 'major' : issues.length > 0 ? 'minor' : 'none',
  };
}

async function runClaudeQA(draft, env) {
  const textContent = draft.html.replace(/<[^>]+>/g, '').slice(0, 6000);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are a newsletter QA editor for ShieldSmart, a cybersecurity newsletter for non-tech-savvy everyday people. Your job is to proofread and check quality. Be strict but fair.`,
      messages: [{
        role: 'user',
        content: `Review this newsletter draft. Check for:
1. Grammar and spelling mistakes
2. Awkward phrasing or sentences that don't flow
3. Tone issues (too scary, too much jargon, not warm enough for non-tech audience)
4. Factual inconsistencies
5. Missing sign-off or incomplete sections

Subject: ${draft.subject}
Issue Type: ${draft.issueType}

Content:
${textContent}

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "pass": true/false,
  "severity": "none" | "minor" | "major",
  "issues": [{"type": "grammar|tone|flow|factual|structure", "description": "...", "suggestion": "..."}],
  "topicTags": ["tag1", "tag2", "tag3"],
  "summary": "One sentence summary of overall quality"
}`
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`QA API error: ${err}`);
  }

  const data = await response.json();
  let raw = data.content[0].text.trim();
  raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    return { pass: false, severity: 'major', issues: [{ type: 'structure', description: 'QA response was not valid JSON', suggestion: raw.slice(0, 200) }], topicTags: [], summary: 'QA parse error' };
  }
}

async function autoFixDraft(draft, qaResult, env) {
  const issuesList = (qaResult.issues || []).map(i => `- ${i.type}: ${i.description}${i.suggestion ? ' (fix: ' + i.suggestion + ')' : ''}`).join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 10000,
      system: `You are an editor fixing a newsletter draft. Apply the requested fixes while preserving all HTML structure, inline styles, and brand formatting. Output ONLY the corrected full HTML — no explanation, no markdown, no code fences.`,
      messages: [{
        role: 'user',
        content: `Fix these issues in the newsletter HTML:\n${issuesList}\n\nOriginal subject: ${draft.subject}\n\nOriginal HTML:\n${draft.html}`
      }],
    }),
  });

  if (!response.ok) throw new Error('Auto-fix API error: ' + await response.text());

  const data = await response.json();
  let fixedHtml = data.content[0].text.trim();
  fixedHtml = fixedHtml.replace(/```html\s*/gi, '').replace(/```\s*/gi, '').trim();
  return fixedHtml;
}

// ─── STATUS REPORT EMAIL ──────────────────────────────────────────────────────
async function sendStatusReport(env, report) {
  const to = 'help@xnltech.com';
  const overallStatus = report.failed > 0 ? (report.sent === 0 ? 'FAIL' : 'PARTIAL FAIL') : 'SUCCESS';
  const subject = `ShieldSmart Daily Report: ${overallStatus} — "${report.subject}"`;

  const issueTypeLabels = {
    'threat-radar': 'Monday Threat Radar',
    'scam-spotlight': 'Tuesday Scam Spotlight',
    'safety-skill': 'Wednesday Safety Skill',
    'news-brief': 'Thursday News Brief',
    'fix-it': 'Friday Fix-It Help Desk',
    monday: 'Monday Threat Radar',
    wednesday: 'Wednesday Safety Skill',
    friday: 'Friday Fix-It Help Desk',
  };

  const qaSection = report.qaResult ? `
    <tr><td style="padding:16px 24px;border-top:1px solid #2A2C2A;">
      <div style="color:#7A8070;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">QA Results</div>
      <div style="color:#F2F5E8;font-size:14px;">
        <strong style="color:${report.qaResult.pass ? '#BCE600' : '#E8443A'};">${report.qaResult.pass ? 'PASSED' : 'ISSUES FOUND'}</strong>
        ${report.qaResult.summary ? ' — ' + report.qaResult.summary : ''}
        ${report.qaResult.autoFixed ? '<br/><span style="color:#F5A623;">Auto-fixes were applied</span>' : ''}
      </div>
    </td></tr>` : '';

  const xPostSection = report.xPostStatus ? `
    <tr><td style="padding:16px 24px;border-top:1px solid #2A2C2A;">
      <div style="color:#7A8070;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">X (Twitter) Post</div>
      <div style="color:${report.xPostStatus === 'posted' ? '#BCE600' : '#E8443A'};font-size:14px;font-weight:600;">${report.xPostStatus === 'posted' ? 'POSTED' : 'FAILED: ' + (report.xPostError || 'unknown')}</div>
      ${report.tweetText ? '<div style="color:#7A8070;font-size:13px;margin-top:6px;white-space:pre-wrap;">' + report.tweetText + '</div>' : ''}
    </td></tr>` : '';

  const growthSection = report.growth ? `
    <tr><td style="padding:16px 24px;border-top:1px solid #2A2C2A;">
      <div style="color:#7A8070;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Subscriber Growth</div>
      <div style="color:#F2F5E8;font-size:14px;">
        <strong style="color:#BCE600;">${report.growth.totalActive}</strong> active subscribers
        ${report.growth.netChange !== undefined ? ` (${report.growth.netChange >= 0 ? '+' : ''}${report.growth.netChange} today)` : ''}
      </div>
      ${report.growth.newToday ? '<div style="color:#7A8070;font-size:13px;margin-top:4px;">New today: ' + report.growth.newToday + ' | Unsubscribed: ' + (report.growth.unsubscribedToday || 0) + '</div>' : ''}
      ${report.growth.weeklyChange !== undefined ? '<div style="color:#7A8070;font-size:13px;margin-top:4px;">This week: ' + (report.growth.weeklyChange >= 0 ? '+' : '') + report.growth.weeklyChange + ' net</div>' : ''}
      ${report.growth.tip ? '<div style="background:#1A2600;border:1px solid #4A6600;border-radius:8px;padding:12px;margin-top:10px;color:#BCE600;font-size:13px;">' + report.growth.tip + '</div>' : ''}
    </td></tr>` : '';

  const emailHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#111311;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#111311"><tr><td align="center" style="padding:24px;">
<table width="600" cellpadding="0" cellspacing="0" bgcolor="#1E201E" style="max-width:600px;width:100%;border-radius:12px;">
  <tr><td style="padding:24px;border-bottom:2px solid #BCE600;">
    <div style="font-size:20px;font-weight:800;color:#FFF;">SHIELD<span style="color:#BCE600;">SMART</span> <span style="font-size:12px;color:#F5A623;font-weight:700;background:#F5A62320;padding:2px 8px;border-radius:4px;">DAILY REPORT</span></div>
  </td></tr>
  <tr><td style="padding:20px 24px;">
    <div style="font-size:28px;font-weight:700;color:${overallStatus === 'SUCCESS' ? '#BCE600' : '#E8443A'};">${overallStatus}</div>
    <div style="color:#F2F5E8;font-size:16px;margin-top:8px;">${report.subject}</div>
    <div style="color:#7A8070;font-size:13px;margin-top:4px;">${issueTypeLabels[report.issueType] || report.issueType} — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #2A2C2A;">
    <div style="color:#7A8070;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Delivery</div>
    <div style="color:#F2F5E8;font-size:14px;">
      <strong style="color:#BCE600;">${report.sent}</strong> sent &nbsp;|&nbsp;
      <strong style="color:${report.failed > 0 ? '#E8443A' : '#7A8070'};">${report.failed}</strong> failed &nbsp;|&nbsp;
      <strong>${report.totalSubscribers || (report.sent + report.failed)}</strong> total
    </div>
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #2A2C2A;">
    <div style="color:#7A8070;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">How It Was Sent</div>
    <div style="color:#F2F5E8;font-size:14px;">${report.sendMethod || 'Unknown'}</div>
  </td></tr>
  ${qaSection}${xPostSection}${growthSection}
  <tr><td style="padding:16px 24px;border-top:1px solid #2A2C2A;text-align:center;">
    <a href="https://xnltech.com/admin" style="display:inline-block;background:#BCE600;color:#111311;padding:10px 24px;border-radius:8px;font-weight:700;font-size:14px;text-decoration:none;">Open Admin Panel</a>
  </td></tr>
</table>
</td></tr></table></body></html>`;

  try {
    await sendEmail({ email: to }, emailHtml, subject, env);
  } catch (e) {
    console.error('Status report email failed:', e.message);
  }
}

// ─── X (TWITTER) AUTO-POST ────────────────────────────────────────────────────
async function generateTweet(newsletterSubject, issueType, env) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You write viral tweets for ShieldSmart, a free cybersecurity newsletter for everyday people by XNL Tech. Tone: urgent but friendly, relatable. Goal: drive subscriptions to xnltech.com. Never use hashtags excessively — max 1-2.`,
      messages: [{
        role: 'user',
        content: `Write a single tweet (max 270 characters) promoting today's ShieldSmart newsletter.

Newsletter subject: "${newsletterSubject}"
Issue type: ${issueType}

The tweet should:
- Hook with the threat/topic from the subject
- Create urgency without fearmongering
- End with a CTA to subscribe at xnltech.com
- Be under 270 characters (leave room for platform formatting)

Output ONLY the tweet text. No quotes, no labels, no explanation.`
      }],
    }),
  });

  if (!response.ok) throw new Error('Tweet generation failed: ' + await response.text());
  const data = await response.json();
  return data.content[0].text.trim().replace(/^["']|["']$/g, '');
}

function buildOAuthHeader(method, url, params, env) {
  const oauthParams = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...params };
  const paramString = Object.keys(allParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(env.X_API_SECRET)}&${encodeURIComponent(env.X_ACCESS_SECRET)}`;

  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  ).then(key =>
    crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString))
  ).then(sig => {
    const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
    oauthParams.oauth_signature = signature;
    const headerParts = Object.keys(oauthParams).sort()
      .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(', ');
    return `OAuth ${headerParts}`;
  });
}

async function postToX(text, env) {
  if (!env.X_API_KEY || !env.X_ACCESS_TOKEN) {
    console.log('[SKIP] X posting: API keys not configured');
    return { posted: false, reason: 'not_configured' };
  }

  const url = 'https://api.x.com/2/tweets';
  const authHeader = await buildOAuthHeader('POST', url, {}, env);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`X API error (${resp.status}): ${err}`);
  }

  const result = await resp.json();
  return { posted: true, tweetId: result.data?.id };
}

// ─── SUBSCRIBER GROWTH TRACKING ───────────────────────────────────────────────
async function takeGrowthSnapshot(env) {
  const today = new Date().toISOString().split('T')[0];
  const key = `growth:${today}`;

  // Count current subscribers
  const list = await env.SUBSCRIBERS.list({ prefix: 'sub:' });
  let totalActive = 0;
  let totalInactive = 0;
  for (const k of list.keys) {
    const val = await env.SUBSCRIBERS.get(k.name);
    if (val) {
      const sub = JSON.parse(val);
      if (sub.active) totalActive++; else totalInactive++;
    }
  }

  // Get yesterday's snapshot for comparison
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  let prevSnap = null;
  try {
    const prev = await env.CONTENT.get(`growth:${yesterday}`);
    if (prev) prevSnap = JSON.parse(prev);
  } catch (_) {}

  // Get last week's snapshot
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  let weekSnap = null;
  try {
    const ws = await env.CONTENT.get(`growth:${weekAgo}`);
    if (ws) weekSnap = JSON.parse(ws);
  } catch (_) {}

  const snapshot = {
    date: today,
    totalActive,
    totalInactive,
    newToday: prevSnap ? Math.max(0, totalActive - prevSnap.totalActive + (prevSnap.totalInactive < totalInactive ? totalInactive - prevSnap.totalInactive : 0)) : 0,
    unsubscribedToday: prevSnap ? Math.max(0, prevSnap.totalActive - totalActive + (totalActive > prevSnap.totalActive ? totalActive - prevSnap.totalActive : 0)) : 0,
    netChange: prevSnap ? (totalActive - prevSnap.totalActive) : 0,
    weeklyChange: weekSnap ? (totalActive - weekSnap.totalActive) : undefined,
  };

  await env.CONTENT.put(key, JSON.stringify(snapshot));
  return snapshot;
}

async function generateGrowthTip(growth, env) {
  if (!env.ANTHROPIC_API_KEY) return '';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: 'You give brief, actionable newsletter growth tips. One sentence only.',
        messages: [{
          role: 'user',
          content: `ShieldSmart newsletter stats: ${growth.totalActive} active subscribers, ${growth.netChange >= 0 ? '+' : ''}${growth.netChange} today, ${growth.weeklyChange !== undefined ? (growth.weeklyChange >= 0 ? '+' : '') + growth.weeklyChange + ' this week' : 'no weekly data yet'}. Give one specific, actionable growth tip.`
        }],
      }),
    });
    if (!response.ok) return '';
    const data = await response.json();
    return data.content[0].text.trim();
  } catch (_) {
    return '';
  }
}

// ─── POST-SEND PIPELINE ──────────────────────────────────────────────────────
async function runPostSendPipeline(newsletter, sendResult, sendMethod, qaResult, env) {
  const growth = await takeGrowthSnapshot(env);
  const tip = await generateGrowthTip(growth, env);
  growth.tip = tip;

  let xPostStatus = 'skipped';
  let xPostError = '';
  let tweetText = '';

  try {
    tweetText = await generateTweet(newsletter.subject, newsletter.issueType, env);
    const xResult = await postToX(tweetText, env);
    xPostStatus = xResult.posted ? 'posted' : 'skipped';
    if (!xResult.posted) xPostError = xResult.reason || '';
  } catch (e) {
    xPostStatus = 'failed';
    xPostError = e.message;
    console.error('X post failed:', e.message);
  }

  await sendStatusReport(env, {
    subject: newsletter.subject,
    issueType: newsletter.issueType,
    sent: sendResult.sent,
    failed: sendResult.failed,
    totalSubscribers: sendResult.total,
    sendMethod,
    qaResult: qaResult || null,
    xPostStatus,
    xPostError,
    tweetText,
    growth,
  });
}

// ─── ADMIN AUTH ───────────────────────────────────────────────────────────────
function isAdmin(request, env) {
  const secret = request.headers.get('X-Admin-Secret');
  return secret && secret === env.ADMIN_SECRET;
}