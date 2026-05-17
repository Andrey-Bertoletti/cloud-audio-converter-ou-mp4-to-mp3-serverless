/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const INPUT = process.argv[2] || path.join(__dirname, '..', 'test-local-MEDLEY - É ELE + UMA VEZ + CRISTO - MORADA.webm');
const OUTPUT = path.join(__dirname, '..', `test-local-output-${Date.now()}.mp3`);

if (!fs.existsSync(INPUT)) {
  console.error('Arquivo de entrada não encontrado:', INPUT);
  process.exit(1);
}

console.log('Input :', INPUT, '(', (fs.statSync(INPUT).size / 1024 / 1024).toFixed(2), 'MB )');
console.log('Output:', OUTPUT);

const started = Date.now();

ffmpeg(INPUT)
  .noVideo()
  .audioCodec('libmp3lame')
  .audioBitrate(192)
  .audioChannels(2)
  .audioFrequency(44100)
  .format('mp3')
  .on('start', (cmd) => console.log('\nffmpeg cmd:', cmd, '\n'))
  .on('progress', (p) => {
    if (p.timemark) process.stdout.write(`  progresso: ${p.timemark}\r`);
  })
  .on('error', (err) => {
    console.error('\nErro ffmpeg:', err.message);
    process.exit(1);
  })
  .on('end', () => {
    const ms = Date.now() - started;
    const size = fs.statSync(OUTPUT).size;
    console.log('\nConversão concluída em', (ms / 1000).toFixed(1), 's');
    console.log('Tamanho:', (size / 1024 / 1024).toFixed(2), 'MB');

    ffmpeg.ffprobe(OUTPUT, (e, data) => {
      if (e) {
        console.log('(ffprobe falhou:', e.message, ')');
        process.exit(0);
      }
      const s = data.streams?.[0] || {};
      const f = data.format || {};
      console.log('Probe :', f.format_name, '|', Number(f.duration || 0).toFixed(1) + 's',
        '|', Math.round((f.bit_rate || 0) / 1000) + 'kbps',
        '|', s.codec_name, '|', s.sample_rate + 'Hz');
      process.exit(0);
    });
  })
  .save(OUTPUT);
