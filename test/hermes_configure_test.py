"""Tests of deploy/oracle/hermes/configure.py (Hermes' config.yaml merge). Needs PyYAML.
Run by test/hermes-configure.test.js:  python3 -B -I test/hermes_configure_test.py
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "deploy" / "oracle" / "hermes"))

import configure  # noqa: E402


def run(existing=None):
    """configure.main on a config.yaml holding *existing*; returns what it wrote."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "config.yaml")
        if existing is not None:
            with open(path, "w", encoding="utf-8") as handle:
                yaml.safe_dump(existing, handle)
        configure.main(path)
        with open(path, encoding="utf-8") as handle:
            return yaml.safe_load(handle)


class SpeechToText(unittest.TestCase):
    def test_fresh_install_gets_local_turkish_small_int8_with_idle_unload(self):
        stt = run()["stt"]
        self.assertEqual(stt["provider"], "local")
        self.assertIs(stt["enabled"], True)
        self.assertIs(stt["echo_transcripts"], True)
        self.assertEqual(stt["language"], "tr")
        self.assertEqual(stt["local"], {
            "model": "small", "device": "cpu", "compute_type": "int8", "unload_after_idle_seconds": 600,
        })

    def test_user_choices_are_kept(self):
        stt = run({"stt": {
            "provider": "groq", "enabled": False, "echo_transcripts": False, "language": "de",
            "local": {"model": "base", "compute_type": "float32", "unload_after_idle_seconds": 0},
            "groq": {"model": "whisper-large-v3"},
        }})["stt"]
        self.assertEqual(stt["provider"], "groq")
        self.assertIs(stt["enabled"], False)
        self.assertIs(stt["echo_transcripts"], False)
        self.assertEqual(stt["language"], "de")
        self.assertEqual(stt["local"]["model"], "base")
        self.assertEqual(stt["local"]["compute_type"], "float32")
        self.assertEqual(stt["local"]["unload_after_idle_seconds"], 0)
        self.assertEqual(stt["local"]["device"], "cpu")
        self.assertEqual(stt["groq"], {"model": "whisper-large-v3"})

    def test_hermes_default_english_becomes_turkish(self):
        for language in ("en", "", None):
            self.assertEqual(run({"stt": {"language": language}})["stt"]["language"], "tr")

    def test_idempotent_and_other_settings_untouched(self):
        first = run({"model": {"provider": "openai-codex", "default": "gpt-5"}})
        second = run(first)
        self.assertEqual(first, second)
        self.assertEqual(second["model"], {"provider": "openai-codex", "default": "gpt-5"})

    def test_no_disabled_toolset_covers_voice(self):
        # Inbound transcription is gateway enrichment, not a tool; tts is the only voice toolset.
        self.assertFalse({"tts", "voice", "transcription", "stt"} & set(configure.DISABLED_TOOLSETS))


class SelfImprovementNotices(unittest.TestCase):
    def test_fresh_install_hides_review_notices_but_keeps_the_review(self):
        config = run()
        self.assertEqual(config["display"]["memory_notifications"], "off")
        self.assertNotIn("auxiliary", config)
        self.assertNotIn("skills", config)
        self.assertNotIn("memory", config)

    def test_user_choice_is_kept(self):
        for choice in ("on", "verbose", True):
            config = run({"display": {"memory_notifications": choice, "language": "tr"}})
            self.assertEqual(config["display"]["memory_notifications"], choice)


if __name__ == "__main__":
    unittest.main()
