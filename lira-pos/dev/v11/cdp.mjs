/**
 * V1.1 acceptance — a small CDP driver for the real WebView2 window.
 *
 * Evidence classes (CLAUDE.md "What counts as desktop evidence"):
 *   - key()/type()   → REAL KEY EVENTS (Input.dispatchKeyEvent: keyDown/char/keyUp)
 *   - click()        → real mouse events at the element's on-screen centre
 *                      (Input.dispatchMouseEvent), not element.click()
 *   - viewport()     → EMULATED VIEWPORT (Emulation.setDeviceMetricsOverride)
 *   - invoke()       → IPC, used only for setup and for reading results back
 */
import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(port) {
  let list;
  for (let i = 0; i < 80; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list.some((t) => t.type === "page")) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  const page = list?.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error(`no CDP page on ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  let next = 1;
  const send = (method, params = {}) => {
    const id = next++;
    return new Promise((resolve, reject) => {
      const on = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.id !== id) return;
        ws.off("message", on);
        m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result);
      };
      ws.on("message", on);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  await send("Runtime.enable");
  await send("Page.enable");

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };

  const invoke = async (cmd, args = {}) => {
    for (let i = 0; i < 60; i++) {
      const v = await evaluate(`(async () => { if (!window.__TAURI_INTERNALS__) return { notReady: true };
        try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}) }; }
        catch (e) { return { ok: false, error: typeof e === "string" ? e : (e && e.message) || JSON.stringify(e) }; } })()`);
      if (!v?.notReady) return v;
      await sleep(250);
    }
    throw new Error("IPC never became ready");
  };
  const select = async (sql, params = []) => {
    const r = await invoke("db_select", { sql, params });
    if (!r.ok) throw new Error(`db_select: ${r.error}\n  ${sql}`);
    return r.value;
  };
  const text = async () => (await evaluate("document.body ? document.body.innerText : ''")) ?? "";

  /** Centre of the first element matching a CSS selector, optionally by text. */
  const locate = async (selector, textMatch = null) => {
    const r = await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const want = ${JSON.stringify(textMatch)};
      const el = els.find((e) => {
        if (!want) return true;
        const t = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
        return new RegExp(want, 'i').test(t);
      });
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, disabled: !!el.disabled };
    })()`);
    return r;
  };

  const waitFor = async (selector, textMatch = null, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const r = await locate(selector, textMatch);
      if (r) return r;
      if (Date.now() > end) throw new Error(`waitFor timed out: ${selector} ${textMatch ?? ""}`);
      await sleep(200);
    }
  };

  const mouse = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const click = async (selector, textMatch = null) => {
    const p = await waitFor(selector, textMatch);
    await sleep(60);
    await mouse(p.x, p.y);
    await sleep(120);
    return p;
  };

  const KEYS = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Tab: { code: "Tab", vk: 9 },
    Escape: { code: "Escape", vk: 27 },
    Backspace: { code: "Backspace", vk: 8 },
    F5: { code: "F5", vk: 116 },
    F6: { code: "F6", vk: 117 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
  };
  const key = async (name, { modifiers = 0 } = {}) => {
    const k = KEYS[name];
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
    if (k.text) await send("Input.dispatchKeyEvent", { type: "char", key: name, text: k.text, unmodifiedText: k.text, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
    await sleep(80);
  };
  /** Type text as real keystrokes (keyDown/char/keyUp per character). */
  const type = async (s) => {
    for (const ch of s) {
      const upper = ch.toUpperCase();
      const isLetter = /[a-z]/i.test(ch);
      const isDigit = /[0-9]/.test(ch);
      const code = isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : ch === "." ? "Period" : ch === " " ? "Space" : ch === "-" ? "Minus" : "";
      const vk = isLetter ? upper.charCodeAt(0) : isDigit ? ch.charCodeAt(0) : ch === "." ? 190 : ch === " " ? 32 : ch === "-" ? 189 : 0;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, text: ch, unmodifiedText: ch });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk });
    }
    await sleep(80);
  };
  /** Select-all + delete in the focused field, by keys. */
  const clearField = async () => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await key("Backspace");
  };

  /** Focus a field found by its visible label (a <label for> or a wrapping
   *  <label>) by CLICKING it with the mouse, then optionally clear it. */
  const field = async (labelRegex, { nth = 0, clear = true } = {}) => {
    const sel = await evaluate(`(() => {
      const re = new RegExp(${JSON.stringify(labelRegex)}, 'i');
      const labels = [...document.querySelectorAll('label')].filter((l) => re.test((l.innerText || '').trim()));
      const els = labels.map((l) => (l.htmlFor && document.getElementById(l.htmlFor)) || l.querySelector('input,select,textarea')).filter(Boolean);
      const el = els[${nth}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + Math.min(20, b.width / 2), y: b.top + b.height / 2, tag: el.tagName };
    })()`);
    if (!sel) throw new Error(`no field labelled /${labelRegex}/`);
    await mouse(sel.x, sel.y);
    await sleep(80);
    if (clear && sel.tag !== "SELECT") await clearField();
    return sel;
  };
  /** Set a <select> found by label (a select has no keyboard-typing contract
   *  worth simulating here; this is SIMULATED UI INTERACTION and says so). */
  const chooseByLabel = async (labelRegex, value) => {
    return evaluate(`(() => {
      const re = new RegExp(${JSON.stringify(labelRegex)}, 'i');
      const l = [...document.querySelectorAll('label')].find((l) => re.test((l.innerText || '').trim()));
      const el = l && ((l.htmlFor && document.getElementById(l.htmlFor)) || l.querySelector('select'));
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  };
  /** Computed colours of the focused element — for the contrast check. */
  const focusedStyle = () =>
    evaluate(`(() => { const e = document.activeElement; if (!e) return null; const s = getComputedStyle(e);
      return { tag: e.tagName, value: e.value, bg: s.backgroundColor, color: s.color, placeholder: getComputedStyle(e, '::placeholder').color }; })()`);

  const viewport = async (width, height, scale = 1) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await sleep(400);
  };
  const clearViewport = async () => {
    await send("Emulation.clearDeviceMetricsOverride");
    await sleep(300);
  };
  const screenshot = async (path) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  };
  const navigate = async (hashOrPath) => {
    await evaluate(`(() => { history.pushState({}, '', ${JSON.stringify(hashOrPath)}); dispatchEvent(new PopStateEvent('popstate')); })()`);
    await sleep(700);
  };

  return { ws, send, evaluate, invoke, select, text, locate, waitFor, click, mouse, key, type, clearField, field, chooseByLabel, focusedStyle, viewport, clearViewport, screenshot, navigate, close: () => ws.close() };
}

export function makeChecker(label) {
  const results = [];
  const check = (name, cond, detail = "") => {
    const ok = Boolean(cond);
    results.push({ ok, name, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  [${label}] ${name}${detail ? `  — ${String(detail).slice(0, 300)}` : ""}`);
    return ok;
  };
  return { check, results };
}
