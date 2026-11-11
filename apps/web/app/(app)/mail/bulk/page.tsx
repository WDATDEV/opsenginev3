import { redirect } from "next/navigation";

// Bulk email is hidden for now. The API is still there; this page just sends people back to Inbox.
export default function BulkEmailPage() {
  redirect("/mail");
}
