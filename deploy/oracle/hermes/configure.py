#!/usr/bin/env python3
"""Merges Echo's settings into Hermes' config.yaml, keeping everything else in it, and
writes the Turkish wording of Hermes' approval prompt (locales/tr.yaml next to it).

Usage: python3 -I configure.py /opt/hermes/data/config.yaml
Run by setup-hermes.sh; safe to run again. Needs PyYAML (python3-yaml).
"""
import os
import sys

import yaml

TRYPOST_MCP_URL = "https://sosyal.marmaraai.com/mcp/trypost"
# Echo's studio gateway (src/studio): Higgsfield images/audio within the club's limits. Hermes never
# gets Higgsfield itself; the bearer comes from ECHO_STUDIO_TOKEN in Hermes' .env (studio-prepare.sh),
# expanded by Hermes at connect time, so no secret is written here.
STUDIO_MCP_URL = os.environ.get("STUDIO_MCP_URL", "http://studio:8091/mcp")

# TryPost tools Hermes never gets: API keys and webhooks (Echo's own webhook lives there).
# Tool names are TryPost's MCP names (kebab-case class names, see app/Mcp/Tools in TryPost).
EXCLUDED_TOOLS = [
    "create-api-key-tool",
    "delete-api-key-tool",
    "list-api-keys-tool",
    "create-webhook-tool",
    "update-webhook-tool",
    "delete-webhook-tool",
    "rotate-webhook-secret-tool",
    "replay-webhook-log-tool",
    "send-webhook-test-tool",
]

# A WhatsApp assistant for social media needs no shell, files, browser or code
# execution; leaving them out keeps a prompt injected through post content from
# reaching the container (and the WhatsApp token in its environment).
DISABLED_TOOLSETS = [
    "terminal",
    "code_execution",
    "file",
    "browser",
    "computer_use",
    "delegation",
    "cronjob",
    "kanban",
    "connections",
    "catalog",
    "image_gen",
    "video_gen",
]

# TryPost write tools always ask on WhatsApp: an "always allow" answer for one of them
# (command_allowlist key "mcp:<server>/<tool>", tools/mcp_tool_handlers.py) is removed again.
TRYPOST_GRANT_PREFIX = "mcp:trypost/"
# The same for the studio: every generation (credits) and every TryPost attach asks.
STUDIO_GRANT_PREFIX = "mcp:studio/"

# Hermes' user overlay ($HERMES_HOME/locales/<lang>.yaml, agent/i18n_layers.py): plainer
# Turkish for the approval card's frame and buttons than the bundled locales/tr.yaml. The
# card's middle is fixed English in Hermes; the echo_onay_tr plugin (plugins/echo_onay_tr,
# copied by setup-hermes.sh) replaces it with a short Turkish summary for TryPost and studio
# tools, and its one-line note follows the "Not:" label below.
LOCALE_MARKER = "# echo-managed: setup-hermes.sh bu dosyayi yeniler. Kendi metnini korumak icin bu satiri sil."
LOCALE_TR = {
    "gateway": {
        "exec_approval": {
            "header": "Onayın gerekiyor",
            "reason_label": "Not",
            "deadline": "{window} içinde cevap vermezsen hiçbir şey yapılmaz.",
            "timed_out_notice": "⌛ {window} içinde onay gelmedi; işlem yapılmadı. Hâlâ istiyorsan tekrar söyle.",
        },
    },
    "platform": {
        "whatsapp": {
            "approve_button": "✅ Onayla",
            "deny_button": "❌ Vazgeç",
        },
    },
}

# Hermes plugin (deploy/oracle/hermes/plugins/<name>, copied to $HERMES_HOME/plugins by
# setup-hermes.sh). User plugins are opt-in through plugins.enabled. One listed under
# plugins.disabled stays off (Hermes then shows its own English approval text).
ECHO_PLUGINS = ["echo_onay_tr"]

# Voice messages (Hermes gateway/run_inbound_transcription.py, tools/transcription_tools.py): local
# faster-whisper, free and on the VM. "small" because "base" gets Turkish badly wrong; on the VM's two
# ARM cores small/int8 takes roughly 10-15 s for a 15 s clip and ~0.5-0.7 GB RAM while loaded, freed
# after 10 idle minutes. faster-whisper is not in the image: setup-hermes.sh installs the stt-whisper
# extra into /opt/hermes/data/installs (hermes pm install), which survives image updates.
STT_DEFAULTS = {"provider": "local", "enabled": True, "echo_transcripts": True}
STT_LOCAL_DEFAULTS = {
    "model": "small",
    "device": "cpu",
    "compute_type": "int8",
    "unload_after_idle_seconds": 600,
}

# onboarding.seen flags (Hermes agent/onboarding.py) marked as already shown.
ONBOARDING_SEEN_FLAGS = [
    "profile_build_offered",
    "busy_input_prompt",
    "tool_progress_prompt",
]


def main(path):
    config = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        sys.exit(f"{path} is not a YAML mapping")

    # The model is the user's choice (`hermes.sh model`); only a fresh install gets the
    # provider. No model name is set: which ones a ChatGPT account may use differs, and
    # Hermes has no default for openai-codex, so setup-hermes.sh asks the user to pick one.
    model = config.get("model")
    if not model:
        config["model"] = {"provider": "openai-codex"}
    elif isinstance(model, dict) and not model.get("provider") and not model.get("default"):
        model["provider"] = "openai-codex"

    servers = config.get("mcp_servers")
    if not isinstance(servers, dict):
        servers = config["mcp_servers"] = {}
    trypost = servers.get("trypost") if isinstance(servers.get("trypost"), dict) else {}
    trypost.update({
        "url": TRYPOST_MCP_URL,
        # TryPost's MCP accepts only OAuth grants with the mcp:use scope; an API key gets 403.
        "auth": "oauth",
        # Every TryPost tool not marked read-only asks for approval on WhatsApp before it runs.
        "trust": "untrusted",
        "timeout": 120,
        "connect_timeout": 30,
    })
    trypost.pop("headers", None)
    tools = trypost.get("tools") if isinstance(trypost.get("tools"), dict) else {}
    tools["exclude"] = sorted(set(tools.get("exclude") or []) | set(EXCLUDED_TOOLS))
    trypost["tools"] = tools
    servers["trypost"] = trypost

    studio = servers.get("studio") if isinstance(servers.get("studio"), dict) else {}
    studio.update({
        "url": STUDIO_MCP_URL,
        "headers": {"Authorization": "Bearer ${ECHO_STUDIO_TOKEN}"},
        # generate_image / edit_image / generate_audio / add_logo / attach_to_trypost ask on WhatsApp; the read-only
        # tools (brand kit, usage, status, original file) carry readOnlyHint and do not.
        "trust": "untrusted",
        # A generation waits up to ~3 minutes for its job.
        "timeout": 300,
        "connect_timeout": 15,
    })
    studio.pop("auth", None)
    servers["studio"] = studio

    approvals = config.get("approvals") if isinstance(config.get("approvals"), dict) else {}
    if approvals.get("mode") in (None, "off"):
        approvals["mode"] = "manual"
    approvals.setdefault("timeout", 300)
    config["approvals"] = approvals

    allowlist = config.get("command_allowlist")
    if isinstance(allowlist, list):
        config["command_allowlist"] = [
            entry for entry in allowlist
            if not (isinstance(entry, str) and entry.startswith((TRYPOST_GRANT_PREFIX, STUDIO_GRANT_PREFIX)))
        ]

    agent = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    disabled = agent.get("disabled_toolsets") or []
    if not isinstance(disabled, list):
        disabled = [disabled]
    agent["disabled_toolsets"] = disabled + [name for name in DISABLED_TOOLSETS if name not in disabled]
    config["agent"] = agent

    plugins = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
    enabled = plugins.get("enabled") if isinstance(plugins.get("enabled"), list) else []
    disabled = plugins.get("disabled") if isinstance(plugins.get("disabled"), list) else []
    plugins["enabled"] = enabled + [name for name in ECHO_PLUGINS if name not in enabled and name not in disabled]
    config["plugins"] = plugins

    # First-contact onboarding (agent/onboarding.py): profile_build "off" drops the
    # "build a short profile of you" offer; the latched `seen` flags keep Hermes from
    # adding its one-time "/busy ..." and "/verbose ..." tips to WhatsApp replies.
    onboarding = config.get("onboarding") if isinstance(config.get("onboarding"), dict) else {}
    onboarding["profile_build"] = "off"
    seen = onboarding.get("seen") if isinstance(onboarding.get("seen"), dict) else {}
    for flag in ONBOARDING_SEEN_FLAGS:
        seen[flag] = True
    onboarding["seen"] = seen
    config["onboarding"] = onboarding

    # Hermes' own fixed messages (approval prompts, busy notices) in Turkish; another
    # language the user picked is kept.
    display = config.get("display") if isinstance(config.get("display"), dict) else {}
    if display.get("language") in (None, "", "en"):
        display["language"] = "tr"
    # No "💾 Kendini geliştirme incelemesi: 'x' skill'i oluşturuldu / yamalandı" (or "💾 Memory
    # updated") messages to WhatsApp users. They come from Hermes' background self-improvement review
    # (agent/background_review.py); "off" only hides the notice, the review keeps running (it is
    # switched by auxiliary.background_review.enabled, skills.creation_nudge_interval and
    # memory.nudge_interval). The gateway reads this global key, not display.platforms.<p>.
    display.setdefault("memory_notifications", "off")
    config["display"] = display

    # Voice messages: only what is missing is filled in, so a provider, model or setting the user
    # picked stays. Hermes' default language is "en" (forced, so Turkish comes out as English
    # nonsense); like display.language above, that one is replaced. The transcript is echoed back
    # (🎙️ "…") before the answer so the user sees what was understood.
    stt = config.get("stt") if isinstance(config.get("stt"), dict) else {}
    for key, value in STT_DEFAULTS.items():
        stt.setdefault(key, value)
    if stt.get("language") in (None, "", "en"):
        stt["language"] = "tr"
    local = stt.get("local") if isinstance(stt.get("local"), dict) else {}
    for key, value in STT_LOCAL_DEFAULTS.items():
        local.setdefault(key, value)
    stt["local"] = local
    config["stt"] = stt

    # No "gateway shutting down / restarted" notices to WhatsApp users on updates
    # (gateway/config.py gateway_restart_notification; a root-level platform block).
    wa = config.get("whatsapp_cloud") if isinstance(config.get("whatsapp_cloud"), dict) else {}
    wa["gateway_restart_notification"] = False
    config["whatsapp_cloud"] = wa

    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        yaml.safe_dump(config, handle, allow_unicode=True, sort_keys=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

    write_locale(os.path.join(os.path.dirname(os.path.abspath(path)), "locales", "tr.yaml"))


def write_locale(path):
    """Writes the Turkish overlay unless someone took it over (removed the marker line)."""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            if LOCALE_MARKER not in handle.read():
                return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(LOCALE_MARKER + "\n")
        yaml.safe_dump(LOCALE_TR, handle, allow_unicode=True, sort_keys=False)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
