import type { Metadata, Viewport } from "next";
import { InstallPrompt } from "@/components/install-prompt";
import { SentryInit } from "@/components/sentry-init";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { AuthProvider } from "@/lib/auth";
import { LanguageProvider } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MediQ: Book doctor appointments", template: "%s · MediQ" },
  description:
    "Book a doctor at your nearest hospital, pay online and get your token number instantly.",
  applicationName: "MediQ",
  appleWebApp: { capable: true, title: "MediQ", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f766e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <LanguageProvider>{children}</LanguageProvider>
        </AuthProvider>
        <ServiceWorkerRegister />
        <SentryInit />
        <InstallPrompt />
      </body>
    </html>
  );
}
