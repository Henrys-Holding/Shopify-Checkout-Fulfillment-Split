import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const supabase = createClient(
  requireEnv("VITE_SUPABASE_URL"),
  requireEnv("VITE_SUPABASE_SERVICE_ROLE_KEY")
);
