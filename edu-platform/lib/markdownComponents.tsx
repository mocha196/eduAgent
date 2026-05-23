/**
 * Shared ReactMarkdown `components` override.
 * Renders ```mermaid code blocks as live diagrams via MermaidBlock.
 * All other code elements fall through to the default renderer.
 */
import type { Components } from "react-markdown";
import { MermaidBlock } from "@/components/MermaidBlock";

export const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    if (match?.[1] === "mermaid") {
      return (
        <MermaidBlock code={String(children).replace(/\n$/, "")} />
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  table({ children, ...props }) {
    return (
      <div className="overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    );
  },
};
