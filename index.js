// index.js
// GitHub Actions + Playwright YouTube Community Posts watcher
// - checks a list of channel /posts pages for a keyword (case-insensitive)
// - notifies via Discord webhooks (MATCH and NO-MATCH)
// - optionally sends email via SMTP if SMTP_* env vars are set
// - persists state to state.json and the workflow will commit changes back to repo

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const nodemailer = require('nodemailer');

const CHANNELS = [
  "https://www.youtube.com/@TBSkyenShorts/posts",
  "https://www.youtube.com/@TBSkyen/posts",
  "https://www.youtube.com/@2BSkyen/posts",
  "https://www.youtube.com/@3BSkyen/posts"
];

const KEYWORD = (process.env.KEYWORD || 'discord').toLowerCase();
const STATE_PATH = path.join(__dirname, 'state.json');

const MATCH_WEBHOOK = process.env.MATCH_WEBHOOK;            // required for match notifications
const NO_MATCH_WEBHOOK = process.env.NO_MATCH_WEBHOOK;      // optional no-match webhook
const NO_MATCH_MIN_HOURS = Number(process.env.NO_MATCH_MIN_HOURS || 24); // rate limit no-match

// Optional SMTP/email configuration (set as repo secrets if you want email)
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL; // comma-separated emails

// Helper — read/create state.json
function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    const init = { lastNotified: {}, lastNoMatchNotified: 0 };
    fs.writeFileSync(STATE_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}
function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Fetch posts for a channel page using Playwright and extract ytInitialData
async function fetchPostsWithPlaywright(channelUrl, maxPosts = 5) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    await page.goto(channelUrl, { waitUntil: 'networkidle', timeout: 45000 });
    // Try to read window.ytInitialData directly (fastest)
    let ytData = await page.evaluate(() => (window && window.ytInitialData) ? window.ytInitialData : null);
    if (!ytData) {
      // fallback: find a script tag that contains "ytInitialData" and extract JSON
      const scripts = await page.$$eval('script', els => els.map(s => s.textContent).filter(Boolean));
      let found = null;
      for (const t of scripts) {
        const idx = t.indexOf('ytInitialData');
        if (idx !== -1) {
          // regex to extract first JSON object after ytInitialData = 
          const m = t.match(/ytInitialData\s*=\s*(\{[\s\S]*\});?/);
          if (m && m[1]) {
            try {
              found = JSON.parse(m[1]);
              break;
            } catch (e) {
              // continue searching other scripts
            }
          }
        }
      }
      ytData = found;
    }
    if (!ytData) {
      console.warn(`No ytInitialData found for ${channelUrl}`);
      return [];
    }

    // Recursively search for backstagePostThreadRenderer nodes and collect posts
    const posts = [];
    function recurse(o) {
      if (!o || typeof o !== 'object') return;
      if (o.backstagePostThreadRenderer && o.backstagePostThreadRenderer.post
          && o.backstagePostThreadRenderer.post.backstagePostRenderer) {
        try {
          const thread = o.backstagePostThreadRenderer;
          const pr = thread.post.backstagePostRenderer;
          // extract text
          let text = '';
          if (pr.contentText) {
            if (pr.contentText.simpleText) text = pr.contentText.simpleText;
            else if (Array.isArray(pr.contentText.runs)) text = pr.contentText.runs.map(r => r.text || '').join('');
          }
          let published = '';
          if (pr.publishedTimeText) {
            if (pr.publishedTimeText.simpleText) published = pr.publishedTimeText.simpleText;
            else if (Array.isArray(pr.publishedTimeText.runs)) published = pr.publishedTimeText.runs.map(r => r.text || '').join('');
          }
          let id = thread.postId || (pr.postId) || (pr.id) || '';
          if (!id) {
            id = Buffer.from((text || '') + '|' + published).toString('base64');
          }
          posts.push({ id, text: text || '', published: published || '' });
        } catch (e) {
          // ignore
        }
      }
      for (const k of Object.keys(o)) {
        recurse(o[k]);
      }
    }
    recurse(ytData);
    // return up to maxPosts, newest first (order discovered is usually newest-first)
    return posts.slice(0, maxPosts);
  } catch (err) {
    console.error('Playwright error for', channelUrl, err);
    return [];
  } finally {
    await page.close();
    await browser.close();
  }
}

// Discord webhook notifier
async function sendDiscordWebhook(url, content) {
  if (!url) {
    console.warn('No webhook url provided for Discord message.');
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      console.warn('Discord webhook returned', res.status, await res.text());
    } else {
      console.log('Posted to Discord webhook successfully.');
    }
  } catch (e) {
    console.error('Failed to post to Discord webhook', e);
  }
}

// Optional email notifier using nodemailer (SMTP)
async function sendEmail(subject, text) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ADMIN_EMAIL) {
    console.log('SMTP not fully configured; skipping email send.');
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: SMTP_PORT == 465, // true for 465, false for other ports
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    await transporter.sendMail({
      from: SMTP_USER,
      to: ADMIN_EMAIL.split(',').map(s => s.trim()),
      subject,
      text
    });
    console.log('Email sent to', ADMIN_EMAIL);
  } catch (e) {
    console.error('Error sending email:', e);
  }
}

// main
(async () => {
  const state = readState();
  let foundAny = false;

  for (const channelUrl of CHANNELS) {
    console.log('Checking', channelUrl);
    const posts = await fetchPostsWithPlaywright(channelUrl, 5);
    if (!posts || posts.length === 0) {
      console.log('No posts found for', channelUrl);
      continue;
    }
    const newest = posts[0];
    const textLower = (newest.text || '').toLowerCase();
    const matched = textLower.indexOf(KEYWORD) !== -1;
    const lastId = state.lastNotified[channelUrl] || null;
    if (matched) {
      foundAny = true;
      if (newest.id !== lastId) {
        const snippet = (newest.text || '').slice(0, 800);
        const msg = `**Keyword "${KEYWORD}" found** on ${channelUrl}\nPost time: ${newest.published || 'unknown'}\nSnippet: ${snippet}\nPost ID: ${newest.id}`;
        console.log('Match:', msg);
        if (MATCH_WEBHOOK) await sendDiscordWebhook(MATCH_WEBHOOK, msg);
        await sendEmail(`Keyword "${KEYWORD}" found on channel`, `${msg}\n\nLink: ${channelUrl}`);
        state.lastNotified[channelUrl] = newest.id;
      } else {
        console.log('Matched but already notified (same post id). Skipping duplicate.');
      }
    } else {
      console.log('No keyword match in newest post for', channelUrl);
    }
  }

  // If nothing matched across channels -> NO-MATCH logic (rate-limited)
  if (!foundAny) {
    const now = Date.now();
    const lastNoMatch = state.lastNoMatchNotified || 0;
    const hoursSince = (now - lastNoMatch) / (1000 * 60 * 60);
    if (hoursSince >= NO_MATCH_MIN_HOURS) {
      const nowStr = new Date().toLocaleString();
      const msg = `⚠️ NO MATCH — keyword "${KEYWORD}" was NOT found in the most recent posts of ${CHANNELS.length} channels.\nChecked at: ${nowStr}`;
      console.log(msg);
      if (NO_MATCH_WEBHOOK) await sendDiscordWebhook(NO_MATCH_WEBHOOK, msg);
      await sendEmail(`NO MATCH: keyword "${KEYWORD}" not found`, msg);
      state.lastNoMatchNotified = now;
    } else {
      console.log(`No-match suppressed (only ${hoursSince.toFixed(2)} hours since last NO-MATCH message).`);
    }
  } else {
    console.log('At least one match found; skipping NO-MATCH notification.');
  }

  // Persist state
  writeState(state);
  console.log('State updated.');

  process.exit(0);
})();
