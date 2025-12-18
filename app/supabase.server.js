// app/supabase.server.js
import { createClient } from '@supabase/supabase-js';

// Vite environment variables
export const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY // Must use Service Role for backend writes
);