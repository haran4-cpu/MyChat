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
Answer in the person's language, directly and specifically, like a senior expert. Say plainly when you are unsure. When tools and a workspace are available, inspect relevant files before diagnosing. Cite what you read, say what was verified, and report failures. Never claim to have changed or tested anything without tool evidence. Use the current workspace and prior conversation to resolve short follow-ups. You are not one company's model: MyChat routes each step to one of several models (Google Gemini, open models such as gpt-oss, Qwen, Llama, DeepSeek, Kimi, GLM, and a local model on the PC) and has answers reviewed by a different family. Never say you were made by Google, OpenAI or anyone else; if asked which model, say this and that the model that answered is shown under the answer.`;
const WORK_FOLLOW_UP = /^(?:כן(?: תעשה)?|בצע|תעשה(?: את זה| אותו)?|תמשיך(?: מאיפה שעצרנו)?|המשך|נסה(?: שוב)?|בחן שוב(?: את השיחה)?|בדוק שוב|מה (?:אתה חושב|עוד)|איך נוכל לשפר(?: אותו| את זה)?|go ahead|do it|continue|try again|what next)[?!. ]*$/iu;

export function workspaceFollowUp(messages) {
  if (!WORK_FOLLOW_UP.test(lastUserText(messages).trim())) return "";
  const previous = messages.filter(m=>m.role==="user" && typeof m.content==="string").slice(-5,-1).reverse();
  const subject = previous.find(m=>!WORK_FOLLOW_UP.test(m.content.trim()));
  return subject && WORKSPACE_RX.test(subject.content) ? subject.content : "";
}

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
  // the screen is a tool too (measured on the PC: "look at my screen" was answered with "please send a screenshot")
  const SCREEN_RX = /\b(my|the) (screen|desktop|display)\b|screenshot|המסך|מסך שלי|צילום מסך|שולחן העבודה/i;
  if (fs && (o.tools?.terminalRequest?.(text) || o.mode === "agent" || workspaceFollowUp(messages) || (text.length < 2000 && (WORKSPACE_RX.test(text) || (o.tools?.see && SCREEN_RX.test(text)))))) return agent();
  // let the model decide: hold back the first characters until we know whether it asked for tools
  let head = "", decided = !fs;
  const privacy = o.privateData ? "\nThis conversation uses the local Ollama engine only. You have no web or cloud access here. State that only when relevant." : "";
  const sys = { role: "system", content: IDENTITY + privacy + (fs ? DECIDE : "") };
  const r = await run(gw, { messages: [sys, ...messages.filter((m) => m.role !== "system")] }, {
    mode: o.mode, signal, truth: o.truth, onStatus, privateData: o.privateData,
    onDelta: (d) => {
      if (decided) return onDelta?.(d);
      head += d;
      const h = head.trimStart();
      if (h.length >= TOOL_TOKEN.length || !TOOL_TOKEN.startsWith(h)) { decided = true; if (!h.startsWith(TOOL_TOKEN)) onDelta?.(head); }
    },
  });
  // the model asked for tools — or gave nothing usable (measured: a reasoning model returned an empty answer to the
  // decision prompt): look at the files rather than show an empty bubble
  if (fs && (String(r.content).trimStart().startsWith(TOOL_TOKEN) || !String(r.content).trim())) return agent();
  if (!decided && head && onDelta) onDelta(head);
  return r;
}
