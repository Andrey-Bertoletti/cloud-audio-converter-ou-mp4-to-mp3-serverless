const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const { safeLog } = require('../utils/safeLog');

ffmpeg.setFfmpegPath(ffmpegPath);

const PIPED_API_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.darkness.services',
  'https://pipedapi.drgns.space'
];

const INVIDIOUS_API_INSTANCES = [
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.privacydev.net',
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr'
];

const FETCH_TIMEOUT_MS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extractVideoId(youtubeUrl) {
  if (!youtubeUrl) return '';
  try {
    const u = new URL(String(youtubeUrl).trim());
    const host = u.hostname.toLowerCase();

    if (host === 'youtu.be') {
      return u.pathname.replace(/^\//, '').split('/')[0];
    }

    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;

      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => ['shorts', 'embed', 'live'].includes(p));
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
  } catch (_) {
    // ignore
  }
  return '';
}

function fetchJson(urlString, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(err);
      return;
    }

    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchJson(new URL(res.headers.location, url).toString(), { timeoutMs }).then(resolve, reject);
          return;
        }

        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode || 'unknown'}`));
          return;
        }

        const chunks = [];
        let total = 0;
        const maxBytes = 4 * 1024 * 1024;

        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });

        res.on('error', reject);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function pickBestAudioFromPiped(payload) {
  if (!payload || !Array.isArray(payload.audioStreams) || payload.audioStreams.length === 0) {
    return null;
  }

  const sorted = [...payload.audioStreams]
    .filter((s) => s && s.url)
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

  return sorted[0] || null;
}

function pickBestAudioFromInvidious(payload) {
  if (!payload || !Array.isArray(payload.adaptiveFormats)) return null;

  const audios = payload.adaptiveFormats.filter((f) => {
    if (!f || !f.url) return false;
    const type = String(f.type || '').toLowerCase();
    return type.startsWith('audio/');
  });

  if (!audios.length) return null;

  const sorted = audios.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  return sorted[0];
}

function safeTitle(rawTitle, fallback) {
  const text = String(rawTitle || '').trim();
  return text || fallback;
}

async function tryPipedInstances(videoId) {
  for (const base of PIPED_API_INSTANCES) {
    const endpoint = `${base.replace(/\/$/, '')}/streams/${encodeURIComponent(videoId)}`;
    try {
      safeLog.info('[YouTube][piped] tentando instância', { instance: base });
      const data = await fetchJson(endpoint, { timeoutMs: FETCH_TIMEOUT_MS });
      const audio = pickBestAudioFromPiped(data);
      if (audio?.url) {
        return {
          streamUrl: audio.url,
          title: safeTitle(data.title, `youtube-${videoId}`),
          source: `piped:${base}`
        };
      }
    } catch (err) {
      safeLog.warn('[YouTube][piped] instância falhou', {
        instance: base,
        message: err?.message
      });
    }
  }
  return null;
}

async function tryInvidiousInstances(videoId) {
  for (const base of INVIDIOUS_API_INSTANCES) {
    const endpoint = `${base.replace(/\/$/, '')}/api/v1/videos/${encodeURIComponent(videoId)}`;
    try {
      safeLog.info('[YouTube][invidious] tentando instância', { instance: base });
      const data = await fetchJson(endpoint, { timeoutMs: FETCH_TIMEOUT_MS });
      const audio = pickBestAudioFromInvidious(data);
      if (audio?.url) {
        return {
          streamUrl: audio.url,
          title: safeTitle(data.title, `youtube-${videoId}`),
          source: `invidious:${base}`
        };
      }
    } catch (err) {
      safeLog.warn('[YouTube][invidious] instância falhou', {
        instance: base,
        message: err?.message
      });
    }
  }
  return null;
}

function downloadStreamToMp3(streamUrl, outputMp3Path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(true);
    };

    const watchdog = setTimeout(() => {
      finish(new Error('Timeout ao converter stream em MP3.'));
    }, DOWNLOAD_TIMEOUT_MS);
    watchdog.unref?.();

    try {
      ffmpeg(streamUrl)
        .inputOptions([
          '-user_agent',
          USER_AGENT,
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '5'
        ])
        .audioBitrate(192)
        .toFormat('mp3')
        .on('error', (err) => {
          clearTimeout(watchdog);
          finish(err);
        })
        .on('end', () => {
          clearTimeout(watchdog);
          finish();
        })
        .save(outputMp3Path);
    } catch (err) {
      clearTimeout(watchdog);
      finish(err);
    }
  });
}

async function runPipedToMp3({ youtubeUrl, outputMp3Path }) {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    const err = new Error('Não foi possível extrair o ID do vídeo do YouTube.');
    err.code = 'PIPED_INVALID_URL';
    throw err;
  }

  safeLog.info('[YouTube][piped] iniciando fallback piped/invidious', { videoId });

  let resolved = await tryPipedInstances(videoId);
  if (!resolved) {
    resolved = await tryInvidiousInstances(videoId);
  }

  if (!resolved) {
    const err = new Error('Nenhuma instância Piped/Invidious retornou áudio para este vídeo.');
    err.code = 'PIPED_ALL_INSTANCES_FAILED';
    throw err;
  }

  safeLog.info('[YouTube][piped] stream resolvido, convertendo em MP3', { source: resolved.source });

  await downloadStreamToMp3(resolved.streamUrl, outputMp3Path);

  if (!fs.existsSync(outputMp3Path)) {
    const err = new Error('Falha ao converter stream Piped em MP3.');
    err.code = 'PIPED_CONVERT_FAILED';
    throw err;
  }

  return {
    title: resolved.title,
    source: resolved.source
  };
}

module.exports = {
  runPipedToMp3,
  extractVideoId,
  _private: {
    pickBestAudioFromPiped,
    pickBestAudioFromInvidious,
    PIPED_API_INSTANCES,
    INVIDIOUS_API_INSTANCES
  }
};
