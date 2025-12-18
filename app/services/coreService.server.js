import { supabase } from "@/app/supabase.server";

export const coreService = {
    createOrder: async (payload) => {
        return await supabase.from("orders").insert(payload);
    }
}