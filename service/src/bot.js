const { Bot, InlineKeyboard } = require('grammy');
const subs = require('./subscriptions');
const payments = require('./payments');
const xray = require('./xray');
const media = require('./media');
const { redirectLinks } = require('./connect_links');
const channelGate = require('./channel_gate');
const { onSubscriptionsChanged } = require('./sync');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '@tokyo_vpn_support';
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
const CABINET_URL = PUBLIC_URL ? `${PUBLIC_URL}/app/` : null;
const CASES_URL = PUBLIC_URL ? `${PUBLIC_URL}/app/?tab=cases` : null;

// Telegram HTML parse_mode only reserves these three characters - far less error-prone
// for Russian prose than MarkdownV2, which reserves a long list including `.` and `-`.
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mainMenu() {
  const kb = new InlineKeyboard();
  kb.text('👤 Личный кабинет', 'cabinet').row();
  if (CABINET_URL) kb.webApp('🗼 Открыть мини-апп', CABINET_URL).row();
  kb.text('💳 Купить подписку', 'buy').row().text('🎁 Пробный период — 3 дня', 'trial').row();
  kb.text('🎁 Подарить подписку другу', 'gift').row();
  if (CASES_URL) kb.webApp('🎁 Кейсы', CASES_URL).row();
  kb.text('🎟 Промокод', 'promo').text('👥 Рефералы', 'ref').row();
  kb.text('📢 Медиа-рефералы', 'media').row();
  kb.text('🆘 Поддержка', 'support');
  return kb;
}

/** Inline buttons that open the subscription straight into Happ / INCY - routed through our own
 * https redirect (see connect_links.js) since Telegram rejects/drops non-http(s) button URLs. */
function connectButtons(sub) {
  const kb = new InlineKeyboard();
  const links = redirectLinks(sub.vless_uuid);
  if (!links) return kb.text('⬅ В меню', 'menu');
  return kb.url('📲 Открыть в Happ', links.happ).row().url('📲 Открыть в INCY', links.incy).row().text('⬅ В меню', 'menu');
}

function plansMenu() {
  const kb = new InlineKeyboard();
  for (const [key, plan] of Object.entries(subs.PLANS)) {
    kb.text(`${plan.label} — ${plan.price} ₽`, `plan:${key}`).row();
  }
  return kb.text('⬅ Назад', 'menu');
}

function giftPlansMenu() {
  const kb = new InlineKeyboard();
  for (const [key, plan] of Object.entries(subs.PLANS)) {
    kb.text(`${plan.label} — ${plan.price} ₽`, `giftplan:${key}`).row();
  }
  return kb.text('⬅ Назад', 'menu');
}

function welcomeText() {
  return (
    `🗼 <b>Добро пожаловать в TOKYO VPN</b>\n\n` +
    `Быстрый VPN, который не блокируют.\n\n` +
    `✅ ${xray.COUNTRY_COUNT}+ стран\n` +
    `✅ Белые списки операторов (LTE-обход)\n` +
    `✅ Пробный период — 3 дня бесплатно`
  );
}

function subToText(sub) {
  return `Ваша подписка активна до <b>${escHtml(sub.expires_at)} UTC</b>\n\nНажмите кнопку ниже — приложение подключится автоматически.`;
}

function progressBar(current, base, target, size = 10) {
  if (!target || target <= base) return '█'.repeat(size);
  const done = Math.min(size, Math.max(0, Math.round(((current - base) / (target - base)) * size)));
  return '█'.repeat(done) + '░'.repeat(size - done);
}

const PLATFORM_LABELS = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };
const STATUS_ICON = { pending: '🕓', approved: '✅', rejected: '❌' };

function mediaMenu() {
  return new InlineKeyboard()
    .text('➕ Добавить аккаунт', 'media:add').row()
    .text('👥 Рефералы', 'ref').row()
    .text('⬅ В меню', 'menu');
}

function mediaText(userId) {
  const stats = media.mediaStats(userId);
  let text = '📢 <b>Медиа-рефералы</b>\n\n';
  text +=
    `Публикуйте ролики с рекламой TOKYO VPN (баннерная, прямая или нативная реклама — без накрутки, ` +
    `канал только про VPN, в описании — юзер или ссылка бота) и получайте <b>$${media.PAYOUT_USD_PER_100K_VIEWS} за каждые 100 000 просмотров</b>, выплата раз в неделю через поддержку.\n\n` +
    `Добавьте до ${media.MAX_ACCOUNTS_PER_PLATFORM} аккаунтов на каждой площадке (YouTube, Instagram, TikTok) — пришлите ссылку, мы промодерируем.\n\n`;

  if (stats.accounts.length) {
    text += '<b>Ваши аккаунты:</b>\n';
    for (const a of stats.accounts) {
      text += `${STATUS_ICON[a.status]} ${PLATFORM_LABELS[a.platform]}${a.status === 'approved' ? ` — ${a.views.toLocaleString('ru-RU')} просмотров` : ''}\n`;
    }
    text += '\n';
  }

  text += `Всего одобренных просмотров: <b>${stats.totalViews.toLocaleString('ru-RU')}</b>\n`;
  text += `К выплате: <b>$${stats.pendingPayoutUsd}</b>\n\n`;
  if (stats.nextMilestone) {
    const bar = progressBar(stats.totalViews, stats.progressBase, stats.nextMilestone.views);
    text += `🏆 ${bar}  ${stats.totalViews.toLocaleString('ru-RU')}/${stats.nextMilestone.views.toLocaleString('ru-RU')}\nСледующий приз: ${escHtml(stats.nextMilestone.prize)}`;
  } else {
    text += '🏆 Все текущие призовые уровни разблокированы!';
  }
  return text;
}

function createBot() {
  if (!BOT_TOKEN) {
    console.log('[bot] BOT_TOKEN not set — Telegram bot disabled, site/admin still run.');
    return null;
  }

  const bot = new Bot(BOT_TOKEN);

  bot.command('start', async (ctx) => {
    const payload = ctx.match ? String(ctx.match) : '';
    const refCode = payload.startsWith('ref_') ? payload.slice(4) : null;
    subs.ensureUser(ctx.from, refCode);

    if (payload.startsWith('gift_')) {
      const code = payload.slice(5);
      const result = subs.redeemGiftCode(code, ctx.from.id);
      if (result.error === 'not_found') {
        await ctx.reply('Такой подарочной ссылки не существует. Проверьте, что она скопирована полностью.', { reply_markup: mainMenu() });
      } else if (result.error === 'already_redeemed') {
        await ctx.reply('Эта подарочная подписка уже была активирована — её можно использовать только один раз.', { reply_markup: mainMenu() });
      } else {
        onSubscriptionsChanged();
        await ctx.reply(`🎁 Вам подарили подписку TOKYO VPN!\n\n${subToText(result.sub)}`, {
          parse_mode: 'HTML',
          reply_markup: connectButtons(result.sub),
        });
      }
    }

    await ctx.reply(welcomeText(), { parse_mode: 'HTML', reply_markup: mainMenu() });
    if (payload === 'cases' && CASES_URL) {
      await ctx.reply('🎁 Открывайте кейсы за монеты, заработанные на покупках подписки:', {
        reply_markup: new InlineKeyboard().webApp('Открыть кейсы', CASES_URL),
      });
    }
  });

  bot.callbackQuery('menu', (ctx) => ctx.editMessageText(welcomeText(), { parse_mode: 'HTML', reply_markup: mainMenu() }));

  bot.callbackQuery('buy', (ctx) => ctx.editMessageText('Выберите тариф — оплата картой через ЮKassa:', { reply_markup: plansMenu() }));

  bot.callbackQuery(/^plan:(1m|6m|12m)$/, async (ctx) => {
    const planKey = ctx.match[1];
    const user = subs.ensureUser(ctx.from);
    if (!payments.configured()) {
      return ctx.answerCallbackQuery({ text: 'Оплата подключается — попробуйте чуть позже 🙏', show_alert: true });
    }
    const returnUrl = PUBLIC_URL || 'https://t.me/';
    const result = await payments.createPayment(user.id, planKey, returnUrl);
    if (result.error) {
      return ctx.answerCallbackQuery({ text: 'Не получилось создать платёж, попробуйте ещё раз.', show_alert: true });
    }
    const kb = new InlineKeyboard().url('Оплатить', result.url).row().text('⬅ Назад', 'menu');
    await ctx.editMessageText(`Тариф: <b>${escHtml(subs.PLANS[planKey].label)}</b>\nНажмите «Оплатить» — после оплаты доступ включится автоматически.`, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  });

  bot.callbackQuery('gift', (ctx) =>
    ctx.editMessageText('🎁 Выберите тариф для подарка — после оплаты пришлём вам ссылку, которую можно отправить другу:', {
      reply_markup: giftPlansMenu(),
    })
  );

  bot.callbackQuery(/^giftplan:(1m|6m|12m)$/, async (ctx) => {
    const planKey = ctx.match[1];
    const user = subs.ensureUser(ctx.from);
    if (!payments.configured()) {
      return ctx.answerCallbackQuery({ text: 'Оплата подключается — попробуйте чуть позже 🙏', show_alert: true });
    }
    const returnUrl = PUBLIC_URL || 'https://t.me/';
    const result = await payments.createPayment(user.id, planKey, returnUrl, { gift: 'true' });
    if (result.error) {
      return ctx.answerCallbackQuery({ text: 'Не получилось создать платёж, попробуйте ещё раз.', show_alert: true });
    }
    const kb = new InlineKeyboard().url('Оплатить', result.url).row().text('⬅ Назад', 'menu');
    await ctx.editMessageText(
      `🎁 Подарок: <b>${escHtml(subs.PLANS[planKey].label)}</b>\nНажмите «Оплатить» — после оплаты пришлём ссылку, которую можно отправить другу.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  });

  bot.callbackQuery('trial', async (ctx) => {
    const user = subs.ensureUser(ctx.from);
    if (user.trial_used) {
      return ctx.answerCallbackQuery({ text: 'Пробный период уже был использован на этом аккаунте.', show_alert: true });
    }

    if (channelGate.enabled() && !(await channelGate.isSubscribed(ctx.api, ctx.from.id))) {
      const kb = new InlineKeyboard();
      if (channelGate.channelUrl) kb.url('📢 Подписаться на канал', channelGate.channelUrl).row();
      kb.text('✅ Я подписался, проверить', 'trial').row().text('⬅ В меню', 'menu');
      return ctx.editMessageText('Чтобы активировать пробный период, сначала подпишитесь на наш канал 👇', {
        reply_markup: kb,
      });
    }

    const result = subs.startTrial(user.id);
    if (result.error === 'used') {
      return ctx.answerCallbackQuery({ text: 'Пробный период уже был использован на этом аккаунте.', show_alert: true });
    }
    onSubscriptionsChanged();
    return ctx.editMessageText(`🎁 Пробный период активирован на ${subs.TRIAL_DAYS} дня!\n\n${subToText(result.sub)}`, {
      parse_mode: 'HTML',
      reply_markup: connectButtons(result.sub),
    });
  });

  bot.callbackQuery('cabinet', async (ctx) => {
    const user = subs.ensureUser(ctx.from);
    const sub = subs.activeSubscription(user.id);
    const coins = subs.getCoins(user.id);
    const link = `https://t.me/${ctx.me.username}?start=ref_${user.referral_code}`;

    let text = '👤 <b>Личный кабинет</b>\n\n';
    text += sub
      ? `Подписка «${escHtml(sub.plan)}» активна до <b>${escHtml(sub.expires_at)} UTC</b>\n`
      : 'Подписки пока нет — оформите платную или активируйте пробный период.\n';
    text += `\n🪙 Баланс монет за кейсы: <b>${coins}</b>\n`;
    text += `\n👥 Ваша реферальная ссылка:\n<code>${escHtml(link)}</code>`;

    const kb = sub ? connectButtons(sub) : new InlineKeyboard().text('⬅ В меню', 'menu');
    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  });

  const pendingPromo = new Set();
  const pendingMediaPlatform = new Map(); // userId -> platform, while we're waiting for their link

  bot.callbackQuery('promo', (ctx) => {
    pendingPromo.add(ctx.from.id);
    return ctx.editMessageText('Введите промокод одним сообщением:', { reply_markup: new InlineKeyboard().text('⬅ Отмена', 'menu') });
  });

  // Single handler for every free-text step (promo code, media account link) - grammy stops the
  // middleware chain at the first bot.on('message:text', ...) that doesn't call next(), so a
  // second independent handler further down would simply never run.
  bot.on('message:text', (ctx) => {
    const uid = ctx.from.id;

    if (pendingMediaPlatform.has(uid)) {
      const platform = pendingMediaPlatform.get(uid);
      pendingMediaPlatform.delete(uid);
      const user = subs.ensureUser(ctx.from);
      const result = media.addAccount(user.id, platform, ctx.message.text.trim());
      if (result.error === 'bad_url') {
        return ctx.reply('Это не похоже на ссылку. Пришлите полную ссылку на аккаунт/канал.', { reply_markup: mediaMenu() });
      }
      if (result.error === 'limit_reached') {
        return ctx.reply(`Уже добавлено максимум аккаунтов (${media.MAX_ACCOUNTS_PER_PLATFORM}) для ${PLATFORM_LABELS[platform]}.`, {
          reply_markup: mediaMenu(),
        });
      }
      return ctx.reply('✅ Аккаунт отправлен на модерацию.', { reply_markup: mediaMenu() });
    }

    if (pendingPromo.has(uid)) {
      pendingPromo.delete(uid);
      const user = subs.ensureUser(ctx.from);
      const result = subs.redeemPromo(user.id, ctx.message.text);
      if (result.error === 'not_found') return ctx.reply('Такого промокода нет. Проверьте написание.', { reply_markup: mainMenu() });
      if (result.error === 'already_used') return ctx.reply('Этот промокод уже был активирован на вашем аккаунте.', { reply_markup: mainMenu() });
      if (result.error === 'exhausted') return ctx.reply('У этого промокода закончились активации.', { reply_markup: mainMenu() });
      if (result.kind === 'days') {
        onSubscriptionsChanged();
        return ctx.reply(`✅ Промокод применён: +${result.value} дней к подписке.`, { reply_markup: mainMenu() });
      }
      return ctx.reply(`✅ Промокод применён: скидка ${result.value}% на следующую оплату.`, { reply_markup: mainMenu() });
    }
  });

  bot.callbackQuery('ref', (ctx) => {
    const user = subs.ensureUser(ctx.from);
    const link = `https://t.me/${ctx.me.username}?start=ref_${user.referral_code}`;
    const db = require('./db');
    const invited = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(user.id).c;
    const stats = subs.referralStats(user.id);

    let text = '👥 <b>Реферальная программа</b>\n\n';
    text +=
      `Приглашай друзей — за первую оплату вы оба получите 7 бесплатных дней, а с каждой их следующей оплаты ` +
      `вы получаете <b>${subs.REFERRAL_COMMISSION_PERCENT}%</b> — пожизненно. Для вывода обратитесь в поддержку.\n\n`;
    text += `Ваша ссылка:\n<code>${escHtml(link)}</code>\n\n`;
    text += `Приглашено всего: <b>${invited}</b>\nИз них оплатили подписку: <b>${stats.payingReferrals}</b>\n`;
    text += `Баланс к выводу: <b>${stats.balanceRub} ₽</b>\n\n`;

    if (stats.nextMilestone) {
      const bar = progressBar(stats.payingReferrals, stats.progressBase, stats.nextMilestone.count);
      text += `🏆 <b>Бонус за приглашённых</b>\n${bar}  ${stats.payingReferrals}/${stats.nextMilestone.count}\n`;
      text += `За ${stats.nextMilestone.count} оплативших: ${escHtml(stats.nextMilestone.prize)} <i>или</i> ${stats.nextMilestone.cashRub} ₽ на выбор.`;
    } else {
      text += '🏆 Все бонусы за приглашённых уже разблокированы!';
    }

    const kb = new InlineKeyboard().text('📢 Медиа-рефералы', 'media').row().text('⬅ В меню', 'menu');
    return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.callbackQuery('media', (ctx) => {
    const user = subs.ensureUser(ctx.from);
    return ctx.editMessageText(mediaText(user.id), { parse_mode: 'HTML', reply_markup: mediaMenu() });
  });

  bot.callbackQuery('media:add', (ctx) => {
    const kb = new InlineKeyboard()
      .text('YouTube', 'media:add:youtube').row()
      .text('Instagram', 'media:add:instagram').row()
      .text('TikTok', 'media:add:tiktok').row()
      .text('⬅ Назад', 'media');
    return ctx.editMessageText('Выберите площадку:', { reply_markup: kb });
  });

  bot.callbackQuery(/^media:add:(youtube|instagram|tiktok)$/, (ctx) => {
    const platform = ctx.match[1];
    pendingMediaPlatform.set(ctx.from.id, platform);
    return ctx.editMessageText(`Пришлите ссылку на ваш аккаунт/канал в ${PLATFORM_LABELS[platform]} одним сообщением:`, {
      reply_markup: new InlineKeyboard().text('⬅ Отмена', 'media'),
    });
  });

  bot.callbackQuery('support', (ctx) =>
    ctx.editMessageText(`🆘 Поддержка на связи: ${escHtml(SUPPORT_CONTACT)}\n\nОпишите проблему — ответим как можно скорее.`, {
      reply_markup: new InlineKeyboard().url('Написать в поддержку', `https://t.me/${SUPPORT_CONTACT.replace('@', '')}`).row().text('⬅ В меню', 'menu'),
    })
  );

  bot.catch((err) => console.error('[bot] error:', err));
  return bot;
}

module.exports = { createBot, subToText };
