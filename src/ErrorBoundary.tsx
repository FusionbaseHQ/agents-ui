import React from "react";

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[agents-ui] Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#1e1e1e",
            color: "#ccc",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          <div style={{ maxWidth: 520, textAlign: "center" }}>
            <h2 style={{ color: "#e06c75", margin: "0 0 12px" }}>
              Something went wrong
            </h2>
            <pre
              style={{
                background: "#2a2a2a",
                padding: "12px 16px",
                borderRadius: 6,
                fontSize: 12,
                textAlign: "left",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 200,
                overflow: "auto",
                color: "#abb2bf",
              }}
            >
              {this.state.error.message}
            </pre>
            <div style={{ marginTop: 20, display: "flex", gap: 12, justifyContent: "center" }}>
              <button
                onClick={() => this.setState({ error: null })}
                style={{
                  padding: "8px 20px",
                  borderRadius: 6,
                  border: "1px solid #555",
                  background: "#333",
                  color: "#ccc",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Try to Recover
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: "8px 20px",
                  borderRadius: 6,
                  border: "none",
                  background: "#4c8bf5",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Reload App
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
