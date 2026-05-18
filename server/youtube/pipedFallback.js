const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const { safeLog } = require('../utils/safeLog');

ffmpeg.setFfmpegPath(ffmpegPath);

// Lista atualizada (2026-05): a maioria das instâncias Piped/Invidious históricas
// foi desligada ou está rate-limiting datacenters. Mantemos só as confirmadamente
// vivas e respondendo JSON válido. Override com PIPED_INSTANCES / INVIDIOUS_INSTANCES.
const PIPED_DEFAULT_INSTANCES = [
  'https://api.piped.private.coffee'
];

const INVIDIOUS_DEFAULT_INSTANCES = [
  'https://inv.thepixora.com',
  'https://invidious.nerdvpn.de'
];

function parseInstanceList(envValue, fallback) {
  const raw = String(envValue || '').trim();
  if (!raw) return fallback;
  const parsed = raw
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/\/+$/, ''));
  return parsed.length > 0 ? parsed : fallback;
}

function readPipedInstances() {
  return parseInstanceList(process.env.PIPED_INSTANCES, PIPED_DEFAULT_INSTANCES);
}

function readInvidiousInstances() {
  return parseInstanceList(process.env.INVIDIOUS_INSTANCES, INVIDIOUS_DEFAULT_INSTANCES);
}

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

function pickProgressiveMp4FromPiped(payload) {
  if (!payload || !Array.isArray(payload.videoStreams) || payload.videoStreams.length === 0) {
    return null;
  }

  const candidates = payload.videoStreams
    .filter((s) => s && s.url && !s.videoOnly && String(s.format || '').toLowerCase().includes('mp4'))
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

  return candidates[0] || null;
}

function pickBestVideoOnlyMp4FromPiped(payload) {
  if (!payload || !Array.isArray(payload.videoStreams)) return null;

  const candidates = payload.videoStreams
    .filter((s) => s && s.url && s.videoOnly && String(s.format || '').toLowerCase().includes('mp4'))
    .sort((a, b) => {
      const heightDiff = (Number(b.height) || 0) - (Number(a.height) || 0);
      if (heightDiff !== 0) return heightDiff;
      return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
    });

  return candidates[0] || null;
}

function pickProgressiveMp4FromInvidious(payload) {
  if (!payload || !Array.isArray(payload.formatStreams) || payload.formatStreams.length === 0) {
    return null;
  }

  const candidates = payload.formatStreams
    .filter((f) => f && f.url && String(f.container || '').toLowerCase() === 'mp4')
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

  return candidates[0] || null;
}

function pickBestVideoOnlyMp4FromInvidious(payload) {
  if (!payload || !Array.isArray(payload.adaptiveFormats)) return null;

  const candidates = payload.adaptiveFormats
    .filter((f) => {
      if (!f || !f.url) return false;
      const type = String(f.type || '').toLowerCase();
      return type.startsWith('video/mp4');
    })
    .sort((a, b) => {
      const heightDiff = (Number(b.resolution) || Number(b.height) || 0) - (Number(a.resolution) || Number(a.height) || 0);
      if (heightDiff !== 0) return heightDiff;
      return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
    });

  return candidates[0] || null;
}

function safeTitle(rawTitle, fallback) {
  const text = String(rawTitle || '').trim();
  return text || fallback;
}

async function tryPipedInstances(videoId) {
  for (const base of readPipedInstances()) {
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
  for (const base of readInvidiousInstances()) {
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

async function tryPipedInstancesMp4(videoId) {
  for (const base of readPipedInstances()) {
    const endpoint = `${base.replace(/\/$/, '')}/streams/${encodeURIComponent(videoId)}`;
    try {
      safeLog.info('[YouTube][piped-mp4] tentando instância', { instance: base });
      const data = await fetchJson(endpoint, { timeoutMs: FETCH_TIMEOUT_MS });

      const progressive = pickProgressiveMp4FromPiped(data);
      if (progressive?.url) {
        return {
          videoUrl: progressive.url,
          audioUrl: null,
          title: safeTitle(data.title, `youtube-${videoId}`),
          source: `piped:${base}`
        };
      }

      const videoOnly = pickBestVideoOnlyMp4FromPiped(data);
      const audio = pickBestAudioFromPiped(data);
      if (videoOnly?.url && audio?.url) {
        return {
          videoUrl: videoOnly.url,
          audioUrl: audio.url,
          title: safeTitle(data.title, `youtube-${videoId}`),
          source: `piped:${base}`
        };
      }
    } catch (err) {
      safeLog.warn('[YouTube][piped-mp4] instância falhou', {
        instance: base,
        message: err?.message
      });
    }
  }
  return null;
}

async function tryInvidiousInstancesMp4(videoId) {
  for (const base of readInvidiousInstances()) {
    const endpoint = `${base.replace(/\/$/, '')}/api/v1/videos/${encodeURIComponent(videoId)}`;
    try {
      safeLog.info('[YouTube][invidious-mp4] tentando instância', { instance: base });
      const data = await fetchJson(endpoint, { timeoutMs: FETCH_TIMEOUT_MS });

      const progressive = pickProgressiveMp4FromInvidious(data);
      if (progressive?.url) {
        return {
          videoUrl: progressive.url,
          audioUrl: null,
          title: safeTitle(data.title, `youtube-${videoId}`),
          source: `invidious:${base}`
        };
      }

      const videoOnly = pickBestVideoOnlyMp4FromInvidious(data);
      const audio = pickBestAudioFromInvidious(data);
      if (videoOnly?.url && audio?.url) {
        return {
          videoUrl: videoOnly.url,
          audioUrl: audio.url,
          title: safeTitle(data.title, `youtube-${videoId}`),
          source: `invidious:${base}`
        };
      }
    } catch (err) {
      safeLog.warn('[YouTube][invidious-mp4] instância falhou', {
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

function downloadAndMergeToMp4(videoUrl, audioUrl, outputMp4Path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(true);
    };

    const watchdog = setTimeout(() => {
      finish(new Error('Timeout ao remuxar streams em MP4.'));
    }, DOWNLOAD_TIMEOUT_MS * 2);
    watchdog.unref?.();

    try {
      const command = ffmpeg();
      command.input(videoUrl).inputOptions([
        '-user_agent',
        USER_AGENT,
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5'
      ]);

      if (audioUrl) {
        command.input(audioUrl).inputOptions([
          '-user_agent',
          USER_AGENT,
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '5'
        ]);
      }

      const outputOptions = ['-c', 'copy', '-movflags', '+faststart'];
      if (audioUrl) {
        outputOptions.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
      }

      command
        .outputOptions(outputOptions)
        .format('mp4')
        .on('error', (err) => {
          clearTimeout(watchdog);
          finish(err);
        })
        .on('end', () => {
          clearTimeout(watchdog);
          finish();
        })
        .save(outputMp4Path);
    } catch (err) {
      clearTimeout(watchdog);
      finish(err);
    }
  });
}

async function runPipedToMp4({ youtubeUrl, outputMp4Path }) {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    const err = new Error('Não foi possível extrair o ID do vídeo do YouTube.');
    err.code = 'PIPED_INVALID_URL';
    throw err;
  }

  safeLog.info('[YouTube][piped-mp4] iniciando fallback piped/invidious para MP4', { videoId });

  let resolved = await tryPipedInstancesMp4(videoId);
  if (!resolved) {
    resolved = await tryInvidiousInstancesMp4(videoId);
  }

  if (!resolved) {
    const err = new Error('Nenhuma instância Piped/Invidious retornou vídeo MP4.');
    err.code = 'PIPED_ALL_INSTANCES_FAILED';
    throw err;
  }

  safeLog.info('[YouTube][piped-mp4] streams resolvidos, gerando MP4', {
    source: resolved.source,
    hasAudio: Boolean(resolved.audioUrl)
  });

  await downloadAndMergeToMp4(resolved.videoUrl, resolved.audioUrl, outputMp4Path);

  if (!fs.existsSync(outputMp4Path)) {
    const err = new Error('Falha ao gerar MP4 a partir de Piped/Invidious.');
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
  runPipedToMp4,
  extractVideoId,
  _private: {
    pickBestAudioFromPiped,
    pickBestAudioFromInvidious,
    pickProgressiveMp4FromPiped,
    pickBestVideoOnlyMp4FromPiped,
    pickProgressiveMp4FromInvidious,
    pickBestVideoOnlyMp4FromInvidious,
    PIPED_DEFAULT_INSTANCES,
    INVIDIOUS_DEFAULT_INSTANCES,
    readPipedInstances,
    readInvidiousInstances
  }
};
