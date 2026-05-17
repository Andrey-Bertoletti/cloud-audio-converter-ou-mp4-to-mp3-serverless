/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runYtDlpToMp4 } = require('../server/youtube/ytDlpFallback');
const { runYoutubeiToMp4 } = require('../server/youtube/youtubeiFallback');
const { runCobaltToMp4 } = require('../server/youtube/cobaltFallback');
const { runPipedToMp4 } = require('../server/youtube/pipedFallback');

const VIDEO_URL = process.argv[2] || 'https://youtu.be/KlKKYMQOXr4';
const OUTPUT_PATH = path.join(__dirname, '..', `test-output-${Date.now()}.mp4`);

function header(label) {
  console.log('\n' + '='.repeat(60));
  console.log('  ' + label);
  console.log('='.repeat(60));
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

async function tryYtDlp() {
  header('1) yt-dlp MP4');
  await runYtDlpToMp4({
    youtubeUrl: VIDEO_URL,
    outputMp4Path: OUTPUT_PATH,
    rawCookieInput: '',
    cookieHeader: '',
    proxyUrl: undefined
  });
  return { source: 'yt-dlp', title: '' };
}

async function tryYoutubei() {
  header('2) youtubei.js MP4');
  return await runYoutubeiToMp4({ youtubeUrl: VIDEO_URL, outputMp4Path: OUTPUT_PATH });
}

async function tryCobalt() {
  header('3) Cobalt MP4');
  return await runCobaltToMp4({ youtubeUrl: VIDEO_URL, outputMp4Path: OUTPUT_PATH });
}

async function tryPiped() {
  header('4) Piped/Invidious MP4');
  return await runPipedToMp4({ youtubeUrl: VIDEO_URL, outputMp4Path: OUTPUT_PATH });
}

(async () => {
  console.log('URL:', VIDEO_URL);
  console.log('Output:', OUTPUT_PATH);

  const attempts = [tryYtDlp, tryYoutubei, tryCobalt, tryPiped];

  for (const attempt of attempts) {
    try {
      if (fs.existsSync(OUTPUT_PATH)) fs.unlinkSync(OUTPUT_PATH);
      const result = await attempt();
      const size = fileSize(OUTPUT_PATH);

      if (size < 1024) {
        throw new Error(`Arquivo gerado é muito pequeno (${size} bytes).`);
      }

      console.log('\nSUCESSO via', result.source);
      console.log('  Tamanho:', (size / 1024 / 1024).toFixed(2), 'MB');
      console.log('  Arquivo:', OUTPUT_PATH);
      process.exit(0);
    } catch (err) {
      console.log('FALHOU:', err?.code || '-', '-', String(err?.message || err).slice(0, 200));
    }
  }

  console.log('\nTodos os fallbacks falharam.');
  process.exit(1);
})().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
