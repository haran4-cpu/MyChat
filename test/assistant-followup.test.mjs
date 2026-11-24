import test from "node:test";
import assert from "node:assert/strict";
import { workspaceFollowUp } from "../core/assistant.mjs";

const messages = (...contents) => contents.map(content=>({role:"user",content}));
test("short Hebrew follow-ups keep the last relevant project request",()=>{
  const request="בדוק את קובץ DJ-TiTo";
  assert.equal(workspaceFollowUp(messages(request,"איך נוכל לשפר אותו","תמשיך")),request);
  assert.equal(workspaceFollowUp(messages(request,"איך מכינים קפה","תמשיך")),"");
  assert.equal(workspaceFollowUp(messages("כן")),"");
});
