import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ComponentType,
    ModalBuilder,
    EmbedBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    Colors,
} from 'discord.js';
import { QuestClient } from '../quest/questClient.js';
import { TokenStoreV3 } from '../quest/tokenStoreV3.js';
import { enableAutoquest, disableAutoquest, isAutoquestEnabled } from '../quest/autoquestStore.js';
import { addPermanentPremiumAccessForUsers, addPremiumAccess, addPremiumAccessForUsers, formatPremiumExpiry, hasPremiumAccess, isTrialPremium, listPremiumAccess, normalizePremiumUserId, parsePremiumDuration, removePremiumAccess } from '../quest/premiumStore.js';
import { PREFIX, OWNER_ID, PREMIUM_ROLE_IDS, QUEST_SETTINGS, SUPPORT_SERVER_INVITE, isOwnerUserId } from '../utils/config.js';
import { getEmoji } from '../handlers/emoji.js';
import { getDeviceGuideData as getScriptGuideData } from './script.js';
import { FREE_QUEST_LIMIT, hasBypass, hasGuildPremium, hasQuestAccess, releaseQuestReservation, reserveFreeQuest } from '../quest/questAccessStore.js';

const BOT_INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1530860905573650612';

// ── TokenStore (shared instance via BOT_TOKEN as secret) ───────────────────
export function makeTokenStore(secret) {
    return new TokenStoreV3(secret);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeToken(raw) {
    return raw.trim()
        .replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')
        .replace(/^`+|`+$/g, '')
        .replace(/^Bot\s+/i, '')
        .trim();
}

function isValidUserToken(token) {
    return token.length >= 50 && /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(token);
}

function isTrialAccountToken(userId, accountId, hasFullPremiumAccess = false) {
    return hasFullPremiumAccess || !isTrialPremium(userId) || String(userId) === String(accountId);
}

// ── UI Builders (Component V2) ─────────────────────────────────────────────

const UI_EMOJI = {
    phone: getEmoji('phone'), computer: getEmoji('computer'), ios: getEmoji('ios'),
    devicePhone: getEmoji('device_phone'), deviceComputer: getEmoji('device_computer'), deviceIos: getEmoji('device_ios'),
    link: getEmoji('link_icon'), tokenRequired: getEmoji('token_required'), search: getEmoji('search'), error: getEmoji('error_icon'),
    success: getEmoji('success_icon'), warning: getEmoji('warning_icon'), desktop: getEmoji('desktop'),
    video: getEmoji('video'), stream: getEmoji('stream'), game: getEmoji('game'), mobile: getEmoji('phone'),
    gear: getEmoji('gear'), quest: getEmoji('quest'), task: getEmoji('task_icon'), calendar: getEmoji('calendar_icon'),
    progress: getEmoji('chart_icon'), reward: getEmoji('gift_icon'), timer: getEmoji('timer'),
    clock: getEmoji('clock'), spark: getEmoji('sparkle'), support: getEmoji('support'), live: getEmoji('live'),
    bad: getEmoji('red_circle'), good: getEmoji('circle'), crown: getEmoji('crown_icon'),
    premium: getEmoji('premium_icon'), prem: getEmoji('prem'), time: getEmoji('time'), bot: getEmoji('bot'), unlock: getEmoji('unlock'),
    questSolving: getEmoji('quest_solving'), questComplete: getEmoji('quest_complete'), taskCustom: getEmoji('task_custom'), rewardOrbs: getEmoji('reward_orbs'),
};

const PREMIUM_ACCOUNT_LIMIT = 5;
const PREMIUM_ROLE_ACCOUNT_LIMIT = 2;
const GUILD_PREMIUM_ACCOUNT_LIMIT = 2;
const activeQuestUsers = new Set();
const activeQuestAllUsers = new Set();

function buildLinkModal(slot = '', sourceMessageId = '') {
    const modal = new ModalBuilder()
        .setCustomId(`link_token_modal${slot === '' ? '' : `_${slot}`}${sourceMessageId ? `:${sourceMessageId}` : ''}`)
        .setTitle('Link Your Discord Token');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('link_token_input')
                .setLabel('Discord user token')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Paste your token here...')
                .setRequired(true),
        ),
    );
    return modal;
}

function accountAgeTag(accountId) {
    try {
        const createdAt = Number((BigInt(accountId) >> 22n) + 1420070400000n);
        return Number.isFinite(createdAt) ? `<t:${Math.floor(createdAt / 1000)}:R>` : 'N/A';
    } catch {
        return 'N/A';
    }
}

function discordUserAvatarUrl(user) {
    if (!user?.id) return '';
    if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
    return `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) % 6n)}.png`;
}

async function buildAccountPanel(userId, tokenStore, accountSlots = 1, notice = '') {
    const linkedAccounts = await tokenStore.getAccounts(userId);
    const accounts = await Promise.all(linkedAccounts.map(async (account) => {
        const token = await tokenStore.getAccountToken(account.userId ?? userId, account.slot);
        if (!token) return account;
        try {
            const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: token } });
            if (!response.ok) return account;
            const linkedUser = await response.json();
            return { ...account, avatarUrl: discordUserAvatarUrl(linkedUser), accountId: linkedUser.id, accountName: linkedUser.global_name || linkedUser.username || account.accountName };
        } catch {
            return account;
        }
    }));
    const container = new ContainerBuilder().setAccentColor(0xFFFFFF);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `${notice ? `${notice}\n\n` : ''}# __**${getEmoji('premium_link')} Premium Link**__\n**Terms & Privacy**\n> By linking your Discord token, you allow the bot to use it for quest completion.\n> Use \`;script\` if you need the exact token flow guide first.\n\n### __**${getEmoji('account_panel')} Account Panel**__`,
    ));

    for (let slot = 0; slot < accountSlots; slot += 1) {
        const account = accounts.find((item) => item.slot === slot);
        const details = [`### #${slot + 1} Account Configuration`];
        if (account) {
            details.push(`- ${account.accountName || account.accountId} (${account.accountId})`, `- Status: ${account.active ? 'Active' : 'Inactive'}`, `- Account Age: ${accountAgeTag(account.accountId)}`, `- Linked At: ${account.linkedAt ? `<t:${Math.floor(new Date(account.linkedAt).getTime() / 1000)}:D>` : 'N/A'}`);
        } else {
            details.push('- Not Linked (Free Slot)', '- Status: Not Active', '- Account Age: N/A', '- Linked At: N/A');
        }
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        const detailsDisplay = new TextDisplayBuilder().setContent(details.join('\n'));
        if (account?.avatarUrl) {
            container.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(detailsDisplay)
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(account.avatarUrl)),
            );
        } else {
            container.addTextDisplayComponents(detailsDisplay);
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${account ? 'account_unlink' : 'account_link'}:${userId}:${slot}`).setLabel(account ? 'Unlink' : 'Link').setStyle(account ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`account_switch:${userId}:${slot}`).setLabel('Switch').setStyle(ButtonStyle.Secondary).setDisabled(!account || account.active),
        );
        container.addActionRowComponents(row);
    }

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

async function accountLimit(userId, tokenStore, accountSlots) {
    return (await tokenStore.getAccounts(userId)).length >= accountSlots;
}

function addSupportButton(container) {
    if (!SUPPORT_SERVER_INVITE) return;
    container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Support Server')
                .setStyle(ButtonStyle.Link)
                .setURL(SUPPORT_SERVER_INVITE),
        ),
    );
}

function supportComponents() {
    if (!SUPPORT_SERVER_INVITE) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(SUPPORT_SERVER_INVITE),
    )];
}

function questMessages(config) {
    const messages = config?.messages ?? {};
    return {
        quest_name: String(messages.quest_name ?? 'Discord Quest'),
        game_title: String(messages.game_title ?? 'Unknown game'),
        game_publisher: String(messages.game_publisher ?? 'Unknown publisher'),
    };
}

export const getDeviceGuideData = getScriptGuideData;
export { getDeviceScript } from './script.js';

export function buildTokenDeviceInstructions(device) {
    const info = getDeviceGuideData(device);
    const instructions = info.intro.replace(/\n?```javascript[\s\S]*?```/i, '').trim();
    const gallery = new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(info.videoUrl),
    );
    const copyButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`token_copy_code_${device}`)
            .setLabel('Copy Code')
            .setStyle(ButtonStyle.Danger),
    );
    const panel = new ContainerBuilder()
        .setAccentColor(0xFFFFFF)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# ${info.title}\n\n${instructions}`),
        )
        .addMediaGalleryComponents(gallery)
        .addActionRowComponents(copyButton);

    return {
        components: [panel],
        flags: MessageFlags.IsComponentsV2,
    };
}

function buildLinkPrompt(includeLinkButton = false, scriptHelp = false) {
    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
                scriptHelp
                    ? `# __**${getEmoji('script_help')} Script Help**__\nUse the guide below to get your Discord token for quest completion.\n\nChoose the device you want to use to get your token. After you click one of the buttons below, I’ll send you a private message with the steps and script.`
                    : `# __**${UI_EMOJI.tokenRequired} Token Required**__\nYou need to link your Discord token before using quest commands.\n\nChoose the device you want to use to get your token. After you click one of the buttons below, I’ll send you a private message with the steps and script.\n\nand do **\`;link\`** to link your token`,
        ),
    );
    c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('token_device_ios').setEmoji({ name: 'Xieron_stolen_emoji_1787798625', id: '1542373084923830273' }).setLabel('iOS').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('token_device_phone').setEmoji({ name: 'mobile', id: '1542375181606068287' }).setLabel('Phone').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('token_device_computer').setEmoji({ name: 'pc', id: '1542373647249973339' }).setLabel('Computer').setStyle(ButtonStyle.Secondary),
        ),
    );
    if (includeLinkButton) {
        c.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('link_prompt').setLabel(`${UI_EMOJI.link} Link Token`).setStyle(ButtonStyle.Success),
            ),
        );
    }
    return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

function buildNoQuestsCard() {
    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `# __**${UI_EMOJI.search} No Quests Available**__\nThere are no active, uncompleted quests on your account right now.`,
        ),
    );
    return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

function buildQuestLimitCard() {
    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `# ${UI_EMOJI.premium} Daily Quest Limit\nYou have completed your ${FREE_QUEST_LIMIT} free \`;quest\` quests for the last 24 hours.\n\nAsk the owner to grant access with \`;access @user\` for lifetime access.`,
        ),
    );
    addSupportButton(c);
    return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

function buildExpiredTokenCard() {
    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `# ${UI_EMOJI.error} Token Expired\nYour saved token was rejected by Discord — it has likely expired.\n\n**Your token has been removed.** Re-link with \`/link\` or \`${PREFIX}link\`.`,
        ),
    );
    return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

function buildErrorCard(err) {
    const msg = err?.message ?? String(err);
    const is401 = msg.includes('401');
    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            is401
                ? `# ${UI_EMOJI.error} Invalid or Expired Token\nRe-link your token with \`${PREFIX}link\`.`
                : `# ${UI_EMOJI.error} Error\n${msg.slice(0, 800)}`,
        ),
    );
    return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

function buildQuestSelectCard(quests) {
    const ICONS = {
        PLAY_ON_DESKTOP: UI_EMOJI.deviceComputer, PLAY_ON_XBOX: getEmoji('play_on_xbox'), PLAY_ON_PLAYSTATION: getEmoji('play_on_playstation'),
        WATCH_VIDEO: UI_EMOJI.video, STREAM_ON_DESKTOP: UI_EMOJI.stream,
        PLAY_ACTIVITY: UI_EMOJI.game, WATCH_VIDEO_ON_MOBILE: UI_EMOJI.devicePhone, WATCH_VIDEO_ON_IOS: UI_EMOJI.deviceIos,
    };

    const lines = quests.map((q, i) => {
        const messages = questMessages(q.config);
        const tasks = (q.config.task_config ?? q.config.task_config_v2)?.tasks ?? {};
        const taskKey = Object.keys(tasks)[0] ?? '';
        const icon = ICONS[taskKey] ?? UI_EMOJI.gear;
        const exp = Math.floor(new Date(q.config.expires_at).getTime() / 1000);
        return `**${i + 1}.** ${icon} **${messages.quest_name}**\n> *${messages.game_title}*  •  Expires <t:${exp}:R>`;
    }).join('\n\n');

    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
                `# __**${UI_EMOJI.game} ${quests.length} Quest${quests.length !== 1 ? 's' : ''} Available**__\n${lines}\n\n*Use the dropdown below to pick one.*`,
        ),
    );
    c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`quest_select_${Date.now()}`)
        .setPlaceholder('Pick a quest...')
        .addOptions(
            quests.map((q) => {
                const tasks = (q.config.task_config ?? q.config.task_config_v2)?.tasks ?? {};
                const taskKey = Object.keys(tasks)[0] ?? '';
                return {
                    label: questMessages(q.config).quest_name.slice(0, 100),
                    description: questMessages(q.config).game_title.slice(0, 100),
                    value: q.id,
                    emoji: ICONS[taskKey] ?? UI_EMOJI.gear,
                };
            }),
        );

    c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
    return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

function getQuestProgressValue(quest) {
    if (!quest?.userStatus?.progress) return 0;
    const taskConfig = quest.config?.task_config ?? quest.config?.task_config_v2;
    const tasks = taskConfig?.tasks ?? {};
    const taskName = Object.keys(tasks).find((key) => tasks[key] != null) ?? 'WATCH_VIDEO';
    const eventName = tasks[taskName]?.event_name ?? taskName;
    const progress = quest.userStatus.progress;
    const byEvent = eventName ? progress[eventName]?.value : undefined;
    const byTask = progress[taskName]?.value;
    return Number(byEvent ?? byTask ?? 0) || 0;
}

function findQuestMediaUrl(quest) {
    const cfg = quest?.config ?? {};
    const candidates = [
        quest?.preview,
        quest?.preview?.url,
        quest?.preview?.image,
        quest?.preview?.image_url,
        quest?.preview?.video,
        cfg?.preview,
        cfg?.preview?.url,
        cfg?.preview?.image,
        cfg?.preview?.image_url,
        cfg?.hero_asset,
        cfg?.hero_asset_url,
        cfg?.image,
        cfg?.image_url,
        cfg?.video,
        cfg?.video_url,
        cfg?.messages?.image,
        cfg?.messages?.image_url,
        cfg?.messages?.video,
        cfg?.messages?.video_url,
        cfg?.assets?.hero,
        cfg?.assets?.image,
        cfg?.assets?.thumbnail,
        cfg?.assets?.video,
        cfg?.assets?.url,
        cfg?.application?.cover_image,
        cfg?.application?.icon,
        quest?.targetedContent?.preview,
        quest?.targetedContent?.image,
        quest?.targetedContent?.video,
    ];

    const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());
    return candidates.find(isHttpUrl)?.trim() ?? '';
}

function buildProgressBar(percent, size = 12) {
    const filled = Math.max(0, Math.min(size, Math.round((percent / 100) * size)));
    const empty = size - filled;
    return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

async function buildQuestInfoCard(quest, phase, claimed = 0, failReason = '', progressValue = null) {
    const cfg  = quest.config;
    const msgs = questMessages(cfg);
    const taskConfig = cfg.task_config ?? cfg.task_config_v2;
    const tasks = taskConfig?.tasks ?? {};
    const taskName = Object.keys(tasks).find((key) => tasks[key] != null) ?? 'WATCH_VIDEO';
    const task = tasks[taskName] ?? { target: 1 };
    const targetSeconds = Number(task.target ?? 1);
    const totalProgress = typeof progressValue === 'number' ? progressValue : getQuestProgressValue(quest);
    const percentage = Math.min(100, Math.max(0, Math.round((totalProgress / Math.max(1, targetSeconds)) * 100)));

    const TASK_META = {
        PLAY_ON_DESKTOP:       { icon: UI_EMOJI.deviceComputer, label: 'Play on Desktop' },
        PLAY_ON_XBOX:          { icon: getEmoji('play_on_xbox'), label: 'Play on Xbox' },
        PLAY_ON_PLAYSTATION:   { icon: getEmoji('play_on_playstation'), label: 'Play on PlayStation' },
        WATCH_VIDEO:           { icon: UI_EMOJI.video, label: 'Watch Video' },
        STREAM_ON_DESKTOP:     { icon: UI_EMOJI.stream, label: 'Stream on Desktop' },
        PLAY_ACTIVITY:         { icon: UI_EMOJI.game, label: 'Play Activity' },
        WATCH_VIDEO_ON_MOBILE: { icon: UI_EMOJI.devicePhone, label: 'Watch Video on Mobile' },
        WATCH_VIDEO_ON_IOS:    { icon: UI_EMOJI.deviceIos, label: 'Watch Video on iOS' },
    };

    const taskLines = Object.entries((cfg.task_config ?? cfg.task_config_v2)?.tasks ?? {}).map(([type, task]) => {
        const meta = TASK_META[type] ?? { icon: UI_EMOJI.gear, label: type };
        let dur = '';
        if (type === 'PLAY_ON_DESKTOP' || type === 'STREAM_ON_DESKTOP') {
            dur = `  •  **${Math.ceil(task.target / 60)} min**`;
        } else if (type === 'WATCH_VIDEO' || type === 'WATCH_VIDEO_ON_MOBILE') {
            const s = task.target;
            dur = s >= 60 ? `  •  **${Math.ceil(s / 60)} min**` : `  •  **${s}s**`;
        }
        return `${meta.icon} ${meta.label}${dur}${phase === 'done' ? `  ${UI_EMOJI.success}` : ''}`;
    });

    const rewardLines = (cfg.rewards_config?.rewards ?? []).map((r) => {
        let line = `**${r.messages?.name ?? 'Reward'}**`;
        if (r.orb_quantity) line += `  ✦ *(${r.orb_quantity} Orbs)* ${UI_EMOJI.rewardOrbs}`;
        else if (r.quantity) line += `  *(${r.quantity}d Nitro)*`;
        return line;
    });

    const expiresEpoch = Math.floor(new Date(cfg.expires_at).getTime() / 1000);
    const daysLeft = Math.max(0, Math.ceil((new Date(cfg.expires_at).getTime() - Date.now()) / 86400000));

    const PHASE = {
        starting: { color: 0xFFFFFF, icon: UI_EMOJI.questSolving, title: 'Solving Quest...', bar: '' },
        done:     { color: 0xFFFFFF, icon: UI_EMOJI.questComplete, title: 'Quest Complete!', bar: '' },
        failed:   { color: 0xFFFFFF, icon: UI_EMOJI.bad, title: 'Quest Failed', bar: '' },
    };

    const p = PHASE[phase];
    const progressText = phase === 'failed' && failReason
        ? `\`${buildProgressBar(0, 12)}\`  **0%**\n\`\`\`\n${failReason.slice(0, 300)}\n\`\`\``
        : `\`${buildProgressBar(phase === 'done' ? 100 : percentage, 12)}\`  **${phase === 'done' ? 100 : percentage}%**${phase === 'starting' ? '  —  *Working on it...*' : ''}`;

    const footerNote = phase === 'done' && claimed > 0
        ? `-# ${UI_EMOJI.reward} ${claimed} reward(s) claimed`
        : phase === 'starting'
        ? `-# Quest Bot  •  Please wait...`
        : phase === 'failed'
        ? `-# Requires manual completion in the Discord app`
        : '';

    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);

    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `# __**${p.icon} ${p.title}**__\n### __**${msgs.quest_name}**__\n*${msgs.game_title}*  •  ${msgs.game_publisher}`,
        ),
    );
    c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    const mediaUrl = findQuestMediaUrl(quest);
    if (mediaUrl) {
        try {
            const gallery = new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(mediaUrl),
            );
            c.addMediaGalleryComponents(gallery);
        } catch {
            // Invalid media URLs should never break quest completion UI.
        }
    } else {
        c.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`**Quest Preview**\n${msgs.quest_name}\n${msgs.game_title}`),
                )
                .setButtonAccessory(
                    new ButtonBuilder()
                        .setLabel(phase === 'done' ? 'Quest Completed!' : 'Open Quest')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://discord.com/quests/${encodeURIComponent(String(quest.id))}`),
                ),
        );
    }
    c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel(phase === 'done' ? 'Quest Completed!' : 'Open Quest')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/quests/${encodeURIComponent(String(quest.id))}`),
        ),
    );
    c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `${UI_EMOJI.taskCustom} **Task**\n${taskLines.join('\n') || '*Unknown task*'}\n\n` +
            `${UI_EMOJI.calendar} **Expires**  <t:${expiresEpoch}:R>  *(${daysLeft}d left)*\n\n` +
            `${UI_EMOJI.progress} **Progress**\n${progressText || '`░░░░░░░░░░`  0%'}\n\n` +
            `${UI_EMOJI.reward} **Reward**\n${rewardLines.join('\n') || '*No rewards listed*'}`,
        ),
    );
    if (footerNote) {
        c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerNote));
    }

    return {
        components: [c],
        flags: MessageFlags.IsComponentsV2,
    };
}

// ── Quest Runners ──────────────────────────────────────────────────────────

async function runQuestOne(userId, tokenStore, send) {
    const token = await tokenStore.get(userId);
    if (!token) { await send(buildLinkPrompt()); return false; }
    if (activeQuestUsers.has(userId)) {
        await send({ content: `${UI_EMOJI.warning} A quest run is already in progress for you. Please wait for it to finish.` });
        return false;
    }
    activeQuestUsers.add(userId);

    const qc = new QuestClient(token);
    try {
        const manager = await qc.fetchQuests();
        const valid = manager.filterQuestsValid();
        if (valid.length === 0) { await send(buildNoQuestsCard()); return false; }

        const selectable = valid.slice(0, 25);
        const selMsg = await send(buildQuestSelectCard(selectable));

        let completedAny = false;
        while (true) {
            let selectedId;
            try {
                const interaction = await selMsg.awaitMessageComponent({
                    filter: (i) => i.user.id === userId,
                    time: 60_000,
                    componentType: ComponentType.StringSelect,
                });
                await interaction.deferUpdate();
                selectedId = interaction.values[0];
            } catch {
                const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
                c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.clock} Timed Out\nNo quest was selected within 60 seconds. Run \`${PREFIX}quest\` again.`));
                await send({ components: [c], flags: MessageFlags.IsComponentsV2 });
                return completedAny;
            }

            const quest = selectable.find((q) => q.id === selectedId);
            if (!quest) continue;

            const progressMsg = await send(await buildQuestInfoCard(quest, 'starting', 0, '', getQuestProgressValue(quest)));
            const logs = [];
            let lastProgressEdit = 0;
            const log = (m) => { console.log(m); logs.push(m); };
            const questDone = await manager.doingQuest(quest, log, async ({ done, total }) => {
                if (Date.now() - lastProgressEdit < 5000) return;
                lastProgressEdit = Date.now();
                await progressMsg.edit(await buildQuestInfoCard(quest, 'starting', 0, '', Math.min(total, Math.max(0, done)))).catch(() => {});
            });

            if (!questDone) {
                const failReason = logs.filter(l => l.startsWith('[FAIL]')).slice(-2).join('\n') || logs.slice(-3).join('\n') || 'Could not be completed automatically.';
                await progressMsg.edit(await buildQuestInfoCard(quest, 'failed', 0, failReason));
                continue;
            }

            await progressMsg.edit(await buildQuestInfoCard(quest, 'done'));
            completedAny = true;
        }

    } catch (err) {
        const msg = err?.message ?? String(err);
        if (msg.includes('401') && await tokenStore.has(userId)) {
            await tokenStore.remove(userId); disableAutoquest(userId);
            await send(buildExpiredTokenCard()).catch(() => {});
        } else {
            await send(buildErrorCard(err)).catch(() => {});
        }
        return false;
    } finally {
        activeQuestUsers.delete(userId);
    }
}

async function runQuestAll(userId, member, tokenStore, send, client, guildId = null) {
    if (!(await canUsePremiumFeature(userId, member, client, guildId))) {
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.premium} Premium Required\nThis command is locked behind premium access.\n\nUse \`${PREFIX}premium\` to check access or ask the owner to grant access.`));
        addSupportButton(c);
        await send({ components: [c], flags: MessageFlags.IsComponentsV2 });
        return false;
    }

    const token = await tokenStore.get(userId);
    if (!token) { await send(buildLinkPrompt()); return false; }
    if (activeQuestUsers.has(userId)) {
        await send({ content: `${UI_EMOJI.warning} A quest run is already in progress for you. Please wait for it to finish.` });
        return false;
    }
    activeQuestUsers.add(userId);
    activeQuestAllUsers.add(userId);

    const qc = new QuestClient(token);
    try {
        const manager = await qc.fetchQuests();
        const valid = manager.filterQuestsValid();
        if (valid.length === 0) { await send(buildNoQuestsCard()); return false; }
        const progressMsgs = await Promise.all(valid.map(async (q) => send(await buildQuestInfoCard(q, 'starting', 0, '', getQuestProgressValue(q)))));

        const { questLogs, questResults } = await dispatchQuestBatch(valid, manager, progressMsgs);

        const completed = valid.filter((_, i) => questResults[i].status === 'fulfilled' && questResults[i].value === true);
        const skipped   = valid.filter((_, i) => questResults[i].status === 'rejected' || (questResults[i].status === 'fulfilled' && questResults[i].value === false));

        await Promise.allSettled(skipped.map(async (q) => {
            const idx = valid.indexOf(q);
            const failLogs = questLogs[idx].filter(l => l.startsWith('[FAIL]'));
            const reason = questResults[idx].status === 'rejected'
                ? questResults[idx].reason?.message ?? 'Unknown error'
                : failLogs.slice(-2).join('\n') || questLogs[idx].slice(-3).join('\n') || 'Could not be completed automatically.';
            return progressMsgs[idx].edit(await buildQuestInfoCard(q, 'failed', 0, reason));
        }));

        if (completed.length === 0) {
            const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
            c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.warning} No Quests Auto-Completed\nAll quests require manual completion via the Discord desktop or mobile app.`));
            await send({ components: [c], flags: MessageFlags.IsComponentsV2 });
            return false;
        }

        await Promise.allSettled(completed.map(async (q, i) => {
            const idx = valid.indexOf(q);
            return progressMsgs[idx].edit(await buildQuestInfoCard(q, 'done'));
        }));
        return true;

    } catch (err) {
        const msg = err?.message ?? String(err);
        if (msg.includes('401') && await tokenStore.has(userId)) {
            await tokenStore.remove(userId); disableAutoquest(userId);
            await send(buildExpiredTokenCard()).catch(() => {});
        } else {
            await send(buildErrorCard(err)).catch(() => {});
        }
        return false;
    } finally {
        activeQuestUsers.delete(userId);
        activeQuestAllUsers.delete(userId);
    }
}

    async function runQuestList(userId, tokenStore, send) {
    const token = await tokenStore.get(userId);
    if (!token) { await send(buildLinkPrompt()); return; }

    const qc = new QuestClient(token);
    try {
        const manager = await qc.fetchQuests();
        const all = manager.list();
        if (all.length === 0) { await send(buildNoQuestsCard()); return; }

        const TASK_META = {
            PLAY_ON_DESKTOP:       { icon: UI_EMOJI.deviceComputer, label: 'Play on Desktop' },
            PLAY_ON_XBOX:          { icon: getEmoji('play_on_xbox'), label: 'Play on Xbox' },
            PLAY_ON_PLAYSTATION:   { icon: getEmoji('play_on_playstation'), label: 'Play on PlayStation' },
            WATCH_VIDEO:           { icon: UI_EMOJI.video, label: 'Watch Video' },
            STREAM_ON_DESKTOP:     { icon: UI_EMOJI.stream, label: 'Stream on Desktop' },
            PLAY_ACTIVITY:         { icon: UI_EMOJI.game, label: 'Play Activity' },
            WATCH_VIDEO_ON_MOBILE: { icon: UI_EMOJI.devicePhone, label: 'Watch Video on Mobile' },
            WATCH_VIDEO_ON_IOS:    { icon: UI_EMOJI.deviceIos, label: 'Watch Video on iOS' },
        };

        for (const q of all.slice(0, 10)) {
            const cfg = q.config;
            const msgs = questMessages(cfg);
            const expiresEpoch = Math.floor(new Date(cfg.expires_at).getTime() / 1000);
            const daysLeft = Math.max(0, Math.ceil((new Date(cfg.expires_at).getTime() - Date.now()) / 86400000));

            const st = q.isCompleted() ? { color: 0xFFFFFF, icon: UI_EMOJI.success, label: 'Completed' }
                : q.isExpired()        ? { color: 0xFFFFFF, icon: UI_EMOJI.bad, label: 'Expired' }
                : q.isEnrolledQuest()  ? { color: 0xFFFFFF, icon: UI_EMOJI.timer, label: 'In Progress' }
                :                        { color: 0xFFFFFF, icon: UI_EMOJI.good, label: 'Available' };

            const taskLines = Object.entries((cfg.task_config ?? cfg.task_config_v2)?.tasks ?? {}).map(([type, task]) => {
                const meta = TASK_META[type] ?? { icon: UI_EMOJI.gear, label: type };
                let dur = '';
                if (type === 'PLAY_ON_DESKTOP' || type === 'STREAM_ON_DESKTOP') dur = `  •  **${Math.ceil(task.target / 60)} min**`;
                else if (type === 'WATCH_VIDEO' || type === 'WATCH_VIDEO_ON_MOBILE') {
                    const s = task.target;
                    dur = s >= 60 ? `  •  **${Math.ceil(s / 60)} min**` : `  •  **${s}s**`;
                }
                return `${meta.icon} ${meta.label}${dur}`;
            });

            const rewardLines = (cfg.rewards_config?.rewards ?? []).map((r) => {
                let line = `**${r.messages?.name ?? 'Reward'}**`;
                if (r.orb_quantity) line += `  ✦ *(${r.orb_quantity} Orbs)* ${UI_EMOJI.rewardOrbs}`;
                else if (r.quantity) line += `  *(${r.quantity}d Nitro)*`;
                return line;
            });

            const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
            c.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `# __**${st.icon}  ${msgs.quest_name}**__\n*${msgs.game_title}*  •  ${msgs.game_publisher}`,
                        ),
                    )
            );
            c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
            c.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `${UI_EMOJI.progress} **Status:** ${st.label}   ${UI_EMOJI.calendar} **Expires:** <t:${expiresEpoch}:R> *(${daysLeft}d)*\n\n` +
                    `${UI_EMOJI.taskCustom} **Task**\n${taskLines.join('\n') || '*Unknown*'}\n\n` +
                    `${UI_EMOJI.reward} **Reward**\n${rewardLines.join('\n') || '*No rewards listed*'}`,
                ),
            );
            await send({
                components: [c],
                flags: MessageFlags.IsComponentsV2,
            });
        }

        if (all.length > 10) {
            const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
            c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# …and **${all.length - 10}** more quest(s) not shown.`));
            await send({ components: [c], flags: MessageFlags.IsComponentsV2 });
        }

    } catch (err) {
        await send(buildErrorCard(err)).catch(() => {});
    }
}

async function runTokenCheck(userId, tokenStore, replyFn) {
    const token = await tokenStore.get(userId);

    if (!token) {
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# No Token Saved\nYou don't have a saved token. Use \`${PREFIX}link\` to save one.`));
        await replyFn({ components: [c], flags: MessageFlags.IsComponentsV2 });
        return;
    }

    let valid = false, accountName = '';
    try {
        const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: token } });
        valid = res.ok;
        if (res.ok) {
            const data = await res.json();
            accountName = data.global_name || data.username || '';
        }
    } catch { valid = false; }

    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            valid
                ? `# ${UI_EMOJI.success} Token is Valid\nLinked as **"${accountName}"**.\n\nYour saved token is working correctly.`
                : `# ${UI_EMOJI.error} Token Invalid or Expired\nYour saved token was rejected by Discord.\nUse \`${PREFIX}unlink\` then \`${PREFIX}link\` to save a fresh token.`,
        ),
    );
    await replyFn({ components: [c], flags: MessageFlags.IsComponentsV2 });
    if (!valid) await tokenStore.remove(userId);
}

async function runAutoquestToggle(userId, member, tokenStore, replyFn, client, guildId = null) {
    if (!(await canUsePremiumFeature(userId, member, client, guildId))) {
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.premium} Premium Required\nAuto-Quest is a premium feature.\n\nAsk the bot owner to grant access with \`${PREFIX}premium add <number> <day|month|year|permanent> <userId>\`.`));
        addSupportButton(c);
        await replyFn({ components: [c], flags: MessageFlags.IsComponentsV2 });
        return;
    }

    if (isAutoquestEnabled(userId)) {
        disableAutoquest(userId);
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.bot} Auto-Quest Disabled\nI'll no longer auto-run new quests for you.\nUse \`${PREFIX}autoquest\` again to turn it back on.`));
        await replyFn({ components: [c], flags: MessageFlags.IsComponentsV2 });
        return;
    }
    if (!await tokenStore.has(userId)) {
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.error} No Saved Token\nAuto-Quest needs your Discord user token.\n\n**Use \`${PREFIX}link\` first**, then run \`${PREFIX}autoquest\` again.`));
        await replyFn({ components: [c], flags: MessageFlags.IsComponentsV2 });
        return;
    }
    enableAutoquest(userId);
    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `# ${UI_EMOJI.bot} Auto-Quest Enabled!\nEvery new Discord quest that drops will be **auto-completed for you** in the background.\n\nI'll DM you a summary once each quest finishes.\n\nUse \`${PREFIX}autoquest\` again to turn this off.\n\n-# Keep your saved token fresh with \`${PREFIX}tokencheck\`.`,
        ),
    );
    await replyFn({ components: [c], flags: MessageFlags.IsComponentsV2 });
}

// ── Slash + Prefix exports ─────────────────────────────────────────────────

export function getQuestAllWorkerCount(validQuestCount) {
    const total = Number(validQuestCount) || 0;
    if (!Number.isFinite(total) || total <= 0) return 1;
    return Math.max(1, Math.floor(total));
}

export async function dispatchQuestBatch(validQuests, manager, progressMsgs) {
    const questLogs = validQuests.map(() => []);
    const questResults = Array(validQuests.length);
    const lastProgressEdits = validQuests.map(() => 0);

    await Promise.all(validQuests.map(async (quest, index) => {
        const log = (message) => { console.log(message); questLogs[index].push(message); };

        try {
            const value = await manager.doingQuest(quest, log, async ({ done, total }) => {
                const msg = progressMsgs[index];
                if (!msg) return;
                if (Date.now() - lastProgressEdits[index] < 5000) return;
                lastProgressEdits[index] = Date.now();
                await msg.edit(await buildQuestInfoCard(quest, 'starting', 0, '', Math.min(total, Math.max(0, done)))).catch(() => {});
            });
            questResults[index] = { status: 'fulfilled', value };
        } catch (reason) {
            questResults[index] = { status: 'rejected', reason };
        }
    }));

    return { questLogs, questResults };
}

function createInteractionSender(interaction) {
    let firstResponse = true;
    return (payload) => {
        if (firstResponse) {
            firstResponse = false;
            return interaction.editReply(payload);
        }
        return interaction.followUp(payload);
    };
}

export const questCmd = {
    data: new SlashCommandBuilder().setName('quest').setDescription('Pick and complete one Discord quest'),
    prefix: 'quest',
    async execute(interaction, client) {
        const ts = client.tokenStore;
        await interaction.deferReply();
        const hasUnlimitedAccess = isOwner(interaction.user.id)
            || hasBypass(interaction.user.id)
            || hasPremiumAccess(interaction.user.id)
            || hasQuestAccess(interaction.user.id)
            || hasGuildPremium(interaction.user.id, interaction.guildId)
            || await hasPremiumRole(interaction.user.id, client, interaction.member);
        let reservationTime = null;
        if (!hasUnlimitedAccess) {
            reservationTime = reserveFreeQuest(interaction.user.id);
            if (reservationTime === null) {
                await interaction.editReply(buildQuestLimitCard());
                return;
            }
        }

        const completed = await runQuestOne(interaction.user.id, ts, createInteractionSender(interaction));
        if (!hasUnlimitedAccess && !completed) releaseQuestReservation(interaction.user.id, reservationTime);
    },
    async prefixExecute(message, _args, client) {
        const hasUnlimitedAccess = isOwner(message.author.id)
            || hasBypass(message.author.id)
            || hasPremiumAccess(message.author.id)
            || hasQuestAccess(message.author.id)
            || hasGuildPremium(message.author.id, message.guild?.id)
            || await hasPremiumRole(message.author.id, client, message.member);
        let reservationTime = null;
        if (!hasUnlimitedAccess) {
            reservationTime = reserveFreeQuest(message.author.id);
            if (reservationTime === null) {
                await message.channel.send(buildQuestLimitCard());
                return;
            }
        }

        const completed = await runQuestOne(message.author.id, client.tokenStore, (opts) => message.channel.send(opts));
        if (!hasUnlimitedAccess && !completed) releaseQuestReservation(message.author.id, reservationTime);
    },
};

export const questAllCmd = {
    data: new SlashCommandBuilder().setName('questall').setDescription('Complete all quests at once'),
    prefix: 'questall',
    async execute(interaction, client) {
        await interaction.deferReply();
        await runQuestAll(interaction.user.id, interaction.member, client.tokenStore, createInteractionSender(interaction), client, interaction.guildId);
    },
    async prefixExecute(message, _args, client) {
        await runQuestAll(message.author.id, message.member, client.tokenStore, (opts) => message.channel.send(opts), client, message.guild?.id);
    },
};

export const questListCmd = {
    data: new SlashCommandBuilder().setName('questlist').setDescription('List all Discord quests and their status'),
    prefix: 'questlist',
    async execute(interaction, client) {
        await interaction.deferReply();
        await runQuestList(interaction.user.id, client.tokenStore, createInteractionSender(interaction));
    },
    async prefixExecute(message, _args, client) {
        await runQuestList(message.author.id, client.tokenStore, (opts) => message.channel.send(opts));
    },
};

export const tokenCheckCmd = {
    data: new SlashCommandBuilder().setName('tokencheck').setDescription('Check whether your saved Discord token is still valid'),
    prefix: 'tokencheck',
    async execute(interaction, client) {
        await interaction.deferReply({ flags: 64 });
        await runTokenCheck(interaction.user.id, client.tokenStore, (opts) => interaction.editReply(opts));
    },
    async prefixExecute(message, _args, client) {
        await runTokenCheck(message.author.id, client.tokenStore, (opts) => message.reply(opts));
    },
};

export const autoquestCmd = {
    data: new SlashCommandBuilder().setName('autoquest').setDescription('Auto-complete every new quest the moment it drops'),
    prefix: 'autoquest',
    async execute(interaction, client) {
        await interaction.deferReply({ flags: 64 });
        await runAutoquestToggle(interaction.user.id, interaction.member, client.tokenStore, (opts) => interaction.editReply(opts), client, interaction.guildId);
    },
    async prefixExecute(message, _args, client) {
        await runAutoquestToggle(message.author.id, message.member, client.tokenStore, (opts) => message.reply(opts), client, message.guild?.id);
    },
};

export const scripCmd = {
    data: new SlashCommandBuilder().setName('scrip').setDescription('Get device-specific Discord token scripts and instructions'),
    prefix: 'scrip',
    async execute(interaction) {
        await interaction.reply(buildLinkPrompt(false, true));
    },
    async prefixExecute(message) {
        await message.reply(buildLinkPrompt(false, true));
    },
};

export const scriptCmd = {
    data: new SlashCommandBuilder().setName('script').setDescription('Get device-specific Discord token scripts and instructions'),
    prefix: 'script',
    async execute(interaction) {
        await interaction.reply(buildLinkPrompt(false, true));
    },
    async prefixExecute(message) {
        await message.reply(buildLinkPrompt(false, true));
    },
};

export const inviteCmd = {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Invite the bot to your server and join the support community.'),
    prefix: 'invite',
    async execute(interaction) {
        await interaction.reply(buildInviteCard());
    },
    async prefixExecute(message) {
        await message.reply(buildInviteCard());
    },
};

export const supportCmd = {
    data: new SlashCommandBuilder()
        .setName('support')
        .setDescription('Need help? Join the support server or invite the bot.'),
    prefix: 'support',
    async execute(interaction) {
        await interaction.reply(buildSupportCard());
    },
    async prefixExecute(message) {
        await message.reply(buildSupportCard());
    },
};

function buildPremiumGrantedEmbed(displayUser, result, value, unit) {
    const duration = result.permanent
        ? 'Permanent access'
        : `${value} ${unit}${value === 1 ? '' : 's'}`;
    const expiry = result.permanent ? 'Never expires' : `Expires: ${formatPremiumExpiry(result.expiresAt, false)}`;

    return new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle(`__**${UI_EMOJI.prem} Premium Granted Successfully**__`)
        .setDescription(`Premium access has been granted to ${displayUser}.`)
        .addFields(
            { name: `${UI_EMOJI.time} Duration`, value: duration, inline: true },
            { name: `${UI_EMOJI.time} Status`, value: expiry, inline: true },
        )
        .setFooter({ text: 'Premium access is now active' });
}

async function buildPremiumListLines(items, client, offset = 0) {
    if (items.length === 0) return 'No premium users found.';

    const lines = await Promise.all(items.map(async (user, index) => {
        let username = 'Unknown User';
        try {
            const fetchedUser = await client?.users?.fetch(user.userId);
            username = fetchedUser?.globalName || fetchedUser?.username || fetchedUser?.tag || username;
        } catch {}
        return `${offset + index + 1}. ${username} | ${user.userId} • ${UI_EMOJI.time} ${user.permanent ? 'Permanent' : formatPremiumExpiry(user.expiresAt, false)} • by ${user.grantedBy}`;
    }));
    return lines.join('\n');
}

function buildPremiumPaginationButtons(page, pages, userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`premium_prev_${userId}`)
            .setLabel(`${getEmoji('previous')} Previous`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1),
        new ButtonBuilder()
            .setCustomId(`premium_page_${userId}`)
            .setLabel(`Page ${page}/${pages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`premium_next_${userId}`)
            .setLabel(`Next ${getEmoji('next')}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= pages),
    );
}

export const premiumCmd = {
    data: new SlashCommandBuilder()
        .setName('premium')
        .setDescription('Owner premium access management for premium commands.')
        .addSubcommand((sub) => sub
            .setName('list')
            .setDescription('List all premium users'))
        .addSubcommand((sub) => sub
            .setName('add')
            .setDescription('Grant premium access to a user')
            .addStringOption((opt) => opt.setName('userid').setDescription('User ID to grant premium to').setRequired(true))
            .addIntegerOption((opt) => opt.setName('value').setDescription('Duration value (optional for permanent)').setRequired(false))
            .addStringOption((opt) => opt.setName('unit').setDescription('s, min, h, d, w, m, y, p').setRequired(false)))
        .addSubcommand((sub) => sub
            .setName('remove')
            .setDescription('Remove premium access from a user')
            .addStringOption((opt) => opt.setName('userid').setDescription('User ID to remove premium from').setRequired(true)))
        .addSubcommand((sub) => sub
            .setName('alltime')
            .setDescription('Grant permanent premium to all members in this server')),
    prefix: 'premium',
    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            await interaction.reply({ content: `${getEmoji('error')} This command is owner-only.`, flags: MessageFlags.Ephemeral });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'alltime') {
            if (!interaction.guild) {
                await interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const members = await interaction.guild.members.fetch();
            const userIds = members.filter((member) => !member.user?.bot).map((member) => member.user.id);
            const result = addPermanentPremiumAccessForUsers(userIds, interaction.user.id);
            await interaction.editReply({ embeds: [new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle(`__**${UI_EMOJI.prem} Premium Granted to Server Members**__`)
                .setDescription(`${UI_EMOJI.time} Permanent premium access granted to **${result.count}** members.`)
                .setFooter({ text: 'These members can now use premium commands.' })] });
            return;
        }

        if (subcommand === 'list') {
            const items = listPremiumAccess();
            const lines = await buildPremiumListLines(items, interaction.client);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFFFFFF).setTitle(`__**${UI_EMOJI.prem} Premium Access • ${items.length} users**__`).setDescription(`\`\`\`\n${lines}\n\`\`\``)] });
            return;
        }

        if (subcommand === 'add') {
            const rawValue = interaction.options.getInteger('value');
            const rawUnit = (interaction.options.getString('unit') ?? '').trim().toLowerCase();
            const userInput = String(interaction.options.getString('userid') ?? '').trim();
            const userId = normalizePremiumUserId(userInput);
            const permanentUnits = new Set(['p', 'permanent', 'perm', 'forever', 'never', 'life', 'lifetime']);
            const isPermanent = permanentUnits.has(rawUnit) || (rawValue === null && !rawUnit);

            if (!userId) {
                await interaction.reply({ content: 'Usage: `/premium add [value] [s|min|h|d|mo|y|permanent] userid` or use a Discord mention like `<@123456789012345678>`' });
                return;
            }

            if (rawValue === null && rawUnit && !permanentUnits.has(rawUnit)) {
                await interaction.reply({ content: 'Invalid duration. Add a value for temporary access, for example `7 day`, or use `permanent`.' });
                return;
            }

            const result = addPremiumAccess(userId, isPermanent ? 0 : (rawValue ?? 1), isPermanent ? 'permanent' : (rawUnit || 'day'), interaction.user.id);
            if (!result.ok) {
                await interaction.reply({ content: result.error });
                return;
            }

            const displayUser = userInput.startsWith('<@') ? userInput : `<@${userId}>`;
            await interaction.reply({ embeds: [buildPremiumGrantedEmbed(displayUser, result, rawValue ?? 1, rawUnit || 'day')] });
            return;
        }

        if (subcommand === 'remove') {
            const userInput = String(interaction.options.getString('userid') ?? '').trim();
            const userId = normalizePremiumUserId(userInput);
            if (!userId) {
                await interaction.reply({ content: 'Usage: `/premium remove userid` or use a Discord mention like `<@123456789012345678>`' });
                return;
            }

            const removed = removePremiumAccess(userId);
            const displayUser = userInput.startsWith('<@') ? userInput : `<@${userId}>`;
            await interaction.reply({ content: removed ? `${UI_EMOJI.success} Premium removed from ${displayUser}.` : `${UI_EMOJI.warning} No premium access found for ${displayUser}.` });
            return;
        }

        await interaction.reply({ content: 'Use `/premium add`, `/premium remove`, or `/premium list`.' });
    },
    async prefixExecute(message, args) {
        if (!(await requireOwner(message))) return;

        const [action, ...rest] = args;
        const normalizedAction = String(action ?? '').toLowerCase();
        if (!action || normalizedAction === 'list') {
            const items = listPremiumAccess();
            const pageSize = 20;
            const pages = Math.max(1, Math.ceil(items.length / pageSize));
            let currentPage = Number(rest[0] ?? 1);
            currentPage = Number.isFinite(currentPage) && currentPage > 0 ? Math.min(currentPage, pages) : 1;
            const start = (currentPage - 1) * pageSize;
            const pageItems = items.slice(start, start + pageSize);
            const lines = await buildPremiumListLines(pageItems, message.client, start);
            const reply = await message.reply({
                embeds: [new EmbedBuilder().setColor(0xFFFFFF).setTitle(`__**${UI_EMOJI.prem} Premium Access • ${items.length} users • Page ${currentPage}/${pages}**__`).setDescription(`\`\`\`\n${lines}\n\`\`\``)],
                components: [buildPremiumPaginationButtons(currentPage, pages, message.author.id)],
            }).catch(() => null);
            if (!reply) return;

            const collector = reply.createMessageComponentCollector({
                filter: (interaction) => interaction.user.id === message.author.id
                    && (interaction.customId === `premium_prev_${message.author.id}` || interaction.customId === `premium_next_${message.author.id}`),
                time: 5 * 60 * 1000,
            });
            collector.on('collect', async (interaction) => {
                const isPrevious = interaction.customId === `premium_prev_${message.author.id}`;
                if ((isPrevious && currentPage <= 1) || (!isPrevious && currentPage >= pages)) {
                    await interaction.deferUpdate().catch(() => {});
                    return;
                }
                currentPage += isPrevious ? -1 : 1;
                const nextStart = (currentPage - 1) * pageSize;
                const nextItems = items.slice(nextStart, nextStart + pageSize);
                const nextLines = await buildPremiumListLines(nextItems, message.client, nextStart);
                await interaction.update({
                    embeds: [new EmbedBuilder().setColor(0xFFFFFF).setTitle(`__**${UI_EMOJI.prem} Premium Access • ${items.length} users • Page ${currentPage}/${pages}**__`).setDescription(`\`\`\`\n${nextLines}\n\`\`\``)],
                    components: [buildPremiumPaginationButtons(currentPage, pages, message.author.id)],
                }).catch(() => {});
            });
            return;
        }

        if (normalizedAction === 'all') {
            if (!message.guild) {
                await message.reply('This command can only be used inside a server.').catch(() => {});
                return;
            }

            try {
                const members = await message.guild.members.fetch();
                const userIds = members.filter((member) => !member.user?.bot).map((member) => member.user.id);
                const durationArgs = (String(rest[0] ?? '').toLowerCase() === 'time' ? rest.slice(1) : rest).filter(Boolean);
                let value = 0;
                let unit = 'permanent';

                if (durationArgs.length > 0) {
                    const compactMatch = durationArgs[0].toLowerCase().match(/^(\d+(?:\.\d+)?)(second|seconds|sec|secs|s|minute|minutes|min|mins|hour|hours|hr|hrs|h|day|days|d|week|weeks|w|month|months|mon|mo|m|year|years|yr|yrs|y)$/);
                    if (compactMatch) {
                        value = Number(compactMatch[1]);
                        unit = compactMatch[2];
                    } else if (durationArgs.length <= 2 && /^\d+(?:\.\d+)?$/.test(durationArgs[0])) {
                        value = Number(durationArgs[0]);
                        unit = String(durationArgs[1] ?? 'day').toLowerCase();
                    } else if (durationArgs.length === 1 && /^[a-z]+$/i.test(durationArgs[0])) {
                        value = 1;
                        unit = durationArgs[0].toLowerCase();
                    } else {
                        await message.reply('Usage: `;premium all [value] [s|min|h|d|w|mo|y]` or `;premium all` for permanent access.').catch(() => {});
                        return;
                    }

                    if (!parsePremiumDuration(value, unit)) {
                        await message.reply('Invalid duration. Use examples like `7 day`, `1 week`, `1 month`, or `1 year`.').catch(() => {});
                        return;
                    }
                }

                const result = durationArgs.length > 0
                    ? addPremiumAccessForUsers(userIds, value, unit, message.author.id)
                    : addPermanentPremiumAccessForUsers(userIds, message.author.id);
                const durationText = result.permanent ? 'Permanent' : `${value} ${unit}`;
                await message.reply({ embeds: [new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle(`__**${UI_EMOJI.prem} Premium Granted to Server Members**__`)
                    .setDescription(`${UI_EMOJI.time} ${durationText} premium access granted to **${result.count}** members.`)
                    .setFooter({ text: 'These members can now use premium commands.' })] }).catch(() => {});
            } catch {
                await message.reply('I could not fetch all server members. Please enable the Server Members Intent for the bot.').catch(() => {});
            }
            return;
        }

        if (normalizedAction === 'add') {
            const raw = rest.filter(Boolean);
            if (raw.length === 0) {
                const usageEmbed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle(`__**${UI_EMOJI.prem} Premium Usage**__`)
                    .setDescription([
                        'Usage: `;premium add <value><unit> <userId>`',
                        'Units: `second/s`, `minute/min`, `hour/h`, `day/d`, `week/w`, `month/m`, `year/y`, `permanent/p`',
                        'Example: `;premium add 1m <@123456789012345678>`',
                        'Example: `;premium add p <@123456789012345678>`',
                        'Mention works too: `;premium add permanent <@123456789012345678>`',
                        '',
                        'Usage: `;premium remove <userId>`',
                    ].join('\n'))
                    .setFooter({ text: 'Need help? Join our support server.' });

                await message.reply({ embeds: [usageEmbed], components: supportComponents() }).catch(() => {});
                return;
            }

            const compactMatch = String(raw[0] ?? '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(second|seconds|sec|secs|s|minute|minutes|min|mins|hour|hours|hr|hrs|h|day|days|d|week|weeks|w|month|months|mon|mo|m|year|years|yr|yrs|y)$/);
            const hasPermanentKeyword = ['p', 'perm', 'permanent', 'forever', 'never', 'lifetime', 'life'].includes(String(raw[0]).trim().toLowerCase());
            let value = 0;
            let unit = 'permanent';
            let userInput = ''; 

            if (hasPermanentKeyword) {
                userInput = String(raw[1] ?? '').trim();
            } else if (compactMatch) {
                value = Number(compactMatch[1]);
                unit = compactMatch[2];
                userInput = String(raw[1] ?? '').trim();
            } else {
                if (raw.length >= 3) {
                    value = Number(raw[0]);
                    unit = String(raw[1]).trim().toLowerCase();
                    userInput = String(raw[2]).trim();
                } else if (raw.length === 2) {
                    value = Number(raw[0]);
                    unit = 'day';
                    userInput = String(raw[1]).trim();
                } else {
                    await message.reply({ content: 'Usage: `;premium add <value><s|min|h|d|w|m|y> <userId>` or `;premium add p <userId>`' }).catch(() => {});
                    return;
                }
            }

            const userId = normalizePremiumUserId(userInput);
            if (!userId) {
                const usageEmbed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle(`__**${UI_EMOJI.prem} Premium Usage**__`)
                    .setDescription([
                        'Usage: `;premium add <value><unit> <userId>`',
                        'Units: `second/s`, `minute/min`, `hour/h`, `day/d`, `week/w`, `month/m`, `year/y`, `permanent/p`',
                        'Example: `;premium add 1m <@123456789012345678>`',
                        'Example: `;premium add p <@123456789012345678>`',
                        'Mention works too: `;premium add permanent <@123456789012345678>`',
                        '',
                        'Usage: `;premium remove <userId>`',
                    ].join('\n'))
                    .setFooter({ text: 'Need help? Join our support server.' });

                await message.reply({ embeds: [usageEmbed], components: supportComponents() }).catch(() => {});
                return;
            }

            const result = addPremiumAccess(userId, hasPermanentKeyword ? 0 : value, hasPermanentKeyword ? 'permanent' : unit, message.author.id);
            if (!result.ok) {
                await message.reply({ content: result.error }).catch(() => {});
                return;
            }

            const displayUser = userInput.startsWith('<@') ? userInput : `<@${userId}>`;
            await message.reply({ embeds: [buildPremiumGrantedEmbed(displayUser, result, value, unit)] }).catch(() => {});
            return;
        }

        if (normalizedAction === 'remove') {
            const userInput = String(rest[0] ?? '').trim();
            const userId = normalizePremiumUserId(userInput);
            if (!userId) {
                const usageEmbed = new EmbedBuilder()
                    .setColor(0xFFFFFF)
                    .setTitle(`__**${UI_EMOJI.prem} Premium Usage**__`)
                    .setDescription([
                        'Usage: `;premium remove <userId>`',
                        'Mention works too: `;premium remove <@123456789012345678>`',
                        '',
                        'Example: `;premium remove 123456789012345678`',
                    ].join('\n'))
                    .setFooter({ text: 'Need help? Join our support server.' });

                await message.reply({ embeds: [usageEmbed], components: supportComponents() }).catch(() => {});
                return;
            }

            const removed = removePremiumAccess(userId);
            const displayUser = userInput.startsWith('<@') ? userInput : `<@${userId}>`;
            await message.reply({ content: removed ? `${UI_EMOJI.success} Premium removed from ${displayUser}.` : `${UI_EMOJI.warning} No premium access found for ${displayUser}.` }).catch(() => {});
            return;
        }

        const usageEmbed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(`__**${UI_EMOJI.prem} Premium Usage**__`)
            .setDescription([
                'Usage: `;premium add <value> <s|min|h|d|mo|y|permanent> <userId>`',
                'Example: `;premium add 7 d 123456789012345678`',
                'Example: `;premium add permanent 123456789012345678`',
                '',
                'Usage: `;premium remove <userId>`',
            ].join('\n'))
            .setFooter({ text: 'Need help? Join our support server.' });

        const supportButton = new ButtonBuilder()
            .setLabel('Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(SUPPORT_SERVER_INVITE);

        await message.reply({ embeds: [usageEmbed], components: [new ActionRowBuilder().addComponents(supportButton)] }).catch(() => {});
    },
};

function getBotInviteUrl() {
    return BOT_INVITE_URL;
}

function buildInviteCard() {
    const embed = new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle(`__**${UI_EMOJI.spark} Invite the Bot**__`)
        .setDescription([
            'Use the button below to invite this bot to your own Discord server.',
            '',
            'You can also join the support server if you need help or want to ask questions.',
        ].join('\n'))
        .setFooter({ text: 'Invite the bot to your server in one click.' });

    const buttons = [];
    const botInviteUrl = getBotInviteUrl();
    if (botInviteUrl) {
        buttons.push(new ButtonBuilder()
            .setLabel('Invite Bot')
            .setStyle(ButtonStyle.Link)
            .setURL(botInviteUrl));
    }
    if (SUPPORT_SERVER_INVITE) {
        buttons.push(new ButtonBuilder()
            .setLabel('Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(SUPPORT_SERVER_INVITE));
    }

    return {
        embeds: [embed],
        components: buttons.length > 0 ? [new ActionRowBuilder().addComponents(buttons)] : [],
    };
}

function buildSupportCard() {
    const embed = new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle(`__**${UI_EMOJI.support} Need Help?**__`)
        .setDescription([
            'If you are facing any problem with the bot, please join our support server for quick help.',
            '',
            'We will help you fix issues, guide you through setup, and answer your questions.',
        ].join('\n'))
        .setFooter({ text: 'Need assistance? We are here to help you.' });

    const buttons = [];
    const botInviteUrl = getBotInviteUrl();
    if (SUPPORT_SERVER_INVITE) {
        buttons.push(new ButtonBuilder()
            .setLabel('Support Server')
            .setStyle(ButtonStyle.Link)
            .setURL(SUPPORT_SERVER_INVITE));
    }
    if (botInviteUrl) {
        buttons.push(new ButtonBuilder()
            .setLabel('Invite Bot')
            .setStyle(ButtonStyle.Link)
            .setURL(botInviteUrl));
    }

    return {
        embeds: [embed],
        components: buttons.length > 0 ? [new ActionRowBuilder().addComponents(buttons)] : [],
    };
}

function isOwner(userId) {
    return isOwnerUserId(userId);
}

async function requireOwner(message) {
    if (!isOwner(message.author.id)) {
        await message.reply({ content: `${getEmoji('error')} This command is owner-only.`, allowedMentions: { repliedUser: false } }).catch(() => {});
        return false;
    }
    return true;
}

export async function hasPremiumRole(userId, client, currentMember = null) {
    if (!client || PREMIUM_ROLE_IDS.length === 0) return false;
    if (PREMIUM_ROLE_IDS.some((roleId) => currentMember?.roles?.cache?.has(roleId))) return true;

    const members = await Promise.all([...client.guilds.cache.values()].map(async (guild) => (
        guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null)
    )));
    return members.some((member) => PREMIUM_ROLE_IDS.some((roleId) => member?.roles?.cache?.has(roleId)));
}

async function canUsePremiumFeature(userId, member, client, guildId = null) {
    return isOwner(userId)
        || hasBypass(userId)
        || hasPremiumAccess(userId)
        || hasGuildPremium(userId, guildId)
        || await hasPremiumRole(userId, client, member);
}

async function hasFullPremiumAccess(userId, member, client, guildId = null) {
    return isOwner(userId)
        || hasBypass(userId)
        || (hasPremiumAccess(userId) && !isTrialPremium(userId))
        || hasGuildPremium(userId, guildId)
        || await hasPremiumRole(userId, client, member);
}

async function getAccountSlotLimit(userId, member, client, guildId = null) {
    if (isOwner(userId) || hasBypass(userId)) return PREMIUM_ACCOUNT_LIMIT;
    if (hasPremiumAccess(userId)) {
        if (isTrialPremium(userId)) return 1;
        return PREMIUM_ACCOUNT_LIMIT;
    }
    if (hasGuildPremium(userId, guildId)) return GUILD_PREMIUM_ACCOUNT_LIMIT;
    if (await hasPremiumRole(userId, client, member)) return PREMIUM_ROLE_ACCOUNT_LIMIT;
    return 1;
}

async function requirePremium(userId, sendReply, commandName = 'this command', client) {
    if (await canUsePremiumFeature(userId, null, client)) return true;

    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
    c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `# ${UI_EMOJI.premium} Premium Required\n**${commandName}** is available to premium members only.\n\nAsk the bot owner to grant access with \`${PREFIX}premium add <number> <day|month|year|permanent> <userId>\`.`,
        ),
    );
    addSupportButton(c);
    await sendReply({ components: [c], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    return false;
}



// ── Link / Unlink ──────────────────────────────────────────────────────────

export const linkCmd = {
    data: new SlashCommandBuilder().setName('link').setDescription('Save your Discord token so you never have to enter it again'),
    prefix: 'link',

    async execute(interaction, client) {
        const accountSlots = await getAccountSlotLimit(interaction.user.id, interaction.member, client, interaction.guildId);
        const showAccountPanel = accountSlots > 1 || isTrialPremium(interaction.user.id);
        await interaction.reply(showAccountPanel ? await buildAccountPanel(interaction.user.id, client.tokenStore, accountSlots) : buildLinkPrompt(true));
    },

    async prefixExecute(message, args, client) {
        const ts = client.tokenStore;
        const inlineToken = args.join('').trim();
        const fullPremium = await hasFullPremiumAccess(message.author.id, message.member, client, message.guild?.id);
        const accountSlots = await getAccountSlotLimit(message.author.id, message.member, client, message.guild?.id);
        const showAccountPanel = accountSlots > 1 || isTrialPremium(message.author.id);

        if (inlineToken) {
            try { await message.delete(); } catch {}
            const token = sanitizeToken(inlineToken);

            const sendDM = async (payload) => {
                const user = await client.users.fetch(message.author.id).catch(() => null);
                const dm = await user?.createDM().catch(() => null);
                await dm?.send(payload).catch(() => {});
            };

            if (!isValidUserToken(token)) {
                await sendDM((() => {
                    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
                    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.error} Invalid Token Format\nThat doesn't look like a valid Discord token. Copy the **Authorization** header value exactly.`));
                    return { components: [c], flags: MessageFlags.IsComponentsV2 };
                })());
                return;
            }

            let accountId = '', accountName = '', accountAvatarUrl = '', verifyOk = false;
            try {
                const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: token } });
                verifyOk = res.ok;
                if (res.ok) {
                    const data = await res.json();
                    accountId = data.id;
                    accountName = data.global_name || data.username || '';
                    accountAvatarUrl = discordUserAvatarUrl(data);
                }
            } catch {}

            if (!verifyOk) {
                await sendDM((() => {
                    const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
                    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.error} Token Rejected by Discord\nMake sure you copied the \`Authorization\` header and try again.`));
                    return { components: [c], flags: MessageFlags.IsComponentsV2 };
                })());
                return;
            }

            if (!isTrialAccountToken(message.author.id, accountId, fullPremium)) {
                await sendDM({ content: 'Trial accounts can only link their own Discord account.' });
                return;
            }

            if (await accountLimit(message.author.id, ts, accountSlots)) {
                await sendDM({ content: accountSlots > 1 ? `All ${accountSlots} account slots are already linked. Use \`;link\` and switch or unlink an account first.` : 'Your account is already linked. Premium users can link more accounts.' });
                return;
            }
            const slot = (await ts.getAccounts(message.author.id)).length;
            await ts.saveAccount(message.author.id, slot, token, message.author.globalName || message.author.username || message.author.tag, accountAvatarUrl, accountId, accountName);
            const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
            c.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `# ${UI_EMOJI.success} Token Linked!\nLinked as **"${accountName}"**.\n\nYou can now use \`${PREFIX}quest\`, \`${PREFIX}questall\`, and \`${PREFIX}questlist\`.\nTo remove it, use \`${PREFIX}unlink\`.`,
                ),
            );
            await sendDM({ components: [c], flags: MessageFlags.IsComponentsV2 });
            return;
        }

        await message.reply(showAccountPanel ? await buildAccountPanel(message.author.id, ts, accountSlots) : buildLinkPrompt(true));
    },
};

export const unlinkCmd = {
    data: new SlashCommandBuilder().setName('unlink').setDescription('Remove your saved Discord token'),
    prefix: 'unlink',

    async execute(interaction, client) {
        const ts = client.tokenStore;
        const removed = await ts.remove(interaction.user.id);
        disableAutoquest(interaction.user.id);
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                removed
                    ? `# ${UI_EMOJI.unlock} Token Unlinked\nYour saved token has been removed.`
                    : `# No Token Saved\nYou don't have a saved token.`,
            ),
        );
        await interaction.reply({ components: [c], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    },

    async prefixExecute(message, _args, client) {
        const ts = client.tokenStore;
        const removed = await ts.remove(message.author.id);
        disableAutoquest(message.author.id);
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                removed
                    ? `# ${UI_EMOJI.unlock} Token Unlinked\nYour saved token has been removed.`
                    : `# No Token Saved\nYou don't have a saved token.`,
            ),
        );
        await message.reply({ components: [c], flags: MessageFlags.IsComponentsV2 });
    },
};

// ── Modal Submit Handler (called from interactionCreate) ───────────────────
export async function handleLinkModal(interaction, client) {
    const ts = client.tokenStore;
    const fullPremium = await hasFullPremiumAccess(interaction.user.id, interaction.member, client, interaction.guildId);
    const accountSlots = await getAccountSlotLimit(interaction.user.id, interaction.member, client, interaction.guildId);
    const [modalId, sourceMessageId] = interaction.customId.split(':');
    const requestedSlot = modalId.startsWith('link_token_modal_')
        ? Number(modalId.replace('link_token_modal_', ''))
        : null;
    const existingAccounts = await ts.getAccounts(interaction.user.id);
    const maxSlots = accountSlots;
    if (requestedSlot !== null && (!Number.isInteger(requestedSlot) || requestedSlot < 0 || requestedSlot >= maxSlots || existingAccounts.some((account) => account.slot === requestedSlot))) {
        await interaction.reply({ content: 'That account slot is not available.', flags: MessageFlags.Ephemeral });
        return;
    }
    if (await accountLimit(interaction.user.id, ts, accountSlots)) {
        await interaction.reply({ content: accountSlots > 1 ? `All ${accountSlots} account slots are already linked. Switch or unlink an account first.` : 'Your account is already linked. Premium users can link more accounts.', flags: MessageFlags.Ephemeral });
        return;
    }
    const raw = interaction.fields.getTextInputValue('link_token_input');
    const token = sanitizeToken(raw);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isValidUserToken(token)) {
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.error} Invalid Token Format\nThat doesn't look like a valid Discord token. Copy the **Authorization** header value exactly.`));
        await interaction.editReply({ components: [c], flags: MessageFlags.IsComponentsV2 });
        return;
    }

    let accountId = '', accountName = '', accountAvatarUrl = '', verifyOk = false;
    try {
        const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: token } });
        verifyOk = res.ok;
        if (res.ok) {
            const data = await res.json();
            accountId = data.id;
            accountName = data.global_name || data.username || '';
            accountAvatarUrl = discordUserAvatarUrl(data);
        }
    } catch {}

    if (!verifyOk) {
        const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
        c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.error} Token Rejected by Discord\nMake sure you copied the \`Authorization\` header and try again.`));
        await interaction.editReply({ components: [c], flags: MessageFlags.IsComponentsV2 });
        return;
    }

    if (!isTrialAccountToken(interaction.user.id, accountId, fullPremium)) {
        await interaction.editReply({ content: 'Trial accounts can only link their own Discord account.' });
        return;
    }

    const slot = Number.isInteger(requestedSlot)
        ? requestedSlot
        : Array.from({ length: accountSlots }, (_, candidate) => candidate).find((candidate) => !existingAccounts.some((account) => account.slot === candidate));
    await ts.saveAccount(
        interaction.user.id,
        slot,
        token,
        interaction.user.globalName || interaction.user.username || interaction.user.tag,
        accountAvatarUrl,
        accountId,
        accountName,
    );
    const updatedPanel = await buildAccountPanel(interaction.user.id, ts, accountSlots);
    const sourceMessage = interaction.message
        ?? (sourceMessageId && interaction.channel?.messages?.cache?.get(sourceMessageId));
    if (sourceMessage?.editable) {
        await sourceMessage.edit(updatedPanel).catch(() => {});
        const success = new ContainerBuilder().setAccentColor(0xFFFFFF);
        success.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `# ${UI_EMOJI.success} Token Linked!\nLinked as **"${accountName}"**.\n\nYou can now use \`${PREFIX}quest\`, \`${PREFIX}questall\`, and \`${PREFIX}questlist\`.\nTo remove it, use \`${PREFIX}unlink\`.`,
            ),
        );
        await interaction.editReply({ components: [success], flags: MessageFlags.IsComponentsV2 });
    } else {
        await interaction.editReply({
            ...updatedPanel,
            components: [
                new TextDisplayBuilder().setContent(
                    `# ${UI_EMOJI.success} Token Linked!\nLinked as **"${accountName}"**.`,
                ),
                ...updatedPanel.components,
            ],
        });
    }
}

// ── Button: link_prompt handler (called from interactionCreate) ────────────
export async function handleLinkPromptButton(interaction) {
    try {
        await interaction.showModal(buildLinkModal('', interaction.message?.id));
    } catch (err) {
        if (err?.code === 10062 || err?.code === 40060 || err?.status === 404) return;
        throw err;
    }
}

export async function handleAccountButton(interaction, client) {
    const [action, userId, slotText] = interaction.customId.split(':');
    if (interaction.user.id !== userId) {
        await interaction.reply({ content: 'This account panel belongs to another user.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (action === 'account_link') {
        try {
            await interaction.showModal(buildLinkModal(Number(slotText), interaction.message?.id));
        } catch (err) {
            if (err?.code === 40060 || /already been acknowledged/i.test(String(err?.message ?? ''))) return;
            throw err;
        }
        return;
    }

    if (action === 'account_unlink') {
        const removed = await client.tokenStore.removeAccount(userId, slotText);
        if (removed && !await client.tokenStore.has(userId)) disableAutoquest(userId);
        await interaction.update(await buildAccountPanel(userId, client.tokenStore, await getAccountSlotLimit(userId, interaction.member, client, interaction.guildId)));
        return;
    }

    const switched = await client.tokenStore.switchAccount(userId, slotText);
    await interaction.update(await buildAccountPanel(userId, client.tokenStore, await getAccountSlotLimit(userId, interaction.member, client, interaction.guildId)));
    if (!switched) return;
}

// ── AutoQuest runner (called from questWatcher) ────────────────────────────
export async function runAutoquestForUser(userId, quest, tokenStore, discordClient, existingManager = null) {
    const token = await tokenStore.get(userId);
    if (!token) { disableAutoquest(userId); return; }
    if (activeQuestUsers.has(userId)) return false;
    activeQuestUsers.add(userId);

    const { QuestClient: QC } = await import('../quest/questClient.js');
    const { Quest: Q } = await import('../quest/quest.js');
    const qc = new QC(token);
    const logs = [];
    const log = (m) => { console.log(`[AutoQuest:${userId}]`, m); logs.push(m); };

    try {
        const manager = existingManager ?? await qc.fetchQuests();
        let live = manager.get(quest.id);
        if (!live) {
            live = Q.create({ id: quest.id, config: quest.config, user_status: null, targeted_content: quest.targetedContent, preview: quest.preview });
        }
        if (live.isCompleted() || live.isExpired()) return;

        const completed = await manager.doingQuest(live, log);
        if (!completed) return false;

        try {
            const user = await discordClient.users.fetch(userId);
            const dm = await user.createDM();
            const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
            c.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `# ${UI_EMOJI.bot} Auto-Quest Complete!\n**${live.config.messages.quest_name}** has been completed automatically.\n\nUse \`${PREFIX}autoquest\` to disable.`,
                ),
            );
            await dm.send({ components: [c], flags: MessageFlags.IsComponentsV2 });
        } catch {}

        return true;

    } catch (err) {
        const msg = err?.message ?? String(err);
        console.error(`[AutoQuest:${userId}] Error:`, msg);
        if (msg.includes('401')) {
            await tokenStore.remove(userId);
            disableAutoquest(userId);
            try {
                const user = await discordClient.users.fetch(userId);
                const dm = await user.createDM();
                const c = new ContainerBuilder().setAccentColor(0xFFFFFF);
                c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${UI_EMOJI.bot} Auto-Quest Paused\nYour saved token expired. Run \`${PREFIX}link\` to re-link, then \`${PREFIX}autoquest\` to re-enable.`));
                await dm.send({ components: [c], flags: MessageFlags.IsComponentsV2 });
            } catch {}
        }
    } finally {
        activeQuestUsers.delete(userId);
    }
}
