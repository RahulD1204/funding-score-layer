// The lender and insurer screens. Each page checks the login and the role for itself.

import AppShell from "@/components/shell/AppShell";

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
