import { TelegramBot } from "./TelegramBot";
import { LANGUAGES, DURATIONS, NODE_EMOJI } from "./constants";

const escapeMd = (t: string) => t.replace(/([_*`\[])/g, "\\$1");

/**
 * TelegramHandler — semua logika bisnis untuk menangani
 * command (teks) dan callback query (klik tombol) dari user.
 */
export class TelegramHandler {
  constructor(
    private bot: TelegramBot,
    private supabase: any,
    private studio: { id: string; user_id: string; video_duration: number | null }
  ) {}

  // ═══════════════════════════════════════════════════════════════
  //  TEXT COMMANDS
  // ═══════════════════════════════════════════════════════════════

  async handleStart(chatId: string): Promise<void> {
    await this.bot.sendMessage(
      chatId,
      "🎬 *Welcome to AI Film Studio!*\n\n" +
        "Type any story idea or prompt here, and our system will automatically generate the script and video for you.\n\n" +
        "Example: _Make a video about a T-Rex playing piano on the moon_\n\n" +
        "*Command:*\n" +
        "/status — Check pipeline & active nodes status\n" +
        "/duration — Change video duration\n" +
        "/lang — Change output language",
      { parseMode: "Markdown" }
    );
  }

  async handleStatus(chatId: string): Promise<void> {
    const { data: lastJob } = await this.supabase
      .from("jobs")
      .select("status, result_url, error, created_at")
      .eq("studio_id", this.studio.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: allNodes } = await this.supabase
      .from("nodes")
      .select("type, label, status")
      .eq("studio_id", this.studio.id)
      .order("position_y", { ascending: true });

    let msg = "📊 *Studio Render Status*\n━━━━━━━━━━━━━━━━━━━━\n\n";

    if (!lastJob) {
      msg += "No render jobs have been started in this studio yet.\n";
    } else {
      const jobStatusMap: Record<string, string> = {
        done: "✅ *Completed (Success)*",
        error: "❌ *Failed*",
        running: "⏳ *Running (Processing)*",
        pending: "⏱️ *Pending (Queued)*",
        polling: "🔄 *Applying (Polling)*"
      };
      
      msg += `📋 *Status Pipeline:* ${jobStatusMap[lastJob.status] || lastJob.status}\n`;
      if (lastJob.status === "error") {
        msg += `*Error Detail:* _${escapeMd(lastJob.error || "Unknown error")}_\n`;
      } else if (lastJob.status === "done" && lastJob.result_url) {
        msg += `🎬 [View Rendered Video](${lastJob.result_url})\n`;
      }
    }

    if (allNodes && allNodes.length > 0) {
      msg += "\n⚙️ *AI Process Details (Nodes):*\n";
      
      const PRETTY_TYPES: Record<string, string> = {
        producer: "Ideation",
        writer: "Scripting",
        reviewer: "Review",
        actor: "Character",
        tts: "Voice-over",
        video: "Renderer",
        telegram: "Delivery",
        telegram_trigger: "Trigger",
        cloud: "Storage",
        input: "Prompt",
      };

      for (const node of allNodes) {
        const icon = this.statusIcon(node.status);
        const typeName = PRETTY_TYPES[node.type] || node.type;
        
        let name = node.label || node.type;
        if (name.startsWith("New ")) name = name.replace("New ", "");
        if (name.length > 25) name = name.substring(0, 22) + "...";
        
        msg += `${icon} *${typeName}:* _${escapeMd(name)}_\n`;
      }

      const doneCount = allNodes.filter((n: any) => n.status === "done").length;
      const totalCount = allNodes.length;
      
      let progressStr = "░░░░░░░░░░";
      if (totalCount > 0) {
        const percent = Math.round((doneCount / totalCount) * 10);
        progressStr = "█".repeat(percent) + "░".repeat(10 - percent);
      }
      msg += `\n📈 *Progress:* \`${progressStr}\` (${doneCount}/${totalCount})\n`;
    }

    await this.bot.sendMessage(chatId, msg, { parseMode: "Markdown", disablePreview: true });
  }

  async handleDuration(chatId: string, arg?: string): Promise<void> {
    if (arg) {
      // Backward compatible: /duration 15
      const secs = parseInt(arg);
      if ((DURATIONS as readonly number[]).includes(secs)) {
        await this.supabase.from("studios").update({ video_duration: secs }).eq("id", this.studio.id);
        await this.bot.sendMessage(chatId, `✅ Video duration successfully changed to *${secs} seconds*.`, { parseMode: "Markdown" });
      } else {
        await this.bot.sendMessage(chatId, `⚠️ Available durations: 5, 15, or 30 seconds.`);
      }
      return;
    }

    // No argument → send inline keyboard
    const currentDuration = this.studio.video_duration || 5;
    await this.bot.sendMessage(
      chatId,
      `🎬 *Choose Video Duration:*\n\nCurrent duration: *${currentDuration} seconds*`,
      {
        parseMode: "Markdown",
        replyMarkup: {
          inline_keyboard: [
            DURATIONS.map(d => ({
              text: `${d === currentDuration ? "✅ " : ""}${d}s`,
              callback_data: `duration:${d}`,
            })),
          ],
        }
      }
    );
  }

  async handleLang(chatId: string, arg?: string): Promise<void> {
    if (arg) {
      // Backward compatible: /lang en
      const langInfo = LANGUAGES.find(l => l.code === arg);
      if (langInfo) {
        await this.supabase.from("studios").update({ language: arg }).eq("id", this.studio.id);
        await this.bot.sendMessage(chatId, `✅ Language successfully changed to: ${langInfo.label} (*${arg.toUpperCase()}*)`, { parseMode: "Markdown" });
      } else {
        await this.bot.sendMessage(chatId, `⚠️ Language "${arg}" is not recognized. Type /lang to see options.`);
      }
      return;
    }

    // No argument → send inline keyboard (2 per row)
    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < LANGUAGES.length; i += 2) {
      const row = LANGUAGES.slice(i, i + 2).map(l => ({
        text: l.label,
        callback_data: `lang:${l.code}`,
      }));
      rows.push(row);
    }

    await this.bot.sendMessage(chatId, "🌐 *Choose Output Language:*", {
      parseMode: "Markdown",
      replyMarkup: {
        inline_keyboard: rows,
      }
    });
  }

  async handleUnknownCommand(chatId: string): Promise<void> {
    await this.bot.sendMessage(chatId, `⚠️ Command not recognized. Type /help for command list.`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  CALLBACK QUERY (button clicks)
  // ═══════════════════════════════════════════════════════════════

  async handleCallback(chatId: string, data: string, callbackQueryId: string): Promise<void> {
    if (data.startsWith("duration:")) {
      await this.onDurationCallback(chatId, data, callbackQueryId);
    } else if (data.startsWith("lang:")) {
      await this.onLangCallback(chatId, data, callbackQueryId);
    } else {
      await this.bot.answerCallbackQuery(callbackQueryId);
    }
  }

  // ── Private helpers ───────────────────────────────────────────

  private async onDurationCallback(chatId: string, data: string, cbId: string): Promise<void> {
    const secs = parseInt(data.split(":")[1]);
    if ((DURATIONS as readonly number[]).includes(secs)) {
      await this.supabase.from("studios").update({ video_duration: secs }).eq("id", this.studio.id);
      await this.bot.answerCallbackQuery(cbId, `✅ Duration → ${secs}s`);
      await this.bot.sendMessage(chatId, `✅ Video duration successfully changed to *${secs} seconds*.`, { parseMode: "Markdown" });
    } else {
      await this.bot.answerCallbackQuery(cbId, "❌ Invalid option");
    }
  }

  private async onLangCallback(chatId: string, data: string, cbId: string): Promise<void> {
    const langCode = data.split(":")[1];
    const langInfo = LANGUAGES.find(l => l.code === langCode);
    if (langInfo) {
      await this.supabase.from("studios").update({ language: langCode }).eq("id", this.studio.id);
      await this.bot.answerCallbackQuery(cbId, `✅ Language → ${langInfo.label}`);
      await this.bot.sendMessage(chatId, `✅ Language successfully changed to: ${langInfo.label} (*${langCode.toUpperCase()}*)`, { parseMode: "Markdown" });
    } else {
      await this.bot.answerCallbackQuery(cbId, "❌ Invalid language");
    }
  }

  private statusIcon(status: string): string {
    switch (status) {
      case "running": return "🔄";
      case "queued":  return "⏳";
      case "done":    return "✅";
      case "error":   return "❌";
      default:        return "⚪";
    }
  }
}
