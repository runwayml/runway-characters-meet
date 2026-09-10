export const MAX_CHAT_INTRO_MESSAGE_LENGTH = 500;

export function parseChatIntroMessage(value) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error("chatIntroMessage must be a string");
  }

  const message = value.trim();
  if (!message) return null;
  if (message.length > MAX_CHAT_INTRO_MESSAGE_LENGTH) {
    throw new Error(
      `chatIntroMessage must be ${MAX_CHAT_INTRO_MESSAGE_LENGTH} characters or fewer`
    );
  }
  return message;
}

export function createRecallChatConfig(chatIntroMessage) {
  if (!chatIntroMessage) return undefined;
  return {
    on_bot_join: {
      send_to: "everyone",
      message: chatIntroMessage,
    },
  };
}
