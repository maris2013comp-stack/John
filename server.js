require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const REDIRECT_URI = `http://localhost:${PORT}/api/calendar/callback`;

function getOAuth2Client() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return null;
  return new google.auth.OAuth2(id, secret, REDIRECT_URI);
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {}
  return null;
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function authedClient() {
  const client = getOAuth2Client();
  const tokens = loadTokens();
  if (!client || !tokens) return null;
  client.setCredentials(tokens);
  client.on('tokens', newTokens => saveTokens({ ...loadTokens(), ...newTokens }));
  return client;
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ─── ANTHROPIC PROXY ──────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY nav iestatīta .env failā' } });
  }

  const { _beta, ...body } = req.body;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (_beta) headers['anthropic-beta'] = _beta;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: { message: 'Nevar savienoties ar Anthropic API: ' + err.message } });
  }
});

// ─── GOOGLE CALENDAR ──────────────────────────────────────

app.get('/api/calendar/status', (req, res) => {
  const configured = !!getOAuth2Client();
  const connected = !!(configured && loadTokens());
  res.json({ configured, connected });
});

app.get('/api/calendar/auth-url', (req, res) => {
  const client = getOAuth2Client();
  if (!client) return res.status(400).json({ error: 'GOOGLE_CLIENT_ID un GOOGLE_CLIENT_SECRET nav iestatīti .env failā' });
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/tasks.readonly',
    ],
    prompt: 'consent',
  });
  res.json({ url });
});

app.get('/api/calendar/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?gcal_error=1');
  const client = getOAuth2Client();
  if (!client) return res.redirect('/?gcal_error=1');
  try {
    const { tokens } = await client.getToken(code);
    saveTokens(tokens);
    res.redirect('/?gcal_connected=1');
  } catch {
    res.redirect('/?gcal_error=1');
  }
});

app.get('/api/calendar/events', async (req, res) => {
  const client = authedClient();
  if (!client) return res.status(401).json({ error: 'Nav savienots ar Google Calendar' });
  const cal = google.calendar({ version: 'v3', auth: client });
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  try {
    const calListResp = await cal.calendarList.list({ maxResults: 50 });
    const calendars = calListResp.data.items || [];

    const allEvents = [];
    await Promise.all(calendars.map(async cal2 => {
      try {
        const resp = await cal.events.list({
          calendarId: cal2.id,
          timeMin: dayStart.toISOString(),
          timeMax: dayEnd.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
        });
        (resp.data.items || []).forEach(e => {
          allEvents.push({
            id: e.id,
            title: e.summary || 'Bez nosaukuma',
            start: e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date,
            allDay: !e.start?.dateTime,
            location: e.location || '',
            calendarName: cal2.summary || '',
            calendarColor: cal2.backgroundColor || '#c9a84c',
          });
        });
      } catch (_) {}
    }));

    allEvents.sort((a, b) => {
      const at = a.allDay ? 0 : new Date(a.start).getTime();
      const bt = b.allDay ? 0 : new Date(b.start).getTime();
      return at - bt;
    });

    res.json({ events: allEvents });
  } catch (err) {
    if (err.code === 401) {
      if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
      return res.status(401).json({ error: 'Sesija beigusies, lūdzu savienojies no jauna' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar/events', async (req, res) => {
  const client = authedClient();
  if (!client) return res.status(401).json({ error: 'Nav savienots ar Google Calendar' });
  const { title, date, startTime, endTime, description } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'Nosaukums un datums ir obligāti' });
  const cal = google.calendar({ version: 'v3', auth: client });
  const event = {
    summary: title,
    description: description || '',
    start: startTime
      ? { dateTime: `${date}T${startTime}:00`, timeZone: 'Europe/Riga' }
      : { date },
    end: endTime
      ? { dateTime: `${date}T${endTime}:00`, timeZone: 'Europe/Riga' }
      : startTime
        ? { dateTime: `${date}T${startTime}:00`, timeZone: 'Europe/Riga' }
        : { date },
  };
  try {
    const resp = await cal.events.insert({ calendarId: 'primary', resource: event });
    res.json({ event: { id: resp.data.id, title: resp.data.summary } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/calendar/disconnect', (req, res) => {
  try {
    if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Neizdevās atvienot' });
  }
});

app.get('/api/calendar/tasks', async (req, res) => {
  const client = authedClient();
  if (!client) return res.status(401).json({ error: 'Nav savienots' });
  try {
    const tasksApi = google.tasks({ version: 'v1', auth: client });
    const listsResp = await tasksApi.tasklists.list({ maxResults: 20 });
    const lists = listsResp.data.items || [];
    const allTasks = [];
    await Promise.all(lists.map(async list => {
      try {
        const tasksResp = await tasksApi.tasks.list({
          tasklist: list.id,
          showCompleted: false,
          showHidden: false,
          maxResults: 100,
        });
        (tasksResp.data.items || []).forEach(t => {
          allTasks.push({
            id: t.id,
            title: t.title,
            due: t.due || null,
            notes: t.notes || '',
            status: t.status,
            listName: list.title,
          });
        });
      } catch (_) {}
    }));
    allTasks.sort((a, b) => {
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return new Date(a.due) - new Date(b.due);
    });
    res.json({ tasks: allTasks });
  } catch (err) {
    if (err.code === 403 || (err.response && err.response.status === 403)) {
      return res.status(403).json({ error: 'tasks_scope_missing' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`JOHN OS darbojas: http://localhost:${PORT}`);
});
