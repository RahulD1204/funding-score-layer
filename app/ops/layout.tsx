// The Razorpay ops screens. Each page checks the login and the ops role for itself.

import AppShell from "@/components/shell/AppShell";

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
