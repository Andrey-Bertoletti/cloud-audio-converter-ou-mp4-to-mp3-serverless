const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const { safeLog } = require('../utils/safeLog');

ffmpeg.setFfmpegPath(ffmpegPath);

// Community Cobalt instances that historically accept anonymous requests.
// Newer Cobalt versions may require an API key; instances that demand one
// will simply return 401/403 and we'll skip to the next one.
const COBALT_API_INSTANCES = [
  'https://api.cobalt.tools',
  'https://co.wuk.sh',
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt.synzr.lol',
  'https://capi.oak.li',
  'https://cobalt.tdjsnelling.com',
  'https://api.dl01.yt-dl.click',
  'https://dl.khr.is'
];

const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function postJson(urlString, payload, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(err);
      return;
    }

    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': String(body.length)
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          postJson(new URL(res.headers.location, url).toString(), payload, { timeoutMs }).then(resolve, reject);
          return;
        }

        const chunks = [];
        let total = 0;
        const maxBytes = 2 * 1024 * 1024;

        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode || 'unknown'}${raw ? `: ${raw.slice(0, 240)}` : ''}`));
            return;
          }

          try {
            resolve(JSON.parse(raw));
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
    req.write(body);
    req.end();
  });
}

function buildCobaltEndpoint(baseUrl) {
  const trimmed = baseUrl.replace(/\/$/, '');
  // Newer Cobalt (v10+) accepts POST at root. Older Cobalt uses /api/json.
  if (trimmed.endsWith('/api/json')) return trimmed;
  return `${trimmed}/`;
}

function buildLegacyEndpoint(baseUrl) {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (trimmed.endsWith('/api/json')) return trimmed;
  return `${trimmed}/api/json`;
}

function buildAudioPayload(youtubeUrl) {
  return {
    url: youtubeUrl,
    downloadMode: 'audio',
    audioFormat: 'mp3',
    audioBitrate: '192',
    filenameStyle: 'basic',
    // Legacy fields for older Cobalt versions:
    isAudioOnly: true,
    aFormat: 'mp3',
    aBitrate: '192'
  };
}

function buildVideoPayload(youtubeUrl) {
  return {
    url: youtubeUrl,
    downloadMode: 'auto',
    videoQuality: '1080',
    filenameStyle: 'basic',
    youtubeVideoCodec: 'h264',
    youtubeDubLang: 'original',
    // Legacy fields:
    vQuality: '1080',
    isAudioOnly: false
  };
}

function pickCobaltStreamUrl(response) {
  if (!response || typeof response !== 'object') return null;
  const status = String(response.status || '').toLowerCase();
  if (!['tunnel', 'redirect', 'stream'].includes(status)) return null;
  if (typeof response.url !== 'string' || !response.url.startsWith('http')) return null;
  return response.url;
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
      finish(new Error('Timeout ao converter stream Cobalt em MP3.'));
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

function downloadHttpToFile(streamUrl, outputPath, { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(streamUrl);
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
          'Accept': '*/*'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (maxRedirects <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          downloadHttpToFile(next, outputPath, { timeoutMs, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
          return;
        }

        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode || 'unknown'}`));
          return;
        }

        const file = fs.createWriteStream(outputPath, { mode: 0o600 });
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
        });
        res.pipe(file);
        file.on('error', (err) => {
          file.close();
          reject(err);
        });
        file.on('finish', () => {
          file.close(() => {
            if (bytes === 0) {
              reject(new Error('Downloaded file is empty'));
            } else {
              resolve(true);
            }
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Download timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function tryCobaltInstance(baseUrl, payload) {
  // Try v10+ endpoint first (POST /), then legacy /api/json
  const endpoints = [buildCobaltEndpoint(baseUrl), buildLegacyEndpoint(baseUrl)];
  let lastError;

  for (const endpoint of endpoints) {
    try {
      const response = await postJson(endpoint, payload, { timeoutMs: FETCH_TIMEOUT_MS });

      if (response?.status === 'error') {
        const code = response?.error?.code || response?.text || 'unknown';
        throw new Error(`Cobalt error: ${code}`);
      }

      const streamUrl = pickCobaltStreamUrl(response);
      if (streamUrl) {
        return { streamUrl, filename: response?.filename || '' };
      }

      throw new Error(`Cobalt response inválido: status=${response?.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Cobalt instance falhou');
}

async function runCobaltToMp3({ youtubeUrl, outputMp3Path }) {
  safeLog.info('[YouTube][cobalt] iniciando fallback Cobalt MP3');

  const payload = buildAudioPayload(youtubeUrl);
  let lastError;

  for (const baseUrl of COBALT_API_INSTANCES) {
    try {
      safeLog.info('[YouTube][cobalt] tentando instância', { instance: baseUrl });
      const { streamUrl, filename } = await tryCobaltInstance(baseUrl, payload);
      safeLog.info('[YouTube][cobalt] stream resolvido, baixando MP3', {
        instance: baseUrl,
        filenameProvided: Boolean(filename)
      });

      try {
        await downloadStreamToMp3(streamUrl, outputMp3Path);
      } catch (ffErr) {
        safeLog.warn('[YouTube][cobalt] ffmpeg falhou, tentando download HTTP direto.', {
          message: ffErr?.message
        });
        await downloadHttpToFile(streamUrl, outputMp3Path);
      }

      if (fs.existsSync(outputMp3Path)) {
        return {
          title: filename ? String(filename).replace(/\.[^.]+$/, '') : '',
          source: `cobalt:${baseUrl}`
        };
      }

      throw new Error('Arquivo MP3 não gerado.');
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube][cobalt] instância falhou', {
        instance: baseUrl,
        message: err?.message
      });
    }
  }

  const error = new Error('Todas as instâncias Cobalt falharam.');
  error.code = 'COBALT_ALL_INSTANCES_FAILED';
  error.cause = lastError;
  throw error;
}

async function runCobaltToMp4({ youtubeUrl, outputMp4Path }) {
  safeLog.info('[YouTube][cobalt] iniciando fallback Cobalt MP4');

  const payload = buildVideoPayload(youtubeUrl);
  let lastError;

  for (const baseUrl of COBALT_API_INSTANCES) {
    try {
      safeLog.info('[YouTube][cobalt-mp4] tentando instância', { instance: baseUrl });
      const { streamUrl, filename } = await tryCobaltInstance(baseUrl, payload);
      safeLog.info('[YouTube][cobalt-mp4] stream resolvido, baixando MP4', {
        instance: baseUrl,
        filenameProvided: Boolean(filename)
      });

      await downloadHttpToFile(streamUrl, outputMp4Path);

      if (fs.existsSync(outputMp4Path)) {
        return {
          title: filename ? String(filename).replace(/\.[^.]+$/, '') : '',
          source: `cobalt:${baseUrl}`
        };
      }

      throw new Error('Arquivo MP4 não gerado.');
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube][cobalt-mp4] instância falhou', {
        instance: baseUrl,
        message: err?.message
      });
    }
  }

  const error = new Error('Todas as instâncias Cobalt falharam.');
  error.code = 'COBALT_ALL_INSTANCES_FAILED';
  error.cause = lastError;
  throw error;
}

module.exports = {
  runCobaltToMp3,
  runCobaltToMp4,
  _private: {
    COBALT_API_INSTANCES,
    buildCobaltEndpoint,
    buildLegacyEndpoint,
    buildAudioPayload,
    buildVideoPayload,
    pickCobaltStreamUrl
  }
};
