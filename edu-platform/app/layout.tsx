import type { Metadata } from "next";
import { Noto_Sans_SC, Noto_Serif_SC } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import "katex/dist/katex.min.css";

const notoSerifSC = Noto_Serif_SC({
  variable: "--font-serif",
  display: "swap",
  preload: false,
  weight: ["400", "500", "600", "700"],
});

const notoSansSC = Noto_Sans_SC({
  variable: "--font-sans",
  display: "swap",
  preload: false,
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "EduAgent Campus",
  description: "让教学流程与 AI 学习支持自然融合",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className={`${notoSerifSC.variable} ${notoSansSC.variable}`}>
      <body suppressHydrationWarning>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
