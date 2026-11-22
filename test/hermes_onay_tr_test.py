"""Tests of the Hermes plugin deploy/oracle/hermes/plugins/echo_onay_tr against fake Hermes modules
shaped like hermes-agent's tools/mcp_tool_handlers.py and tools/approval_prompt.py.
Run by test/hermes-approval.test.js:  python3 -B -I test/hermes_onay_tr_test.py
"""

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "deploy" / "oracle" / "hermes" / "plugins"))

import echo_onay_tr  # noqa: E402
from echo_onay_tr import render as R  # noqa: E402

echo_onay_tr.STATUS_FILE = Path(tempfile.mkdtemp()) / "status.json"


def fake_hermes(*, lazy=True, with_args=True):
    """Fresh fake modules; prompts lists every (message, description, kwargs) the 'user' was asked."""
    tools = types.ModuleType("tools")
    tools.__path__ = []
    prompt = types.ModuleType("tools.approval_prompt")
    prompts = []

    def request_elicitation_consent(message, description, *, timeout_seconds=None, surface="mcp-elicitation",
                                    title="Confirm this action?", remember_key=None):
        prompts.append((message, description, dict(surface=surface, title=title, remember_key=remember_key)))
        return "accept"

    prompt.request_elicitation_consent = request_elicitation_consent
    handlers = types.ModuleType("tools.mcp_tool_handlers")
    sys.modules.update({"tools": tools, "tools.approval_prompt": prompt, "tools.mcp_tool_handlers": handlers})

    def _trust_gate_check(server_name, tool_name, booked=None, args=None):
        if lazy:
            from tools.approval_prompt import request_elicitation_consent as ask
        else:
            ask = handlers.request_elicitation_consent
        message = (f"MCP tool '{tool_name}' on UNTRUSTED server '{server_name}' wants to run. This tool is "
                   f"write-capable (no readOnlyHint=true annotation) and may modify external state.")
        if with_args and args:
            message += f"\n\nArguments:\n{json.dumps(args, ensure_ascii=False, indent=2)}"
        answer = ask(message, f"Server '{server_name}' is configured 'trust: untrusted'.",
                     surface=f"mcp-trust/{server_name}", title=f"MCP server '{server_name}' is asking",
                     remember_key=f"mcp:{server_name}/{tool_name}")
        return None if answer == "accept" else "denied"

    def gate_without_args(server_name, tool_name):
        return _trust_gate_check(server_name, tool_name, None, None)

    handlers._trust_gate_check = _trust_gate_check if with_args else gate_without_args
    if not lazy:
        handlers.request_elicitation_consent = request_elicitation_consent
    handlers.SOURCE_MARK = "wants to run"
    return handlers, prompt, prompts


def no_hint(tool, args):
    return {"aspect_ratio": "4:5", "credits": 1.5} if tool == "generate_image" else {}


class PluginTest(unittest.TestCase):
    def setUp(self):
        self._hint = echo_onay_tr.studio_hint
        echo_onay_tr.studio_hint = no_hint
        # rewrite() took the hint function as a default argument at definition time.
        self._defaults = echo_onay_tr.rewrite.__defaults__
        echo_onay_tr.rewrite.__defaults__ = (None, no_hint)

    def tearDown(self):
        echo_onay_tr.studio_hint = self._hint
        echo_onay_tr.rewrite.__defaults__ = self._defaults

    def test_turkish_card_for_studio_and_trypost_gate_unchanged(self):
        handlers, prompt, prompts = fake_hermes()
        ok, _ = echo_onay_tr.install(handlers, prompt)
        self.assertTrue(ok)
        result = handlers._trust_gate_check("studio", "generate_image", [], {
            "prompt": "poster", "platform": "instagram", "ozet": "8 Mart Dünya Kadınlar Günü afişi"})
        self.assertIsNone(result)
        message, description, kwargs = prompts[-1]
        self.assertEqual(message, "🎨 Görsel üretilecek · Instagram (4:5) · yaklaşık 1.5 kredi\n"
                                  "Konu: 8 Mart Dünya Kadınlar Günü afişi")
        self.assertNotIn("UNTRUSTED", message + description)
        self.assertEqual(kwargs["remember_key"], "mcp:studio/generate_image")
        self.assertEqual(kwargs["surface"], "mcp-trust/studio")
        handlers._trust_gate_check("trypost", "create-post-tool", [], {"content": "Merhaba", "social_account_id": "x",
                                                                       "content_type": "instagram_feed"})
        self.assertEqual(prompts[-1][0], "📝 TryPost'ta taslak oluşturulacak · Instagram\nMetin: “Merhaba”")

    def test_idempotent(self):
        handlers, prompt, prompts = fake_hermes()
        echo_onay_tr.install(handlers, prompt)
        gate, consent = handlers._trust_gate_check, prompt.request_elicitation_consent
        self.assertTrue(echo_onay_tr.install(handlers, prompt)[0])
        self.assertIs(handlers._trust_gate_check, gate)
        self.assertIs(prompt.request_elicitation_consent, consent)
        handlers._trust_gate_check("trypost", "delete-post-tool", [], {"post_id": "p"})
        self.assertEqual(len(prompts), 1)
        self.assertEqual(prompts[0][0], "❌ Gönderi silinecek (geri alınamaz)")

    def test_other_servers_and_spend_limit_keep_hermes_text(self):
        handlers, prompt, prompts = fake_hermes()
        echo_onay_tr.install(handlers, prompt)
        handlers._trust_gate_check("github", "create_issue", [], {"title": "x"})
        self.assertTrue(prompts[-1][0].startswith("MCP tool 'create_issue' on UNTRUSTED server 'github'"))
        prompt.request_elicitation_consent("MCP tool 'x' on server 'studio' would take this chat past its spend limit.",
                                           "d", surface="mcp-trust/studio")
        self.assertIn("spend limit", prompts[-1][0])

    def test_render_failure_shows_original(self):
        handlers, prompt, prompts = fake_hermes()
        echo_onay_tr.install(handlers, prompt)
        original = R.render
        R.render = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self.assertIsNone(handlers._trust_gate_check("trypost", "create-post-tool", [], {"content": "x"}))
        finally:
            R.render = original
        self.assertIn("UNTRUSTED", prompts[-1][0])

    def test_module_level_import_is_wrapped_too(self):
        handlers, prompt, prompts = fake_hermes(lazy=False)
        echo_onay_tr.install(handlers, prompt)
        handlers._trust_gate_check("trypost", "delete-post-tool", [], {"post_id": "p"})
        self.assertEqual(prompts[-1][0], "❌ Gönderi silinecek (geri alınamaz)")

    def test_older_gate_without_args_parameter_reads_the_text(self):
        handlers, prompt, prompts = fake_hermes(with_args=False)
        echo_onay_tr.install(handlers, prompt)
        handlers._trust_gate_check("trypost", "publish-post-tool")
        self.assertEqual(prompts[-1][0], "🚀 Gönderi HEMEN yayınlanacak")

    def test_unreadable_argument_dump_keeps_original(self):
        changed = echo_onay_tr.rewrite("MCP tool 'create-post-tool' on UNTRUSTED server 'trypost' wants to run."
                                       "\n\nArguments:\n{\"content\": \"abc\n... [arguments truncated]",
                                       "d", "mcp-trust/trypost", None)
        self.assertIsNone(changed)

    def test_hermes_changed_install_fails_safe_and_reports(self):
        handlers, prompt, prompts = fake_hermes()
        del handlers._trust_gate_check
        ok, text = echo_onay_tr.install(handlers, prompt)
        self.assertFalse(ok)
        self.assertIn("UYGULANAMADI", text)
        status = json.loads(echo_onay_tr.STATUS_FILE.read_text(encoding="utf-8"))
        self.assertFalse(status["ok"])
        # Untouched: the original function is still the one asking.
        prompt.request_elicitation_consent("MCP tool 'a' on UNTRUSTED server 'trypost' wants to run.", "d",
                                           surface="mcp-trust/trypost")
        self.assertIn("UNTRUSTED", prompts[-1][0])

    def test_changed_signature_fails_safe(self):
        handlers, prompt, _ = fake_hermes()
        prompt.request_elicitation_consent = lambda text, *, surface=None: "accept"
        ok, _ = echo_onay_tr.install(handlers, prompt)
        self.assertFalse(ok)

    def test_studio_hint_failure_is_empty(self):
        os.environ["ECHO_STUDIO_TOKEN"] = "t" * 20

        def broken(request, timeout):
            raise OSError("unreachable")
        self.assertEqual(self._hint("generate_image", {}, opener=broken), {})
        self.assertEqual(self._hint("attach_to_trypost", {}), {})


# What hermes-agent v0.23.3 does to the card text before WhatsApp (gateway/run_turn_runner.py
# _render_approval_sync -> gateway/run.py _redact_approval_command -> agent/redact.py
# redact_approval_display -> agent/redact_approval_display.py sanitize_command_for_display, command
# mode): every invisible code point becomes its unicode_escape text. Copied here so the test needs no Hermes.
_HERMES_BLANK = frozenset("\u034f\u115f\u1160\u17b4\u17b5\u180b\u180c\u180d\u180f\u2800\u3164\uffa0"
                          + "".join(map(chr, range(0xFE00, 0xFE10))) + "".join(map(chr, range(0xE0100, 0xE01F0))))


def hermes_display(text):
    import unicodedata
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        hidden = not ("\x20" <= ch <= "\x7e" or ch in "\t\n") and (
            ch in _HERMES_BLANK or cat[0] == "C" or cat in ("Zl", "Zp"))
        out.append(ch.encode("unicode_escape").decode("ascii") if hidden else ch)
    return "".join(out)


FULL_ARGS = {
    "content": "Merhaba ❤️ dünya 👩‍💻", "content_type": "instagram_feed", "media": [1], "status": "scheduled",
    "scheduled_at": "2026-12-03T12:30:00Z", "label_ids": [1], "destinations": [{"content_type": "linkedin_post", "content": "x"}],
    "text": "Teşekkürler ✌️", "name": "Ad ☺️", "title": "Başlık", "body": "Not ✔️", "emoji": "👍🏽",
    "idea_ids": [1, 2], "urls": ["https://example.test/a.png"], "frequency": "weekly", "interval": 2,
    "slot_at": "2026-12-04T09:00:00Z", "post_id": "post_123456789", "publish_now": False,
    "prompt": "poster", "platform": "instagram", "ozet": "Atölye afişi ✳️", "baslik": "Yapay Zeka ☀️",
    "reference_image": "/opt/data/platforms/whatsapp_cloud/media/abc.jpg", "talimat": "metni düzelt",
    "kaynak_gorsel": "/opt/data/platforms/whatsapp_cloud/media/abc.jpg", "konum": "alt-sag", "kind": "speech",
    "yuksek_cozunurluk": True, "secenek": 2,
}
HINT = {"aspect_ratio": "4:5", "credits": 1.25, "resolution": "2k", "count": 2}


class NoEscapeInCardTest(unittest.TestCase):
    def fixtures(self):
        for tool in R.TRYPOST:
            yield "trypost", tool, {}
            yield "trypost", tool, FULL_ARGS
        for tool in R.STUDIO:
            yield "studio", tool, {}
            yield "studio", tool, FULL_ARGS
        for kind in ("speech", "music", "other"):
            yield "studio", "generate_audio", dict(FULL_ARGS, kind=kind)
        yield "trypost", "approve-post-tool", {"publish_now": True}
        yield "trypost", "publish-post-tool", {}
        yield "trypost", "create-post-tool", {"status": "publishing", "content": "x"}
        yield "studio", "unknown_tool", FULL_ARGS
        yield "other", "x", FULL_ARGS

    def test_no_rendered_card_contains_a_backslash_escape(self):
        for server, tool, args in self.fixtures():
            for hint in ({}, HINT):
                with self.subTest(server=server, tool=tool, args=bool(args), hint=bool(hint)):
                    body = R.render(server, tool, args, hint)
                    shown = hermes_display(body)
                    self.assertEqual(shown, body, "Hermes would escape a character of this card")
                    self.assertNotRegex(shown, r"\\[uUx][0-9a-fA-F]")
                    self.assertNotRegex(body, "[\ufe00-\ufe0f\U000e0100-\U000e01ef]")

    def test_edit_image_card_as_whatsapp_shows_it(self):
        body = R.render("studio", "edit_image", {"talimat": "metni düzelt",
                                                 "kaynak_gorsel": "/opt/data/platforms/whatsapp_cloud/media/a.jpg"},
                        {"credits": 1.25})
        self.assertEqual(hermes_display(body), "🪄 Görsel düzenlenecek · yaklaşık 1.25 kredi\n"
                                               "Değişiklik: “metni düzelt”\nKaynak: gönderdiğin görsel")

    def test_renderer_source_has_no_selector_or_escaped_emoji(self):
        source = (HERE.parent / "deploy/oracle/hermes/plugins/echo_onay_tr/render.py").read_text(encoding="utf-8")
        self.assertNotRegex(source, "[\ufe00-\ufe0f\u200d]")
        self.assertNotRegex(source.lower(), r"\\ufe0f|\\u200d|\\U0001f")


if __name__ == "__main__":
    unittest.main(verbosity=1)
