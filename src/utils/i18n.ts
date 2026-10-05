import { redisGet, redisSet } from '../services/redis.service';

export type Language = 'km' | 'en';

const userLanguages = new Map<number, Language>();

export function getUserLanguage(userId?: number): Language {
    if (!userId) return 'km';
    return userLanguages.get(userId) || 'km'; // Default language is Khmer
}

export function setUserLanguage(userId: number, lang: Language): void {
    userLanguages.set(userId, lang);
    if (userLanguages.size > 5000) {
        const oldest = userLanguages.keys().next().value;
        if (oldest) userLanguages.delete(oldest);
    }
    redisSet(`user:lang:${userId}`, lang, 30 * 86400).catch(() => {});
}

export async function loadUserLanguage(userId: number): Promise<Language> {
    if (userLanguages.has(userId)) {
        return userLanguages.get(userId)!;
    }
    const cached = await redisGet<Language>(`user:lang:${userId}`);
    if (cached === 'km' || cached === 'en') {
        userLanguages.set(userId, cached);
        return cached;
    }
    userLanguages.set(userId, 'km');
    return 'km';
}

const userNotifs = new Map<number, boolean>();

export function getUserNotificationPreference(userId?: number): boolean {
    if (!userId) return true;
    return userNotifs.get(userId) ?? true;
}

export function setUserNotificationPreference(userId: number, enabled: boolean): void {
    userNotifs.set(userId, enabled);
    if (userNotifs.size > 5000) {
        const oldest = userNotifs.keys().next().value;
        if (oldest) userNotifs.delete(oldest);
    }
    redisSet(`user:notif:${userId}`, enabled ? '1' : '0', 30 * 86400).catch(() => {});
}

export async function loadUserNotificationPreference(userId: number): Promise<boolean> {
    if (userNotifs.has(userId)) {
        return userNotifs.get(userId)!;
    }
    const cached = await redisGet<string>(`user:notif:${userId}`);
    const enabled = cached === null ? true : (cached === '1' || cached === 'true');
    userNotifs.set(userId, enabled);
    return enabled;
}

export const strings = {
    km: {
        welcome: (name: string) =>
            `🌟 <b>សួស្តី ${name}!</b> សូមស្វាគមន៍មកកាន់ <b>@sddaDCbOT</b>!\n\n` +
            `✨ <b>មុខងាររបស់អ្នក</b>៖\n` +
            `• 🤖 <b>AI Chat៖</b> សួរ សរសេរ និងទទួលជំនួយដោយ Gemini\n` +
            `• 🔊 <b>Text-to-Speech៖</b> បម្លែងអត្ថបទជាសំឡេង ១០ ភាសា (ខ្មែរ, អង់គ្លេស, ចិន, កូរ៉េ, ជប៉ុន, ហិណ្ឌី, ម៉ាឡេស៊ី, ឥណ្ឌូនេស៊ី, ហ្វីលីពីន, អារ៉ាប់)\n` +
            `• 📸 <b>Vision OCR៖</b> ស្រង់អក្សរពីរូបភាព\n` +
            `• 📧 <b>Temp Mail៖</b> ទទួលអ៊ីមែល និង OTP ជូនដំណឹងភ្លាមៗ\n` +
            `• 📥 <b>Media Downloader៖</b> ទាញយកពី TikTok, YouTube, Instagram និង Facebook\n\n` +
            `👇 <b>ជ្រើសរើសមុខងារមួយខាងក្រោមដើម្បីចាប់ផ្តើម</b>៖`,
        menu_ai_chat: '🤖 សន្ទនា AI',
        menu_tts: '🔊 បំប្លែងសំឡេង TTS',
        menu_voice: '🤖 សន្ទនា AI',
        menu_vision: '📸 ស្កេន OCR',
        menu_mail: '📧 អ៊ីមែលបណ្តោះអាសន្ន',
        menu_dl: '📥 ទាញយកវីដេអូ',
        menu_settings: '⚙️ ការកំណត់',
        menu_help: '💡 ជំនួយ & ណែនាំ',
        menu_donation: '☕ ឧបត្ថម្ភ (Donation)',
        menu_status: '⚡ ស្ថានភាពមុខងារ',
        btn_back: '🔴 ◀️ ថយក្រោយ (Back)',
        returned_main: '🌟 <b>ត្រឡប់មកម៉ឺនុយមេរួចរាល់!</b> ជ្រើសរើសមុខងារដែលអ្នកចង់ប្រើ៖',
        donation_msg: '🙏 <b>Thanks for Donation!</b>\n\n❤️ <i>សូមអរគុណសម្រាប់ការឧបត្ថម្ភ និងការគាំទ្រដល់ការអភិវឌ្ឍន៍ @sddaDCbOT!</i>',
        animation_ai: [
            '🧠 <b>AI កំពុងគិត...</b>\n<i>⚡ កំពុងវិភាគសំណួររបស់អ្នក ▰▱▱▱▱</i>',
            '🧠 <b>AI កំពុងគិត...</b>\n<i>🔍 កំពុងស្រាវជ្រាវ និងផ្ទៀងផ្ទាត់ ▰▰▰▱▱</i>',
            '✨ <b>AI កំពុងរៀបចំចម្លើយ...</b>\n<i>📝 កំពុងចងក្រងយ៉ាងក្បោះក្បាយ ▰▰▰▰▱</i>',
            '🚀 <b>ជិតរួចរាល់ហើយ...</b>\n<i>⚡ កំពុងបញ្ចប់ការឆ្លើយតប ▰▰▰▰▰</i>'
        ],
        animation_tts: ['🎙️ <b>កំពុងរៀបចំសំឡេង...</b> <i>សូមរង់ចាំ</i>', '🎙️ <b>កំពុងបង្កើតសំឡេងធម្មជាតិ...</b> ▰▰▱', '🔊 <b>ជិតរួចរាល់ហើយ...</b> ▰▰▰'],
        animation_voice: ['🎧 <b>កំពុងស្តាប់សារសំឡេង...</b>', '📝 <b>កំពុងសរសេរតាមសំឡេង...</b> ▰▰▱', '🧠 <b>AI កំពុងរៀបចំចម្លើយ...</b> ▰▰▰'],

        // AI Chat Feature
        ai_chat_title: '🤖 <b>សន្ទនាជាមួយ AI (Gemini 3.6 Flash)</b>\n⚡ <b>ស្ថានភាព (Status)៖</b> 🟢 <code>ONLINE [● ● ●]</code>\n\n💬 <b>សូមសរសេរសំណួរ ឬសន្ទនាជាមួយខ្ញុំនៅទីនេះ៖</b>\n• សួរពីចំណេះដឹងទូទៅ បច្ចេកវិទ្យា សរសេរកូដ និងការងារប្រចាំថ្ងៃ\n• ឬចុចសង្កត់លើរូបមេក្រូហ្វូនដើម្បីផ្ញើសារសំឡេង (Voice Note) AI នឹងស្តាប់ និងឆ្លើយតបវិញភ្លាមៗ! 🎧',

        // Direct TTS Feature
        tts_title: '🔊 <b>ស្ទូឌីយោបំប្លែងអក្សរទៅជាសំឡេង (Edge Neural TTS Studio)</b>\n⚡ <b>ស្ថានភាព (Status)៖</b> 🟢 <code>ONLINE [Studio Quality 96kbps]</code>\n\n🌍 <b>គាំទ្រ ១០ ភាសាជាផ្លូវការ (10 Languages Supported)៖</b>\n• 🇰🇭 ខ្មែរ • 🇺🇸 English • 🇨🇳 中文 • 🇰🇷 한국어 • 🇯🇵 日本語\n• 🇮🇳 हिन्दी • 🇲🇾 Melayu • 🇮🇩 Indonesia • 🇵🇭 Filipino • 🇸🇦 العربية\n\n📝 <b>សូមផ្ញើអត្ថបទដែលអ្នកចង់ឱ្យអាន៖</b>\n• ស្គាល់ភាសាស្វ័យប្រវត្តិ ឬប្រើ <code>/tts [ភាសា] [អត្ថបទ]</code>\n• មានជម្រើសសំឡេងប្រុស និងស្រីធម្មជាតិកម្រិត HD ✨',

        voice_title: '🤖 <b>សន្ទនាជាមួយ AI (Gemini 3.6 Flash)</b>\n⚡ <b>ស្ថានភាព (Status)៖</b> 🟢 <code>ONLINE [● ● ●]</code>\n\n💬 <b>សូមសរសេរសំណួរ ឬផ្ញើសារជាសំឡេងមកកាន់ទីនេះ៖</b>',
        voice_btn_km: '🇰🇭 សំឡេងខ្មែរ (Studio)',
        voice_btn_en: '🇺🇸 សំឡេងអង់គ្លេស (Neural)',
        voice_btn_guide: '🎙️ របៀបផ្ញើសារសំឡេង (Voice Note)',
        voice_note_listening: '🎧 <b>[ ▰▱▱▱▱ 25% ]</b> <i>កំពុងស្តាប់សារសំឡេងរបស់អ្នក និងគិតរកចម្លើយ...</i>',
        voice_transcription: '📝 <b>ការសរសេរតាមសំឡេង៖</b>',
        voice_response: '🤖 <b>ចម្លើយពី AI៖</b>',
        listen_km: '🔊 ស្តាប់ជាភាសាខ្មែរ',
        listen_en: '🔊 ស្តាប់ជាភាសាអង់គ្លេស',

        // Vision OCR
        vision_info: '📸 <b>ស្កេនរូបភាព & បកប្រែជាភាសាខ្មែរ</b>\n⚡ <b>ស្ថានភាព (Status)៖</b> 🟢 <code>OCR READY [● ● ●]</code>\n\nគ្រាន់តែផ្ញើរូបថត ឯកសារ ឬបង្កាន់ដៃមកទីនេះ! Gemini 3.6 Vision នឹងស្រង់អក្សរចេញ និងមានប៊ូតុងបកប្រែជាភាសាខ្មែរជូនភ្លាមៗ! 🪄',
        vision_analyzing: '🔍 <b>[ ▰▱▱▱▱ 25% ]</b> <i>កំពុងវិភាគរូបភាពដោយប្រើ Gemini Vision OCR...</i>',
        vision_result: '✨ <b>អត្ថបទដែលស្រង់បាន៖</b>',
        vision_translate_btn: '🌐 បកប្រែជាភាសាខ្មែរ',
        vision_translating: 'កំពុងបកប្រែជាភាសាខ្មែរ... 🪄',
        vision_translated_title: '🇰🇭 <b>អត្ថបទបកប្រែជាភាសាខ្មែរ៖</b>',

        // Temp Mail
        mail_title: '📧 <b>អ៊ីមែលបណ្តោះអាសន្ន (Temp Mail)</b>\n⚡ <b>ស្ថានភាព (Status)៖</b> 🟢 <code>WATCHING (4s Pulse ⚡)</code>',
        mail_current_addr: '📬 <b>អាសយដ្ឋានអ៊ីមែលបច្ចុប្បន្នរបស់អ្នក៖</b>',
        mail_copy_hint: '<i>(ចុចលើអក្សរដើម្បីចម្លង)</i>',
        mail_count: (count: number) => `📊 <b>សារក្នុងប្រអប់៖</b> ${count} សារ`,
        mail_realtime_badge: '🟢 <b>ប្រព័ន្ធ Realtime៖</b> កំពុងដំណើរការ <i>(ជូនដំណឹងភ្លាមៗពេលមានសារថ្មី)</i>',
        mail_empty_hint: '📭 <i>មិនទាន់មានសារនៅឡើយទេ។ ប្រើអ៊ីមែលនេះដើម្បីចុះឈ្មោះលើវេបសាយ ឬទទួលកូដ — ពេលមានអ៊ីមែលផ្ញើមក អ្នកនឹងទទួលបានសារដំណឹងភ្លាមៗ!</i>',
        mail_btn_refresh: '🔄 ពិនិត្យសារថ្មី',
        mail_btn_new: '🎲 បង្កើតអ៊ីមែលថ្មី',
        mail_btn_delete: '🗑️ លុបអ៊ីមែលចោល',
        mail_btn_read: (idx: number, subject: string) => `📖 អាន #${idx}: ${subject}`,
        mail_btn_back: '🔴 ◀️ ថយក្រោយ (Back)',
        mail_alert_title: '🔔 <b>ទទួលបានអ៊ីមែលថ្មី!</b>',
        mail_otp_label: '🔑 <b>លេខកូដផ្ទៀងផ្ទាត់ (OTP)៖</b>',
        mail_from_label: '👤 <b>ផ្ញើពី៖</b>',
        mail_subject_label: '📌 <b>ប្រធានបទ៖</b>',
        mail_time_label: '🕒 <b>ពេលវេលា៖</b>',
        mail_preview_label: '📄 <b>ខ្លឹមសារសង្ខេប៖</b>',

        // Downloader
        dl_guide_title: '📥 <b>ប្រព័ន្ធទាញយកវីដេអូគ្រប់បណ្តាញ (Media Downloader)</b>\n⚡ <b>ស្ថានភាព (Status)៖</b> 🟢 <code>ULTRA-SPEED [● ● ●]</code>',
        dl_guide_body: 
            'គ្រាន់តែចម្លង និងផ្ញើតំណភ្ជាប់ (Link) វីដេអូមកទីនេះ៖\n\n' +
            '• 🎵 <b>TikTok៖</b> វីដេអូធម្មតា និងតំណខ្លី (<code>vt.tiktok.com</code>)\n' +
            '• 🔴 <b>YouTube៖</b> វីដេអូទូទៅ និង Shorts\n' +
            '• 📸 <b>Instagram៖</b> Reels, វីដេអូ និងផុស\n' +
            '• 🔵 <b>Facebook៖</b> Reels, វីដេអូសាធារណៈ និង Watch\n\n' +
            '✨ <i>មិនបាច់ប្រើ Command អ្វីទាំងអស់ — គ្រាន់តែបិទភ្ជាប់ Link នោះខ្ញុំនឹងទាញយកវីដេអូច្បាស់ជូនភ្លាមៗ!</i>',
        dl_fetching: '⏳ <b>[ ▰▱▱▱▱ 20% ]</b> <i>រកឃើញតំណភ្ជាប់! កំពុងចាប់ផ្តើមទាញយកវីដេអូ...</i>',
        dl_success: '🎬 <b>នេះជាវីដេអូរបស់អ្នក!</b>',
        dl_failed: '🥺 មិនអាចទាញយកវីដេអូនោះបានទេ (អាចជាវីដេអូឯកជន ឬទំហំធំជាង 50MB)។',

        // Settings
        settings_title: '⚙️ <b>ការកំណត់ប្រព័ន្ធ (Bot Settings)</b>\n\nកែសម្រួលការប្រើប្រាស់របស់អ្នក៖',
        settings_btn_voice: '🗣️ សំឡេងលំនាំដើម',
        settings_btn_lang: '🌐 ជ្រើសរើសភាសា (Language)',
        settings_btn_status: '⚡ ស្ថានភាពមុខងារ (Component Status)',
        settings_btn_gender: (g: 'male' | 'female') => g === 'male' ? '👨 សំឡេង៖ ប្រុស (Male)' : '👩 សំឡេង៖ ស្រី (Female)',
        settings_btn_notif: (on: boolean) => `🔔 ការជូនដំណឹង៖ ${on ? 'បើក (ON)' : 'បិទ (OFF)'}`,
        settings_lang_chosen: '✅ បានកំណត់ភាសាទៅជា <b>ភាសាខ្មែរ</b>។'
    },
    en: {
        welcome: (name: string) =>
            `🌟 <b>Hello ${name}!</b> Welcome to <b>@sddaDCbOT</b>.\n\n` +
            `✨ <b>What you can do</b>:\n` +
            `• 🤖 <b>AI Chat:</b> Ask questions, write, and get help\n` +
            `• 🔊 <b>Text-to-Speech:</b> Turn text into audio in 10 languages (Khmer, English, Chinese, Korean, Japanese, Hindi, Malay, Indonesian, Filipino, Arabic)\n` +
            `• 📸 <b>Vision OCR:</b> Extract text from images\n` +
            `• 📧 <b>Temp Mail:</b> Get disposable email and OTP alerts\n` +
            `• 📥 <b>Media Downloader:</b> Download from TikTok, YouTube, Instagram, and Facebook\n\n` +
            `👇 <b>Choose a feature below to get started</b>:`,
        menu_ai_chat: '🤖 AI Chat',
        menu_tts: '🔊 Text to Speech',
        menu_voice: '🤖 AI Chat',
        menu_vision: '📸 Vision OCR',
        menu_mail: '📧 Temp Mail',
        menu_dl: '📥 Media Downloader',
        menu_settings: '⚙️ Settings',
        menu_help: '💡 Help & Guide',
        menu_donation: '☕ Donation',
        menu_status: '⚡ Component Status',
        btn_back: '🔴 ◀️ Back',
        returned_main: '🌟 <b>Back to the main menu.</b> Choose a feature to continue:',
        donation_msg: '🙏 <b>Thanks for Donation!</b>\n\n❤️ <i>Your generous support helps keep @sddaDCbOT running and continuously improving!</i>',
        animation_ai: [
            '🧠 <b>AI is thinking...</b>\n<i>⚡ Analyzing your question ▰▱▱▱▱</i>',
            '🧠 <b>AI is thinking...</b>\n<i>🔍 Searching knowledge base ▰▰▰▱▱</i>',
            '✨ <b>AI is preparing reply...</b>\n<i>📝 Composing clear explanation ▰▰▰▰▱</i>',
            '🚀 <b>Almost ready...</b>\n<i>⚡ Finalizing response ▰▰▰▰▰</i>'
        ],
        animation_tts: ['🎙️ <b>Preparing your voice...</b> <i>Please wait</i>', '🎙️ <b>Generating natural speech...</b> ▰▰▱', '🔊 <b>Almost ready...</b> ▰▰▰'],
        animation_voice: ['🎧 <b>Listening to your voice note...</b>', '📝 <b>Transcribing your speech...</b> ▰▰▱', '🧠 <b>AI is preparing a reply...</b> ▰▰▰'],

        // AI Chat Feature
        ai_chat_title: '🤖 <b>Gemini 3.6 Flash AI Assistant</b>\n⚡ <b>Status:</b> 🟢 <code>ONLINE [● ● ●]</code>\n\n💬 <b>Type any question or chat message here:</b>\n• Ask about coding, general knowledge, work, or daily tasks\n• Or hold the mic icon to send a voice note directly! 🎧',

        // Direct TTS Feature
        tts_title: '🔊 <b>Edge Neural Text-to-Speech Studio (TTS)</b>\n⚡ <b>Status:</b> 🟢 <code>ONLINE [Studio Quality 96kbps]</code>\n\n🌍 <b>Supports 10 Global Languages:</b>\n• 🇰🇭 Khmer • 🇺🇸 English • 🇨🇳 Chinese • 🇰🇷 Korean • 🇯🇵 Japanese\n• 🇮🇳 Hindi • 🇲🇾 Malay • 🇮🇩 Indonesian • 🇵🇭 Filipino • 🇸🇦 Arabic\n\n📝 <b>Send any text you want read aloud:</b>\n• Auto-detects all 10 languages or use <code>/tts [lang] [text]</code>\n• Studio quality Male & Female natural voice notes ✨',

        voice_title: '🤖 <b>Gemini 3.6 Flash AI Assistant</b>\n⚡ <b>Status:</b> 🟢 <code>ONLINE [● ● ●]</code>\n\n💬 <b>Type any question or voice note here:</b>',
        voice_btn_km: '🇰🇭 Khmer (Studio)',
        voice_btn_en: '🇺🇸 English (Neural)',
        voice_btn_guide: '🎙️ How to send Voice Notes',
        voice_note_listening: '🎧 <b>[ ▰▱▱▱▱ 25% ]</b> <i>Listening to your voice note and thinking...</i>',
        voice_transcription: '📝 <b>Voice Transcription:</b>',
        voice_response: '🤖 <b>AI Response:</b>',
        listen_km: '🔊 Read in Khmer',
        listen_en: '🔊 Read in English',

        // Vision OCR
        vision_info: '📸 <b>Vision OCR & Translation</b>\n⚡ <b>Status:</b> 🟢 <code>OCR READY [● ● ●]</code>\n\nSend any photo or document! Gemini 3.6 Vision will extract all visible text and provide a 1-tap Khmer translation button! 🪄',
        vision_analyzing: '🔍 <b>[ ▰▱▱▱▱ 25% ]</b> <i>Analyzing photo with Gemini Vision OCR...</i>',
        vision_result: '✨ <b>Extracted Text:</b>',
        vision_translate_btn: '🌐 Translate to Khmer',
        vision_translating: 'Translating to Khmer... 🪄',
        vision_translated_title: '🇰🇭 <b>Khmer Translation:</b>',

        // Temp Mail
        mail_title: '📧 <b>Disposable Temp Mail</b>\n⚡ <b>Status:</b> 🟢 <code>REALTIME WATCHER [● ● ●]</code>',
        mail_current_addr: '📬 <b>Your Current Email Address:</b>',
        mail_copy_hint: '<i>(tap to copy)</i>',
        mail_count: (count: number) => `📊 <b>Inbox Count:</b> ${count} message(s)`,
        mail_realtime_badge: '🟢 <b>Realtime Watcher:</b> Active <i>(push alerts enabled)</i>',
        mail_empty_hint: '📭 <i>No messages yet. Send an email to your address or sign up on a service — as soon as an email arrives, you will get an instant notification!</i>',
        mail_btn_refresh: '🔄 Refresh Inbox',
        mail_btn_new: '🎲 New Email',
        mail_btn_delete: '🗑️ Delete Address',
        mail_btn_read: (idx: number, subject: string) => `📖 Read #${idx}: ${subject}`,
        mail_btn_back: '🔴 ◀️ Back',
        mail_alert_title: '🔔 <b>NEW EMAIL RECEIVED!</b>',
        mail_otp_label: '🔑 <b>Verification Code (OTP):</b>',
        mail_from_label: '👤 <b>From:</b>',
        mail_subject_label: '📌 <b>Subject:</b>',
        mail_time_label: '🕒 <b>Time:</b>',
        mail_preview_label: '📄 <b>Preview:</b>',

        // Downloader
        dl_guide_title: '📥 <b>Universal Media Downloader</b>\n⚡ <b>Status:</b> 🟢 <code>ULTRA-SPEED [● ● ●]</code>',
        dl_guide_body: 
            'Send or paste any video link directly into the chat:\n\n' +
            '• 🎵 <b>TikTok:</b> Videos, slideshows, short links (<code>vt.tiktok.com</code>)\n' +
            '• 🔴 <b>YouTube:</b> Videos, Shorts, music clips\n' +
            '• 📸 <b>Instagram:</b> Reels, videos, posts\n' +
            '• 🔵 <b>Facebook:</b> Reels, public videos, Watch clips\n\n' +
            '✨ <i>No commands needed — simply paste the URL here and I\'ll send back the video!</i>',
        dl_fetching: '⏳ <b>[ ▰▱▱▱▱ 20% ]</b> <i>Found media link! Fetching video for you...</i>',
        dl_success: '🎬 <b>Here is your video!</b>',
        dl_failed: '🥺 Could not download that media (it may be private or exceeds 50MB).',

        // Settings
        settings_title: '⚙️ <b>Bot Settings</b>\n\nCustomize your experience:',
        settings_btn_voice: '🗣️ Default Voice',
        settings_btn_lang: '🌐 Choose Language',
        settings_btn_status: '⚡ Live Component Status',
        settings_btn_gender: (g: 'male' | 'female') => g === 'male' ? '👨 Voice: Male' : '👩 Voice: Female',
        settings_btn_notif: (on: boolean) => `🔔 Notifications: ${on ? 'ON' : 'OFF'}`,
        settings_lang_chosen: '✅ Preferred language set to <b>English</b>.'
    }
};

export function getTranslation(userId?: number) {
    const lang = getUserLanguage(userId);
    return strings[lang];
}
