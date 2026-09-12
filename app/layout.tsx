import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Competitor Import Tool",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900">{children}</body>
    </html>
  );
}
