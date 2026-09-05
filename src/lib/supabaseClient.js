import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Doesn't throw — lets the app still render locally with a clear console
  // warning rather than a blank white screen, since a missing .env file is
  // the single most common setup mistake.
  console.warn(
    "[SharedClassrooms] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Copy .env.example to .env, fill in your Supabase project's URL and anon key, and restart the dev server."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
