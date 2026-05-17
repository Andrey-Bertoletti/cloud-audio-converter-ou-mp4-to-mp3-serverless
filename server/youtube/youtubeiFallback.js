const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Readable } = require('stream');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const { safeLog } = require('../utils/safeLog');

ffmpeg.setFfmpegPath(ffmpegPath);

const DOWNLOAD_TIMEOUT_MS = 120_000;

// Clients que costumam funcionar sem PO Token, em ordem de preferência.
// MWEB e ANDROID frequentemente entregam streams sem desafio anti-bot.
const INNERTUBE_CLIENTS = ['IOS', 'ANDROID', 'MWEB', 'TV_EMBEDDED', 'WEB_EMBEDDED'];

const ANDROID_UA = 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip';

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
  } catch {
    // ignore
  }
  return '';
}

let evaluatorInstalled = false;

async function installJsEvaluator() {
  if (evaluatorInstalled) return;
  try {
    const path = require('path');
    const { pathToFileURL } = require('url');
    const utilsPath = path.join(
      __dirname,
      '..',
      '..',
      'node_modules',
      'youtubei.js',
      'dist',
      'src',
      'utils',
      'Utils.js'
    );
    const utils = await import(pathToFileURL(utilsPath).href);
    const platform = utils?.Platform?.shim;
    if (platform && typeof platform.eval === 'function') {
      platform.eval = async (data /*, env */) => {
        // O script termina com `return process(...)` — válido apenas dentro de
        // uma função. Embrulhamos com new Function para executar.
        const script = String(data?.output || '');
        const fn = new Function(script);
        return fn();
      };
      evaluatorInstalled = true;
      safeLog.info('[YouTube][youtubei] avaliador JS instalado (Function-based)');
    }
  } catch (err) {
    safeLog.warn('[YouTube][youtubei] falha ao instalar avaliador JS', { message: err?.message });
  }
}

async function createInnertube({ cookie } = {}) {
  const mod = await import('youtubei.js');
  const Innertube = mod.Innertube || mod.default?.Innertube || mod.default;

  const options = {
    generate_session_locally: true,
    retrieve_player: true
  };

  if (cookie) options.cookie = cookie;

  const yt = await Innertube.create(options);
  await installJsEvaluator();
  return yt;
}

function extractFormats(info) {
  return (
    info?.streaming_data?.adaptive_formats ||
    info?.streamingData?.adaptiveFormats ||
    info?.streaming_data?.formats ||
    info?.streamingData?.formats ||
    []
  );
}

function pickBestAudioFormat(info) {
  const formats = extractFormats(info);
  const audios = formats.filter((f) => {
    const mime = String(f.mime_type || f.mimeType || '').toLowerCase();
    return mime.startsWith('audio/');
  });

  if (!audios.length) return null;
  audios.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  return audios[0];
}

function pickBestProgressiveMp4(info, { maxHeight = 1080 } = {}) {
  const formats = info?.streaming_data?.formats || info?.streamingData?.formats || [];
  const progressive = formats
    .filter((f) => {
      const mime = String(f.mime_type || f.mimeType || '').toLowerCase();
      return mime.startsWith('video/mp4') && (Number(f.height) || 0) <= maxHeight;
    })
    .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

  return progressive[0] || null;
}

function pickAdaptiveMp4(info, { maxHeight = 1080 } = {}) {
  const adaptive = info?.streaming_data?.adaptive_formats || info?.streamingData?.adaptiveFormats || [];

  const videoOnly = adaptive
    .filter((f) => {
      const mime = String(f.mime_type || f.mimeType || '').toLowerCase();
      return mime.startsWith('video/mp4') && (Number(f.height) || 0) <= maxHeight;
    })
    .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

  const audio = pickBestAudioFormat(info);
  if (videoOnly.length && audio) return { video: videoOnly[0], audio };
  return null;
}

function getFormatUrl(format) {
  if (!format) return '';
  return format.url || format.decipher_url || format.signed_url || '';
}

async function getInfoForClient(yt, videoId, client) {
  return yt.getBasicInfo(videoId, client);
}

function downloadHttpToFile(streamUrl, outputPath, { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxRedirects = 5, userAgent = ANDROID_UA } = {}) {
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
          'User-Agent': userAgent,
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
          downloadHttpToFile(next, outputPath, { timeoutMs, maxRedirects: maxRedirects - 1, userAgent }).then(resolve, reject);
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
            if (bytes === 0) reject(new Error('Downloaded file is empty'));
            else resolve(true);
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

function transcodeUrlToMp3(streamUrl, outputMp3Path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const watchdog = setTimeout(() => finish(new Error('Timeout MP3 (transcode).')), DOWNLOAD_TIMEOUT_MS);
    watchdog.unref?.();

    ffmpeg(streamUrl)
      .inputOptions([
        '-user_agent', ANDROID_UA,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
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
  });
}

function remuxUrlToMp4(streamUrl, outputMp4Path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const watchdog = setTimeout(() => finish(new Error('Timeout MP4 (remux).')), DOWNLOAD_TIMEOUT_MS);
    watchdog.unref?.();

    ffmpeg(streamUrl)
      .inputOptions([
        '-user_agent', ANDROID_UA,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
      ])
      .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
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
  });
}

function muxVideoAudioToMp4(videoUrl, audioUrl, outputMp4Path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const watchdog = setTimeout(() => finish(new Error('Timeout MP4 (mux).')), DOWNLOAD_TIMEOUT_MS);
    watchdog.unref?.();

    ffmpeg()
      .input(videoUrl)
      .inputOptions([
        '-user_agent', ANDROID_UA,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
      ])
      .input(audioUrl)
      .inputOptions([
        '-user_agent', ANDROID_UA,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
      ])
      .outputOptions(['-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-movflags', '+faststart'])
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
  });
}

async function downloadAudioViaInnertube(yt, videoId, client, outputMp3Path) {
  let webStream;
  try {
    webStream = await yt.download(videoId, {
      type: 'audio',
      quality: 'best',
      format: 'mp4',
      client
    });
  } catch (err) {
    err.code = err.code || 'YOUTUBEI_DOWNLOAD_INIT_FAILED';
    throw err;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    let nodeStream;
    try {
      nodeStream = typeof webStream.getReader === 'function' ? Readable.fromWeb(webStream) : webStream;
    } catch (err) {
      finish(err);
      return;
    }

    nodeStream.on('error', (err) => finish(err));

    const watchdog = setTimeout(() => finish(new Error('Timeout MP3 (innertube stream).')), DOWNLOAD_TIMEOUT_MS);
    watchdog.unref?.();

    ffmpeg(nodeStream)
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
  });
}

async function runYoutubeiToMp3({ youtubeUrl, outputMp3Path, cookie }) {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    const err = new Error('Não foi possível extrair o ID do vídeo do YouTube.');
    err.code = 'YOUTUBEI_INVALID_URL';
    throw err;
  }

  safeLog.info('[YouTube][youtubei] iniciando fallback InnerTube MP3', { videoId, hasCookie: Boolean(cookie) });

  let yt;
  try {
    yt = await createInnertube({ cookie });
  } catch (err) {
    err.code = err.code || 'YOUTUBEI_INIT_FAILED';
    throw err;
  }

  let lastError;
  let title = '';

  for (const client of INNERTUBE_CLIENTS) {
    let info;
    try {
      safeLog.info('[YouTube][youtubei] tentando client', { client });
      info = await getInfoForClient(yt, videoId, client);
      title = info?.basic_info?.title || title;
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube][youtubei] getBasicInfo falhou', { client, message: err?.message });
      continue;
    }

    const audioFormat = pickBestAudioFormat(info);
    if (!audioFormat) {
      lastError = new Error('Sem formato de áudio disponível.');
      safeLog.warn('[YouTube][youtubei] sem formato áudio para client', { client });
      continue;
    }

    const directUrl = getFormatUrl(audioFormat);

    if (directUrl) {
      try {
        await transcodeUrlToMp3(directUrl, outputMp3Path);

        if (fs.existsSync(outputMp3Path) && fs.statSync(outputMp3Path).size > 0) {
          safeLog.info('[YouTube][youtubei] sucesso via URL direta', { client });
          return { title, source: `youtubei:${client.toLowerCase()}` };
        }
      } catch (err) {
        lastError = err;
        safeLog.warn('[YouTube][youtubei] URL direta falhou no ffmpeg', { client, message: err?.message });
      }
    }

    try {
      await downloadAudioViaInnertube(yt, videoId, client, outputMp3Path);

      if (fs.existsSync(outputMp3Path) && fs.statSync(outputMp3Path).size > 0) {
        safeLog.info('[YouTube][youtubei] sucesso via download()', { client });
        return { title, source: `youtubei:${client.toLowerCase()}` };
      }

      lastError = new Error('Arquivo MP3 vazio gerado pelo InnerTube.');
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube][youtubei] download() falhou', { client, message: err?.message });
    }
  }

  const error = new Error('Todos os clients InnerTube falharam.');
  error.code = 'YOUTUBEI_ALL_CLIENTS_FAILED';
  error.cause = lastError;
  throw error;
}

async function runYoutubeiToMp4({ youtubeUrl, outputMp4Path, cookie }) {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    const err = new Error('Não foi possível extrair o ID do vídeo do YouTube.');
    err.code = 'YOUTUBEI_INVALID_URL';
    throw err;
  }

  safeLog.info('[YouTube][youtubei] iniciando fallback InnerTube MP4', { videoId, hasCookie: Boolean(cookie) });

  let yt;
  try {
    yt = await createInnertube({ cookie });
  } catch (err) {
    err.code = err.code || 'YOUTUBEI_INIT_FAILED';
    throw err;
  }

  let lastError;
  let title = '';

  for (const client of INNERTUBE_CLIENTS) {
    let info;
    try {
      safeLog.info('[YouTube][youtubei-mp4] tentando client', { client });
      info = await getInfoForClient(yt, videoId, client);
      title = info?.basic_info?.title || title;
    } catch (err) {
      lastError = err;
      safeLog.warn('[YouTube][youtubei-mp4] getBasicInfo falhou', { client, message: err?.message });
      continue;
    }

    const progressive = pickBestProgressiveMp4(info, { maxHeight: 1080 });
    if (progressive) {
      const url = getFormatUrl(progressive);
      if (url) {
        try {
          await remuxUrlToMp4(url, outputMp4Path);
          if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 0) {
            safeLog.info('[YouTube][youtubei-mp4] sucesso via progressive', { client });
            return { title, source: `youtubei:${client.toLowerCase()}` };
          }
        } catch (err) {
          lastError = err;
          safeLog.warn('[YouTube][youtubei-mp4] progressivo falhou', { client, message: err?.message });
        }
      }
    }

    const adaptive = pickAdaptiveMp4(info, { maxHeight: 1080 });
    if (adaptive) {
      const videoUrl = getFormatUrl(adaptive.video);
      const audioUrl = getFormatUrl(adaptive.audio);

      if (videoUrl && audioUrl) {
        try {
          await muxVideoAudioToMp4(videoUrl, audioUrl, outputMp4Path);
          if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 0) {
            safeLog.info('[YouTube][youtubei-mp4] sucesso via mux', { client });
            return { title, source: `youtubei:${client.toLowerCase()}` };
          }
        } catch (err) {
          lastError = err;
          safeLog.warn('[YouTube][youtubei-mp4] mux falhou', { client, message: err?.message });
        }
      }
    }
  }

  const error = new Error('Todos os clients InnerTube falharam (MP4).');
  error.code = 'YOUTUBEI_ALL_CLIENTS_FAILED';
  error.cause = lastError;
  throw error;
}

module.exports = {
  runYoutubeiToMp3,
  runYoutubeiToMp4,
  _private: {
    INNERTUBE_CLIENTS,
    extractVideoId,
    pickBestAudioFormat,
    pickBestProgressiveMp4,
    pickAdaptiveMp4,
    downloadHttpToFile
  }
};
