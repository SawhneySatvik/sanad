import { ChatScreen } from "@/components/chat/chat-screen";

/** Chat home — the always-available "start a new conversation" screen; not a one-time onboarding moment. */
export default function ChatHomePage() {
  return <ChatScreen chatId={null} />;
}
