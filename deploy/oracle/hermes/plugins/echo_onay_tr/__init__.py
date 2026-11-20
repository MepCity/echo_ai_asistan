"""echo_onay_tr: a short Turkish body for Hermes' WhatsApp approval card of Echo's MCP tools.

Why a plugin that wraps two functions: Hermes has no supported way to change this text. The trust
gate (tools/mcp_tool_handlers.py, ``_ask_for_call``) builds the body as fixed English f-strings
("MCP tool '…' on UNTRUSTED server '…' wants to run. … Arguments: {json}") and hands it to
``tools.approval_prompt.request_elicitation_consent``; no locale key, config option, tool annotation
or hook can change it (``pre_approval_request`` is an observer, its return value is ignored).

What it does, and nothing more:
  1. wraps ``tools.mcp_tool_handlers._trust_gate_check`` only to remember (server, tool, arguments) of
     the call being gated (a context variable, same thread);
  2. wraps ``tools.approval_prompt.request_elicitation_consent``: for surface ``mcp-trust/trypost`` or
     ``mcp-trust/studio`` and Hermes' English trust-gate text, it swaps the text for render.render(...)
     (Turkish, at most 600 characters, so the WhatsApp card holds it whole and Hermes does not send
     the long text as a separate message first) and the description for a short Turkish note.
The gate itself is untouched: the same function asks the same person with the same Onayla/Vazgeç
buttons, the same timeout and the same remembered-answer key; the plugin only changes the words.

Fail-safe: if Hermes' code no longer has these functions, or the text is not the expected one (a
spend-limit notice, another server, an argument dump that cannot be read), or anything raises, the
original English card is shown unchanged. The outcome of loading is written to status.json next to
this file; setup-hermes.sh prints it (and a warning when it did not apply).
"""

import contextvars
import functools
import inspect
import json
import logging
import os
import re
import time
import urllib.request
from pathlib import Path

from . import render as _render

logger = logging.getLogger("echo_onay_tr")

MARK = "__echo_onay_tr__"
SERVERS = ("trypost", "studio")
HINT_TOOLS = ("generate_image", "generate_audio")
HINT_URL = os.environ.get("ECHO_STUDIO_HINT_URL", "http://studio:8091/approval-hint")
HINT_TIMEOUT_S = 2.0
DESCRIPTION = "Onaylarsan şimdi yapılır; Vazgeç'e basarsan hiçbir şey yapılmaz."
STATUS_FILE = Path(__file__).resolve().parent / "status.json"

_current_call = contextvars.ContextVar("echo_onay_tr_call", default=None)


# ---- the rewrite (pure apart from the studio hint) ------------------------------------------------

def _arguments_from_message(message):
    """(tool, args) from Hermes' own English text, for a Hermes whose gate does not pass the arguments
    to us. args is None when the text has an argument dump that cannot be read (cut or redacted)."""
    match = re.match(r"MCP tool '([^']+)'", message)
    tool = match.group(1) if match else ""
    if "\nArguments:\n" not in message:
        return tool, {}
    dump = message.split("\nArguments:\n", 1)[1]
    try:
        args = json.loads(dump)
    except ValueError:
        return tool, None
    return tool, args if isinstance(args, dict) else None


def studio_hint(tool, args, opener=None):
    """Aspect ratio and approximate credits from the studio (POST /approval-hint); {} on any failure."""
    token = os.environ.get("ECHO_STUDIO_TOKEN", "")
    if tool not in HINT_TOOLS or not token:
        return {}
    request = urllib.request.Request(
        HINT_URL, data=json.dumps({"tool": tool, "arguments": args}).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with (opener or urllib.request.urlopen)(request, timeout=HINT_TIMEOUT_S) as response:
            hint = json.loads(response.read(16 * 1024).decode("utf-8"))
        return hint if isinstance(hint, dict) else {}
    except Exception as exc:  # the card is shown without credits
        logger.info("echo_onay_tr: studio hint unavailable: %s", exc)
        return {}


def _redact(text):
    try:
        from agent.redact import redact_sensitive_text
    except Exception:
        return text
    try:
        return redact_sensitive_text(text, force=True)
    except TypeError:
        return redact_sensitive_text(text)
    except Exception:
        return text


def rewrite(message, description, surface, call=None, hint_fn=studio_hint):
    """(new message, new description), or None to keep Hermes' own card."""
    if not isinstance(message, str) or not isinstance(surface, str) or not surface.startswith("mcp-trust/"):
        return None
    server = surface.split("/", 1)[1]
    if server not in SERVERS:
        return None
    # Only the plain trust-gate card; a spend-limit notice (and any wording we do not know) stays as is.
    if not message.startswith("MCP tool '") or "wants to run" not in message or "spend limit" in message:
        return None
    if call and call[0] == server and isinstance(call[2], dict):
        tool, args = call[1], call[2]
    else:
        tool, args = _arguments_from_message(message)
        if args is None or not tool:
            return None
    hint = hint_fn(tool, args) if server == "studio" else {}
    body = _render.render(server, tool, args, hint)
    if not body:
        return None
    return _redact(body), DESCRIPTION


# ---- installation -------------------------------------------------------------------------------------

def _bound(func, args, kwargs):
    try:
        return inspect.signature(func).bind_partial(*args, **kwargs).arguments
    except (TypeError, ValueError):
        return {}


def _wrap_gate(original):
    def remember(args, kwargs):
        bound = _bound(original, args, kwargs)
        server = bound.get("server_name", args[0] if args else None)
        tool = bound.get("tool_name", args[1] if len(args) > 1 else None)
        return _current_call.set((server, tool, bound.get("args")))

    if inspect.iscoroutinefunction(original):
        @functools.wraps(original)
        async def gate(*args, **kwargs):
            token = remember(args, kwargs)
            try:
                return await original(*args, **kwargs)
            finally:
                _current_call.reset(token)
    else:
        @functools.wraps(original)
        def gate(*args, **kwargs):
            token = remember(args, kwargs)
            try:
                return original(*args, **kwargs)
            finally:
                _current_call.reset(token)
    setattr(gate, MARK, True)
    return gate


def _wrap_consent(original):
    @functools.wraps(original)
    def consent(message, description, *args, **kwargs):
        try:
            changed = rewrite(message, description, kwargs.get("surface"), _current_call.get())
        except Exception as exc:  # never in the way of an approval: the original card is shown
            logger.warning("echo_onay_tr: Turkish card failed, showing Hermes' own: %s", exc)
            changed = None
        if changed:
            message, description = changed
        return original(message, description, *args, **kwargs)
    setattr(consent, MARK, True)
    return consent


def _write_status(ok, text):
    try:
        STATUS_FILE.write_text(json.dumps({"ok": ok, "message": text, "time": int(time.time())}, ensure_ascii=False),
                               encoding="utf-8")
    except Exception:
        pass


def install(handlers=None, prompt=None):
    """Wraps the two functions once. Returns (ok, text); never raises."""
    try:
        if handlers is None:
            import tools.mcp_tool_handlers as handlers  # noqa: PLC0415 (Hermes' module, in its process)
        if prompt is None:
            import tools.approval_prompt as prompt  # noqa: PLC0415
        gate = getattr(handlers, "_trust_gate_check", None)
        consent = getattr(prompt, "request_elicitation_consent", None)
        if not callable(gate) or not callable(consent):
            raise LookupError("_trust_gate_check / request_elicitation_consent not found")
        params = list(inspect.signature(consent).parameters)
        if params[:2] != ["message", "description"] or "surface" not in params:
            raise LookupError(f"request_elicitation_consent has another signature ({', '.join(params)})")
        if list(inspect.signature(gate).parameters)[:2] != ["server_name", "tool_name"]:
            raise LookupError("_trust_gate_check has another signature")
        try:
            source = inspect.getsource(handlers)
        except (OSError, TypeError):
            source = ""
        if source and "wants to run" not in source:
            raise LookupError("the trust-gate text in tools/mcp_tool_handlers.py changed")

        if not getattr(gate, MARK, False):
            handlers._trust_gate_check = _wrap_gate(gate)
        if not getattr(consent, MARK, False):
            prompt.request_elicitation_consent = _wrap_consent(consent)
        # A Hermes that imports the function at module level calls its own copy: wrap that one too.
        local = getattr(handlers, "request_elicitation_consent", None)
        if callable(local) and not getattr(local, MARK, False):
            handlers.request_elicitation_consent = _wrap_consent(local)
        text = "Türkçe onay mesajı etkin (trypost, studio)."
        _write_status(True, text)
        logger.info("echo_onay_tr: %s", text)
        return True, text
    except Exception as exc:
        text = f"Türkçe onay mesajı UYGULANAMADI, Hermes'in kendi (İngilizce) onay mesajı kullanılıyor: {exc}"
        _write_status(False, text)
        logger.warning("echo_onay_tr: %s", text)
        return False, text


def register(ctx):
    ok, _ = install()
    if ok:
        return
    # Hermes' modules may not be importable yet when plugins load: try once more before the first tool
    # call (pre_tool_call runs before an MCP tool's handler, so before its trust gate). Observer only.
    state = {"tried": False}

    def retry(**_kwargs):
        if not state["tried"]:
            state["tried"] = True
            install()
        return None

    try:
        ctx.register_hook("pre_tool_call", retry)
    except Exception as exc:
        logger.warning("echo_onay_tr: could not register the retry hook: %s", exc)
