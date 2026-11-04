import { TelegramApi } from "./src/agent/notify/telegram-api";
import * as fs from "fs";
import * as os from "os";

const config = JSON.parse(fs.readFileSync(os.homedir() + "/.jeo/config.json", "utf8"));
const { botToken, chatId } = config.notifications.telegram;

const api = new TelegramApi(botToken);
api.sendPhoto(chatId, "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png", {
  caption: "🫡 형님! gjc parity 완벽 이식 및 동작 검증 완료 (Inline Keyboard + Image)",
  replyMarkup: {
    inline_keyboard: [[{ text: "확인 완료 (Approve)", callback_data: "approve" }]]
  }
}).then(() => console.log("Sent successfully!")).catch(console.error);
