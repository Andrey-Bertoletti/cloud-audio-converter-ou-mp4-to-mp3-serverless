/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const os = require('os');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ytdl = require('@distube/ytdl-core');

const { runCobaltToMp3 } = require('../server/youtube/cobaltFallback');
const { runPipedToMp3 } = require('../server/youtube/pipedFallback');
const { runYtDlpToMp3 } = require('../server/youtube/ytDlpFallback');
const { runYoutubeiToMp3 } = require('../server/youtube/youtubeiFallback');

ffmpeg.setFfmpegPath(ffmpegPath);

const VIDEO_URL = process.argv[2] || 'https://youtu.be/KlKKYMQOXr4';
const OUTPUT_PATH = path.join(__dirname, '..', `test-output-${Date.now()}.mp3`);

function header(label) {
  console.log('\n' + '═'.repeat(60));
  console.log('  ' + label);
  console.log('═'.repeat(60));
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

async function tryYtdlCore() {
  header('1) ytdl-core');
  const agent = ytdl.createAgent([]);
  const info = await ytdl.getInfo(VIDEO_URL, {
    agent,
    playerClients: ['WEB_EMBEDDED'],
    requestOptions: {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    }
  });
  console.log('• Título:', info.videoDetails.title);

  await new Promise((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, {
      agent,
      quality: 'highestaudio',
      filter: 'audioonly',
      highWaterMark: 1 << 25
    });

    ffmpeg(stream)
      .toFormat('mp3')
      .audioBitrate(192)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(OUTPUT_PATH);
  });

  return { source: 'ytdl-core', title: info.videoDetails.title };
}

async function tryYtDlp() {
  header('2) yt-dlp (local)');
  await runYtDlpToMp3({
    youtubeUrl: VIDEO_URL,
    outputMp3Path: OUTPUT_PATH,
    rawCookieInput: '',
    cookieHeader: '',
    proxyUrl: undefined
  });
  return { source: 'yt-dlp', title: '' };
}

async function tryYoutubei() {
  header('3) youtubei.js (InnerTube)');
  const result = await runYoutubeiToMp3({ youtubeUrl: VIDEO_URL, outputMp3Path: OUTPUT_PATH });
  return { source: result.source, title: result.title };
}

async function tryCobalt() {
  header('4) Cobalt');
  const result = await runCobaltToMp3({ youtubeUrl: VIDEO_URL, outputMp3Path: OUTPUT_PATH });
  return { source: result.source, title: result.title };
}

async function tryPiped() {
  header('5) Piped/Invidious');
  const result = await runPipedToMp3({ youtubeUrl: VIDEO_URL, outputMp3Path: OUTPUT_PATH });
  return { source: result.source, title: result.title };
}

(async () => {
  console.log('▶ URL:', VIDEO_URL);
  console.log('▶ Output:', OUTPUT_PATH);

  const attempts = [tryYtdlCore, tryYtDlp, tryYoutubei, tryCobalt, tryPiped];

  for (const attempt of attempts) {
    try {
      if (fs.existsSync(OUTPUT_PATH)) fs.unlinkSync(OUTPUT_PATH);

      const result = await attempt();
      const size = fileSize(OUTPUT_PATH);

      console.log('\n✅ SUCESSO via', result.source);
      console.log('   Tamanho do arquivo:', (size / 1024).toFixed(1), 'KB');
      console.log('   Arquivo:', OUTPUT_PATH);
      process.exit(0);
    } catch (err) {
      console.log('❌ Falhou:', err?.code || '-', '-', String(err?.message || err).slice(0, 200));
    }
  }

  console.log('\n❌ Todos os fallbacks falharam.');
  process.exit(1);
})().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
