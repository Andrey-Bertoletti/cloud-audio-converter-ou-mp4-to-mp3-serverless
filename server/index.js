process.env.YTDL_NO_UPDATE = process.env.YTDL_NO_UPDATE || '1';
require('dotenv').config();

const cron = require('node-cron');
const { createApp } = require('./app');
const { supabaseAdmin } = require('./config/supabaseAdmin');
const { safeLog } = require('./utils/safeLog');
const { checkYtDlpAndFfmpegAvailability } = require('./youtube/ytDlpFallback');

const app = createApp();

function getYtDlpFallbackConfig() {
  const raw = String(process.env.ENABLE_YTDLP_FALLBACK ?? '')
    .trim()
    .toLowerCase();

  if (!raw) return { enabled: true, required: false };

  if (['0', 'false', 'no', 'off'].includes(raw)) return { enabled: false, required: false };
  if (['required', 'strict', 'force', 'mandatory'].includes(raw)) return { enabled: true, required: true };
  if (['1', 'true', 'yes', 'on'].includes(raw)) return { enabled: true, required: false };

  return { enabled: true, required: false };
}

async function logMediaToolingHealth() {
  const status = await checkYtDlpAndFfmpegAvailability();
  const fallbackCfg = getYtDlpFallbackConfig();

  if (status.ok) {
    safeLog('log', `[Backend] yt-dlp disponível: ${status.ytDlpVersion}`);
    safeLog('log', `[Backend] ffmpeg disponível: ${status.ffmpegVersion}`);
    return { status, fallbackCfg, shouldAbortStartup: false };
  }

  const meta = {
    ytDlpVersion: status.ytDlpVersion || null,
    ffmpegVersion: status.ffmpegVersion || null
  };

  if (fallbackCfg.enabled && !status.ytDlpVersion) {
    if (fallbackCfg.required) {
      safeLog(
        'error',
        '[Backend] ENABLE_YTDLP_FALLBACK=required, mas yt-dlp não foi encontrado. Abortando startup.',
        meta
      );
      const err = new Error('yt-dlp is required but not available');
      err.code = 'YTDLP_NOT_AVAILABLE';
      throw err;
    }

    safeLog('warn', '[Backend] ENABLE_YTDLP_FALLBACK=true, mas yt-dlp não foi encontrado. O fallback ficará inoperante.', meta);
    return { status, fallbackCfg, shouldAbortStartup: false };
  }

  safeLog('warn', '[Backend] yt-dlp/ffmpeg não estão disponíveis. O fallback pode falhar.', meta);
  return { status, fallbackCfg, shouldAbortStartup: false };
}

async function performCleanup() {
  safeLog('log', '[Cleanup] Iniciando limpeza de arquivos com mais de 24 horas...');
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: expired, error: fetchError } = await supabaseAdmin
      .from('conversoes')
      .select('id, storage_path')
      .lt('criado_em', yesterday);

    if (fetchError) throw fetchError;
    if (!expired || expired.length === 0) {
      safeLog('log', '[Cleanup] Nenhum arquivo expirado para remover.');
      return;
    }

    safeLog('log', `[Cleanup] Encontrados ${expired.length} registros para remover.`);

    const pathsToRemove = expired
      .filter((row) => row.storage_path)
      .map((row) => row.storage_path);

    if (pathsToRemove.length > 0) {
      const { error: storageError } = await supabaseAdmin.storage.from('converted-audio').remove(pathsToRemove);
      if (storageError) safeLog('error', '[Cleanup] Erro ao remover do storage:', storageError);
      else safeLog('log', `[Cleanup] ${pathsToRemove.length} arquivos removidos do Storage.`);
    }

    const idsToRemove = expired.map((row) => row.id);
    const { error: dbError } = await supabaseAdmin.from('conversoes').delete().in('id', idsToRemove);

    if (dbError) throw dbError;
    safeLog('log', '[Cleanup] Registros removidos do banco de dados com sucesso.');
  } catch (err) {
    safeLog('error', '[Cleanup] Falha na limpeza:', err);
  }
}

if (process.env.DISABLE_CLEANUP_CRON !== '1') {
  cron.schedule('0 * * * *', performCleanup);
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);

  (async () => {
    await logMediaToolingHealth();

    app.listen(port, () => {
      const mode = process.env.NODE_ENV === 'production' ? 'PRODUÇÃO (Nuvem)' : 'DESENVOLVIMENTO (Local)';
      safeLog('log', `[Backend] Rodando em modo: ${mode}`);
      safeLog('log', `[Backend] API disponível na porta: ${port}`);
    });
  })().catch((err) => {
    safeLog('error', '[Backend] Falha no startup.', {
      name: err?.name,
      code: err?.code,
      message: err?.message
    });
    process.exit(1);
  });
}

module.exports = { app, performCleanup, logMediaToolingHealth, getYtDlpFallbackConfig };
