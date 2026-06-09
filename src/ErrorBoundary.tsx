import React from "react";

interface State {
  error: Error | null;
}

interface PanelState {
  error: Error | null;
  resetKey: number;
}

interface PanelProps extends React.PropsWithChildren {
  /** Shown in the fallback and in the console log, e.g. "File viewer". */
  label: string;
}

/**
 * Boundary for one panel/viewer subtree. A render crash inside a heavy panel
 * (editor, agent panel, file tree) must never blank the whole app — the
 * terminals keep running in the backend either way, and they keep rendering
 * with this in place. "Reload panel" remounts only the crashed subtree via a
 * key bump, clearing whatever state crashed it.
 */
export class PanelErrorBoundary extends React.Component<PanelProps, PanelState> {
  state: PanelState = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[agents-ui] ${this.props.label} crashed:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <section
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#ccc",
          }}
          aria-label={`${this.props.label} error`}
        >
          <div style={{ maxWidth: 420, textAlign: "center", padding: 16 }}>
            <div style={{ color: "#e06c75", fontWeight: 600, marginBottom: 8 }}>
              {this.props.label} crashed
            </div>
            <pre
              style={{
                background: "rgba(0,0,0,0.25)",
                padding: "10px 12px",
                borderRadius: 6,
                fontSize: 11,
                textAlign: "left",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 140,
                overflow: "auto",
              }}
            >
              {this.state.error.message}
            </pre>
            <button
              onClick={() =>
                this.setState((prev) => ({ error: null, resetKey: prev.resetKey + 1 }))
              }
              style={{
                marginTop: 12,
                padding: "6px 16px",
                borderRadius: 6,
                border: "1px solid #555",
                background: "#333",
                color: "#ccc",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Reload panel
            </button>
          </div>
        </section>
      );
    }
    return (
      <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>
    );
  }
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
