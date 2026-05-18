const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !supabaseServiceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY'
  ]
    .filter(Boolean)
    .join(', ');

  console.error(
    '[Backend] Variáveis de ambiente obrigatórias ausentes: ' +
      missing +
      '. No Hugging Face Spaces defina em Settings → Variables and secrets ' +
      '(use "Secret" para SUPABASE_SERVICE_ROLE_KEY, nunca "Variable").'
  );
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

module.exports = { supabaseAdmin };
