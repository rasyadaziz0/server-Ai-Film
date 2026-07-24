import { TelegramBot } from "./TelegramBot";
import { LANGUAGES, DURATIONS, NODE_EMOJI } from "./constants";

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
        "Ketik ide cerita atau prompt apa saja di sini, dan sistem kami akan otomatis membuatkan naskah dan videonya untuk Anda.\n\n" +
        "Contoh: _Bikin video tentang T-Rex yang main piano di bulan_\n\n" +
        "*Command:*\n" +
        "/status — Cek status pipeline & node aktif\n" +
        "/duration — Ubah durasi video\n" +
        "/lang — Ubah bahasa output"
    );
  }

  async handleStatus(chatId: string): Promise<void> {
    // Get last job
    const { data: lastJob } = await this.supabase
      .from("jobs")
      .select("status, result_url, error, created_at")
      .eq("studio_id", this.studio.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Get all nodes with their current status
    const { data: allNodes } = await this.supabase
      .from("nodes")
      .select("type, label, status")
      .eq("studio_id", this.studio.id)
      .order("position_y", { ascending: true });

    let msg = "📊 *Pipeline Status*\n\n";

    // Job status
    if (!lastJob) {
      msg += "Belum ada job yang berjalan di studio ini.\n";
    } else if (lastJob.status === "done") {
      msg += `✅ *Job terakhir:* Selesai!\n🎬 ${lastJob.result_url || "(video tersedia)"}\n`;
    } else if (lastJob.status === "error") {
      msg += `❌ *Job terakhir:* Gagal\n_${lastJob.error || "Unknown error"}_\n`;
    } else {
      msg += `⏳ *Job terakhir:* Sedang diproses (_${lastJob.status}_)\n`;
    }

    // Node-level status
    if (allNodes && allNodes.length > 0) {
      msg += "\n*Node Status:*\n";

      for (const node of allNodes) {
        const icon = this.statusIcon(node.status);
        const emoji = NODE_EMOJI[node.type] || "🔲";
        const name = node.label || node.type;
        msg += `  ${icon} ${emoji} ${name} — _${node.status}_\n`;
      }

      const doneCount = allNodes.filter((n: any) => n.status === "done").length;
      const runningCount = allNodes.filter((n: any) => n.status === "running").length;
      msg += `\n_(${doneCount}/${allNodes.length} selesai${runningCount > 0 ? `, ${runningCount} sedang berjalan` : ""})_`;
    }

    await this.bot.sendMessage(chatId, msg);
  }

  async handleDuration(chatId: string, arg?: string): Promise<void> {
    if (arg) {
      // Backward compatible: /duration 15
      const secs = parseInt(arg);
      if ((DURATIONS as readonly number[]).includes(secs)) {
        await this.supabase.from("studios").update({ video_duration: secs }).eq("id", this.studio.id);
        await this.bot.sendMessage(chatId, `✅ Durasi video berhasil diubah menjadi *${secs} detik*.`);
      } else {
        await this.bot.sendMessage(chatId, `⚠️ Pilihan durasi: 5, 15, atau 30 detik.`);
      }
      return;
    }

    // No argument → send inline keyboard
    const currentDuration = this.studio.video_duration || 5;
    await this.bot.sendMessage(
      chatId,
      `🎬 *Pilih Durasi Video:*\n\nDurasi saat ini: *${currentDuration} detik*`,
      {
        inline_keyboard: [
          DURATIONS.map(d => ({
            text: `${d === currentDuration ? "✅ " : ""}${d} detik`,
            callback_data: `duration:${d}`,
          })),
        ],
      }
    );
  }

  async handleLang(chatId: string, arg?: string): Promise<void> {
    if (arg) {
      // Backward compatible: /lang en
      const langInfo = LANGUAGES.find(l => l.code === arg);
      if (langInfo) {
        await this.supabase.from("studios").update({ language: arg }).eq("id", this.studio.id);
        await this.bot.sendMessage(chatId, `✅ Bahasa berhasil diubah menjadi: ${langInfo.label} (*${arg.toUpperCase()}*)`);
      } else {
        await this.bot.sendMessage(chatId, `⚠️ Bahasa "${arg}" tidak dikenali. Ketik /lang untuk melihat pilihan.`);
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

    await this.bot.sendMessage(chatId, "🌐 *Pilih Bahasa Output:*", {
      inline_keyboard: rows,
    });
  }

  async handleUnknownCommand(chatId: string): Promise<void> {
    await this.bot.sendMessage(chatId, `⚠️ Command tidak dikenali. Ketik /help untuk daftar command.`);
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
      await this.bot.answerCallbackQuery(cbId, `✅ Durasi → ${secs}s`);
      await this.bot.sendMessage(chatId, `✅ Durasi video berhasil diubah menjadi *${secs} detik*.`);
    } else {
      await this.bot.answerCallbackQuery(cbId, "❌ Pilihan tidak valid");
    }
  }

  private async onLangCallback(chatId: string, data: string, cbId: string): Promise<void> {
    const langCode = data.split(":")[1];
    const langInfo = LANGUAGES.find(l => l.code === langCode);
    if (langInfo) {
      await this.supabase.from("studios").update({ language: langCode }).eq("id", this.studio.id);
      await this.bot.answerCallbackQuery(cbId, `✅ Bahasa → ${langInfo.label}`);
      await this.bot.sendMessage(chatId, `✅ Bahasa berhasil diubah menjadi: ${langInfo.label} (*${langCode.toUpperCase()}*)`);
    } else {
      await this.bot.answerCallbackQuery(cbId, "❌ Bahasa tidak valid");
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
