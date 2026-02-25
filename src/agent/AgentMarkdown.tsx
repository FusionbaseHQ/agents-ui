import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";

type Props = {
  content: string;
};

class MarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <div className="agentMessageContent" style={{ whiteSpace: "pre-wrap" }}>{this.props.fallback}</div>;
    }
    return this.props.children;
  }
}

function CodeBlock({ className, children }: { className?: string; children: string }) {
  const match = /language-(\w+)/.exec(className ?? "");
  const lang = match ? match[1] : "";
  const code = children.replace(/\n$/, "");

  if (!lang) {
    return (
      <div className="agentCodeBlock">
        <pre className="agentCodeBlockPre">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="agentCodeBlock">
      <div className="agentCodeBlockHeader">{lang}</div>
      <Highlight theme={themes.vsDark} code={code} language={lang}>
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre className="agentCodeBlockPre" style={{ ...style, background: "transparent", margin: 0 }}>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line, key: i });
              return (
                <div key={i} {...lineProps}>
                  {line.map((token, j) => {
                    const tokenProps = getTokenProps({ token, key: j });
                    return <span key={j} {...tokenProps} />;
                  })}
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

export const AgentMarkdown = React.memo(function AgentMarkdown({ content }: Props) {
  return (
    <MarkdownErrorBoundary fallback={content}>
      <div className="agentMessageContent-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children }) {
              const isBlock = className?.startsWith("language-") ||
                (typeof children === "string" && children.includes("\n"));
              if (isBlock) {
                return <CodeBlock className={className}>{String(children)}</CodeBlock>;
              }
              return <code className="agentInlineCode">{children}</code>;
            },
            pre({ children }) {
              return <>{children}</>;
            },
            a({ href, children }) {
              return (
                <a className="agentLink" href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
            table({ children }) {
              return (
                <div className="agentTableWrap">
                  <table className="agentTable">{children}</table>
                </div>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
});
