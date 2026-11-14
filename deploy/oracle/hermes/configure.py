#!/usr/bin/env python3
"""Merges Echo's settings into Hermes' config.yaml, keeping everything else in it.

Usage: python3 -I configure.py /opt/hermes/data/config.yaml
Run by setup-hermes.sh; safe to run again. Needs PyYAML (python3-yaml).
"""
import os
import sys

import yaml

TRYPOST_MCP_URL = "https://sosyal.marmaraai.com/mcp/trypost"

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

    approvals = config.get("approvals") if isinstance(config.get("approvals"), dict) else {}
    if approvals.get("mode") in (None, "off"):
        approvals["mode"] = "manual"
    approvals.setdefault("timeout", 300)
    config["approvals"] = approvals

    agent = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    disabled = agent.get("disabled_toolsets") or []
    if not isinstance(disabled, list):
        disabled = [disabled]
    agent["disabled_toolsets"] = disabled + [name for name in DISABLED_TOOLSETS if name not in disabled]
    config["agent"] = agent

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
    config["display"] = display

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


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
