import type { Terminal, IMarker } from "xterm";

export interface CommandBlock {
  id: number;
  promptMarker: IMarker;
  commandMarker?: IMarker;
  commandStartCol?: number;
  outputMarker?: IMarker;
  endMarker?: IMarker;
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
}

let nextBlockId = 1;

export class SessionShellIntegration {
  private blocks: CommandBlock[] = [];
  private currentBlock: CommandBlock | null = null;
  private disposed = false;
  private onBlockEvicted: ((blockId: number) => void) | null = null;
  private static hasCommandLifecycle(block: CommandBlock): boolean {
    return Boolean(block.commandMarker || block.outputMarker || block.endMarker);
  }

  get activated(): boolean {
    return this.blocks.length > 0 || this.currentBlock !== null;
  }

  get pendingBlock(): CommandBlock | null {
    return this.currentBlock;
  }

  get completedBlocks(): ReadonlyArray<CommandBlock> {
    return this.blocks.filter((b) => b.endMarker != null);
  }

  get allBlocks(): ReadonlyArray<CommandBlock> {
    const result = [...this.blocks];
    if (this.currentBlock && !this.blocks.includes(this.currentBlock)) {
      result.push(this.currentBlock);
    }
    return result;
  }

  handlePromptStart(term: Terminal): void {
    if (this.disposed) return;

    // If there's an incomplete current block (no D marker), finalize it
    if (
      this.currentBlock &&
      !this.currentBlock.endMarker &&
      SessionShellIntegration.hasCommandLifecycle(this.currentBlock)
    ) {
      this.blocks.push(this.currentBlock);
    }

    const marker = term.registerMarker(0);
    if (!marker) return;

    const block: CommandBlock = {
      id: nextBlockId++,
      promptMarker: marker,
    };
    this.currentBlock = block;

    marker.onDispose(() => this.evictBlock(block.id));
  }

  handleCommandStart(term: Terminal): void {
    if (this.disposed) return;
    if (!this.currentBlock) return;
    const block = this.currentBlock;
    if (block.commandMarker) return;
    const marker = term.registerMarker(0);
    if (!marker) return;
    block.commandMarker = marker;
    // Capture cursor column — this is where user input begins (after the prompt)
    block.commandStartCol = term.buffer.active.cursorX;
  }

  handleOutputStart(term: Terminal): void {
    if (this.disposed) return;
    const block = this.currentBlock;
    if (!block) return;
    if (!block.commandMarker) return;
    if (block.outputMarker) return;
    const marker = term.registerMarker(0);
    if (!marker) return;
    block.outputMarker = marker;
    block.startedAt = Date.now();
  }

  handleCommandFinished(term: Terminal, exitCode: number): void {
    if (this.disposed) return;
    const block = this.currentBlock;
    if (!block) return;
    if (!block.commandMarker) return;
    if (block.endMarker) return;
    if (!block.outputMarker) {
      block.outputMarker = block.commandMarker;
      block.startedAt = Date.now();
    }
    const marker = term.registerMarker(0);
    if (!marker) return;
    block.endMarker = marker;
    block.exitCode = exitCode;
    block.finishedAt = Date.now();
    this.blocks.push(block);
    this.currentBlock = null;
  }

  getBlockAtRow(row: number): CommandBlock | null {
    const all = this.allBlocks;
    for (let i = all.length - 1; i >= 0; i--) {
      const block = all[i];
      const startLine = block.promptMarker.line;
      if (row >= startLine) return block;
    }
    return null;
  }

  getOutputText(term: Terminal, block: CommandBlock): string | null {
    if (!block.outputMarker || !block.endMarker) return null;
    const startRow = block.outputMarker.line + 1;
    const endRow = block.endMarker.line;
    if (startRow > endRow) return "";

    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let row = startRow; row <= endRow; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  }

  getCommandText(term: Terminal, block: CommandBlock): string | null {
    if (!block.commandMarker) return null;
    const startRow = block.commandMarker.line;
    // Command text lives between B and C markers. Don't include the C marker line itself
    // since that's where output begins.
    const endRow = block.outputMarker
      ? Math.max(startRow, block.outputMarker.line - 1)
      : block.endMarker
        ? Math.max(startRow, block.endMarker.line - 1)
        : startRow;

    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let row = startRow; row <= endRow; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      let text = line.translateToString(true);
      // On the first line (B marker line), strip the prompt prefix.
      // Use the saved cursor column, then also strip residual prompt indicators
      // (shells like nushell emit B before drawing the final `> ` indicator).
      if (row === startRow) {
        if (block.commandStartCol != null && block.commandStartCol > 0) {
          text = text.slice(block.commandStartCol);
        }
        // Strip common prompt-ending patterns that may remain after column slicing
        // Includes ❯ (U+276F) used by nushell and starship
        text = text.replace(/^[>$%#❯]\s+/, "");
      }
      lines.push(text);
    }
    return lines.join("\n").trim();
  }

  serializeBlock(term: Terminal, block: CommandBlock): {
    command: string | null;
    exitCode: number | null;
    output: string | null;
    durationMs: number | null;
  } {
    return {
      command: this.getCommandText(term, block),
      exitCode: block.exitCode ?? null,
      output: this.getOutputText(term, block),
      durationMs:
        block.startedAt != null && block.finishedAt != null
          ? block.finishedAt - block.startedAt
          : null,
    };
  }

  navigateToBlock(term: Terminal, block: CommandBlock): void {
    const line = block.promptMarker.line;
    const viewportTop = term.buffer.active.viewportY;
    const delta = line - viewportTop;
    term.scrollLines(delta);
  }

  getPreviousBlock(row: number): CommandBlock | null {
    const all = this.allBlocks;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].promptMarker.line < row) return all[i];
    }
    return null;
  }

  getNextBlock(row: number): CommandBlock | null {
    const all = this.allBlocks;
    for (let i = 0; i < all.length; i++) {
      if (all[i].promptMarker.line > row) return all[i];
    }
    return null;
  }

  private evictBlock(blockId: number): void {
    this.blocks = this.blocks.filter((b) => b.id !== blockId);
    if (this.currentBlock?.id === blockId) {
      this.currentBlock = null;
    }
    this.onBlockEvicted?.(blockId);
  }

  setOnBlockEvicted(cb: ((blockId: number) => void) | null): void {
    this.onBlockEvicted = cb;
  }

  dispose(): void {
    this.disposed = true;
    this.blocks = [];
    this.currentBlock = null;
  }
}
