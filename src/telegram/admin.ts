/**
 * Admin handlers — port of plugins/admin.py and plugins/broadcast.py.
 * All commands here are private-only (Python applies `filters.private`).
 */
import type { TelegramApi, TgMessage } from './api.js';
import { btn, keyboard, ButtonStyle, sendSmartRichMessage, sendRichDraft, escapeHtml } from './rich.js';
import {
  ACCESS_DENIED,
  ACCESS_DENIED_STATS,
  adminHelpCard,
  buildStats,
  errorLogCards,
  grantCard,
  listUsersCard,
  revokeAdminCard,
  userInfoCard,
} from './adminContent.js';
import { isAdmin } from '../config.js';
import {
  getFailedRequestCount,
  getRecentErrors,
  getUserRequestCount,
  getUserToken,
  revokeUserToken,
  setUserRequestCount,
} from '../tools.js';
import { redis, scanKeys } from '../redis.js';
import { comma } from '../pyTime.js';

async function deny(api: TelegramApi, msg: TgMessage): Promise<void> {
  const userId = msg.from!.id;
  await sendSmartRichMessage(api, msg.chat.id, ACCESS_DENIED, { receiverUserId: userId });
}

export async function cmdStats(api: TelegramApi, msg: TgMessage): Promise<void> {
  const userId = msg.from!.id;
  if (!isAdmin(userId)) {
    await sendSmartRichMessage(api, msg.chat.id, ACCESS_DENIED_STATS, { receiverUserId: userId });
    return;
  }

  const chatId = msg.chat.id;
  const draftId = api.rndId();
  try {
    const progress = async (text: string): Promise<void> => {
      await sendRichDraft(
        api,
        chatId,
        draftId,
        `<blockquote>⚡ <b>Compiling Statistics...</b><br/>${escapeHtml(text)}</blockquote>`,
      );
    };
    await progress('Scanning Redis database structure...');
    const statsHtml = await buildStats(api, progress);
    await sendSmartRichMessage(api, chatId, statsHtml, {
      replyMarkup: keyboard([
        [btn('🔄 Refresh Stats', { callback_data: 'admin_refresh_stats', style: ButtonStyle.PRIMARY })],
      ]),
    });
  } catch (e) {
    await sendSmartRichMessage(
      api,
      chatId,
      `<blockquote>❌ <b>Error retrieving stats:</b> ${escapeHtml(String(e))}</blockquote>`,
    );
  }
}

export async function cmdUser(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!isAdmin(msg.from!.id)) return deny(api, msg);
  try {
    const targetUserId = msg.text!.split(/\s+/)[1]!;
    const token = await getUserToken(targetUserId);
    const requestCount = await getUserRequestCount(targetUserId);
    const failedCount = await getFailedRequestCount(targetUserId);

    if (token) {
      await sendSmartRichMessage(api, msg.chat.id, userInfoCard(targetUserId, token, requestCount, failedCount));
    } else {
      await sendSmartRichMessage(
        api,
        msg.chat.id,
        `<blockquote>❌ <b>Not Found:</b> User <code>${targetUserId}</code> has no registered token.</blockquote>`,
      );
    }
  } catch (e) {
    await sendSmartRichMessage(
      api,
      msg.chat.id,
      `<blockquote>❌ <b>Error:</b> ${escapeHtml(String(e))}</blockquote>`,
    );
  }
}

export async function cmdGrant(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!isAdmin(msg.from!.id)) return deny(api, msg);
  try {
    const parts = msg.text!.split(/\s+/);
    const targetUserId = Number.parseInt(parts[1]!, 10);
    const amount = Number.parseInt(parts[2]!, 10);
    const currentCount = await getUserRequestCount(targetUserId);
    const newCount = Math.max(0, currentCount - amount); // Reduce count to grant more
    await setUserRequestCount(targetUserId, newCount);
    await sendSmartRichMessage(api, msg.chat.id, grantCard(targetUserId, amount, currentCount, newCount));
  } catch (e) {
    await sendSmartRichMessage(
      api,
      msg.chat.id,
      `<blockquote>❌ <b>Error:</b> ${escapeHtml(String(e))}</blockquote>`,
    );
  }
}

export async function cmdRevokeAdmin(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!isAdmin(msg.from!.id)) return deny(api, msg);
  try {
    const targetUserId = Number.parseInt(msg.text!.split(/\s+/)[1]!, 10);
    await revokeUserToken(targetUserId);
    await sendSmartRichMessage(api, msg.chat.id, revokeAdminCard(targetUserId));
  } catch (e) {
    await sendSmartRichMessage(
      api,
      msg.chat.id,
      `<blockquote>❌ <b>Error:</b> ${escapeHtml(String(e))}</blockquote>`,
    );
  }
}

export async function cmdListUsers(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!isAdmin(msg.from!.id)) return deny(api, msg);

  const userKeys = await scanKeys('user_token:*');
  const rows: string[] = [];
  for (const key of userKeys.slice(0, 20)) {
    const uid = key.split(':')[1]!;
    const raw = (await redis().get(`user_requests:${uid}`)) ?? '0';
    rows.push(`<tr><td><code>${uid}</code></td><td><b>${comma(Number.parseInt(raw, 10) || 0)}</b></td></tr>`);
  }
  await sendSmartRichMessage(api, msg.chat.id, listUsersCard(rows.join('')));
}

export async function cmdAdminHelp(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!isAdmin(msg.from!.id)) return deny(api, msg);
  await sendSmartRichMessage(api, msg.chat.id, adminHelpCard());
}

export async function cmdErrors(api: TelegramApi, msg: TgMessage): Promise<void> {
  if (!isAdmin(msg.from!.id)) return deny(api, msg);

  const parts = msg.text!.split(/\s+/);
  let count = 15;
  if (parts.length > 1) {
    const parsed = Number.parseInt(parts[1]!, 10);
    count = Number.isNaN(parsed) ? 15 : Math.min(parsed, 50);
  }

  try {
    const errors = await getRecentErrors(count);
    if (!errors.length) {
      await sendSmartRichMessage(
        api,
        msg.chat.id,
        '<h1>Recent Error Log</h1><blockquote>✅ <b>No errors logged yet!</b> Everything is running clean.</blockquote>',
      );
      return;
    }
    for (const chunk of errorLogCards(errors)) {
      await sendSmartRichMessage(api, msg.chat.id, chunk);
    }
  } catch (e) {
    await sendSmartRichMessage(
      api,
      msg.chat.id,
      `<blockquote>❌ <b>Error fetching logs:</b> ${escapeHtml(String(e))}</blockquote>`,
    );
  }
}

// ── /broadcast (plugins/broadcast.py) ───────────────────────────

const BROADCAST_HELP = `<h1>📢 Broadcast Command</h1>
<blockquote>Please reply to the message you want to broadcast to all registered bot users.</blockquote>

<table border="1">
  <tr><th>Option</th><th>Effect</th></tr>
  <tr><td><code>/broadcast</code></td><td>Forward with original author header</td></tr>
  <tr><td><code>/broadcast -f</code></td><td>Copy message content without author header</td></tr>
</table>

<details>
  <summary><b>Broadcast Instructions</b></summary>
  <p>1. Send or forward any text, photo, video, or document to this chat.<br/>
  2. Reply to that message with <code>/broadcast</code> or <code>/broadcast -f</code>.<br/>
  3. Real-time progress will stream via draft updates until delivery completes.</p>
</details>`;

const BROADCAST_BLOCKED = ['user not found', 'blocked', 'forbidden', 'chat not found'];

export async function cmdBroadcast(api: TelegramApi, msg: TgMessage): Promise<void> {
  const userId = msg.from!.id;
  if (!isAdmin(userId)) {
    await sendSmartRichMessage(api, msg.chat.id, ACCESS_DENIED, { receiverUserId: userId });
    return;
  }

  if (!msg.reply_to_message) {
    await sendSmartRichMessage(api, msg.chat.id, BROADCAST_HELP);
    return;
  }

  try {
    const dropAuthor = (msg.text ?? '').split(/\s+/).includes('-f');

    const userKeys = await scanKeys('user_token:*');
    const storedUserIds = userKeys
      .map((k) => Number.parseInt(k.split(':')[1]!, 10))
      .filter((n) => !Number.isNaN(n));
    const totalUsers = storedUserIds.length;

    if (totalUsers === 0) {
      await sendSmartRichMessage(
        api,
        msg.chat.id,
        '<h1>Broadcast</h1><blockquote>❌ No registered users found in the database.</blockquote>',
      );
      return;
    }

    const draftId = api.rndId();
    const dropLabel = dropAuthor ? 'Yes (-f)' : 'No (Forward)';
    await sendRichDraft(
      api,
      msg.chat.id,
      draftId,
      `<blockquote>📢 <b>Broadcast Initialized</b><br/>
👥 Targets: <b>${comma(totalUsers)}</b> registered users<br/>
📝 Drop Author: <b>${dropLabel}</b></blockquote>`,
    );

    const reply = msg.reply_to_message;
    let sentCount = 0;
    let failedCount = 0;
    let removedUsers = 0;

    for (const target of storedUserIds) {
      try {
        if (dropAuthor) {
          if (reply.text) {
            await api.sendMessage({ chat_id: target, text: reply.text });
          } else if (reply.photo?.length) {
            await api.sendPhoto({
              chat_id: target,
              photo: reply.photo[reply.photo.length - 1]!.file_id,
              caption: reply.caption ?? '',
            });
          } else if (reply.video) {
            await api.sendVideo({ chat_id: target, video: reply.video.file_id, caption: reply.caption ?? '' });
          } else if (reply.document) {
            await api.sendDocument({
              chat_id: target,
              document: reply.document.file_id,
              caption: reply.caption ?? '',
            });
          } else {
            await api.forwardMessage({
              chat_id: target,
              from_chat_id: msg.chat.id,
              message_id: reply.message_id,
            });
          }
        } else {
          await api.forwardMessage({
            chat_id: target,
            from_chat_id: msg.chat.id,
            message_id: reply.message_id,
          });
        }

        sentCount += 1;

        if (sentCount % 10 === 0 || sentCount === totalUsers) {
          await sendRichDraft(
            api,
            msg.chat.id,
            draftId,
            `<blockquote>📢 <b>Broadcast Progress</b><br/>
✅ Delivered: <b>${comma(sentCount)}</b> / ${comma(totalUsers)}<br/>
❌ Failed: <b>${comma(failedCount)}</b><br/>
🗑 Removed Inactive: <b>${comma(removedUsers)}</b><br/>
⏳ Transmission in progress...</blockquote>`,
          );
        }
      } catch (e) {
        const errStr = String(e).toLowerCase();
        if (BROADCAST_BLOCKED.some((k) => errStr.includes(k))) {
          try {
            await redis().del(`user_token:${target}`);
            await redis().del(`user_requests:${target}`);
            removedUsers += 1;
          } catch {
            /* ignore */
          }
        }
        failedCount += 1;
      }
    }

    const successPct = totalUsers ? Math.round((sentCount / totalUsers) * 1000) / 10 : 0.0;
    const finalHtml = `<h1>📢 Broadcast Completed</h1>
<blockquote>Transmission finished across all registered users.</blockquote>

<table border="1">
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td><b>Successfully Sent</b></td><td><b>${comma(sentCount)}</b></td></tr>
  <tr><td><b>Failed Attempts</b></td><td><b>${comma(failedCount)}</b></td></tr>
  <tr><td><b>Invalid Users Purged</b></td><td><b>${comma(removedUsers)}</b></td></tr>
  <tr><td><b>Total Recipients</b></td><td>${comma(totalUsers)}</td></tr>
  <tr><td><b>Success Rate</b></td><td><b>${successPct}%</b></td></tr>
  <tr><td><b>Delivery Mode</b></td><td>${dropLabel}</td></tr>
</table>`;

    await sendSmartRichMessage(api, msg.chat.id, finalHtml);
  } catch (e) {
    await sendSmartRichMessage(
      api,
      msg.chat.id,
      `<blockquote>❌ <b>Broadcast failed:</b> ${escapeHtml(String(e))}</blockquote>`,
    );
  }
}
