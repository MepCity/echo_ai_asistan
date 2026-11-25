"""Turkish body of Hermes' WhatsApp approval card for Echo's MCP tools (TryPost and the studio).

Pure: no Hermes imports, no I/O. ``render(server, tool, args, hint)`` returns a short plain-language
Turkish text (at most MAX_CHARS characters) that replaces Hermes' English "MCP tool '...' on UNTRUSTED
server ... Arguments: {json}" body. Only the fields a club member needs to decide are shown, cut short;
everything comes from the real call arguments (never from a model's free text alone), except the
studio's ``ozet``, which is shown as "Konu" next to the real values.

Run as a script for tests: reads a JSON list of {"server", "tool", "args", "hint"} on stdin and prints
the JSON list of bodies (test/hermes-approval.test.js).
"""

import json
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

# The card is header + this body + "Not: ..." + the deadline line, inside WhatsApp's 1024-character
# interactive body; 600 leaves room for the rest, so Hermes never splits it into two messages.
MAX_CHARS = 600
TEXT_EXCERPT = 200

# Turkey has had no daylight saving since 2016; zoneinfo may be missing in a slim image.
try:
    from zoneinfo import ZoneInfo

    ISTANBUL = ZoneInfo("Europe/Istanbul")
except Exception:  # pragma: no cover
    ISTANBUL = timezone(timedelta(hours=3))

MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]

PLATFORMS = {
    "instagram": "Instagram", "linkedin": "LinkedIn", "x": "X", "twitter": "X", "facebook": "Facebook",
    "tiktok": "TikTok", "threads": "Threads", "bluesky": "Bluesky", "mastodon": "Mastodon",
    "pinterest": "Pinterest", "youtube": "YouTube", "discord": "Discord", "telegram": "Telegram",
}
STUDIO_PLATFORMS = {
    "instagram": "Instagram", "instagram_kare": "Instagram kare", "story": "Hikâye",
    "linkedin": "LinkedIn", "linkedin_dikey": "LinkedIn dikey", "x": "X",
}
SECRET = re.compile(r"(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)", re.I)

# Hermes shows an approval card through agent/redact_approval_display.py (sanitize_command_for_display,
# command mode), which writes every invisible code point as a visible escape: a variation selector
# (U+FE00-FE0F, U+E0100-E01EF), every C* category, line/paragraph separators and a few blank glyphs.
# The pencil U+270F + U+FE0F therefore reached WhatsApp as the pencil and a literal backslash-ufe0f.
# So every icon here is an emoji shown as an emoji without a selector (Emoji_Presentation=Yes), and
# HIDDEN is dropped from all text.
HIDDEN = frozenset("\u034f\u115f\u1160\u17b4\u17b5\u180b\u180c\u180d\u180f\u2028\u2029\u2800\u3164\uffa0"
                   + "".join(map(chr, range(0xFE00, 0xFE10))) + "".join(map(chr, range(0xE0100, 0xE01F0))))


def visible(text):
    """``text`` without what Hermes' card would turn into a backslash escape (tab/newline kept)."""
    return "".join(ch for ch in text if ch in "\n\t"
                   or (ch not in HIDDEN and unicodedata.category(ch)[0] != "C"))


# ---- small helpers -------------------------------------------------------------------------------

def clean(value, limit=TEXT_EXCERPT):
    """One line of display text: control/format characters (bidi overrides, zero-width) and HIDDEN dropped,
    whitespace collapsed, backticks swapped (the card sits in a code block), cut to ``limit``."""
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    text = "".join(" " if ch in "\n\r\t" else ch for ch in text
                   if ch in "\n\r\t" or (ch not in HIDDEN and unicodedata.category(ch)[0] != "C"))
    text = re.sub(r"\s+", " ", text.replace("`", "'")).strip()
    if len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    return text


# A LinkedIn company mention in a post's text (TryPost's Marmara fork turns it into a real mention on
# LinkedIn and into the plain name elsewhere): "@[Akbank](https://www.linkedin.com/company/akbank)", also
# without the scheme or as "urn:li:organization:123". The card shows "Akbank (LinkedIn etiketi)".
LINKEDIN_MENTION = re.compile(
    r"@\[([^\]\r\n]{1,100})\]\((?:urn:li:organization:\d+"
    r"|(?:https?://)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com/company/[^\s/?#()\[\]]+/?)\)", re.I)


def post_text(value):
    """A post's text with its LinkedIn company mentions readable; anything else unchanged."""
    if not isinstance(value, str) or "@[" not in value:
        return value
    return LINKEDIN_MENTION.sub(lambda match: f"{match.group(1).strip()} (LinkedIn etiketi)", value)


def quoted(value, limit=TEXT_EXCERPT):
    text = clean(value, limit)
    return f"“{text}”" if text else "(boş)"


def short_id(value):
    text = clean(value, 64)
    return f"…{text[-6:]}" if len(text) > 8 else text


def when(value):
    """ISO 8601 (TryPost reads no offset as UTC) as Istanbul time, e.g. "12 Mart 15:30"."""
    text = clean(value, 40)
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00").replace(" ", "T"))
    except ValueError:
        return text
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    local = moment.astimezone(ISTANBUL)
    # No year: TryPost only takes times in the near future.
    return f"{local.day} {MONTHS[local.month - 1]} {local:%H:%M}"


def platform_of(content_type):
    key = clean(content_type, 40).lower().split("_")[0]
    return PLATFORMS.get(key, "")


def count(value):
    return len(value) if isinstance(value, (list, tuple)) else 0


def credits_text(value):
    try:
        number = round(float(value), 2)
    except (TypeError, ValueError):
        return ""
    return f"yaklaşık {number:g} kredi"


def join(*parts):
    return " · ".join(part for part in parts if part)


def head(icon, text, *extra):
    return f"{icon} {join(text, *extra)}"


# ---- TryPost ---------------------------------------------------------------------------------------

def _schedule(args):
    """(verb phrase, detail) for a post's status/scheduled_at/queue."""
    status = clean(args.get("status"), 20).lower()
    if status == "publishing":
        return "HEMEN yayınlanacak", ""
    if args.get("queue_slot"):
        return "kuyrukta bir zamana planlanacak", when(args.get("queue_slot"))
    if args.get("queue"):
        return "kuyruğa eklenecek", "en başa" if clean(args.get("queue"), 10) == "top" else "ilk boş zamana"
    if status == "scheduled" or args.get("scheduled_at"):
        return "planlanacak", when(args.get("scheduled_at")) if args.get("scheduled_at") else ""
    return "", ""


def _media_line(args):
    n = count(args.get("media"))
    return f"Medya: {n} dosya" if n else ""


def _create_post(args):
    verb, detail = _schedule(args)
    platform = platform_of(args.get("content_type"))
    first = head("🚀" if "HEMEN" in verb else "📅", f"Gönderi {verb}", platform, detail) if verb \
        else head("📝", "TryPost'ta taslak oluşturulacak", platform)
    return [first, f"Metin: {quoted(post_text(args.get('content')))}", _media_line(args)]


def _create_posts(args):
    verb, detail = _schedule(args)
    destinations = [d for d in args.get("destinations") or [] if isinstance(d, dict)]
    platforms = []
    for dest in destinations:
        name = platform_of(dest.get("content_type"))
        if name and name not in platforms:
            platforms.append(name)
    where = ", ".join(platforms) if platforms else (f"{len(destinations)} hesap" if destinations else "")
    first = head("🚀" if "HEMEN" in verb else "📅", f"{len(destinations) or ''} gönderi {verb}".strip(), where, detail) if verb \
        else head("📝", f"TryPost'ta {len(destinations) or ''} taslak oluşturulacak".replace("  ", " "), where)
    text = args.get("content")
    if not text and destinations:
        text = destinations[0].get("content")
    return [first, f"Metin: {quoted(post_text(text))}", _media_line(args)]


def _update_post(args):
    verb, detail = _schedule(args)
    lines = [head("📝", "TryPost'taki gönderi düzenlenecek", platform_of(args.get("content_type")))]
    if "content" in args:
        lines.append(f"Yeni metin: {quoted(post_text(args.get('content')))}")
    if verb:
        lines.append(f"Durum: {join(verb, detail)}")
    if count(args.get("label_ids")):
        lines.append(f"Etiket: {count(args.get('label_ids'))} etiket")
    return lines


def _publish_post(args):
    verb, detail = _schedule(args)
    if verb and "HEMEN" not in verb:
        return [head("📅", f"Taslak gönderi {verb}", detail)]
    return [head("🚀", "Gönderi HEMEN yayınlanacak")]


def _approve_post(args):
    if args.get("publish_now") is True:
        return [head("🚀", "Onay bekleyen gönderi onaylanıp HEMEN yayınlanacak")]
    if args.get("scheduled_at"):
        return [head("✅", "Onay bekleyen gönderi onaylanacak", when(args.get("scheduled_at")))]
    return [head("✅", "Onay bekleyen gönderi onaylanacak (istenen zamanda yayınlanır)")]


def _reply_inbox(args):
    return [head("💬", "Yorum ya da mesaja cevap gidecek (hemen gönderilir)"), f"Cevap: {quoted(args.get('text'), 300)}"]


def _named(icon, phrase, key="name"):
    def build(args):
        name = args.get(key) or args.get("title")
        return [head(icon, phrase), f"Ad: {quoted(name, 80)}" if name else ""]
    return build


def _simple(icon, phrase):
    return lambda args: [head(icon, phrase)]


def _note(icon, phrase):
    return lambda args: [head(icon, phrase), f"Not: {quoted(args.get('body'))}" if args.get("body") else ""]


def _reaction(phrase):
    return lambda args: [head("🙂", phrase, clean(args.get("emoji"), 8))]


def _idea(phrase):
    def build(args):
        lines = [head("💡", phrase)]
        if args.get("title"):
            lines.append(f"Başlık: {quoted(args.get('title'), 100)}")
        if args.get("body"):
            lines.append(f"Metin: {quoted(args.get('body'), 150)}")
        return lines
    return build


def _ideas_count(phrase):
    def build(args):
        n = count(args.get("idea_ids")) or (1 if args.get("idea_id") else 0)
        return [head("💡", f"{n} fikir {phrase}" if n > 1 else f"Fikir {phrase}")]
    return build


def _attach_urls(args):
    n = count(args.get("urls"))
    return [head("📎", f"Gönderiye {n or ''} medya eklenecek".replace("  ", " "), "adresten")]


def _recurrence(args):
    detail = join(clean(args.get("frequency"), 20), f"her {clean(args.get('interval'), 5)}" if args.get("interval") else "")
    return [head("🔁", "Gönderi düzenli tekrar edecek şekilde ayarlanacak", detail)]


def _move_slot(args):
    return [head("📅", "Gönderi kuyrukta başka zamana taşınacak", when(args.get("slot_at")) if args.get("slot_at") else "")]


def _add_design(args):
    """Designs library upload. The media reference (upload token or id) is never shown."""
    tags = args.get("tags")
    tags = [clean(tag, 40) for tag in tags] if isinstance(tags, (list, tuple)) else []
    tags = ", ".join(tag for tag in tags if tag)
    media = args.get("media") if isinstance(args.get("media"), dict) else {}
    return [head("📁", "Tasarımlar'a dosya eklenecek"),
            f"Başlık: {quoted(args.get('title'), 100)}" if args.get("title") else "",
            f"Etiketler: {clean(tags, 150)}" if tags else "",
            f"Koleksiyon: {clean(args.get('folder'), 80)}" if clean(args.get("folder"), 80) else "",
            "Dosya: WhatsApp'tan gönderilen dosya" if media.get("upload_token") else "",
            f"Ekleyen: {clean(args.get('on_behalf_of'), 60)}" if clean(args.get("on_behalf_of"), 60) else ""]


def _rename_design(args):
    """A design's TryPost title (the Drive file keeps its name). current_title is checked by TryPost
    (the call fails when the design shows another title), so "old → new" is the real change."""
    current = clean(args.get("current_title"), 80) if isinstance(args.get("current_title"), str) else ""
    title = args.get("title") if isinstance(args.get("title"), str) else None
    lines = []
    if title is not None and not clean(title, 80):
        lines.append(head("📝", "Tasarımın başlığı Drive'daki dosya adına dönecek"))
        if current:
            lines.append(f"Şu anki başlık: {quoted(current, 80)}")
    elif title is not None:
        new = quoted(title, 80)
        lines.append(head("📝", "Tasarımın başlığı değişecek", f"{quoted(current, 80)} → {new}" if current else ""))
        if not current:
            lines.append(f"Yeni başlık: {new}")
    else:
        lines.append(head("📝", "Tasarımın başlığı değişecek"))
    if clean(args.get("design_id"), 64):
        lines.append(f"Tasarım: {short_id(args.get('design_id'))}")
    lines.append("Drive'daki dosya adı değişmez")
    return lines


def _repurpose(phrase):
    return lambda args: [head("🔄", f"Otomatik yeniden paylaşım {phrase}")]


TRYPOST = {
    "create-post-tool": _create_post,
    "create-posts-tool": _create_posts,
    "update-post-tool": _update_post,
    "delete-post-tool": _simple("❌", "Gönderi silinecek (geri alınamaz)"),
    "publish-post-tool": _publish_post,
    "approve-post-tool": _approve_post,
    "reject-post-tool": _simple("🚫", "Onay bekleyen gönderi reddedilecek"),
    "attach-media-from-upload-tool": _simple("📎", "Gönderiye medya eklenecek"),
    "attach-media-from-url-tool": _attach_urls,
    "request-media-upload-tool": _simple("📤", "Medya yükleme bağlantısı alınacak"),
    "set-post-recurrence-tool": _recurrence,
    "clear-post-recurrence-tool": _simple("🔁", "Gönderinin tekrarı kaldırılacak"),
    "create-post-note-tool": _note("📋", "Gönderiye not eklenecek"),
    "update-post-note-tool": _note("📋", "Gönderideki not düzenlenecek"),
    "delete-post-note-tool": _simple("❌", "Gönderideki not silinecek"),
    "add-post-note-reaction-tool": _reaction("Nota tepki eklenecek"),
    "remove-post-note-reaction-tool": _reaction("Nottaki tepki kaldırılacak"),
    "reply-to-inbox-item-tool": _reply_inbox,
    "create-idea-tool": _idea("Yeni fikir eklenecek"),
    "update-idea-tool": _idea("Fikir düzenlenecek"),
    "delete-ideas-tool": _ideas_count("silinecek"),
    "duplicate-idea-tool": _ideas_count("kopyalanacak"),
    "move-ideas-tool": _ideas_count("başka aşamaya taşınacak"),
    "create-idea-stage-tool": _named("💡", "Fikir panosuna yeni aşama eklenecek"),
    "update-idea-stage-tool": _named("💡", "Fikir aşaması düzenlenecek"),
    "delete-idea-stage-tool": _simple("❌", "Fikir aşaması silinecek"),
    "reorder-idea-stages-tool": _simple("💡", "Fikir aşamalarının sırası değişecek"),
    "create-label-tool": _named("🔖", "Yeni etiket oluşturulacak"),
    "update-label-tool": _named("🔖", "Etiket düzenlenecek"),
    "delete-label-tool": _simple("❌", "Etiket silinecek"),
    "create-signature-tool": _named("📝", "Yeni imza oluşturulacak"),
    "update-signature-tool": _named("📝", "İmza düzenlenecek"),
    "delete-signature-tool": _simple("❌", "İmza silinecek"),
    "create-repurpose-tool": _repurpose("kurulacak"),
    "update-repurpose-tool": _repurpose("ayarı değişecek"),
    "delete-repurpose-tool": _repurpose("silinecek"),
    "activate-repurpose-tool": _repurpose("açılacak"),
    "disable-repurpose-tool": _repurpose("kapatılacak"),
    "pause-repurpose-tool": _repurpose("duraklatılacak"),
    "resume-repurpose-tool": _repurpose("devam ettirilecek"),
    "copy-posting-schedule-tool": _simple("📅", "Paylaşım takvimi başka hesaptan kopyalanacak"),
    "generate-posting-schedule-tool": _simple("📅", "Paylaşım takvimi yeniden oluşturulacak"),
    "update-posting-schedule-tool": _simple("📅", "Paylaşım takvimi değişecek"),
    "move-post-to-slot-tool": _move_slot,
    "reorder-queue-tool": _simple("📅", "Kuyruktaki gönderilerin sırası değişecek"),
    "create-pinterest-board-tool": _named("📌", "Pinterest panosu oluşturulacak"),
    "add-design-tool": _add_design,
    "rename-design-tool": _rename_design,
}


# ---- studio ---------------------------------------------------------------------------------------

def _konu(args, fallback_key=None, limit=150):
    if args.get("ozet"):
        return f"Konu: {clean(args.get('ozet'), limit)}"
    if fallback_key and args.get(fallback_key):
        return f"Tarif: {quoted(args.get(fallback_key), limit)}"
    return ""


def _reference(value):
    text = clean(value, 300)
    if not text:
        return ""
    if text.startswith("logo"):
        return "Referans: kulüp logosu"
    if text.startswith("gen_"):
        return "Referans: önceki görsel"
    if text.startswith("/"):
        return "Referans: gönderdiğin görsel"
    return "Referans: site görseli"


def _generate_image(args, hint):
    platform = STUDIO_PLATFORMS.get(clean(args.get("platform"), 30), "")
    ratio = clean(hint.get("aspect_ratio") or args.get("aspect_ratio"), 10)
    where = f"{platform} ({ratio})" if platform and ratio else (platform or ratio)
    resolution = clean(hint.get("resolution") or args.get("resolution") or ("2k" if args.get("yuksek_cozunurluk") is True else ""), 4)
    quality = "yüksek çözünürlük" if resolution in ("2k", "4k") else ""
    # secenek: 2 → two separate generations; the hint's credits already cover both.
    several = "2 görsel" if hint.get("count") == 2 or args.get("secenek") == 2 else ""
    return [head("🎨", "Görsel üretilecek", where, quality, several, credits_text(hint.get("credits"))),
            _konu(args, "prompt"), f"Başlık: {quoted(args.get('baslik'), 120)}" if args.get("baslik") else "",
            _reference(args.get("reference_image"))]


def _generate_audio(args, hint):
    kind = clean(args.get("kind"), 10)
    if kind == "speech":
        return [head("🔊", "Seslendirme üretilecek", credits_text(hint.get("credits"))),
                _konu(args), f"Metin: {quoted(args.get('text'), 150)}"]
    if kind == "music":
        seconds = hint.get("duration") or args.get("duration")
        length = f"{clean(seconds, 4)} sn" if seconds else ""
        return [head("🎵", "Müzik üretilecek", length, credits_text(hint.get("credits"))), _konu(args, "prompt")]
    return [head("🔊", "Ses üretilecek", credits_text(hint.get("credits"))), _konu(args, "prompt")]


def _attach_to_trypost(args, hint):
    if args.get("post_id"):
        lines = [head("📎", "Üretilen görsel TryPost'taki gönderiye eklenecek")]
    else:
        lines = [head("📝", "Üretilen görselle TryPost'ta yeni taslak oluşturulacak")]
        if args.get("content"):
            lines.append(f"Metin: {quoted(post_text(args.get('content')))}")
    lines.insert(1, _konu(args))
    return lines


CORNERS = {"alt-sag": "sağ alt", "alt-sol": "sol alt", "ust-sag": "sağ üst", "ust-sol": "sol üst"}


def _edit_image(args, hint):
    resolution = clean(hint.get("resolution") or ("2k" if args.get("yuksek_cozunurluk") is True else ""), 4)
    quality = "yüksek çözünürlük" if resolution in ("2k", "4k") else ""
    source = "Kaynak: gönderdiğin görsel" if clean(args.get("kaynak_gorsel"), 300).startswith("/") else ""
    return [head("🪄", "Görsel düzenlenecek", quality, credits_text(hint.get("credits"))),
            f"Değişiklik: {quoted(args.get('talimat'), 150)}", _konu(args), source]


def _add_logo(args, hint):
    corner = CORNERS.get(clean(args.get("konum"), 10), "")
    return [head("🔖", "Görsele kulüp logosu eklenecek (kredi harcamaz)"),
            f"Köşe: {corner}" if corner else "", _konu(args)]


STUDIO = {
    "generate_image": _generate_image,
    "edit_image": _edit_image,
    "add_logo": _add_logo,
    "generate_audio": _generate_audio,
    "attach_to_trypost": _attach_to_trypost,
}


# ---- generic and assembly ----------------------------------------------------------------------------

def _value(key, value):
    if SECRET.search(str(key)) and value not in (None, ""):
        return "***"
    if isinstance(value, bool):
        return "evet" if value else "hayır"
    if isinstance(value, (list, tuple)):
        return f"{len(value)} öğe"
    if isinstance(value, dict):
        return f"{len(value)} alan"
    return clean(value, 60)


def generic(tool, args):
    name = clean(re.sub(r"-tool$", "", str(tool or "")), 60) or "bir"
    lines = [f"🔧 {name} işlemi yapılacak"]
    if args.get("ozet"):
        lines.append(f"Konu: {clean(args.get('ozet'), 150)}")
    shown = 0
    for key, value in args.items():
        if key == "ozet" or value in (None, "", [], {}):
            continue
        if shown == 6:
            lines.append(f"(+{len(args) - 6} alan daha)")
            break
        lines.append(f"{clean(key, 30)}: {_value(key, value)}")
        shown += 1
    return lines


def width(text):
    """Length in UTF-16 code units, as WhatsApp (and JavaScript) count it: an emoji such as 🔧 is 2."""
    return len(text.encode("utf-16-le")) // 2


def fit(lines, limit=MAX_CHARS):
    """Joins the lines; past ``limit`` the longest line is shortened first, the headline last."""
    lines = [visible(line) for line in lines if line]
    lines = [line for line in lines if line]
    while True:
        text = "\n".join(lines)
        if width(text) <= limit:
            return text
        over = width(text) - limit
        rest = [i for i in range(1, len(lines)) if len(lines[i]) > 24]
        if not rest:
            text = text[: limit - 1].rstrip()
            while width(text) > limit - 1:
                text = text[:-1].rstrip()
            return text + "…"
        index = max(rest, key=lambda i: len(lines[i]))
        keep = max(23, len(lines[index]) - over - 1)
        lines[index] = lines[index][:keep].rstrip() + "…"


def render(server, tool, args, hint=None):
    """The card body for one call. Never raises for odd arguments; unknown tools get the generic form."""
    args = args if isinstance(args, dict) else {}
    hint = hint if isinstance(hint, dict) else {}
    builder = None
    if server == "studio":
        builder = STUDIO.get(tool)
        lines = builder(args, hint) if builder else generic(tool, args)
    elif server == "trypost":
        builder = TRYPOST.get(tool)
        lines = builder(args) if builder else generic(tool, args)
    else:
        lines = generic(tool, args)
    return fit(lines)


if __name__ == "__main__":
    cases = json.load(sys.stdin)
    json.dump([render(c.get("server"), c.get("tool"), c.get("args"), c.get("hint")) for c in cases],
              sys.stdout, ensure_ascii=False)
