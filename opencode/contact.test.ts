import test from "node:test";
import assert from "node:assert/strict";
import { intercomContactText } from "./contact.ts";

test("contact text uses the stable configured intercom session id", () => {
  const previous = process.env.OPENCODE_INTERCOM_SESSION_ID;
  process.env.OPENCODE_INTERCOM_SESSION_ID = "opencode-contact-test";
  try {
    assert.equal(intercomContactText(), "intercom send ID: opencode-contact-test");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_INTERCOM_SESSION_ID;
    else process.env.OPENCODE_INTERCOM_SESSION_ID = previous;
  }
});
