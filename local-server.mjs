import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env.local') });
dotenv.config({ path: path.join(__dirname, '.env'), override: false });
const port = Number(process.env.PORT || 3000);
const dataDir = path.join(__dirname, 'data');
const playlistsPath = path.join(dataDir, 'playlists.json');
const githubEventsPath = path.join(dataDir, 'github-events.json');

function createNeteaseHeaders(cookie = process.env.NETEASE_COOKIE) {
  const headers = {
    Referer: 'https://music.163.com/',
    'User-Agent': 'Mozilla/5.0',
  };
  if (cookie?.trim()) headers.Cookie = cookie.trim();
  return headers;
}

const playableUrlCache = new Map();
const searchCache = new Map();
const githubEventsCache = { events: null, fetchedAt: 0 };
const playableUrlCacheTtl = 1000 * 60 * 10;
const searchCacheTtl = 1000 * 60 * 5;
const githubEventsCacheTtl = 1000 * 60 * 20;
const githubEventsTimeoutMs = 8000;
const githubUser = process.env.GITHUB_USER || 'chenjiuxuan';
const githubRepos = (process.env.GITHUB_REPOS || 'chenjiuxuan/solo_app').split(',').map((repo) => repo.trim()).filter(Boolean);

function createDefaultPlaylists() {
  return [
    { id: 'favorites', name: '收藏', songs: [] },
    { id: 'visual-set', name: '可视集', songs: [] },
  ];
}

function normalizePlaylists(value) {
  if (!Array.isArray(value) || value.length === 0) return createDefaultPlaylists();
  return value.map((playlist) => ({
    id: String(playlist.id || `playlist-${Date.now()}`),
    name: String(playlist.name || '歌单'),
    songs: Array.isArray(playlist.songs) ? playlist.songs : [],
  }));
}

async function readPlaylistsFile() {
  try {
    const raw = await fs.readFile(playlistsPath, 'utf8');
    return normalizePlaylists(JSON.parse(raw));
  } catch {
    return createDefaultPlaylists();
  }
}

async function writePlaylistsFile(playlists) {
  await fs.mkdir(dataDir, { recursive: true });
  const normalized = normalizePlaylists(playlists);
  await fs.writeFile(playlistsPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

async function getNeteasePlayableUrl(id) {
  const cached = playableUrlCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const url = `https://music.163.com/api/song/enhance/player/url?id=${encodeURIComponent(id)}&ids=%5B${encodeURIComponent(id)}%5D&br=320000`;
  try {
    const response = await fetch(url, { headers: createNeteaseHeaders() });
    if (!response.ok) return null;
    const data = await response.json();
    const playableUrl = data?.data?.[0]?.url || null;
    playableUrlCache.set(id, { url: playableUrl, expiresAt: Date.now() + playableUrlCacheTtl });
    return playableUrl;
  } catch {
    return null;
  }
}

async function filterPlayableSongs(rawSongs, resultLimit) {
  const playableSongs = [];
  const batchSize = 8;

  for (let i = 0; i < rawSongs.length && playableSongs.length < resultLimit; i += batchSize) {
    const batch = rawSongs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (song) => ({
      song,
      playableUrl: await getNeteasePlayableUrl(String(song.id)),
    })));

    for (const result of results) {
      if (result.playableUrl) playableSongs.push(result.song);
      if (playableSongs.length >= resultLimit) break;
    }
  }

  return playableSongs;
}

async function readGithubEventsFile() {
  try {
    const raw = await fs.readFile(githubEventsPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.events)) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeGithubEventsFile(events) {
  await fs.mkdir(dataDir, { recursive: true });
  const data = { events, fetchedAt: Date.now() };
  await fs.writeFile(githubEventsPath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function createGithubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'solo-app',
  };
  if (process.env.GITHUB_TOKEN?.trim()) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN.trim();
  return headers;
}

async function fetchGithubJson(url, signal) {
  const response = await fetch(url, { headers: createGithubHeaders(), signal });
  if (!response.ok) throw new Error('GitHub upstream ' + response.status);
  return response.json();
}

function commitToEvent(repo, commit) {
  return {
    id: 'commit-' + repo + '-' + commit.sha,
    type: 'PushEvent',
    created_at: commit.commit?.author?.date || commit.commit?.committer?.date || new Date().toISOString(),
    repo: { name: repo },
    payload: {
      size: 1,
      commits: [{
        sha: commit.sha,
        message: commit.commit?.message || '更新代码',
        url: commit.html_url,
      }],
    },
  };
}

function mergeGithubEvents(events, commitEvents) {
  const visibleTypes = new Set(['PushEvent', 'PullRequestEvent', 'IssuesEvent', 'CreateEvent', 'PublicEvent']);
  const byKey = new Map();
  for (const event of [...commitEvents, ...events]) {
    if (!visibleTypes.has(event.type)) continue;
    const key = event.id || event.type + ':' + event.repo?.name + ':' + event.created_at;
    if (!byKey.has(key)) byKey.set(key, event);
  }
  return [...byKey.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);
}

async function fetchGithubEvents() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), githubEventsTimeoutMs);

  try {
    const userEventsUrl = 'https://api.github.com/users/' + encodeURIComponent(githubUser) + '/events/public?per_page=50';
    const userEvents = await fetchGithubJson(userEventsUrl, controller.signal).catch(() => []);
    if (!Array.isArray(userEvents)) throw new Error('GitHub returned unexpected data');

    const commitResults = await Promise.all(githubRepos.map(async (repo) => {
      const url = 'https://api.github.com/repos/' + repo + '/commits?per_page=5';
      const commits = await fetchGithubJson(url, controller.signal).catch(() => []);
      return Array.isArray(commits) ? commits.map((commit) => commitToEvent(repo, commit)) : [];
    }));
    const commitEvents = commitResults.flat();
    const events = mergeGithubEvents(userEvents, commitEvents);

    githubEventsCache.events = events;
    githubEventsCache.fetchedAt = Date.now();
    await writeGithubEventsFile(events);
    return events;
  } finally {
    clearTimeout(timeout);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));


app.get('/api/github/events', async (_req, res) => {
  if (!githubEventsCache.events) {
    const fileCache = await readGithubEventsFile();
    if (fileCache) {
      githubEventsCache.events = fileCache.events;
      githubEventsCache.fetchedAt = fileCache.fetchedAt || 0;
    }
  }

  const hasFreshCache = githubEventsCache.events && Date.now() - githubEventsCache.fetchedAt < githubEventsCacheTtl;
  if (hasFreshCache) {
    res.json({ events: githubEventsCache.events, cached: true, stale: false });
    return;
  }

  try {
    const events = await fetchGithubEvents();
    res.json({ events, cached: false, stale: false });
  } catch (error) {
    if (githubEventsCache.events) {
      res.json({
        events: githubEventsCache.events,
        cached: true,
        stale: true,
        warning: error?.message || 'GitHub fetch failed',
      });
      return;
    }
    res.status(502).json({ error: 'GitHub events unavailable', details: error?.message || 'unknown error' });
  }
});

app.get('/api/playlists', async (_req, res) => {
  res.json({ playlists: await readPlaylistsFile() });
});

app.get('/api/netease/status', (_req, res) => {
  res.json({
    cookieEnabled: Boolean(process.env.NETEASE_COOKIE?.trim()),
  });
});

app.put('/api/playlists', async (req, res) => {
  try {
    const playlists = await writePlaylistsFile(req.body?.playlists);
    res.json({ playlists });
  } catch {
    res.status(500).json({ error: 'Unable to save playlists' });
  }
});

app.get('/api/netease/search', async (req, res) => {
  try {
    const keywords = String(req.query.keywords || '').trim();
    const requestedLimit = Number(req.query.limit || '12');
    const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 20)) : 12;

    if (!keywords) {
      res.status(400).json({ error: 'Missing keywords' });
      return;
    }

    const cacheKey = `${keywords.toLowerCase()}::${resultLimit}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ songs: cached.songs, cached: true });
      return;
    }

    const body = new URLSearchParams({
      s: keywords,
      type: '1',
      offset: '0',
      total: 'true',
      limit: String(Math.min(resultLimit * 3, 60)),
    });

    const response = await fetch('https://music.163.com/api/search/get/web', {
      method: 'POST',
      headers: {
        ...createNeteaseHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      res.status(response.status).json({ error: 'Netease search failed', details: `upstream ${response.status}` });
      return;
    }
    const data = await response.json();
    const rawSongs = (data?.result?.songs || []).map((song) => ({
      id: song.id,
      name: song.name,
      artist: (song.artists || []).map((artist) => artist.name).filter(Boolean).join(' / '),
      album: song.album?.name || '',
      duration: song.duration || 0,
      fee: song.fee,
    }));
    const songs = await filterPlayableSongs(rawSongs, resultLimit);
    if (!songs.length && rawSongs.length) songs.push(...rawSongs.slice(0, resultLimit));
    searchCache.set(cacheKey, { songs, expiresAt: Date.now() + searchCacheTtl });

    res.json({ songs });
  } catch (error) {
    res.status(500).json({ error: 'Netease search failed', details: error?.message || 'unknown error' });
  }
});

app.get('/api/netease/lyric', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const response = await fetch(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`, {
      headers: createNeteaseHeaders(),
    });
    const data = await response.json();
    res.json({
      lyric: data?.lrc?.lyric || '',
      translatedLyric: data?.tlyric?.lyric || '',
    });
  } catch {
    res.status(500).json({ error: 'Netease lyric failed' });
  }
});

app.get('/api/netease/url', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    res.json({ url: await getNeteasePlayableUrl(id) });
  } catch {
    res.status(500).json({ error: 'Netease url failed' });
  }
});

app.get('/api/netease/audio', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const playableUrl = await getNeteasePlayableUrl(id);
    if (!playableUrl) {
      res.status(404).json({ error: 'No playable url for this song' });
      return;
    }

    const headers = { ...createNeteaseHeaders() };
    if (req.headers.range) headers.Range = req.headers.range;

    const audioResponse = await fetch(playableUrl, { headers });
    res.status(audioResponse.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
      const value = audioResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/mpeg');
    if (audioResponse.body) {
      const reader = audioResponse.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(Buffer.from(value), pump);
      };
      pump();
    } else {
      res.end();
    }
  } catch {
    res.status(500).json({ error: 'Netease audio proxy failed' });
  }
});

app.use(express.static(__dirname));

app.listen(port, '127.0.0.1', () => {
  console.log(`Solo app is running at http://127.0.0.1:${port}`);
});

