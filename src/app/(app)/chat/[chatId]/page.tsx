import { ChatScreen } from "@/components/chat/chat-screen";

interface ChatThreadPageProps {
  // Next 16: params is a Promise — awaited here, in the Server Component, so ChatScreen itself (the
  // client boundary) receives a plain string prop.
  params: Promise<{ chatId: string }>;
}

/**
 * chatId is either local-<uuid> (a guest's or not-yet-persisted thread) or a real server thread id.
 * `key={chatId}` forces a fresh ChatScreen mount on a genuine navigation between two distinct
 * threads (a sidebar RecentsList row, a bookmarked URL) — the internal id swap this same component
 * performs mid-conversation never goes through this route re-render at all, since it never calls
 * router.push/replace, only window.history.replaceState (so an in-flight stream is never aborted
 * by its own success).
 */
export default async function ChatThreadPage({ params }: ChatThreadPageProps) {
  const { chatId } = await params;
  return <ChatScreen key={chatId} chatId={chatId} />;
}
