process.env.YTDL_NO_UPDATE = process.env.YTDL_NO_UPDATE || '1';
require('dotenv').config();

const cron = require('node-cron');
const { createApp } = require('./app');
const { supabaseAdmin } = require('./config/supabaseAdmin');
const { safeLog } = require('./utils/safeLog');

const app = createApp();

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

  app.listen(port, () => {
    const mode = process.env.NODE_ENV === 'production' ? 'PRODUÇÃO (Nuvem)' : 'DESENVOLVIMENTO (Local)';
    safeLog('log', `[Backend] Rodando em modo: ${mode}`);
    safeLog('log', `[Backend] API disponível na porta: ${port}`);
  });
}

module.exports = { app, performCleanup };

