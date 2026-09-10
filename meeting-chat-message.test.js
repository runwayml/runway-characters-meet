import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecallChatConfig,
  MAX_CHAT_INTRO_MESSAGE_LENGTH,
  parseChatIntroMessage,
} from "./meeting-chat-message.js";

test("omits chat when the chat intro message is absent or blank", () => {
  assert.equal(parseChatIntroMessage(undefined), null);
  assert.equal(parseChatIntroMessage(null), null);
  assert.equal(parseChatIntroMessage("   "), null);
  assert.equal(createRecallChatConfig(null), undefined);
});

test("trims and configures a message to everyone when the bot joins", () => {
  const message = parseChatIntroMessage("  Hello from Runway.  ");

  assert.equal(message, "Hello from Runway.");
  assert.deepEqual(createRecallChatConfig(message), {
    on_bot_join: {
      send_to: "everyone",
      message: "Hello from Runway.",
    },
  });
});

test("rejects invalid and over-limit chat messages", () => {
  assert.throws(() => parseChatIntroMessage(true), /must be a string/);
  assert.throws(
    () =>
      parseChatIntroMessage("x".repeat(MAX_CHAT_INTRO_MESSAGE_LENGTH + 1)),
    /500 characters or fewer/
  );
});
