// One brain: every message goes to the same assistant. A normal question streams a normal answer (with the Truth
// Engine, Max, Verified, Consensus as chosen). When the answer needs the person's files or an action on them, the
// assistant switches to the agent loop (tools, steps, proof, approval) — decided by the model itself, plus a fast
// rule for obvious cases. Same code on the phone, the PC gateway (Open WebUI) and inside PC jobs.
import { run } from "./reason.mjs";
import { lastUserText } from "./router.mjs";
import { runAgent, preview } from "./agent.mjs";
import { WORKSPACE_RX } from "./projects.mjs";

export const TOOL_TOKEN = "[[USE_TOOLS]]";
export const IDENTITY = `You are MyChat, the person's own assistant (phone app and PC). You can work with their MyChat folder (projects, inbox, files, archives) through tools, read and search inside it, study whole projects, check facts and numbers, and propose file changes that they approve.
Answer in the person's language, directly and specifically, like a senior expert. Say plainly when you are unsure. Never claim you cannot access their files.`;
const DECIDE = `\nIf answering needs the person's files, folders, projects or an action on them, reply with exactly ${TOOL_TOKEN} and nothing else. Otherwise answer normally.`;

/**
 * respond(gw, { messages, fs?, mode, onDelta, onStatus, onStep, signal, truth, tools, memory, privateData })
 * -> { content, mode, trace, claims?, sources?, steps?, ops?, preview?, planId?, checked? }
 */
export async function respond(gw, o) {
  const { messages, fs, onDelta, onStatus = () => {}, signal } = o;
  const text = lastUserText(messages);
  const history = messages.slice(0, -1).filter((m) => m.role !== "system").slice(-10)
    .map(({ role, content }) => ({ role, content: typeof content === "string" ? content.slice(0, 8000) : "(attachment)" }));
  const agent = async () => {
    onStatus("Looking at your files…");
    const r = await runAgent(gw, { goal: text, fs, history, signal, privateData: o.privateData, memory: o.memory, onStep: o.onStep, ...(o.tools || {}) });
    const out = { content: r.answer, mode: "agent", trace: [{ step: "agent", by: r.by }], steps: r.steps, calls: r.calls, checked: r.checked };
    if (r.ops.length) Object.assign(out, { ops: r.ops, planId: r.id, preview: await preview(fs, r.ops).catch(() => null) });
    if (onDelta) for (let i = 0; i < out.content.length; i += 400) onDelta(out.content.slice(i, i + 400));   // shows like a stream
    return out;
  };
  if (fs && (o.mode === "agent" || (text.length < 2000 && WORKSPACE_RX.test(text)))) return agent();
  // let the model decide: hold back the first characters until we know whether it asked for tools
  let head = "", decided = !fs;
  const sys = { role: "system", content: IDENTITY + (fs ? DECIDE : "") };
  const r = await run(gw, { messages: [sys, ...messages.filter((m) => m.role !== "system")] }, {
    mode: o.mode, signal, truth: o.truth, onStatus, privateData: o.privateData,
    onDelta: (d) => {
      if (decided) return onDelta?.(d);
      head += d;
      const h = head.trimStart();
      if (h.length >= TOOL_TOKEN.length || !TOOL_TOKEN.startsWith(h)) { decided = true; if (!h.startsWith(TOOL_TOKEN)) onDelta?.(head); }
    },
  });
  if (fs && String(r.content).trimStart().startsWith(TOOL_TOKEN)) return agent();
  if (!decided && head && onDelta) onDelta(head);
  return r;
}
