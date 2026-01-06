// app/supabase.server.js
import { createClient } from '@supabase/supabase-js';

// Vite environment variables
export const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // Must use Service Role for backend writes
);