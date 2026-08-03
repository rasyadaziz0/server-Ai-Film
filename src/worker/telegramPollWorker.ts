import { getServiceSupabase } from "../lib/supabase";
import { decrypt } from "../lib/crypto";
import { TelegramBot } from "../lib/telegram/TelegramBot";
import { TelegramHandler } from "../lib/telegram/TelegramHandler";

// Track last update_id per studio to avoid processing the same message twice
const lastUpdateIds = new Map<string, number>();

async function pollBot(studio: any, supabase: any) {
  try {
    const decryptedToken = decrypt(
      studio.encrypted_bot_token,
      studio.iv,
      studio.auth_tag,
      studio.key_version
    );

    const bot = new TelegramBot({
      encrypted_bot_token: studio.encrypted_bot_token,
      iv: studio.iv,
      auth_tag: studio.auth_tag,
      key_version: studio.key_version,
    });

    const handler = new TelegramHandler(bot, supabase, studio);

    // ECS is in China — route through Cloudflare proxy
    const telegramApi = "https://www.acadlabs.fun/api/telegram-proxy";
    const relaySecret = "afs-relay-2026-xK9mP";
    await fetch(`${telegramApi}/bot${decryptedToken}/deleteWebhook`, {
      headers: { "x-relay-secret": relaySecret }
    });

    let offset = lastUpdateIds.get(studio.id) || 0;

    const res = await fetch(`${telegramApi}/bot${decryptedToken}/getUpdates?offset=${offset}&timeout=5`, {
      headers: { "x-relay-secret": relaySecret }
    });
    if (!res.ok) return;

    const data = await res.json();
    if (!data.ok || !data.result || data.result.length === 0) return;

    for (const update of data.result) {
      const updateId = update.update_id;
      if (updateId >= offset) {
        offset = updateId + 1;
        lastUpdateIds.set(studio.id, offset);
      }

      // Process Message
      if (update.message && update.message.text) {
        const text = update.message.text.trim();
        const chatId = update.message.chat.id.toString();
        
        console.log(`[Telegram Poll] Received message: ${text} for studio ${studio.id}`);

        if (text === "/start") {
          await handler.handleStart(chatId);
        } else if (text === "/status") {
          await handler.handleStatus(chatId);
        } else if (text.startsWith("/duration")) {
          const arg = text.split(" ")[1];
          await handler.handleDuration(chatId, arg);
        } else if (text.startsWith("/lang")) {
          const arg = text.split(" ")[1];
          await handler.handleLang(chatId, arg);
        } else if (text.startsWith("/")) {
          await handler.handleUnknownCommand(chatId);
        } else {
          // Normal message -> Create Job
          await supabase.from("jobs").insert({
            studio_id: studio.id,
            source: "telegram",
            input: text,
            chat_id: chatId,
            status: "pending",
          });
          await bot.sendMessage(chatId, `🎬 *Script and video generation started!*\n\n_Your prompt:_ ${text}\n\nType /status to check progress.`, { parseMode: "Markdown" });
        }
      }
      
      // Process Callback Query
      if (update.callback_query) {
        const cb = update.callback_query;
        const cbData = cb.data;
        const cbId = cb.id;
        const chatId = cb.message?.chat.id.toString();
        
        if (chatId && cbData) {
          console.log(`[Telegram Poll] Received callback: ${cbData} for studio ${studio.id}`);
          await handler.handleCallback(chatId, cbData, cbId);
        }
      }
    }
  } catch (error: any) {
    console.error(`[Telegram Poll] Error for studio ${studio.id}:`, error.message);
  }
}

export function startTelegramPollWorker() {
  console.log("[Telegram Poll Worker] Starting long polling...");
  const supabase = getServiceSupabase();
  
  // We use an async IIFE to run the loop without blocking
  (async () => {
    while (true) {
      try {
        const { data: studios } = await supabase
          .from("studios")
          .select("id, user_id, video_duration, telegram_mode");

        if (!studios || studios.length === 0) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        // Only poll for studios that have full_telegram enabled
        const activeStudios = studios.filter((s: any) => s.telegram_mode === "full_telegram");
        
        if (activeStudios.length === 0) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
        }
        
        // Fetch secrets for active studios
        const { data: secrets } = await supabase
          .from("studio_secrets")
          .select("studio_id, encrypted_bot_token, iv, auth_tag, key_version")
          .in("studio_id", activeStudios.map((s: any) => s.id));
          
        if (!secrets || secrets.length === 0) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
        }

        const validStudios = activeStudios.map((s: any) => {
            const secret = secrets.find((sec: any) => sec.studio_id === s.id);
            if (!secret) return null;
            return { ...s, ...secret };
        }).filter(Boolean);

        // Fetch concurrently
        await Promise.all(validStudios.map(s => pollBot(s, supabase)));
      } catch (e: any) {
        console.error("[Telegram Poll Worker] Main loop error:", e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
      
      // Small delay to prevent tight loops
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}
