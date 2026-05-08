require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { supabaseAdmin } = require('./config/supabaseAdmin');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

app.get('/health', (_, res) => {
  res.status(200).json({ ok: true });
});

app.post('/api/conversoes', async (req, res) => {
  try {
    const { nomeArquivo, storagePath } = req.body;

    if (!nomeArquivo) {
      return res.status(400).json({ error: 'nomeArquivo é obrigatório.' });
    }

    const { error } = await supabaseAdmin.from('conversoes').insert({
      nome_arquivo: nomeArquivo,
      storage_path: storagePath ?? null
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Erro inesperado.'
    });
  }
});

app.get('/api/conversoes', async (_, res) => {
  const { data, error } = await supabaseAdmin
    .from('conversoes')
    .select('id, nome_arquivo, criado_em')
    .order('criado_em', { ascending: false })
    .limit(5);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json(data ?? []);
});

app.listen(port, () => {
  console.log(`API disponível em http://localhost:${port}`);
});
